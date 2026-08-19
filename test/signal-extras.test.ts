import { describe, expect, it } from "bun:test";
import {
	buildDarkroomTitle,
	buildSignalExtraSegments,
	DEFAULT_SIGNAL_EXTRAS_CONFIG,
	resolveSignalExtrasConfig,
	SignalExtrasState,
} from "../src/signal-extras";

describe("signal extras settings", () => {
	it("defaults every extra on and lets plugin settings override env values independently", () => {
		const config = resolveSignalExtrasConfig(
			{ retryRadar: false },
			{ OMP_ANIMATIONS_RETRY_RADAR: "true", OMP_ANIMATIONS_QUEUE_FOG: "false" },
		);
		expect(config.retryRadar).toBeFalse();
		expect(config.queueFog).toBeFalse();
		expect(config.liveFiles).toBeTrue();
		expect(config.darkroomTitle).toBeTrue();
	});
});

describe("SignalExtrasState", () => {
	it("keeps the sidecar at zero rows until a signal is meaningful", () => {
		const state = new SignalExtrasState();
		expect(buildSignalExtraSegments(state.snapshot(), DEFAULT_SIGNAL_EXTRAS_CONFIG, 0)).toEqual([]);
	});

	it("marks a repeated per-turn tool sequence as an orbit", () => {
		const state = new SignalExtrasState();
		state.onTurnStart(0);
		state.onToolCall("read", { path: "/repo/a.ts" });
		state.onToolCall("edit", { path: "/repo/a.ts" });
		state.onTurnEnd(false);
		state.onTurnStart(10);
		state.onToolCall("read", { path: "/repo/a.ts" });
		state.onToolCall("edit", { path: "/repo/a.ts" });
		state.onTurnEnd(false);

		expect(state.snapshot().recurrence).toEqual({ cells: [false, true], orbit: true });
		const row = buildSignalExtraSegments(state.snapshot(), DEFAULT_SIGNAL_EXTRAS_CONFIG, 20)[0];
		expect(row?.id).toBe("recurrenceStrip");
		expect(row?.line.spans.map(span => span.text)).toContain("orbit");
	});

	it("retains a bounded compaction scar and counts immediate re-reads", () => {
		const state = new SignalExtrasState();
		state.noteContext(8_000, 6_000);
		state.noteCompactionStart(9_000);
		state.noteCompactionEnd(3_000);
		state.noteRead("src/a.ts");
		state.noteRead("src/a.ts");
		state.noteRead("src/b.ts");

		expect(state.snapshot().rewrite).toEqual({ shown: 8_000, sent: 6_000, stripped: 2_000 });
		expect(state.snapshot().scar).toEqual({ cutTokens: 6_000, rereadCount: 2 });
		for (let turn = 0; turn < 4; turn++) state.onTurnEnd(false);
		expect(state.snapshot().scar).toBeUndefined();
	});

	it("shows consent, retry, and only repeated normalized errors", () => {
		const state = new SignalExtrasState();
		state.noteApprovalRequested("call", "bash", "shared write");
		state.noteError("request 41 failed");
		expect(state.snapshot().error).toBeUndefined();
		state.noteError("request 99 failed");
		state.noteRetryStart(2, 4, 2_000, "request failed", 100);

		const snapshot = state.snapshot();
		expect(snapshot.consent).toEqual({ tool: "bash", reason: "shared write" });
		expect(snapshot.error).toEqual({ signature: "request 99 failed", count: 2 });
		expect(snapshot.retry).toMatchObject({ attempt: 2, maxAttempts: 4, startedAt: 100 });
		state.noteApprovalResolved("call");
		state.noteRetryEnd();
		expect(state.snapshot().consent).toBeUndefined();
		expect(state.snapshot().retry).toBeUndefined();
	});

	it("derives TTFT, thinking balance, skills, queue, goal, and memory from one turn", () => {
		const state = new SignalExtrasState();
		state.onTurnStart(100);
		state.noteAssistantStart(1_600);
		state.noteAssistant(8_000, 1_000);
		state.onToolCall("read", { path: "skill://diagnosing-bugs" });
		state.setQueuePending(true);
		state.noteGoal({ objective: "finish signals", status: "active", tokensUsed: 2_000, tokenBudget: 10_000 });
		state.noteMemory({ backend: "mnemopi", active: true, workingCount: 2, lastRecall: false });
		state.noteMemory({ backend: "mnemopi", active: true, workingCount: 3, lastRecall: true });

		const snapshot = state.snapshot();
		expect(snapshot.ttftMs).toBe(1_500);
		expect(snapshot.thinkAct?.shape).toBe("thinking");
		expect(snapshot.skills).toEqual(["diagnosing-bugs"]);
		expect(snapshot.queuePending).toBeTrue();
		expect(snapshot.goal?.objective).toBe("finish signals");
		expect(snapshot.memory).toMatchObject({ backend: "mnemopi", writes: 1, recalled: true });
	});

	it("filters disabled rows and projects critical state into the terminal title", () => {
		const state = new SignalExtrasState();
		state.noteApprovalRequested("call", "bash");
		state.noteContext(4_000, 3_000);
		const config = { ...DEFAULT_SIGNAL_EXTRAS_CONFIG, consentLock: false };
		const rows = buildSignalExtraSegments(state.snapshot(), config, 0);
		expect(rows.map(row => row.id)).toEqual(["contextRewriteShadow"]);
		expect(
			buildDarkroomTitle(state.snapshot(), 42, {
				entries: [{ owner: "main", path: "src/a.ts", tool: "edit", startedAt: 0 }],
			}),
		).toContain("omp  WAIT  bash  ctx  42  1 writer");
	});
});
