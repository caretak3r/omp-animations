import { describe, expect, it } from "bun:test";
import {
	createMemoryTideState,
	MAX_MEMORY_COUNT,
	MEMORY_OBSERVATION_STALE_MS,
	MEMORY_TIDE_MAX_ROWS,
	MEMORY_TIDE_MAX_WIDTH,
	type MemoryTideState,
	memoryObservationFreshness,
	memoryTideRowText,
	normalizeMemoryBackendStatus,
	reduceMemoryTide,
	renderMemoryTide,
} from "../src/signal-extras/memory-tide";

const PRIVATE = "PRIVATE_SENTINEL_7f31";

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		backend: "mnemopi",
		active: true,
		writable: true,
		searchable: true,
		scope: "per-project",
		workingCount: 10,
		episodicCount: 3,
		tripleCount: 20,
		lastRecall: false,
		...overrides,
	};
}

function success(
	state: MemoryTideState,
	sequence: number,
	observedAt: number,
	overrides: Record<string, unknown> = {},
	extra: { rootChanged?: boolean; wallTimeMs?: number } = {},
): MemoryTideState {
	return reduceMemoryTide(state, {
		kind: "success",
		sequence,
		observedAt,
		status: status(overrides),
		...extra,
	});
}

function renderText(state: MemoryTideState, overrides: Partial<Parameters<typeof renderMemoryTide>[1]> = {}): string {
	return renderMemoryTide(state, {
		now: state.lastGood?.observedAt ?? 0,
		width: 160,
		height: 3,
		mode: "detailed",
		...overrides,
	})
		.map(memoryTideRowText)
		.join("\n");
}

describe("memory tide strict adapter", () => {
	it("normalizes only allowlisted host fields and converts timestamps to safe ages", () => {
		const adapted = normalizeMemoryBackendStatus(
			status({
				lastMemory: "2026-08-28T12:00:00.000Z",
				lastRecall: "2026-08-28T11:59:55Z",
				error: `E_DB_BUSY: ${PRIVATE}`,
				database: `/Users/${PRIVATE}/memory.sqlite`,
				retainBank: PRIVATE,
				recallBanks: [PRIVATE],
				message: PRIVATE,
				content: PRIVATE,
			}),
			{ observedAt: 50_000, wallTimeMs: Date.parse("2026-08-28T12:00:10.000Z") },
		);

		expect(adapted).toEqual({
			backend: "mnemopi",
			active: true,
			writable: true,
			searchable: true,
			scope: "per-project",
			workingCount: 10,
			episodicCount: 3,
			tripleCount: 20,
			lastMemoryAgeMs: 10_000,
			lastRecall: "reported",
			lastRecallAgeMs: 15_000,
			error: "E_DB_BUSY",
		});
		expect(JSON.stringify(adapted)).not.toContain(PRIVATE);
	});

	it("preserves unknown separately from false and rejects malformed counts, scope, backend, and timestamps", () => {
		const adapted = normalizeMemoryBackendStatus(
			{
				backend: "mnemopi",
				active: "false",
				writable: false,
				searchable: undefined,
				scope: PRIVATE,
				workingCount: -1,
				episodicCount: Number.POSITIVE_INFINITY,
				tripleCount: 1.5,
				lastMemory: PRIVATE,
				lastRecall: { message: PRIVATE },
				error: PRIVATE,
			},
			{ observedAt: 1, wallTimeMs: 1 },
		);

		expect(adapted).toMatchObject({
			active: undefined,
			writable: false,
			searchable: undefined,
			scope: undefined,
			workingCount: undefined,
			episodicCount: undefined,
			tripleCount: undefined,
			lastMemoryAgeMs: undefined,
			lastRecall: undefined,
			lastRecallAgeMs: undefined,
			error: undefined,
		});
		expect(normalizeMemoryBackendStatus({ backend: PRIVATE }, { observedAt: 1 })).toBeUndefined();
	});

	it("clamps otherwise valid counts to a fixed safe bound", () => {
		const adapted = normalizeMemoryBackendStatus(
			status({ workingCount: Number.MAX_SAFE_INTEGER, episodicCount: 0, tripleCount: 1 }),
			{ observedAt: 1 },
		);
		expect(adapted?.workingCount).toBe(MAX_MEMORY_COUNT);
		expect(adapted?.episodicCount).toBe(0);
	});
});

describe("memory tide reducer", () => {
	it("keeps disabled and unsupported initial states dormant", () => {
		const disabled = success(createMemoryTideState(), 1, 1_000, {
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
		});
		const unsupported = reduceMemoryTide(createMemoryTideState(), {
			kind: "success",
			sequence: 1,
			observedAt: 1_000,
			status: { backend: PRIVATE },
		});

		expect(renderMemoryTide(disabled, { now: 1_000, width: 80, height: 3, mode: "detailed" })).toEqual([]);
		expect(unsupported.pollFailure?.error).toBe("STATUS_UNAVAILABLE");
		expect(renderMemoryTide(unsupported, { now: 1_000, width: 80, height: 3, mode: "detailed" })).toEqual([]);
	});

	it("represents unavailable, read-only, unsearchable, writable, and searchable facts exactly", () => {
		const unavailable = success(createMemoryTideState(), 1, 1_000, {
			active: false,
			writable: false,
			searchable: false,
		});
		expect(renderText(unavailable)).toContain("active:no writable:no searchable:no");
		expect(renderText(unavailable)).toContain("status:unavailable");

		const readOnly = success(createMemoryTideState(), 1, 1_000, { writable: false, searchable: true });
		expect(renderText(readOnly)).toContain("writable:no searchable:yes");

		const unsearchable = success(createMemoryTideState(), 1, 1_000, { writable: true, searchable: false });
		expect(renderText(unsearchable)).toContain("writable:yes searchable:no");
	});

	it("labels adjacent same-lineage increases as observed deltas", () => {
		let state = success(createMemoryTideState(), 1, 1_000);
		state = success(state, 2, 2_000, { workingCount: 13, episodicCount: 4, tripleCount: 20 });

		expect(state.lastGood?.working.change).toEqual({ kind: "observed delta", amount: 3 });
		expect(state.lastGood?.episodic.change).toEqual({ kind: "observed delta", amount: 1 });
		expect(state.lastGood?.triples.change).toEqual({ kind: "none" });
		const text = renderText(state, { stage: "fresh" });
		expect(text).toContain("work +3 observed");
		expect(text).toContain("episodic +1 observed");
		expect(text).not.toMatch(/\bwrite(?:s|n)?\b/i);
	});

	it("labels decreases, backend switches, scope switches, and caller-reported root changes as rebases", () => {
		const baseline = success(createMemoryTideState(), 1, 1_000);
		const decreased = success(baseline, 2, 2_000, { workingCount: 2 });
		expect(decreased.lastGood?.working.change.kind).toBe("reset/rebase");

		const backendSwitch = success(baseline, 2, 2_000, { backend: "local", workingCount: 10 });
		expect(backendSwitch.lastGood?.transition).toBe("reset/rebase");
		expect(backendSwitch.lastGood?.working.change.kind).toBe("reset/rebase");

		const scopeSwitch = success(baseline, 2, 2_000, { scope: "global" });
		expect(scopeSwitch.lastGood?.transition).toBe("reset/rebase");

		const rootSwitch = success(baseline, 2, 2_000, {}, { rootChanged: true });
		expect(rootSwitch.lastGood?.transition).toBe("reset/rebase");
		expect(renderText(rootSwitch)).toContain("reset/rebase");
	});

	it("retains and ages the last good observation across poll failures, then recovers", () => {
		const good = success(createMemoryTideState(), 1, 1_000);
		const failed = reduceMemoryTide(good, {
			kind: "failure",
			sequence: 2,
			observedAt: 5_000,
			error: { code: "ETIMEDOUT", message: PRIVATE },
		});
		expect(failed.lastGood).toBe(good.lastGood);
		expect(failed.pollFailure).toEqual({ failedAt: 5_000, error: "ETIMEDOUT", consecutiveFailures: 1 });
		expect(renderText(failed, { now: 9_000 })).toContain("obs:error:ETIMEDOUT last-good:8s");

		const recovered = success(failed, 3, 10_000, { workingCount: 12 });
		expect(recovered.pollFailure).toBeUndefined();
		expect(recovered.lastGood?.working.change).toEqual({ kind: "observed delta", amount: 2 });
		expect(renderText(recovered)).toContain("obs:fresh");
	});

	it("keeps an initial poll failure dormant and sanitizes arbitrary errors", () => {
		const state = reduceMemoryTide(createMemoryTideState(), {
			kind: "failure",
			sequence: 1,
			observedAt: 1_000,
			error: new Error(PRIVATE),
		});
		expect(state.pollFailure?.error).toBe("unknown");
		expect(state.lastGood).toBeUndefined();
		expect(renderMemoryTide(state, { now: 2_000, width: 80, height: 3, mode: "compact" })).toEqual([]);
		expect(JSON.stringify(state)).not.toContain(PRIVATE);
	});

	it("ignores late overlapping observations and compares the next result to the latest successful one", () => {
		let state = success(createMemoryTideState(), 1, 1_000, { workingCount: 10 });
		state = success(state, 3, 3_000, { workingCount: 15 });
		const late = success(state, 2, 2_000, { workingCount: 999 });
		expect(late).toBe(state);

		const next = success(late, 4, 4_000, { workingCount: 16 });
		expect(next.lastGood?.working.change).toEqual({ kind: "observed delta", amount: 1 });
	});

	it("does not refresh a sticky recall boolean on every observation or claim retrieval success", () => {
		let state = success(createMemoryTideState(), 1, 1_000, { lastRecall: false });
		state = success(state, 2, 2_000, { lastRecall: true });
		state = success(state, 3, 8_000, { lastRecall: true });
		const text = renderText(state, { now: 12_000 });

		expect(state.lastGood?.recallReportedAt).toBe(2_000);
		expect(text).toContain("recall:reported:10s-ago");
		expect(text).not.toMatch(/success|retriev/i);
	});
});

describe("memory tide semantic renderer", () => {
	it("uses literal backend readiness language in compact mode", () => {
		const ready = success(createMemoryTideState(), 1, 1_000);
		const readOnly = success(createMemoryTideState(), 1, 1_000, { writable: false });
		const failed = reduceMemoryTide(ready, {
			kind: "failure",
			sequence: 2,
			observedAt: 2_000,
			error: "ETIMEDOUT",
		});

		expect(renderText(ready, { mode: "compact" })).toBe("MEM ready");
		expect(renderText(readOnly, { mode: "compact" })).toBe("MEM read only");
		expect(renderText(failed, { mode: "compact", now: 2_000 })).toBe("MEM check failed ETIMEDOUT");
	});

	it("marks stale observations independently from backend health", () => {
		const state = success(createMemoryTideState(), 1, 1_000, { error: "SQLITE_BUSY: ignored details" });
		const now = 1_000 + MEMORY_OBSERVATION_STALE_MS + 1;
		expect(memoryObservationFreshness(state, now)).toBe("stale");
		const text = renderText(state, { now });
		expect(text).toContain("status:error:SQLITE_BUSY");
		expect(text).toContain("obs:stale:30s");
	});

	it("keeps detailed, human-readable compact, reduced, ASCII, and no-color semantics explicit", () => {
		let state = success(createMemoryTideState(), 1, 1_000);
		state = success(state, 2, 2_000, { workingCount: 11, lastRecall: true });
		const detailed = renderText(state, { mode: "detailed", stage: "fresh", symbols: "unicode" });
		const compact = renderText(state, { mode: "compact", stage: "recent", symbols: "ascii" });
		const reduced = renderText(state, { mode: "reduced", stage: "fresh", symbols: "unicode" });

		expect(detailed).toContain("▓");
		expect(detailed).toContain("+1 observed");
		expect(compact).toBe("MEM ready");
		expect(compact).not.toMatch(/A:[?YN]|W:[?YN]|S:[?YN]/);
		expect(reduced).not.toMatch(/[▓▒░]/);
		expect(reduced).toContain("+1 observed");
	});

	it("obeys fixed row and width bounds and returns zero rows at zero height", () => {
		let state = success(createMemoryTideState(), 1, 1_000);
		state = success(state, 2, 2_000, { workingCount: MAX_MEMORY_COUNT, episodicCount: 99, tripleCount: 999 });
		const rows = renderMemoryTide(state, {
			now: 2_000,
			width: 12,
			height: 99,
			mode: "compact",
			stage: "residual",
		});
		expect(rows.length).toBeLessThanOrEqual(MEMORY_TIDE_MAX_ROWS);
		for (const row of rows) expect(memoryTideRowText(row).length).toBeLessThanOrEqual(12);

		const wide = renderMemoryTide(state, {
			now: 2_000,
			width: MEMORY_TIDE_MAX_WIDTH + 100,
			height: 3,
			mode: "compact",
		});
		for (const row of wide) expect(memoryTideRowText(row).length).toBeLessThanOrEqual(MEMORY_TIDE_MAX_WIDTH);
		expect(renderMemoryTide(state, { now: 2_000, width: 80, height: 0, mode: "detailed" })).toEqual([]);
	});

	it("never carries private status fields into reducer state or rendered tokens", () => {
		const state = success(createMemoryTideState(), 1, 1_000, {
			database: `/tmp/${PRIVATE}.sqlite`,
			retainBank: PRIVATE,
			recallBanks: [PRIVATE],
			message: PRIVATE,
			error: `Database exploded at /tmp/${PRIVATE}.sqlite`,
			content: PRIVATE,
			query: PRIVATE,
			toolArgs: { path: PRIVATE },
			output: PRIVATE,
		});
		const serialized = JSON.stringify(state);
		const rendered = renderText(state);
		expect(serialized).not.toContain(PRIVATE);
		expect(rendered).not.toContain(PRIVATE);
		expect(serialized).not.toContain("database");
		expect(serialized).not.toContain("retainBank");
		expect(rendered).not.toContain("Database exploded");
	});
});
