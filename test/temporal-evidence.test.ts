import { describe, expect, it } from "bun:test";
import {
	DEFAULT_TEMPORAL_EVIDENCE_POLICY,
	TEMPORAL_EVIDENCE_KINDS,
	type TemporalEvidenceKind,
	type TemporalEvidenceKindPolicy,
	type TemporalEvidencePolicy,
	TemporalEvidenceStore,
} from "../src/animations-box/temporal-evidence";

function policy(
	globalCapacity = 8,
	kindCapacity = 4,
	ttl: Omit<TemporalEvidenceKindPolicy, "capacity"> = {
		freshForMs: 10,
		recentForMs: 20,
		residualForMs: 30,
	},
): TemporalEvidencePolicy {
	const kinds = {} as Record<TemporalEvidenceKind, TemporalEvidenceKindPolicy>;
	for (const kind of TEMPORAL_EVIDENCE_KINDS) kinds[kind] = { capacity: kindCapacity, ...ttl };
	return { globalCapacity, kinds };
}

function numeric(slot: number, observedAt: number, value = slot) {
	return { kind: "numeric-history" as const, slot, observedAt, payload: { value, series: "count" as const } };
}

describe("TemporalEvidenceStore", () => {
	it("enforces per-kind and global capacity with deterministic oldest-first eviction", () => {
		const perKind = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: policy(8, 2) });
		perKind.observe(numeric(0, 0));
		perKind.observe(numeric(1, 1));
		perKind.observe(numeric(2, 2));
		expect(perKind.snapshot(2).entries.map(entry => entry.slot)).toEqual([1, 2]);

		const global = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: policy(2, 2) });
		global.observe(numeric(0, 0));
		global.observe({
			kind: "memory-observation",
			slot: 0,
			observedAt: 1,
			payload: { status: "available", tier: "local" },
		});
		global.observe({
			kind: "retry-schedule",
			slot: 0,
			observedAt: 2,
			payload: { attempt: 1, delayMs: 2 },
		});
		expect(global.snapshot(2).entries.map(entry => entry.kind)).toEqual(["memory-observation", "retry-schedule"]);
	});

	it("coalesces a kind/slot and never extends expiry from an old observation", () => {
		const store = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: policy() });
		expect(store.observe(numeric(7, 100, 1))).toBeTrue();
		expect(store.observe(numeric(7, 110, 2))).toBeTrue();
		expect(store.observe(numeric(7, 105, 99))).toBeFalse();
		const snapshot = store.snapshot(110);
		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0]).toMatchObject({ observedAt: 110, expiresAt: 170, payload: { value: 2 } });
	});

	it("changes semantic stage exactly at TTL boundaries and reuses unchanged immutable snapshots", () => {
		const store = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: policy() });
		store.observe(numeric(0, 0));
		const fresh = store.snapshot(0);
		expect(fresh.entries[0].stage).toBe("fresh");
		expect(store.snapshot(9)).toBe(fresh);
		const recent = store.snapshot(10);
		expect(recent.entries[0].stage).toBe("recent");
		expect(store.snapshot(29)).toBe(recent);
		const residual = store.snapshot(30);
		expect(residual.entries[0].stage).toBe("residual");
		expect(store.snapshot(59)).toBe(residual);
		expect(store.snapshot(60).entries).toEqual([]);
		expect(Object.isFrozen(fresh)).toBeTrue();
		expect(Object.isFrozen(fresh.entries)).toBeTrue();
		expect(Object.isFrozen(fresh.entries[0])).toBeTrue();
		expect(Object.isFrozen(fresh.entries[0].payload)).toBeTrue();
	});

	it("survives a backward wall-clock step by rebasing entry ages instead of throwing", () => {
		const store = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: policy() });
		store.observe(numeric(0, 1_000));
		expect(store.snapshot(1_005).entries[0]).toMatchObject({ stage: "fresh", observedAt: 1_000 });

		// NTP correction / sleep-wake: Date.now() steps back 500ms. The entry was
		// 5ms old and must stay 5ms old — not become 495ms in the future.
		const rebased = store.snapshot(505);
		expect(rebased.entries[0]).toMatchObject({ stage: "fresh", observedAt: 500, expiresAt: 560 });
		expect(store.snapshot(509).entries[0].stage).toBe("fresh");
		expect(store.snapshot(510).entries[0].stage).toBe("recent");

		// A fresh observation on the post-step clock is newer than the rebased entry, so it coalesces.
		expect(store.observe(numeric(0, 520, 7))).toBeTrue();
		expect(store.snapshot(520).entries[0]).toMatchObject({ observedAt: 520, payload: { value: 7 } });

		expect(() => store.snapshot(Number.NaN)).toThrow(RangeError);
		expect(() => store.snapshot(-1)).toThrow(RangeError);
	});

	it("switches root/session atomically without exposing either key", () => {
		const store = new TemporalEvidenceStore({ scope: { root: 41, session: 8 }, policy: policy() });
		store.observe(numeric(0, 0));
		const first = store.snapshot(0);
		expect(store.switchScope({ root: 42, session: 0 })).toBeTrue();
		const second = store.snapshot(0);
		expect(second.entries).toEqual([]);
		expect(second.scopeVersion).toBe(first.scopeVersion + 1);
		expect(JSON.stringify(second)).not.toContain("41");
		expect(JSON.stringify(second)).not.toContain("42");
		expect(store.switchScope({ root: 42, session: 0 })).toBeFalse();
	});

	it("reconstructs exact allowlisted payloads before retention", () => {
		const store = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: policy() });
		const hostile = {
			kind: "memory-observation",
			slot: 0,
			observedAt: 0,
			payload: {
				status: "available",
				tier: "local",
				content: "PRIVATE_CONTENT_SENTINEL",
				path: "/PRIVATE/PATH/SENTINEL",
				query: "PRIVATE_QUERY_SENTINEL",
			},
		} as const;
		expect(store.observe(hostile)).toBeTrue();
		expect(store.snapshot(0).entries[0]?.payload).toEqual({ status: "available", tier: "local" });
		expect(JSON.stringify(store.snapshot(0))).not.toContain("PRIVATE_");
		expect(() =>
			store.observe({
				kind: "progress-observation",
				slot: 1,
				observedAt: 1,
				payload: { completed: 2, total: 1 },
			}),
		).toThrow(TypeError);
	});

	it("disposes idempotently and rejects later mutation", () => {
		const store = new TemporalEvidenceStore({
			scope: { root: 0, session: 0 },
			policy: DEFAULT_TEMPORAL_EVIDENCE_POLICY,
		});
		store.observe(numeric(0, 0));
		store.dispose();
		const disposed = store.snapshot(0);
		store.dispose();
		expect(store.snapshot(100)).toBe(disposed);
		expect(disposed).toMatchObject({ disposed: true, entries: [], counters: { total: 0 } });
		expect(store.observe(numeric(1, 1))).toBeFalse();
		expect(store.switchScope({ root: 1, session: 0 })).toBeFalse();
	});
});
