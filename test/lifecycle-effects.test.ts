import { describe, expect, it } from "bun:test";
import {
	type AfterglowPolicy,
	type CancellationSweepState,
	cancellationSweep,
	confidenceRail,
	EMPTY_SKILL_INVOCATIONS,
	freshnessAfterglow,
	reduceCancellationSweep,
	reduceRetryFuse,
	reduceSkillInvocations,
	retargetAfterglow,
	retryFuse,
	rootSkillName,
	type SkillInvocationState,
	skillInvocationChain,
	skillInvocationSnapshot,
} from "../src/signal-extras/lifecycle-effects";

const WIDTH = 24;
const RENDER = { width: WIDTH, unicode: true, color: true, reducedMotion: false } as const;
const POLICY: AfterglowPolicy = { freshMs: 100, recentMs: 100, residualMs: 100 };

function expectFixedWidth(text: string, width: number): void {
	expect(text.length).toBe(width);
	expect(text).not.toContain("\u001b[");
}

describe("freshness afterglow", () => {
	it("pins every stage boundary and expires without a trailing frame", () => {
		const state = retargetAfterglow(undefined, 100, POLICY);
		expect(freshnessAfterglow(state, 100, RENDER)?.stage).toBe("fresh");
		expect(freshnessAfterglow(state, 199, RENDER)?.stage).toBe("fresh");
		expect(freshnessAfterglow(state, 200, RENDER)?.stage).toBe("recent");
		expect(freshnessAfterglow(state, 299, RENDER)?.stage).toBe("recent");
		expect(freshnessAfterglow(state, 300, RENDER)?.stage).toBe("residual");
		expect(freshnessAfterglow(state, 399, RENDER)?.stage).toBe("residual");
		expect(freshnessAfterglow(state, 400, RENDER)).toBeUndefined();
	});

	it("coalesces duplicate and old observations while a newer event retargets the window", () => {
		const first = retargetAfterglow(undefined, 100, POLICY);
		expect(retargetAfterglow(first, 100, POLICY)).toBe(first);
		expect(retargetAfterglow(first, 99, POLICY)).toBe(first);
		const retargeted = retargetAfterglow(first, 250, POLICY);
		expect(retargeted).toEqual({ observedAt: 250, freshUntil: 350, recentUntil: 450, expiresAt: 550 });
		expect(freshnessAfterglow(retargeted, 549, RENDER)?.stage).toBe("residual");
		expect(freshnessAfterglow(retargeted, 550, RENDER)).toBeUndefined();
	});

	it("keeps non-color semantics and exact widths in Unicode, ASCII, reduced, and narrow forms", () => {
		const state = retargetAfterglow(undefined, 0, POLICY);
		const unicode = freshnessAfterglow(state, 0, { ...RENDER, color: false });
		const ascii = freshnessAfterglow(state, 0, { ...RENDER, width: 12, unicode: false, color: false });
		const reduced = freshnessAfterglow(state, 0, { ...RENDER, width: 8, reducedMotion: true, color: false });
		expect(unicode?.glyph).toBe("█");
		expect(ascii?.glyph).toBe("#");
		expect(reduced?.glyph).toBe("•");
		expectFixedWidth(unicode?.text ?? "", WIDTH);
		expectFixedWidth(ascii?.text ?? "", 12);
		expectFixedWidth(reduced?.text ?? "", 8);
	});
});

describe("confidence rail", () => {
	it("reports measured regressions and changed totals instead of concealing corrections", () => {
		const forward = confidenceRail(
			{ kind: "measured", current: 4, total: 10, previousCurrent: 3, previousTotal: 10 },
			0,
			RENDER,
		);
		expect(forward).toMatchObject({ kind: "measured", percent: 40, ratio: 0.4, direction: "forward" });

		const regressed = confidenceRail(
			{ kind: "measured", current: 3, total: 10, previousCurrent: 4, previousTotal: 10 },
			0,
			RENDER,
		);
		expect(regressed).toMatchObject({ kind: "measured", percent: 30, direction: "regressed" });

		const rebased = confidenceRail(
			{ kind: "measured", current: 3, total: 20, previousCurrent: 3, previousTotal: 10 },
			0,
			RENDER,
		);
		expect(rebased).toMatchObject({ kind: "measured", percent: 15, direction: "rebased" });
		expect(rebased?.nextAt).toBeUndefined();
	});

	it("uses milestone fractions and visibly records milestone corrections", () => {
		const milestone = confidenceRail(
			{ kind: "milestone", completed: 2, total: 5, previousCompleted: 3, previousTotal: 5 },
			0,
			RENDER,
		);
		expect(milestone).toMatchObject({ kind: "milestone", completed: 2, total: 5, direction: "regressed" });
		expect(milestone?.text).toContain("2/5");
		expect(milestone?.text).not.toContain("%");
		expect(milestone?.nextAt).toBeUndefined();
	});

	it("never gives event-only evidence a ratio, percentage, or filled rail", () => {
		const recent = confidenceRail({ kind: "event-only", observedAt: 10 }, 10, RENDER);
		expect(recent).toMatchObject({ kind: "event-only", recent: true, stage: "fresh" });
		expect(recent === undefined ? true : "percent" in recent).toBeFalse();
		expect(recent === undefined ? true : "ratio" in recent).toBeFalse();
		expect(recent?.text).not.toContain("%");
		expect(recent?.text.match(/[█#]/)).toBeNull();

		const expired = confidenceRail({ kind: "event-only", observedAt: 10 }, 910, RENDER);
		expect(expired).toMatchObject({ kind: "event-only", recent: false });
		expect(expired?.text).toContain("idle");
		expect(expired?.nextAt).toBeUndefined();
		expect(confidenceRail({ kind: "event-only" }, 0, RENDER)).toBeUndefined();
	});

	it("keeps confidence forms fixed-width across capability degradation", () => {
		const forms = [
			confidenceRail({ kind: "measured", current: 7, total: 10 }, 0, { ...RENDER, color: false }),
			confidenceRail({ kind: "milestone", completed: 2, total: 5 }, 0, {
				...RENDER,
				width: 15,
				unicode: false,
				color: false,
			}),
			confidenceRail({ kind: "event-only", observedAt: 0 }, 0, {
				...RENDER,
				width: 9,
				reducedMotion: true,
				color: false,
			}),
		] as const;
		expectFixedWidth(forms[0]?.text ?? "", WIDTH);
		expectFixedWidth(forms[1]?.text ?? "", 15);
		expectFixedWidth(forms[2]?.text ?? "", 9);
	});
});

describe("retry deadline fuse", () => {
	it("uses the authoritative deadline and never travels backward when extended", () => {
		let state = reduceRetryFuse(undefined, { type: "schedule", at: 0, attempt: 2, maxAttempts: 4, deadline: 1_000 });
		const before = retryFuse(state, 400, RENDER);
		expect(before?.remainingFraction).toBeCloseTo(0.6);

		state = reduceRetryFuse(state, { type: "reschedule", at: 400, deadline: 2_000 });
		const atReschedule = retryFuse(state, 400, RENDER);
		const later = retryFuse(state, 1_000, RENDER);
		expect(atReschedule?.remainingFraction).toBeCloseTo(0.6);
		expect(later?.remainingFraction).toBeLessThan(atReschedule?.remainingFraction ?? 0);
		expect(atReschedule?.text).toContain("2/4");
	});

	it("uses count-only form when no deadline is known and schedules no frames", () => {
		const state = reduceRetryFuse(undefined, { type: "schedule", at: 0, attempt: 2, maxAttempts: 4 });
		const frame = retryFuse(state, 50_000, RENDER);
		expect(frame).toMatchObject({ attempt: 2, maxAttempts: 4, countOnly: true });
		expect(frame?.text.trim()).toBe("2/4");
		expect(frame?.text).not.toContain("[");
		expect(frame?.nextAt).toBeUndefined();
	});

	it("clears on dispatch, cancellation, and terminal edges", () => {
		const scheduled = reduceRetryFuse(undefined, { type: "schedule", at: 0, attempt: 1, deadline: 1_000 });
		expect(reduceRetryFuse(scheduled, { type: "dispatch", at: 1_000 })).toBeUndefined();
		expect(reduceRetryFuse(scheduled, { type: "cancel", at: 100 })).toBeUndefined();
		expect(reduceRetryFuse(scheduled, { type: "terminal", at: 100 })).toBeUndefined();
	});

	it("renders known deadlines at exact widths in full, reduced, ASCII, and narrow modes", () => {
		const state = reduceRetryFuse(undefined, {
			type: "schedule",
			at: 0,
			attempt: 3,
			maxAttempts: 5,
			deadline: 2_000,
		});
		const full = retryFuse(state, 500, { ...RENDER, color: false });
		const ascii = retryFuse(state, 500, { ...RENDER, width: 18, unicode: false, color: false });
		const reduced = retryFuse(state, 500, { ...RENDER, width: 16, reducedMotion: true, color: false });
		const narrow = retryFuse(state, 500, { ...RENDER, width: 8, color: false });
		expectFixedWidth(full?.text ?? "", WIDTH);
		expectFixedWidth(ascii?.text ?? "", 18);
		expectFixedWidth(reduced?.text ?? "", 16);
		expectFixedWidth(narrow?.text ?? "", 8);
		expect(narrow?.countOnly).toBeTrue();
	});
});

describe("cancellation sweep", () => {
	it("remains a stable stopping state until an exact acknowledgement edge arrives", () => {
		let state: CancellationSweepState | undefined = reduceCancellationSweep(undefined, { type: "request", at: 100 });
		const stopping = cancellationSweep(state, 50_000, RENDER);
		expect(stopping).toMatchObject({ phase: "stopping" });
		expect(stopping?.nextAt).toBeUndefined();

		const unrelated = reduceCancellationSweep(state, { type: "acknowledge", at: 200, exact: false });
		expect(unrelated).toBe(state);
		expect(cancellationSweep(unrelated, 50_000, RENDER)?.phase).toBe("stopping");

		state = reduceCancellationSweep(state, { type: "acknowledge", at: 200, exact: true }, 300);
		expect(cancellationSweep(state, 200, RENDER)?.phase).toBe("acknowledged");
		expect(cancellationSweep(state, 499, RENDER)?.phase).toBe("acknowledged");
		expect(cancellationSweep(state, 500, RENDER)).toBeUndefined();
	});

	it("coalesces old requests, retargets a new request, and clears terminally", () => {
		const first = reduceCancellationSweep(undefined, { type: "request", at: 100 });
		expect(reduceCancellationSweep(first, { type: "request", at: 90 })).toBe(first);
		const newer = reduceCancellationSweep(first, { type: "request", at: 200 });
		expect(newer).toEqual({ phase: "stopping", requestedAt: 200 });
		expect(reduceCancellationSweep(newer, { type: "terminal", at: 201 })).toBeUndefined();
	});

	it("preserves fixed-width acknowledgement semantics without color or motion", () => {
		const acknowledged = reduceCancellationSweep(reduceCancellationSweep(undefined, { type: "request", at: 0 }), {
			type: "acknowledge",
			at: 10,
			exact: true,
		});
		const unicode = cancellationSweep(acknowledged, 20, { ...RENDER, color: false });
		const ascii = cancellationSweep(acknowledged, 20, { ...RENDER, width: 14, unicode: false, color: false });
		const reduced = cancellationSweep(acknowledged, 20, {
			...RENDER,
			width: 10,
			reducedMotion: true,
			color: false,
		});
		expectFixedWidth(unicode?.text ?? "", WIDTH);
		expectFixedWidth(ascii?.text ?? "", 14);
		expectFixedWidth(reduced?.text ?? "", 10);
	});
});

describe("root skill invocation chain", () => {
	it("accepts only exact root read-skill paths", () => {
		expect(rootSkillName("read", "skill://idea-wizard")).toBe("idea-wizard");
		expect(rootSkillName("write", "skill://idea-wizard")).toBeUndefined();
		expect(rootSkillName("read", "skill://idea-wizard/reference.md")).toBeUndefined();
		expect(rootSkillName("read", "skill://idea-wizard:20")).toBeUndefined();
		expect(rootSkillName("read", "/private/skill.md")).toBeUndefined();
	});

	it("moves exact start to current and matching end to latest without retaining raw paths", () => {
		let state: SkillInvocationState = EMPTY_SKILL_INVOCATIONS;
		state = reduceSkillInvocations(state, {
			type: "read-start",
			actor: "main",
			turn: "18",
			tool: "read",
			path: "skill://idea-wizard",
			at: 100,
		});
		expect(skillInvocationSnapshot(state, "main", "18")?.current).toBe("idea-wizard");

		const ignoredEnd = reduceSkillInvocations(state, {
			type: "read-end",
			actor: "main",
			turn: "18",
			tool: "read",
			path: "skill://prototype",
			at: 110,
		});
		expect(ignoredEnd).toBe(state);

		state = reduceSkillInvocations(state, {
			type: "read-end",
			actor: "main",
			turn: "18",
			tool: "read",
			path: "skill://idea-wizard",
			at: 120,
		});
		const snapshot = skillInvocationSnapshot(state, "main", "18");
		expect(snapshot?.current).toBeUndefined();
		expect(snapshot?.nodes.at(-1)).toMatchObject({ name: "idea-wizard", endedAt: 120 });
		expect(JSON.stringify(state)).not.toContain("skill://");
		expect(skillInvocationChain(snapshot, 120, RENDER)).toMatchObject({
			latest: "idea-wizard",
			text: `${"idea-wizard · used".padEnd(WIDTH)}`,
		});
	});

	it("isolates actors and turns and clears only the exact turn boundary", () => {
		let state: SkillInvocationState = EMPTY_SKILL_INVOCATIONS;
		for (const [actor, turn, skill, at] of [
			["main", "1", "idea-wizard", 10],
			["agent-a", "1", "prototype", 20],
			["main", "2", "lavish", 30],
		] as const) {
			state = reduceSkillInvocations(state, {
				type: "read-start",
				actor,
				turn,
				tool: "read",
				path: `skill://${skill}`,
				at,
			});
		}
		expect(skillInvocationSnapshot(state, "main", "1")?.current).toBe("idea-wizard");
		expect(skillInvocationSnapshot(state, "agent-a", "1")?.current).toBe("prototype");
		expect(skillInvocationSnapshot(state, "main", "2")?.current).toBe("lavish");

		state = reduceSkillInvocations(state, { type: "turn-end", actor: "main", turn: "1", at: 40 });
		expect(skillInvocationSnapshot(state, "main", "1")).toBeUndefined();
		expect(skillInvocationSnapshot(state, "agent-a", "1")?.current).toBe("prototype");
		expect(skillInvocationSnapshot(state, "main", "2")?.current).toBe("lavish");
	});

	it("collapses adjacent repeats and reports exact bounded overflow", () => {
		let repeated: SkillInvocationState = EMPTY_SKILL_INVOCATIONS;
		for (const at of [1, 2, 3]) {
			repeated = reduceSkillInvocations(repeated, {
				type: "read-start",
				actor: "main",
				turn: "1",
				tool: "read",
				path: "skill://prototype",
				at,
			});
		}
		const repeatFrame = skillInvocationChain(skillInvocationSnapshot(repeated, "main", "1"), 3, RENDER);
		expect(repeatFrame?.chain).toBe("prototype×3");

		let overflow: SkillInvocationState = EMPTY_SKILL_INVOCATIONS;
		for (const [skill, at] of [
			["one", 1],
			["two", 2],
			["three", 3],
			["four", 4],
		] as const) {
			overflow = reduceSkillInvocations(
				overflow,
				{ type: "read-start", actor: "main", turn: "2", tool: "read", path: `skill://${skill}`, at },
				2,
			);
		}
		const overflowFrame = skillInvocationChain(skillInvocationSnapshot(overflow, "main", "2"), 4, RENDER);
		expect(overflowFrame?.overflow).toBe(2);
		expect(overflowFrame?.chain).toBe("+2 → three → four");
	});

	it("renders one compact active phrase at fixed Unicode, ASCII, reduced, and narrow widths", () => {
		const state = reduceSkillInvocations(EMPTY_SKILL_INVOCATIONS, {
			type: "read-start",
			actor: "main",
			turn: "1",
			tool: "read",
			path: "skill://prototype",
			at: 0,
		});
		const scope = skillInvocationSnapshot(state, "main", "1");
		const unicode = skillInvocationChain(scope, 0, { ...RENDER, color: false });
		const ascii = skillInvocationChain(scope, 0, { ...RENDER, width: 20, unicode: false, color: false });
		const reduced = skillInvocationChain(scope, 0, { ...RENDER, width: 18, reducedMotion: true, color: false });
		const narrow = skillInvocationChain(scope, 0, { ...RENDER, width: 10, color: false });
		expectFixedWidth(unicode?.text ?? "", WIDTH);
		expectFixedWidth(ascii?.text ?? "", 20);
		expectFixedWidth(reduced?.text ?? "", 18);
		expectFixedWidth(narrow?.text ?? "", 10);
		expect(unicode?.text.trimEnd()).toBe("prototype · active");
		expect(ascii?.text.trimEnd()).toBe("prototype · active");
		expect(narrow?.text).not.toContain("prototype prototype");
		expect(skillInvocationChain(scope, 1_000, RENDER)?.nextAt).toBeUndefined();
	});
});
