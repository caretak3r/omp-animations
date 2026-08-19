import { describe, expect, it } from "bun:test";
import { hashContent, type ProbeObservation, type ProbeSource } from "../src/audit-trail-box/probe";
import { AuditTrailService, PROBE_INTERVAL_MS } from "../src/audit-trail-box/service";
import {
	AuditLedgerState,
	CACHE_INVALIDATION_THRESHOLD,
	COLD_AFTER_TURNS,
	comparePathRecords,
	FAMILY_CONFIDENCE,
	FORMATTER_WINDOW_MS,
	MAX_TRACKED_CONTENT_CHARS,
	noisyOr,
	PATH_COOLDOWN_MS,
	type PathRecord,
	POISON_STREAK_TICKS,
	type ProbeReading,
	RECOVERY_WINDOW_MS,
	REDUNDANT_READ_THRESHOLD,
	SIGNAL_FAMILIES,
	STATUS_RISK_ORDER,
	severityFor,
	WORKING_SET_SOFT_CAP,
	WRITE_AMPLIFICATION_THRESHOLD,
} from "../src/audit-trail-box/state";
import type { FrameScheduler } from "../src/kit";

/** One probe tick that saw `hash` on disk for `path`. */
function seen(path: string, hash: string, content?: string): ProbeReading {
	return { path, hash, content, reachable: true };
}

/** One probe tick where `path` was deleted or hit EPERM. */
function gone(path: string): ProbeReading {
	return { path, hash: undefined, reachable: false };
}

/** A fully-populated {@link PathRecord} for testing the pure comparator without driving a whole session. */
function fakeRecord(overrides: Partial<PathRecord> & { path: string }): PathRecord {
	return {
		status: "fresh",
		severity: "none",
		confidence: 0,
		families: new Set(),
		reads: 1,
		writes: 0,
		redundantReads: 0,
		prefixInvalidations: 0,
		divergenceStreak: 0,
		reachable: true,
		lastTouchTurn: 0,
		contextHash: undefined,
		contextContent: undefined,
		hashNow: undefined,
		contentNow: undefined,
		formatterAbsorbs: 0,
		cooldownUntilMs: 0,
		...overrides,
	};
}

/** Drive `state` past hysteresis for `path` with an off-baseline hash, well clear of any formatter window. */
function poison(state: AuditLedgerState, path: string, startMs: number, hash = "external"): void {
	for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) {
		state.noteProbe([seen(path, hash)], startMs + tick * 1000);
	}
}

describe("audit-trail-box severity gate", () => {
	it("reports no severity for a path with no firing families", () => {
		expect(severityFor(new Set())).toBe("none");
	});

	it("holds a single family at watch, never alarm", () => {
		for (const family of SIGNAL_FAMILIES) {
			expect(severityFor(new Set([family]))).toBe("watch");
		}
	});

	it("escalates to alarm only once two independent families fire", () => {
		expect(severityFor(new Set(["divergence"]))).toBe("watch");
		expect(severityFor(new Set(["divergence", "recovery"]))).toBe("alarm");
	});

	it("stays at alarm for three or more families", () => {
		expect(severityFor(new Set(["divergence", "recovery", "ledger"]))).toBe("alarm");
		expect(severityFor(new Set(SIGNAL_FAMILIES))).toBe("alarm");
	});
});

describe("audit-trail-box noisy-OR confidence", () => {
	it("is zero with no evidence", () => {
		expect(noisyOr([])).toBe(0);
	});

	it("passes a single family's probability straight through", () => {
		expect(noisyOr(["divergence"])).toBeCloseTo(FAMILY_CONFIDENCE.divergence, 10);
	});

	it("combines independent evidence rather than summing it", () => {
		const combined = noisyOr(["divergence", "recovery"]);
		const summed = FAMILY_CONFIDENCE.divergence + FAMILY_CONFIDENCE.recovery;
		expect(combined).toBeCloseTo(1 - 0.3 * 0.55, 10);
		expect(combined).toBeLessThan(summed);
	});

	it("never reaches certainty even with every family firing", () => {
		expect(noisyOr(SIGNAL_FAMILIES)).toBeLessThan(1);
		expect(noisyOr(SIGNAL_FAMILIES)).toBeGreaterThan(noisyOr(["divergence", "recovery"]));
	});
});

describe("audit-trail-box read/write ledger", () => {
	it("marks a first read fresh with no families firing", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		const record = state.record("/a.ts");
		expect(record?.status).toBe("fresh");
		expect(record?.reads).toBe(1);
		expect(record?.families.size).toBe(0);
		expect(record?.severity).toBe("none");
	});

	it("marks a re-read redundant and fires the implicit-miss recovery family", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteRead("/a.ts", { hash: "h1" });
		const record = state.record("/a.ts");
		expect(record?.status).toBe("redundant");
		expect(record?.redundantReads).toBe(1);
		expect([...(record?.families ?? [])]).toEqual(["recovery"]);
	});

	it("fires the ledger family once redundant reads clear the threshold", () => {
		const state = new AuditLedgerState();
		for (let i = 0; i <= REDUNDANT_READ_THRESHOLD; i++) state.noteRead("/a.ts", { hash: "h1" });
		const record = state.record("/a.ts");
		expect(record?.redundantReads).toBe(REDUNDANT_READ_THRESHOLD);
		expect(record?.families.has("ledger")).toBe(true);
		expect(record?.severity).toBe("alarm");
	});

	it("does not count a read that follows the agent's own write as redundant", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/a.ts", 0, { hash: "h1" });
		state.noteRead("/a.ts", { hash: "h1" });
		const record = state.record("/a.ts");
		expect(record?.status).toBe("fresh");
		expect(record?.redundantReads).toBe(0);
	});

	it("marks a written path dirty", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/a.ts", 0, { hash: "h1" });
		expect(state.record("/a.ts")?.status).toBe("dirty");
		expect(state.record("/a.ts")?.writes).toBe(1);
	});

	it("fires the ledger family on write amplification against one path", () => {
		const state = new AuditLedgerState();
		for (let i = 0; i < WRITE_AMPLIFICATION_THRESHOLD; i++) state.noteWrite("/a.ts", i * 10_000, { hash: `h${i}` });
		expect(state.record("/a.ts")?.families.has("ledger")).toBe(true);
	});

	it("counts a prefix invalidation for every rewrite of an already-touched path", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h0" });
		state.noteWrite("/a.ts", 0, { hash: "h1" });
		state.noteWrite("/a.ts", 10_000, { hash: "h2" });
		expect(state.record("/a.ts")?.prefixInvalidations).toBe(2);
		expect(state.snapshot().metrics.prefixInvalidations).toBe(2);
	});

	it("does not count a prefix invalidation for a path written before it was ever read", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/new.ts", 0, { hash: "h1" });
		expect(state.record("/new.ts")?.prefixInvalidations).toBe(0);
	});

	it("fires the cache family once one path's prefix invalidations clear the threshold", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h0" });
		for (let i = 0; i < CACHE_INVALIDATION_THRESHOLD; i++) state.noteWrite("/a.ts", i * 10_000, { hash: `h${i}` });
		expect(state.record("/a.ts")?.families.has("cache")).toBe(true);
	});

	it("derives the redundant-read ratio over the whole session", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteRead("/b.ts", { hash: "h2" });
		state.noteRead("/c.ts", { hash: "h3" });
		const metrics = state.snapshot().metrics;
		expect(metrics.reads).toBe(4);
		expect(metrics.redundantReads).toBe(1);
		expect(metrics.redundantReadRatio).toBeCloseTo(0.25, 10);
	});

	it("derives write amplification as writes over distinct written paths", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/a.ts", 0, { hash: "h1" });
		state.noteWrite("/a.ts", 10_000, { hash: "h2" });
		state.noteWrite("/a.ts", 20_000, { hash: "h3" });
		state.noteWrite("/b.ts", 30_000, { hash: "h4" });
		const metrics = state.snapshot().metrics;
		expect(metrics.writes).toBe(4);
		expect(metrics.distinctWrittenPaths).toBe(2);
		expect(metrics.writeAmplification).toBeCloseTo(2, 10);
	});

	it("reports zero ledger ratios on an untouched session", () => {
		const metrics = new AuditLedgerState().snapshot().metrics;
		expect(metrics.redundantReadRatio).toBe(0);
		expect(metrics.writeAmplification).toBe(0);
		expect(metrics.distinctPaths).toBe(0);
	});

	it("reports working-set bloat against the soft cap", () => {
		const state = new AuditLedgerState();
		for (let i = 0; i < WORKING_SET_SOFT_CAP / 2; i++) state.noteRead(`/f${i}.ts`, { hash: "h" });
		expect(state.snapshot().metrics.workingSetBloat).toBeCloseTo(0.5, 10);
	});

	it("caps the retained content snapshot so the tracker is not the memory problem", () => {
		const state = new AuditLedgerState();
		state.noteRead("/big.ts", { hash: "h1", content: "x".repeat(MAX_TRACKED_CONTENT_CHARS * 2) });
		expect(state.record("/big.ts")?.contextContent?.length).toBe(MAX_TRACKED_CONTENT_CHARS);
	});
});

describe("audit-trail-box disk-divergence probe", () => {
	it("leaves a path alone while the probe keeps seeing the accepted baseline", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteProbe([seen("/a.ts", "h1")], 5_000);
		state.noteProbe([seen("/a.ts", "h1")], 6_000);
		const record = state.record("/a.ts");
		expect(record?.status).toBe("fresh");
		expect(record?.divergenceStreak).toBe(0);
	});

	it("holds off on POISONED after a single divergent tick (2-tick hysteresis)", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteProbe([seen("/a.ts", "external")], 5_000);
		const record = state.record("/a.ts");
		expect(record?.divergenceStreak).toBe(1);
		expect(record?.status).toBe("fresh");
		expect(record?.families.has("divergence")).toBe(false);
	});

	it("flags POISONED on the second consecutive divergent tick", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		const record = state.record("/a.ts");
		expect(record?.divergenceStreak).toBe(POISON_STREAK_TICKS);
		expect(record?.status).toBe("poisoned");
		expect(record?.families.has("divergence")).toBe(true);
	});

	it("resets the streak when a tick sees the baseline again, so POISONED needs two in a row", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteProbe([seen("/a.ts", "external")], 5_000);
		state.noteProbe([seen("/a.ts", "h1")], 6_000);
		state.noteProbe([seen("/a.ts", "external")], 7_000);
		const record = state.record("/a.ts");
		expect(record?.divergenceStreak).toBe(1);
		expect(record?.status).toBe("fresh");
	});

	it("escalates a path that went unreachable through the same hysteresis", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteProbe([gone("/a.ts")], 5_000);
		expect(state.record("/a.ts")?.status).toBe("fresh");
		state.noteProbe([gone("/a.ts")], 6_000);
		const record = state.record("/a.ts");
		expect(record?.status).toBe("poisoned");
		expect(record?.reachable).toBe(false);
	});

	it("records what the probe last saw on disk alongside the agent's own copy", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1", content: "before" });
		state.noteProbe([seen("/a.ts", "h2", "after")], 5_000);
		const record = state.record("/a.ts");
		expect(record?.contextContent).toBe("before");
		expect(record?.contentNow).toBe("after");
		expect(record?.contextHash).toBe("h1");
		expect(record?.hashNow).toBe("h2");
	});

	it("ignores probe readings for paths it never tracked", () => {
		const state = new AuditLedgerState();
		state.noteProbe([seen("/untracked.ts", "h1")], 5_000);
		expect(state.size).toBe(0);
	});

	it("clears POISONED back to FRESH when the agent re-reads the path", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		expect(state.record("/a.ts")?.status).toBe("poisoned");
		state.noteRead("/a.ts", { hash: "external" });
		const record = state.record("/a.ts");
		expect(record?.status).toBe("fresh");
		expect(record?.divergenceStreak).toBe(0);
		expect(record?.families.has("divergence")).toBe(false);
	});
});

describe("audit-trail-box formatter-window exemption", () => {
	it("does NOT fire POISONED when the repo's own formatter rewrites a file the agent just wrote", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/src/a.ts", 0, { hash: "written", content: "const x=1" });
		// `bun run fix` lands ~1s later and rewrites the bytes — byte-identical in
		// shape to a hostile external edit, and it must not raise the alarm.
		state.noteProbe([seen("/src/a.ts", "formatted", "const x = 1;")], 1_000);
		state.noteProbe([seen("/src/a.ts", "formatted", "const x = 1;")], 2_500);
		state.noteProbe([seen("/src/a.ts", "formatted", "const x = 1;")], 30_000);

		const record = state.record("/src/a.ts");
		expect(record?.status).toBe("dirty");
		expect(record?.families.has("divergence")).toBe(false);
		expect(record?.severity).not.toBe("alarm");
		expect(record?.divergenceStreak).toBe(0);
		expect(record?.formatterAbsorbs).toBe(1);
	});

	it("keeps the agent's pre-format copy for the remedy diff while advancing the disk baseline", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/src/a.ts", 0, { hash: "written", content: "const x=1" });
		state.noteProbe([seen("/src/a.ts", "formatted", "const x = 1;")], 1_000);
		const record = state.record("/src/a.ts");
		expect(record?.contextContent).toBe("const x=1");
		expect(record?.contentNow).toBe("const x = 1;");
	});

	it("still flags POISONED for an external edit landing after the formatter window closes", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/src/a.ts", 0, { hash: "written" });
		poison(state, "/src/a.ts", FORMATTER_WINDOW_MS + 1_000, "hostile");
		expect(state.record("/src/a.ts")?.status).toBe("poisoned");
	});

	it("does not exempt a path the agent only read — the window is opened by a write", () => {
		const state = new AuditLedgerState();
		state.noteRead("/src/a.ts", { hash: "h1" });
		state.noteProbe([seen("/src/a.ts", "changed")], 100);
		state.noteProbe([seen("/src/a.ts", "changed")], 200);
		expect(state.record("/src/a.ts")?.status).toBe("poisoned");
		expect(state.record("/src/a.ts")?.formatterAbsorbs).toBe(0);
	});

	it("re-opens the window on each write, so a format-write-format loop never alarms", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/src/a.ts", 0, { hash: "w1" });
		state.noteProbe([seen("/src/a.ts", "f1")], 1_000);
		state.noteWrite("/src/a.ts", 20_000, { hash: "w2" });
		state.noteProbe([seen("/src/a.ts", "f2")], 21_000);
		const record = state.record("/src/a.ts");
		expect(record?.status).toBe("dirty");
		expect(record?.formatterAbsorbs).toBe(2);
	});
});

describe("audit-trail-box per-path cooldown", () => {
	it("opens a cooldown window when a path is flagged POISONED", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		expect(state.record("/a.ts")?.cooldownUntilMs).toBe(6_000 + PATH_COOLDOWN_MS);
	});

	it("does not re-escalate a path while it is inside its cooldown", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		const flaggedAt = state.record("/a.ts")?.cooldownUntilMs ?? 0;
		state.noteProbe([seen("/a.ts", "churn-1")], flaggedAt - 1_000);
		state.noteProbe([seen("/a.ts", "churn-2")], flaggedAt - 500);
		const record = state.record("/a.ts");
		expect(record?.divergenceStreak).toBe(POISON_STREAK_TICKS);
		expect(record?.cooldownUntilMs).toBe(flaggedAt);
	});

	it("still records what the probe sees during a cooldown", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		state.noteProbe([seen("/a.ts", "churn", "latest")], 10_000);
		expect(state.record("/a.ts")?.hashNow).toBe("churn");
		expect(state.record("/a.ts")?.contentNow).toBe("latest");
	});

	it("escalates again once the cooldown has expired", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		const expiry = state.record("/a.ts")?.cooldownUntilMs ?? 0;
		state.noteProbe([seen("/a.ts", "again")], expiry + 1_000);
		expect(state.record("/a.ts")?.divergenceStreak).toBe(POISON_STREAK_TICKS + 1);
	});

	it("clears the cooldown when the agent re-reads the path", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		state.noteRead("/a.ts", { hash: "external" });
		expect(state.record("/a.ts")?.cooldownUntilMs).toBe(0);
	});
});

describe("audit-trail-box recovery correlation", () => {
	it("lifts a lone divergence flag to alarm when a compact follows it", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		expect(state.record("/a.ts")?.severity).toBe("watch");

		state.noteRecovery(8_000);
		const record = state.record("/a.ts");
		expect(record?.families.has("recovery")).toBe(true);
		expect(record?.severity).toBe("alarm");
		expect(state.snapshot().metrics.recoveryCorrelations).toBe(1);
	});

	it("ignores a compact that lands long after the poison flag", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		state.noteRecovery(6_000 + RECOVERY_WINDOW_MS + 1);
		expect(state.record("/a.ts")?.families.has("recovery")).toBe(false);
		expect(state.snapshot().metrics.recoveryCorrelations).toBe(0);
	});

	it("does not correlate a compact with paths that were never poisoned", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteRecovery(1_000);
		expect(state.record("/a.ts")?.families.size).toBe(0);
	});

	it("counts each poisoned path's correlation only once", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		poison(state, "/a.ts", 5_000);
		state.noteRecovery(7_000);
		state.noteRecovery(8_000);
		expect(state.snapshot().metrics.recoveryCorrelations).toBe(1);
	});
});

describe("audit-trail-box session lifecycle", () => {
	it("marks a path cold once it goes untouched for the eviction horizon", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		for (let i = 0; i < COLD_AFTER_TURNS; i++) state.noteTurn();
		const record = state.record("/a.ts");
		expect(record?.status).toBe("cold");
		expect(record?.families.has("lifecycle")).toBe(true);
	});

	it("keeps a path warm right up to the eviction horizon", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		for (let i = 0; i < COLD_AFTER_TURNS - 1; i++) state.noteTurn();
		expect(state.record("/a.ts")?.status).toBe("fresh");
	});

	it("never sweeps an unresolved poisoned or dirty path to cold", () => {
		const state = new AuditLedgerState();
		state.noteRead("/poisoned.ts", { hash: "h1" });
		poison(state, "/poisoned.ts", 5_000);
		state.noteWrite("/dirty.ts", 5_000, { hash: "h2" });
		for (let i = 0; i < COLD_AFTER_TURNS * 2; i++) state.noteTurn();
		expect(state.record("/poisoned.ts")?.status).toBe("poisoned");
		expect(state.record("/dirty.ts")?.status).toBe("dirty");
	});

	it("re-warms a cold path when the agent touches it again", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		for (let i = 0; i < COLD_AFTER_TURNS; i++) state.noteTurn();
		state.noteRead("/a.ts", { hash: "h1" });
		expect(state.record("/a.ts")?.status).toBe("fresh");
	});

	it("drops the whole working set on a session switch", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteRead("/b.ts", { hash: "h2" });
		expect(state.noteSessionSwitch()).toBe(2);
		expect(state.size).toBe(0);
		expect(state.snapshot().paths).toHaveLength(0);
	});

	it("reports a teardown leak when a switch discards unresolved risk", () => {
		const state = new AuditLedgerState();
		state.noteWrite("/a.ts", 0, { hash: "h1" });
		state.noteSessionSwitch();
		expect(state.snapshot().metrics.teardownLeaks).toBe(1);
	});

	it("reports no teardown leak when every dropped path was already resolved", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		state.noteRead("/b.ts", { hash: "h2" });
		state.noteSessionSwitch();
		expect(state.snapshot().metrics.teardownLeaks).toBe(0);
	});

	it("fires the cache family on cold paths once the working set is over its soft cap", () => {
		const state = new AuditLedgerState();
		for (let i = 0; i <= WORKING_SET_SOFT_CAP; i++) state.noteRead(`/f${i}.ts`, { hash: "h" });
		for (let i = 0; i < COLD_AFTER_TURNS; i++) state.noteTurn();
		expect(state.record("/f0.ts")?.families.has("cache")).toBe(true);
		expect(state.record("/f0.ts")?.severity).toBe("alarm");
	});
});

describe("audit-trail-box snapshot", () => {
	it("counts every tracked path by status", () => {
		const state = new AuditLedgerState();
		state.noteRead("/fresh.ts", { hash: "h1" });
		state.noteRead("/redundant.ts", { hash: "h2" });
		state.noteRead("/redundant.ts", { hash: "h2" });
		state.noteWrite("/dirty.ts", 0, { hash: "h3" });
		state.noteRead("/poisoned.ts", { hash: "h4" });
		poison(state, "/poisoned.ts", 50_000);

		const counts = state.snapshot().counts;
		expect(counts).toEqual({ poisoned: 1, dirty: 1, redundant: 1, cold: 0, fresh: 1 });
	});

	it("sorts paths by risk band, highest first", () => {
		const state = new AuditLedgerState();
		state.noteRead("/fresh.ts", { hash: "h1" });
		state.noteRead("/redundant.ts", { hash: "h2" });
		state.noteRead("/redundant.ts", { hash: "h2" });
		state.noteWrite("/dirty.ts", 0, { hash: "h3" });
		state.noteRead("/poisoned.ts", { hash: "h4" });
		poison(state, "/poisoned.ts", 50_000);

		expect(state.snapshot().paths.map(p => p.status)).toEqual(["poisoned", "dirty", "redundant", "fresh"]);
	});

	it("breaks ties inside a risk band by confidence then path", () => {
		const noisy = fakeRecord({ path: "/z.ts", confidence: 0.9 });
		const quiet = fakeRecord({ path: "/a.ts", confidence: 0.1 });
		const twin = fakeRecord({ path: "/b.ts", confidence: 0.1 });
		expect(comparePathRecords(noisy, quiet)).toBeLessThan(0);
		expect(comparePathRecords(quiet, twin)).toBeLessThan(0);
	});

	it("orders the risk bands the panel renders in", () => {
		expect(STATUS_RISK_ORDER).toEqual(["poisoned", "dirty", "redundant", "cold", "fresh"]);
	});

	it("advances the turn counter it stamps records with", () => {
		const state = new AuditLedgerState();
		state.noteTurn();
		state.noteTurn();
		state.noteRead("/a.ts", { hash: "h1" });
		expect(state.snapshot().turn).toBe(2);
		expect(state.record("/a.ts")?.lastTouchTurn).toBe(2);
	});

	it("hands out frozen copies so a later mutation cannot leak into an old snapshot", () => {
		const state = new AuditLedgerState();
		state.noteRead("/a.ts", { hash: "h1" });
		const before = state.snapshot();
		state.noteRead("/a.ts", { hash: "h1" });
		expect(before.paths[0]?.status).toBe("fresh");
		expect(state.record("/a.ts")?.status).toBe("redundant");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Service: the ledger's only owner — probe scheduling, divergence, remedy.
// ═══════════════════════════════════════════════════════════════════════════

/** Manual clock: the service reads `now()` and never starts a tick of its own. */
function manualClock(): FrameScheduler & { set(ms: number): void } {
	let current = 0;
	return {
		now: () => current,
		start: () => () => {},
		set(ms) {
			current = ms;
		},
	};
}

/** In-memory disk. A path absent from the map is unreachable (deleted / EPERM). */
function fakeDisk(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const inspected: string[] = [];
	const source: ProbeSource = {
		async inspect(path: string): Promise<ProbeObservation | undefined> {
			inspected.push(path);
			const content = files.get(path);
			if (content === undefined) return undefined;
			return { hash: hashContent(content), content };
		},
	};
	return {
		source,
		inspected,
		write(path: string, content: string) {
			files.set(path, content);
		},
		remove(path: string) {
			files.delete(path);
		},
	};
}

/** Content plus the hash the agent would have taken when it saw that content. */
function held(content: string) {
	return { hash: hashContent(content), content };
}

describe("audit-trail-box service — probe scheduling", () => {
	it("kicks an off-path probe from a tracked event", async () => {
		const disk = fakeDisk({ "a.ts": "v1", "b.ts": "v1" });
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });

		service.noteRead("a.ts", held("v1"));
		await service.settled();
		expect(disk.inspected).toEqual(["a.ts"]);
	});

	it("rate-limits ticks, then allows one once the interval has passed", async () => {
		const scheduler = manualClock();
		const disk = fakeDisk({ "a.ts": "v1" });
		const service = new AuditTrailService({ scheduler, probeSource: disk.source });

		service.noteRead("a.ts", held("v1"));
		await service.settled();
		service.noteRead("a.ts", held("v1"));
		service.noteTurn();
		await service.settled();
		expect(disk.inspected).toHaveLength(1);

		scheduler.set(PROBE_INTERVAL_MS);
		service.noteTurn();
		await service.settled();
		expect(disk.inspected).toHaveLength(2);
	});

	it("walks the working set round-robin instead of re-hashing everything each tick", async () => {
		const disk = fakeDisk({ "a.ts": "v", "b.ts": "v", "c.ts": "v" });
		const service = new AuditTrailService({
			scheduler: manualClock(),
			probeSource: disk.source,
			probeBatchSize: 1,
		});

		service.noteRead("a.ts", held("v"));
		service.noteRead("b.ts", held("v"));
		service.noteRead("c.ts", held("v"));
		await service.settled();
		disk.inspected.length = 0;

		await service.probeNow();
		expect(disk.inspected).toHaveLength(1);
		await service.probeNow();
		await service.probeNow();
		expect([...disk.inspected].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("skips a tick with nothing tracked", async () => {
		const disk = fakeDisk();
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });
		await service.probeNow();
		expect(disk.inspected).toHaveLength(0);
	});

	it("never overlaps two ticks", async () => {
		let release: (() => void) | undefined;
		const inspected: string[] = [];
		const source: ProbeSource = {
			async inspect(path) {
				inspected.push(path);
				await new Promise<void>(resolve => {
					release = resolve;
				});
				return { hash: hashContent("v"), content: "v" };
			},
		};
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: source, probeBatchSize: 1 });

		// The read kicks a tick that parks inside `inspect`; every call while it is
		// parked must return without touching the disk a second time.
		service.noteRead("a.ts", held("v"));
		await service.probeNow();
		await service.probeNow();
		expect(inspected).toEqual(["a.ts"]);

		release?.();
		await service.settled();
		expect(inspected).toEqual(["a.ts"]);
	});

	it("survives a probe source that throws on the fire-and-forget path", async () => {
		const source: ProbeSource = {
			inspect() {
				throw new Error("EPERM from a hostile filesystem");
			},
		};
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: source });

		service.noteRead("a.ts", held("v"));
		await service.settled();
		expect(service.state.record("a.ts")?.status).toBe("fresh");
	});
});

describe("audit-trail-box service — divergence against a real disk", () => {
	it("needs two consecutive probe ticks before POISONED sticks", async () => {
		const disk = fakeDisk({ "a.ts": "line1\nline2" });
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });

		service.noteRead("a.ts", held("line1\nline2"));
		await service.settled();
		disk.write("a.ts", "line1\nCHANGED");

		await service.probeNow();
		expect(service.state.record("a.ts")?.status).not.toBe("poisoned");
		expect(service.state.record("a.ts")?.divergenceStreak).toBe(1);

		await service.probeNow();
		expect(service.state.record("a.ts")?.status).toBe("poisoned");
		expect(service.state.record("a.ts")?.divergenceStreak).toBe(POISON_STREAK_TICKS);
	});

	it("treats a path that vanished from disk as unreachable, then poisoned", async () => {
		const disk = fakeDisk({ "a.ts": "v1" });
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });

		service.noteRead("a.ts", held("v1"));
		await service.settled();
		disk.remove("a.ts");
		await service.probeNow();
		await service.probeNow();

		const record = service.state.record("a.ts");
		expect(record?.reachable).toBe(false);
		expect(record?.status).toBe("poisoned");
	});

	it("does NOT fire POISONED when the repo's own formatter rewrites a file the agent just wrote", async () => {
		const scheduler = manualClock();
		const disk = fakeDisk({ "a.ts": "const x=1\n" });
		const service = new AuditTrailService({ scheduler, probeSource: disk.source });

		service.noteWrite("a.ts", held("const x=1\n"));
		await service.settled();

		// `bun run fix` lands: same file, different bytes, no human involved.
		disk.write("a.ts", "const x = 1;\n");
		scheduler.set(FORMATTER_WINDOW_MS / 4);
		await service.probeNow();
		scheduler.set(FORMATTER_WINDOW_MS / 2);
		await service.probeNow();

		const record = service.state.record("a.ts");
		expect(record?.status).toBe("dirty");
		expect(record?.formatterAbsorbs).toBe(1);
		expect(record?.divergenceStreak).toBe(0);
	});

	it("still fires POISONED for an external edit that lands after the formatter window closes", async () => {
		const scheduler = manualClock();
		const disk = fakeDisk({ "a.ts": "written\n" });
		const service = new AuditTrailService({ scheduler, probeSource: disk.source });

		service.noteWrite("a.ts", held("written\n"));
		await service.settled();

		scheduler.set(FORMATTER_WINDOW_MS + 1_000);
		disk.write("a.ts", "somebody else was here\n");
		await service.probeNow();
		await service.probeNow();

		expect(service.state.record("a.ts")?.status).toBe("poisoned");
	});
});

describe("audit-trail-box service — remedy", () => {
	it("diffs the held copy against disk BEFORE the stale copy is discarded", async () => {
		const disk = fakeDisk({ "a.ts": "alpha\nbeta\n" });
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });

		service.noteRead("a.ts", held("alpha\nbeta\n"));
		await service.settled();
		disk.write("a.ts", "alpha\nGAMMA\n");
		await service.probeNow();
		await service.probeNow();

		const plan = await service.remedy();
		expect(plan.mustReread.map(entry => entry.path)).toEqual(["a.ts"]);
		expect(plan.mustReread[0]?.status).toBe("poisoned");
		expect(plan.mustReread[0]?.diff).toEqual(["-beta", "+GAMMA"]);
		// The held copy is still held — the remedy describes it, it does not drop it.
		expect(service.state.record("a.ts")?.contextContent).toBe("alpha\nbeta\n");
	});

	it("re-reads every stale path, not just the round-robin slice the next tick would cover", async () => {
		const disk = fakeDisk({ "a.ts": "v", "b.ts": "v", "c.ts": "v" });
		const service = new AuditTrailService({
			scheduler: manualClock(),
			probeSource: disk.source,
			probeBatchSize: 1,
		});

		service.noteWrite("a.ts", held("v"));
		service.noteWrite("b.ts", held("v"));
		service.noteWrite("c.ts", held("v"));
		await service.settled();
		disk.inspected.length = 0;

		await service.remedy();
		expect([...disk.inspected].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("picks up content that moved between the last tick and the command", async () => {
		const disk = fakeDisk({ "a.ts": "one\n" });
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });

		service.noteWrite("a.ts", held("one\n"));
		await service.settled();
		disk.write("a.ts", "two\n");

		const plan = await service.remedy();
		expect(plan.mustReread[0]?.diff).toEqual(["-one", "+two"]);
	});

	it("splits cold paths into the safe-to-drop list", async () => {
		const disk = fakeDisk({ "cold.ts": "v", "hot.ts": "v" });
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: disk.source });

		service.noteRead("cold.ts", held("v"));
		for (let turn = 0; turn < COLD_AFTER_TURNS; turn++) service.noteTurn();
		service.noteWrite("hot.ts", held("v"));
		await service.settled();

		const plan = await service.remedy();
		expect(plan.safeToDrop.map(entry => entry.path)).toEqual(["cold.ts"]);
		expect(plan.mustReread.map(entry => entry.path)).toEqual(["hot.ts"]);
	});

	it("reports an empty plan when nothing is tracked", async () => {
		const service = new AuditTrailService({ scheduler: manualClock(), probeSource: fakeDisk().source });
		expect(await service.remedy()).toEqual({
			turn: 0,
			mustReread: [],
			mustRereadOverflow: 0,
			safeToDrop: [],
			safeToDropOverflow: 0,
		});
	});
});
