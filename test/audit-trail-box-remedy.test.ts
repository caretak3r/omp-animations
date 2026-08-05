import { describe, expect, it } from "bun:test";
import {
	buildRemedyPlan,
	DEFAULT_MAX_REMEDY_ENTRIES,
	diffContent,
	formatRemedyPlan,
	MAX_DIFF_INPUT_LINES,
	MAX_DIFF_LINES,
	remedyReason,
} from "../src/audit-trail-box/remedy";
import {
	AuditLedgerState,
	COLD_AFTER_TURNS,
	FORMATTER_WINDOW_MS,
	POISON_STREAK_TICKS,
	type ProbeReading,
} from "../src/audit-trail-box/state";

function seen(path: string, hash: string, content?: string): ProbeReading {
	return { path, hash, content, reachable: true };
}

function gone(path: string): ProbeReading {
	return { path, hash: undefined, reachable: false };
}

/** Drive `state` past hysteresis for `path`, well clear of any formatter window. */
function poison(state: AuditLedgerState, path: string, startMs: number, hash: string, content?: string): void {
	for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) {
		state.noteProbe([seen(path, hash, content)], startMs + tick * 1000);
	}
}

describe("audit-trail-box content diff", () => {
	it("returns nothing when the held copy still matches disk", () => {
		expect(diffContent("alpha\nbeta\n", "alpha\nbeta\n")).toEqual([]);
	});

	it("returns nothing when neither side captured content", () => {
		expect(diffContent(undefined, undefined)).toEqual([]);
	});

	it("emits only the changed lines, held copy first", () => {
		expect(diffContent("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n")).toEqual(["-beta", "+BETA"]);
	});

	it("reports a pure insertion as additions alone", () => {
		expect(diffContent("alpha\ngamma\n", "alpha\nbeta\ngamma\n")).toEqual(["+beta"]);
	});

	it("reports a pure deletion as removals alone", () => {
		expect(diffContent("alpha\nbeta\ngamma\n", "alpha\ngamma\n")).toEqual(["-beta"]);
	});

	it("treats a missing held copy as everything on disk being new", () => {
		expect(diffContent(undefined, "alpha\nbeta\n")).toEqual(["+alpha", "+beta"]);
	});

	it("treats a vanished file as the whole held copy being removed", () => {
		expect(diffContent("alpha\nbeta\n", undefined)).toEqual(["-alpha", "-beta"]);
	});

	it("ignores a single trailing newline rather than reporting a phantom empty line", () => {
		expect(diffContent("alpha\nbeta", "alpha\nbeta\n")).toEqual([]);
	});

	it("caps the emitted lines and states how many were hidden", () => {
		const before = Array.from({ length: 20 }, (_, index) => `old-${index}`).join("\n");
		const after = Array.from({ length: 20 }, (_, index) => `new-${index}`).join("\n");

		const diff = diffContent(before, after);

		expect(diff).toHaveLength(MAX_DIFF_LINES + 1);
		expect(diff.at(-1)).toBe(`⋯ +${40 - MAX_DIFF_LINES} more changed lines`);
	});

	it("honors a caller-supplied line cap", () => {
		const diff = diffContent("a\nb\nc\n", "A\nB\nC\n", 2);

		expect(diff).toHaveLength(3);
		expect(diff.at(-1)).toBe("⋯ +4 more changed lines");
	});

	it("says line rather than lines when exactly one is hidden", () => {
		const diff = diffContent("a\nb\n", "A\nB\n", 3);

		expect(diff.at(-1)).toBe("⋯ +1 more changed line");
	});

	it("bounds the diff input so a huge file cannot blow up the render path", () => {
		const lines = Array.from({ length: MAX_DIFF_INPUT_LINES + 100 }, (_, index) => `line-${index}`);
		const after = [...lines];
		after[MAX_DIFF_INPUT_LINES + 50] = "changed-past-the-cap";

		expect(diffContent(lines.join("\n"), after.join("\n"))).toEqual([]);
	});
});

describe("audit-trail-box remedy reasons", () => {
	it("names external change with the tick count that confirmed it", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: "h1" });
		poison(state, "src/a.ts", 10_000, "h2");

		const record = state.record("src/a.ts");

		expect(record).toBeDefined();
		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe(
			`changed on disk, confirmed over ${POISON_STREAK_TICKS} probe ticks`,
		);
	});

	it("distinguishes a vanished file from a changed one", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: "h1" });
		for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) state.noteProbe([gone("src/a.ts")], 10_000 + tick * 1000);

		const record = state.record("src/a.ts");

		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe(
			"gone from disk — deleted or no longer readable",
		);
	});

	it("blames the formatter when the rewrite landed inside the write window", () => {
		const state = new AuditLedgerState();
		state.noteWrite("src/a.ts", 0, { hash: "mine" });
		state.noteProbe([seen("src/a.ts", "formatted")], 1_000);

		const record = state.record("src/a.ts");

		expect(record?.formatterAbsorbs).toBe(1);
		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe(
			"rewritten by the repo's formatter after your write",
		);
	});

	it("reports a plain write as the agent's own edit", () => {
		const state = new AuditLedgerState();
		state.noteWrite("src/a.ts", 0, { hash: "mine" });

		const record = state.record("src/a.ts");

		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe(
			"you wrote it — disk may have moved since",
		);
	});

	it("counts idle turns for a cold path", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: "h1" });
		for (let turn = 0; turn < COLD_AFTER_TURNS; turn++) state.noteTurn();

		const record = state.record("src/a.ts");

		expect(record?.status).toBe("cold");
		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe(
			`untouched for ${COLD_AFTER_TURNS} turns (evicts at ${COLD_AFTER_TURNS})`,
		);
	});

	it("reports wasted re-reads for a redundant path", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: "h1" });
		state.noteRead("src/a.ts", { hash: "h1" });

		const record = state.record("src/a.ts");

		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe(
			"read 2 times with nothing invalidating it",
		);
	});

	it("reports a fresh path as in sync", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: "h1" });

		const record = state.record("src/a.ts");

		expect(remedyReason(record as NonNullable<typeof record>, state.turn)).toBe("in sync as of the last probe");
	});
});

describe("audit-trail-box remedy plan", () => {
	it("diffs the held copy against disk BEFORE the stale copy is discarded", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/api.ts", { hash: "h1", content: "export const port = 3000;\nexport const host = 'a';\n" });
		poison(state, "src/api.ts", 10_000, "h2", "export const port = 8080;\nexport const host = 'a';\n");

		const plan = buildRemedyPlan(state.snapshot());
		const entry = plan.mustReread[0];

		expect(entry?.path).toBe("src/api.ts");
		expect(entry?.status).toBe("poisoned");
		expect(entry?.diff).toEqual(["-export const port = 3000;", "+export const port = 8080;"]);
		// The pre-change copy is still held — the plan is the artifact that survives the discard, not a hint to go look.
		expect(state.record("src/api.ts")?.contextContent).toBe("export const port = 3000;\nexport const host = 'a';\n");
	});

	it("still shows the delta when the probe could only capture a hash", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/api.ts", { hash: "h1" });
		poison(state, "src/api.ts", 10_000, "h2");

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread[0]?.diff).toEqual([]);
		expect(plan.mustReread[0]?.reason).toContain("changed on disk");
	});

	it("shows a vanished file's held copy as fully removed", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/gone.ts", { hash: "h1", content: "keep\nthis\n" });
		for (let tick = 0; tick < POISON_STREAK_TICKS; tick++)
			state.noteProbe([gone("src/gone.ts")], 10_000 + tick * 1000);

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread[0]?.diff).toEqual(["-keep", "-this"]);
	});

	it("keeps the formatter's rewrite in must-re-read with the whitespace delta shown", () => {
		const state = new AuditLedgerState();
		state.noteWrite("src/a.ts", 0, { hash: "mine", content: "const x = 1\n" });
		state.noteProbe([seen("src/a.ts", "formatted", "const x = 1;\n")], FORMATTER_WINDOW_MS - 1);

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread[0]?.status).toBe("dirty");
		expect(plan.mustReread[0]?.severity).not.toBe("alarm");
		expect(plan.mustReread[0]?.diff).toEqual(["-const x = 1", "+const x = 1;"]);
	});

	it("puts poisoned and dirty paths in must-re-read, highest risk first", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/poisoned.ts", { hash: "h1" });
		poison(state, "src/poisoned.ts", 10_000, "h2");
		state.noteWrite("src/dirty.ts", 20_000, { hash: "mine" });

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread.map(entry => entry.path)).toEqual(["src/poisoned.ts", "src/dirty.ts"]);
		expect(plan.mustRereadOverflow).toBe(0);
	});

	it("puts cold paths in safe-to-drop and nowhere else", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/cold.ts", { hash: "h1" });
		for (let turn = 0; turn < COLD_AFTER_TURNS; turn++) state.noteTurn();

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread).toEqual([]);
		expect(plan.safeToDrop.map(entry => entry.path)).toEqual(["src/cold.ts"]);
	});

	it("leaves redundant and fresh paths out of both lists", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/fresh.ts", { hash: "h1" });
		state.noteRead("src/redundant.ts", { hash: "h2" });
		state.noteRead("src/redundant.ts", { hash: "h2" });

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread).toEqual([]);
		expect(plan.safeToDrop).toEqual([]);
	});

	it("carries the firing families so the panel need not re-derive them", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: "h1" });
		poison(state, "src/a.ts", 10_000, "h2");
		state.noteRecovery(12_000);

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread[0]?.families).toEqual(["divergence", "recovery"]);
		expect(plan.mustReread[0]?.severity).toBe("alarm");
	});

	it("caps each list and reports the remainder", () => {
		const state = new AuditLedgerState();
		for (let index = 0; index < DEFAULT_MAX_REMEDY_ENTRIES + 3; index++) {
			state.noteWrite(`src/w${index}.ts`, 0, { hash: "mine" });
		}

		const plan = buildRemedyPlan(state.snapshot());

		expect(plan.mustReread).toHaveLength(DEFAULT_MAX_REMEDY_ENTRIES);
		expect(plan.mustRereadOverflow).toBe(3);
	});

	it("honors a caller-supplied entry cap", () => {
		const state = new AuditLedgerState();
		for (let index = 0; index < 5; index++) state.noteWrite(`src/w${index}.ts`, 0, { hash: "mine" });

		const plan = buildRemedyPlan(state.snapshot(), { maxEntries: 2 });

		expect(plan.mustReread).toHaveLength(2);
		expect(plan.mustRereadOverflow).toBe(3);
	});

	it("stamps the plan with the turn it was built on", () => {
		const state = new AuditLedgerState();
		state.noteTurn();
		state.noteTurn();

		expect(buildRemedyPlan(state.snapshot()).turn).toBe(2);
	});

	it("returns empty lists for an untouched session", () => {
		const plan = buildRemedyPlan(new AuditLedgerState().snapshot());

		expect(plan.mustReread).toEqual([]);
		expect(plan.safeToDrop).toEqual([]);
		expect(plan.mustRereadOverflow).toBe(0);
		expect(plan.safeToDropOverflow).toBe(0);
	});
});

describe("audit-trail-box remedy rendering", () => {
	it("says there is nothing to do when every copy is current", () => {
		const lines = formatRemedyPlan(buildRemedyPlan(new AuditLedgerState().snapshot()));

		expect(lines).toEqual(["must re-read: nothing — every tracked copy is still current"]);
	});

	it("prints the path, its reason, and the diff indented beneath it", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/api.ts", { hash: "h1", content: "port = 3000\n" });
		poison(state, "src/api.ts", 10_000, "h2", "port = 8080\n");

		const lines = formatRemedyPlan(buildRemedyPlan(state.snapshot()));

		expect(lines[0]).toBe("must re-read (1):");
		expect(lines[1]).toBe(`  src/api.ts — changed on disk, confirmed over ${POISON_STREAK_TICKS} probe ticks`);
		expect(lines[2]).toBe("    -port = 3000");
		expect(lines[3]).toBe("    +port = 8080");
	});

	it("counts hidden paths in the header and a trailing note", () => {
		const state = new AuditLedgerState();
		for (let index = 0; index < 5; index++) state.noteWrite(`src/w${index}.ts`, 0, { hash: "mine" });

		const lines = formatRemedyPlan(buildRemedyPlan(state.snapshot(), { maxEntries: 2 }));

		expect(lines[0]).toBe("must re-read (5):");
		expect(lines.at(-1)).toBe("  ⋯ +3 more");
	});

	it("omits the safe-to-drop section when nothing is cold", () => {
		const state = new AuditLedgerState();
		state.noteWrite("src/a.ts", 0, { hash: "mine" });

		const lines = formatRemedyPlan(buildRemedyPlan(state.snapshot()));

		expect(lines.some(line => line.startsWith("safe to drop"))).toBe(false);
	});

	it("lists cold paths without diffs — there is nothing to salvage", () => {
		const state = new AuditLedgerState();
		state.noteRead("src/cold.ts", { hash: "h1", content: "unchanged\n" });
		for (let turn = 0; turn < COLD_AFTER_TURNS; turn++) state.noteTurn();

		const lines = formatRemedyPlan(buildRemedyPlan(state.snapshot()));

		expect(lines).toEqual([
			"must re-read: nothing — every tracked copy is still current",
			"safe to drop (1):",
			`  src/cold.ts — untouched for ${COLD_AFTER_TURNS} turns (evicts at ${COLD_AFTER_TURNS})`,
		]);
	});
});
