import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ActivityLifecycleScheduler,
	type ActivityRosterSnapshot,
	ActivityTelemetryBus,
} from "../src/activity-roster";
import { projectActivityAgents } from "../src/activity-roster/projection";
import { AgentBonsaiController } from "../src/agent-bonsai/controller";
import { renderAgentBonsaiRows } from "../src/agent-bonsai/widget";
import { FlashTracker } from "../src/animations-box/status-line";

const EMPTY_SESSION_RESOURCES = { skills: [], contextFiles: [] } as const;

function manualScheduler(): ActivityLifecycleScheduler & { advance(ms: number): void; pending(): number } {
	let current = 0;
	const timers = new Map<() => void, number>();
	return {
		now: () => current,
		schedule(delayMs, tick) {
			timers.set(tick, current + delayMs);
			return () => {
				timers.delete(tick);
			};
		},
		pending: () => timers.size,
		advance(ms) {
			const target = current + ms;
			while (true) {
				const next = [...timers.entries()].sort((left, right) => left[1] - right[1])[0];
				if (next === undefined || next[1] > target) break;
				const [tick, deadline] = next;
				current = deadline;
				timers.delete(tick);
				tick();
			}
			current = target;
		},
	};
}

describe("ActivityTelemetryBus", () => {
	it("joins root and headless plugin instances into one exact writer roster", () => {
		let now = 100;
		const bus = new ActivityTelemetryBus({ now: () => now, completionFlashMs: 1_200, retentionMs: 300_000 });
		const root = bus.registerSession({
			sessionId: "root-session",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/root-session",
			model: "gpt-5.6",
		});
		const agentOne = bus.registerSession({
			sessionId: "agent-session-1",
			hasUI: false,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/root-session/a1.jsonl",
			artifactsDir: "/sessions/root-session/a1",
			model: "sonnet",
		});
		const agentTwo = bus.registerSession({
			sessionId: "agent-session-2",
			hasUI: false,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/root-session/a2.jsonl",
			artifactsDir: "/sessions/root-session/a2",
			model: "codex",
		});

		agentOne.startTool({
			toolCallId: "edit-1",
			toolName: "edit",
			args: "[/repo/src/widget.ts#A1B2]\nPUT 218.=218:\n+value",
		});
		now = 150;
		agentTwo.startTool({ toolCallId: "write-1", toolName: "write", args: { path: "/repo/src/controller.ts" } });

		const snapshot = root.snapshot();
		expect(snapshot.liveWriterCount).toBe(2);
		expect(snapshot.pathCount).toBe(2);
		expect(snapshot.runningCount).toBe(3);
		expect(snapshot.idleCount).toBe(0);
		expect(snapshot.operations).toEqual([
			{
				id: "agent-session-1:edit-1:src/widget.ts:218",
				agentId: "a1",
				tool: "edit",
				path: "src/widget.ts",
				line: 218,
				phase: "active",
				startedAt: 100,
				isError: false,
			},
			{
				id: "agent-session-2:write-1:src/controller.ts",
				agentId: "a2",
				tool: "write",
				path: "src/controller.ts",
				phase: "active",
				startedAt: 150,
				isError: false,
			},
		]);
		expect(snapshot.agents.map(agent => [agent.id, agent.parentId, agent.currentTool, agent.currentTarget])).toEqual([
			["main", undefined, undefined, undefined],
			["a1", "main", "edit", "src/widget.ts"],
			["a2", "main", "write", "src/controller.ts"],
		]);
	});

	it("keeps completion visible through flash and grey phases, then expires it", () => {
		let now = 0;
		const bus = new ActivityTelemetryBus({ now: () => now, completionFlashMs: 1_200, retentionMs: 300_000 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/root",
		});
		const agent = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/root/a1.jsonl",
		});
		agent.startTool({ toolCallId: "write", toolName: "write", args: { path: "/repo/a.ts" } });
		agent.endTool({ toolCallId: "write", toolName: "write", isError: false });
		agent.complete();

		expect(root.snapshot().agents.find(row => row.id === "a1")?.phase).toBe("completing");
		expect(root.snapshot().operations[0]?.phase).toBe("completing");

		now = 1_201;
		expect(root.snapshot().agents.find(row => row.id === "a1")?.phase).toBe("recent");
		expect(root.snapshot().operations).toEqual([]);
		expect(root.snapshot().idleCount).toBe(1);

		now = 300_001;
		expect(root.snapshot().agents.map(row => row.id)).toEqual(["main"]);
		expect(root.snapshot().idleCount).toBe(0);
	});

	it("expires exact children on lifecycle deadlines without frame ticks and keeps their first completion", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler, retentionMs: 0 });
		const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
			retentionMs: 0,
		});
		const completed = bus.registerSession({
			...session,
			sessionId: "completed",
			hasUI: false,
			sessionFile: "/sessions/root/done.jsonl",
		});
		const running = bus.registerSession({
			...session,
			sessionId: "running",
			hasUI: false,
			sessionFile: "/sessions/root/live.jsonl",
		});
		const snapshots: ActivityRosterSnapshot[] = [];
		root.subscribe(() => snapshots.push(root.snapshot()));
		const failedWrite = { toolCallId: "write", toolName: "write", args: { path: "/repo/a.ts" } };
		completed.startTool(failedWrite);
		completed.endTool({ ...failedWrite, isError: true });
		completed.complete();
		const landed = root.snapshot();
		expect(landed.agents.find(agent => agent.id === "done")).toMatchObject({ completedAt: 0 });
		expect(landed.operations[0]?.isError).toBe(true);
		scheduler.advance(400);
		completed.complete();
		completed.startTool(failedWrite);
		completed.updateTool(failedWrite);
		expect(root.snapshot().agents.find(agent => agent.id === "done")?.completedAt).toBe(0);
		scheduler.advance(399);
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "done", "live"]);
		const changes = snapshots.length;
		scheduler.advance(1);
		expect(snapshots.length).toBe(changes + 1);
		expect(snapshots.at(-1)?.agents.map(agent => agent.id)).toEqual(["main", "live"]);
		expect(snapshots.at(-1)?.retiredAgentIds).toEqual(["done"]);
		expect(snapshots.at(-1)?.operations).toEqual([]);
		expect(landed.retiredAgentIds).toEqual([]);
		expect(scheduler.pending()).toBe(0);
		completed.startTool(failedWrite);
		completed.complete();
		scheduler.advance(1_000_000);
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "live"]);
		expect(root.snapshot().operations).toEqual([]);
		running.dispose();
		root.dispose();
		expect(scheduler.pending()).toBe(0);
	});

	it("purges only terminal children at root request boundaries and retains session identity tombstones", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler, retentionMs: 300_000 });
		const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const done = bus.registerSession({
			...session,
			sessionId: "done",
			hasUI: false,
			sessionFile: "/sessions/root/done.jsonl",
		});
		const pending = bus.registerSession({
			...session,
			sessionId: "pending",
			hasUI: false,
			sessionFile: "/sessions/root/pending.jsonl",
		});
		const live = bus.registerSession({
			...session,
			sessionId: "live",
			hasUI: false,
			sessionFile: "/sessions/root/live.jsonl",
		});
		live.startTool({ toolCallId: "live-write", toolName: "write", args: { path: "/repo/live.ts" } });
		done.startTool({ toolCallId: "done-write", toolName: "write", args: { path: "/repo/done.ts" } });
		done.complete();
		pending.beginRequest();
		expect(root.snapshot().agents.some(agent => agent.id === "done")).toBe(true);
		const snapshots: ActivityRosterSnapshot[] = [];
		root.subscribe(() => snapshots.push(root.snapshot()));
		root.beginRequest();
		expect(snapshots.at(-1)?.agents.map(agent => agent.id)).toEqual(["main", "live", "pending"]);
		expect(snapshots.at(-1)?.operations.map(operation => operation.path)).toEqual(["live.ts"]);
		expect(snapshots.at(-1)?.retiredAgentIds).toEqual(["done"]);
		expect(scheduler.pending()).toBe(0);
		root.beginRequest();
		expect(root.snapshot().retiredAgentIds).toEqual(["done"]);
		scheduler.advance(300_000);
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "live", "pending"]);
		root.dispose();
		const replacement = bus.registerSession({
			...session,
			sessionId: "replacement",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		expect(replacement.snapshot().retiredAgentIds).toEqual([]);
		replacement.dispose();
	});

	it("adopts early parent outcomes and reschedules late exact completion to the earliest terminal timestamp", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler, retentionMs: 800 });
		const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		root.noteAgentOutcome("early", "aborted", 0);
		root.noteAgentOutcome("early", "completed", 50);
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
		scheduler.advance(100);
		const early = bus.registerSession({
			...session,
			sessionId: "early",
			hasUI: false,
			sessionFile: "/sessions/root/early.jsonl",
		});
		const late = bus.registerSession({
			...session,
			sessionId: "late",
			hasUI: false,
			sessionFile: "/sessions/root/late.jsonl",
		});
		early.complete();
		late.complete();
		expect(root.snapshot().agents.find(agent => agent.id === "early")).toMatchObject({
			completedAt: 0,
			terminalStatus: "aborted",
		});
		early.noteAgentOutcome("late", "aborted", 0);
		expect(root.snapshot().agents.find(agent => agent.id === "late")).toMatchObject({
			completedAt: 100,
			terminalStatus: "completed",
		});
		root.noteAgentOutcome("late", "aborted", 0);
		root.noteAgentOutcome("late", "completed", 100);
		root.noteAgentOutcome("late", "aborted", 100);
		expect(root.snapshot().agents.find(agent => agent.id === "late")).toMatchObject({
			completedAt: 0,
			terminalStatus: "aborted",
		});
		const snapshots: ActivityRosterSnapshot[] = [];
		root.subscribe(() => snapshots.push(root.snapshot()));
		scheduler.advance(699);
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "early", "late"]);
		scheduler.advance(1);
		expect(snapshots.at(-1)?.agents.map(agent => agent.id)).toEqual(["main"]);
		expect(snapshots.at(-1)?.retiredAgentIds).toEqual(["early", "late"]);
		expect(scheduler.pending()).toBe(0);
		root.noteAgentOutcome("late", "aborted", 800);
		root.beginRequest();
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
		expect(scheduler.pending()).toBe(0);
		root.dispose();
	});

	it("notifies fallback-only completion settlement and expiry with motion off and no polling", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler, completionFlashMs: 1_200, retentionMs: 300_000 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/root",
		});
		let screen: readonly string[] = [];
		const notifications: { at: number; roster: ActivityRosterSnapshot }[] = [];
		const controller = new AgentBonsaiController({
			now: scheduler.now,
			onAgentOutcome: (id, outcome, completedAt) => root.noteAgentOutcome(id, outcome, completedAt),
			onChange: () => paint(),
		});
		const paint = () => {
			const roster = root.snapshot();
			screen = renderAgentBonsaiRows(
				projectActivityAgents(roster, controller.snapshot(roster.retiredAgentIds)),
				120,
				{
					theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
					glyphPreset: "unicode",
					now: scheduler.now(),
					flashTier: "off",
					flash: new FlashTracker(),
					seenIds: new Set(),
					hyperlinks: false,
				},
			);
		};
		controller.mount();
		root.subscribe(() => {
			notifications.push({ at: scheduler.now(), roster: root.snapshot() });
			paint();
		});
		try {
			controller.onToolExecutionUpdate({
				toolName: "task",
				toolCallId: "background",
				partialResult: { details: { progress: [{ index: 0, id: "fallback-only", status: "completed" }] } },
			});
			expect(notifications.at(-1)?.at).toBe(0);
			expect(notifications.at(-1)?.roster.agents.map(agent => agent.id)).toEqual(["main"]);
			expect(screen.join("\n")).toContain("fallback-only");
			const landedNotifications = notifications.length;
			scheduler.advance(1_200);
			expect(notifications).toHaveLength(landedNotifications);
			scheduler.advance(1);
			expect(notifications).toHaveLength(landedNotifications + 1);
			expect(notifications.at(-1)?.at).toBe(1_201);
			expect(screen.join("\n")).toContain("fallback-only");
			scheduler.advance(300_000 - 1_202);
			expect(notifications).toHaveLength(landedNotifications + 1);
			expect(screen.join("\n")).toContain("fallback-only");
			scheduler.advance(1);
			expect(notifications).toHaveLength(landedNotifications + 2);
			expect(notifications.at(-1)?.at).toBe(300_000);
			expect(notifications.at(-1)?.roster.retiredAgentIds).toEqual(["fallback-only"]);
			expect(notifications.at(-1)?.roster.agents.map(agent => agent.id)).toEqual(["main"]);
			expect(screen.join("\n")).not.toContain("fallback-only");
			expect(scheduler.pending()).toBe(0);
			const changes = notifications.length;
			root.noteAgentOutcome("fallback-only", "completed", scheduler.now());
			expect(notifications).toHaveLength(changes);
			expect(scheduler.pending()).toBe(0);
			const late = bus.registerSession({
				sessionId: "late-registration",
				hasUI: false,
				cwd: "/repo",
				sessionResources: EMPTY_SESSION_RESOURCES,
				sessionFile: "/sessions/root/fallback-only.jsonl",
			});
			late.startTool({ toolCallId: "late", toolName: "write", args: { path: "/repo/late.ts" } });
			expect(notifications).toHaveLength(changes);
			expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
			expect(root.snapshot().operations).toEqual([]);
		} finally {
			controller.dispose();
			root.dispose();
		}
	});

	it("keeps exact re-registration inert after expiry or request-boundary retirement", () => {
		for (const retirement of ["expiry", "request"] as const) {
			const scheduler = manualScheduler();
			const bus = new ActivityTelemetryBus({ scheduler, retentionMs: 800 });
			const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
			const root = bus.registerSession({
				...session,
				sessionId: "root",
				hasUI: true,
				artifactsDir: "/sessions/root",
			});
			const registration = {
				...session,
				sessionId: "child",
				hasUI: false,
				sessionFile: "/sessions/root/Worker.jsonl",
			};
			const child = bus.registerSession(registration);
			try {
				child.complete();
				if (retirement === "expiry") scheduler.advance(800);
				else root.beginRequest();
				expect(root.snapshot().retiredAgentIds).toEqual(["Worker"]);
				let changes = 0;
				root.subscribe(() => changes++);
				const stale = bus.registerSession(registration);
				const write = { toolCallId: "late-write", toolName: "write", args: { path: "/repo/late.ts" } };
				stale.beginRequest();
				stale.startTool(write);
				stale.updateTool(write);
				stale.endTool({ ...write, isError: false });
				stale.complete();
				stale.dispose();
				expect(changes).toBe(0);
				expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
				expect(root.snapshot().operations).toEqual([]);
				expect(root.snapshot().retiredAgentIds).toEqual(["Worker"]);
				expect(scheduler.pending()).toBe(0);
			} finally {
				root.dispose();
			}
		}
	});

	it("does not abort a case-distinct exact agent or retire its live sibling", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler, retentionMs: 800 });
		const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const upper = bus.registerSession({
			...session,
			sessionId: "upper",
			hasUI: false,
			sessionFile: "/sessions/root/Worker.jsonl",
		});
		bus.registerSession({
			...session,
			sessionId: "lower",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
		});
		try {
			root.noteAgentOutcome("worker", "aborted", 0);
			expect(root.snapshot().agents.find(agent => agent.id === "worker")?.terminalStatus).toBe("aborted");
			expect(root.snapshot().agents.find(agent => agent.id === "Worker")?.completedAt).toBeUndefined();
			upper.startTool({ toolCallId: "write", toolName: "write", args: { path: "/repo/live.ts" } });
			expect(root.snapshot().operations.map(operation => operation.path)).toEqual(["live.ts"]);
			scheduler.advance(800);
			expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "Worker"]);
			expect(root.snapshot().retiredAgentIds).toEqual(["worker"]);
		} finally {
			root.dispose();
		}
	});

	it("consumes only the case-exact pending outcome when children register later", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler, retentionMs: 2_000 });
		const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		try {
			root.noteAgentOutcome("Worker", "aborted", 0);
			root.noteAgentOutcome("worker", "completed", 50);
			scheduler.advance(100);
			bus.registerSession({
				...session,
				sessionId: "lower",
				hasUI: false,
				sessionFile: "/sessions/root/worker.jsonl",
			});
			expect(root.snapshot().agents.find(agent => agent.id === "worker")).toMatchObject({
				terminalStatus: "completed",
				completedAt: 50,
			});
			bus.registerSession({
				...session,
				sessionId: "upper",
				hasUI: false,
				sessionFile: "/sessions/root/Worker.jsonl",
			});
			expect(root.snapshot().agents.find(agent => agent.id === "Worker")).toMatchObject({
				terminalStatus: "aborted",
				completedAt: 0,
			});
		} finally {
			root.dispose();
		}
	});

	it("purges unmatched terminal outcomes at beginRequest without retiring live or unstarted children", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ scheduler });
		const session = { cwd: "/repo", sessionResources: EMPTY_SESSION_RESOURCES };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		bus.registerSession({
			...session,
			sessionId: "pending",
			hasUI: false,
			sessionFile: "/sessions/root/pending.jsonl",
		});
		const live = bus.registerSession({
			...session,
			sessionId: "live",
			hasUI: false,
			sessionFile: "/sessions/root/live.jsonl",
		});
		try {
			live.startTool({ toolCallId: "live", toolName: "read", args: { path: "/repo/live.ts" } });
			root.noteAgentOutcome("unmatched", "aborted", 0);
			root.beginRequest();
			expect(root.snapshot().retiredAgentIds).toEqual(["unmatched"]);
			expect(new Set(root.snapshot().agents.map(agent => agent.id))).toEqual(new Set(["main", "pending", "live"]));
			expect(scheduler.pending()).toBe(0);
			const stale = bus.registerSession({
				...session,
				sessionId: "unmatched",
				hasUI: false,
				sessionFile: "/sessions/root/unmatched.jsonl",
			});
			stale.startTool({ toolCallId: "stale", toolName: "write", args: { path: "/repo/stale.ts" } });
			expect(root.snapshot().agents.some(agent => agent.id === "unmatched")).toBe(false);
			expect(root.snapshot().operations).toEqual([]);
			expect(root.snapshot().agents.find(agent => agent.id === "live")?.currentTool).toBe("read");
		} finally {
			root.dispose();
		}
	});

	it("isolates simultaneous root sessions and derives nested ancestry from artifact paths", () => {
		const bus = new ActivityTelemetryBus();
		const first = bus.registerSession({
			sessionId: "root-1",
			hasUI: true,
			cwd: "/one",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/one",
		});
		const second = bus.registerSession({
			sessionId: "root-2",
			hasUI: true,
			cwd: "/two",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/two",
		});
		const nested = bus.registerSession({
			sessionId: "nested",
			hasUI: false,
			cwd: "/one",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/one/a1/a2.jsonl",
		});
		nested.startTool({ toolCallId: "edit", toolName: "edit", args: { path: "/one/nested.ts" } });

		expect(first.snapshot().agents.map(agent => [agent.id, agent.parentId])).toEqual([
			["main", undefined],
			["a2", "a1"],
		]);
		expect(first.snapshot().operations[0]?.path).toBe("nested.ts");
		expect(second.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
		expect(second.snapshot().operations).toEqual([]);
	});

	it("notifies only the matching root subscriber", () => {
		const bus = new ActivityTelemetryBus();
		const first = bus.registerSession({
			sessionId: "root-1",
			hasUI: true,
			cwd: "/one",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/one",
		});
		const second = bus.registerSession({
			sessionId: "root-2",
			hasUI: true,
			cwd: "/two",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/two",
		});
		let firstChanges = 0;
		let secondChanges = 0;
		const unsubscribeFirst = first.subscribe(() => firstChanges++);
		const unsubscribeSecond = second.subscribe(() => secondChanges++);
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/one",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/one/a1.jsonl",
		});

		child.startTool({ toolCallId: "write", toolName: "write", args: { path: "/one/a.ts" } });
		expect(firstChanges).toBe(2); // registration plus tool start
		expect(secondChanges).toBe(0);

		unsubscribeFirst();
		unsubscribeSecond();
	});

	it("normalizes mutating device calls from their exact write arguments", () => {
		const bus = new ActivityTelemetryBus();
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/root",
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/root/a1.jsonl",
		});
		child.startTool({
			toolCallId: "ast-edit",
			toolName: "write",
			args: {
				path: "xd://ast_edit",
				content: JSON.stringify({ paths: ["/repo/src/a.ts", "/repo/src/b.ts"] }),
			},
		});
		child.startTool({
			toolCallId: "lsp-rename",
			toolName: "write",
			args: {
				path: "xd://lsp",
				content: JSON.stringify({ action: "rename", file: "/repo/src/c.ts", line: 14 }),
			},
		});

		expect(root.snapshot().operations.map(operation => [operation.path, operation.line])).toEqual([
			["src/a.ts", undefined],
			["src/b.ts", undefined],
			["src/c.ts", 14],
		]);
	});

	it("retains exact per-agent tool, skill, and file activity until the display trail expires", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now, activityTrailMs: 8_000 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/root",
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/root/a1.jsonl",
		});

		root.startTool({ toolCallId: "skill", toolName: "read", args: { path: "skill://tdd" } });
		now = 20;
		child.startTool({ toolCallId: "source", toolName: "edit", args: { path: "/repo/src/state.ts" } });

		const active = root.snapshot();
		expect(active.agents.find(agent => agent.id === "main")?.steps).toEqual([
			{ id: "skill:tool", kind: "tool", label: "read", status: "active", startedAt: 10 },
			{ id: "skill:skill:0", kind: "skill", label: "tdd", status: "active", startedAt: 10 },
		]);
		expect(active.agents.find(agent => agent.id === "a1")?.steps).toEqual([
			{ id: "source:tool", kind: "tool", label: "edit", status: "active", startedAt: 20 },
			{ id: "source:file:0", kind: "file", label: "src/state.ts", status: "active", startedAt: 20 },
		]);

		root.endTool({ toolCallId: "skill", toolName: "read", isError: false });
		child.endTool({ toolCallId: "source", toolName: "edit", isError: true });
		const settled = root.snapshot();
		expect(settled.agents.find(agent => agent.id === "main")?.steps.map(step => step.status)).toEqual([
			"complete",
			"complete",
		]);
		expect(settled.agents.find(agent => agent.id === "a1")?.steps.map(step => step.status)).toEqual([
			"error",
			"error",
		]);

		now = 8_021;
		expect(root.snapshot().agents.every(agent => agent.steps.length === 0)).toBe(true);
	});

	it("keeps discovered availability separate from exact skill invocation", () => {
		const bus = new ActivityTelemetryBus();
		const resources = {
			skills: [
				{
					name: "review",
					description: "Review changes",
					path: "/skills/review/SKILL.md",
					content: "must not escape registration",
				},
				{
					name: "tdd",
					description: "Develop test-first",
					path: "/skills/tdd/SKILL.md",
					content: "must not escape registration",
				},
			],
			contextFiles: [{ path: "/repo/AGENTS.md", content: "private instructions" }],
		};
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: resources,
		});

		root.startTool({ toolCallId: "skill", toolName: "read", args: { path: "skill://tdd/reference" } });

		const snapshot = root.snapshot();
		expect(snapshot.resourceCatalog).toEqual({
			availableSkills: [
				{ name: "review", description: "Review changes", path: "/skills/review/SKILL.md" },
				{ name: "tdd", description: "Develop test-first", path: "/skills/tdd/SKILL.md" },
			],
			contextFiles: [{ path: "/repo/AGENTS.md", label: "AGENTS.md" }],
		});
		expect(snapshot.agents[0]?.steps.filter(step => step.kind === "skill").map(step => step.label)).toEqual(["tdd"]);
		expect(Object.isFrozen(snapshot.resourceCatalog)).toBe(true);
		expect(Object.isFrozen(snapshot.resourceCatalog.availableSkills)).toBe(true);
		expect(Object.isFrozen(snapshot.resourceCatalog.availableSkills[0])).toBe(true);
		expect(Object.isFrozen(snapshot.resourceCatalog.contextFiles)).toBe(true);
		expect(Object.isFrozen(snapshot.resourceCatalog.contextFiles[0])).toBe(true);

		resources.skills.splice(0);
		resources.contextFiles.splice(0);
		expect(root.snapshot().resourceCatalog).toEqual(snapshot.resourceCatalog);
	});

	it("unions sanitized session resources across the root and attached children", () => {
		const bus = new ActivityTelemetryBus();
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: {
				skills: [{ name: "tdd", description: "Root copy", path: "/skills/tdd/SKILL.md" }],
				contextFiles: [{ path: "/repo/AGENTS.md" }],
			},
		});
		bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo/packages/widget",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: {
				skills: [
					{ name: "tdd", description: "Inherited copy", path: "/skills/tdd/SKILL.md" },
					{ name: "review", description: "Review changes", path: "/skills/review/SKILL.md" },
				],
				contextFiles: [{ path: "AGENTS.md" }, { path: "/repo/AGENTS.md" }],
			},
		});

		expect(root.snapshot().resourceCatalog).toEqual({
			availableSkills: [
				{ name: "review", description: "Review changes", path: "/skills/review/SKILL.md" },
				{ name: "tdd", description: "Root copy", path: "/skills/tdd/SKILL.md" },
			],
			contextFiles: [
				{ path: "/repo/AGENTS.md", label: "AGENTS.md" },
				{ path: "/repo/packages/widget/AGENTS.md", label: "AGENTS.md" },
			],
		});
	});

	it("records deduplicated skill provenance for the exact owning agent and completion event", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: {
				skills: [
					{ name: "review", description: "Review changes", path: "/skills/review/SKILL.md" },
					{ name: "tdd", description: "Develop test-first", path: "/skills/tdd/SKILL.md" },
					{ name: "unused", description: "Not invoked", path: "/skills/unused/SKILL.md" },
				],
				contextFiles: [],
			},
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});

		root.startTool({ toolCallId: "root-skill", toolName: "read", args: { path: "skill://tdd/reference" } });
		root.updateTool({ toolCallId: "root-skill", toolName: "read", args: { path: "skill://tdd/reference" } });
		root.updateTool({ toolCallId: "root-skill", toolName: "read", args: { path: "skill://tdd/reference" } });
		now = 20;
		child.startTool({ toolCallId: "child-skill", toolName: "read", args: "skill://review?section=rules" });
		root.endTool({ toolCallId: "root-skill", toolName: "read", isError: false });
		child.endTool({ toolCallId: "child-skill", toolName: "read", isError: true });

		const snapshot = root.snapshot();
		expect(snapshot.agents.find(agent => agent.id === "main")?.provenance).toEqual([
			{
				id: "root-skill:skill",
				kind: "skill",
				label: "tdd",
				status: "complete",
				startedAt: 10,
			},
		]);
		expect(snapshot.agents.find(agent => agent.id === "a1")?.provenance).toEqual([
			{
				id: "child-skill:skill",
				kind: "skill",
				label: "review",
				status: "error",
				startedAt: 20,
			},
		]);
		expect(snapshot.resourceUsage).toEqual({
			skillInvocationCount: 2,
			contextFileReadCount: 0,
			memoryOperationCount: 0,
			qmdOperationCount: 0,
			totalCount: 2,
		});
		expect(snapshot.resourceCatalog.availableSkills.map(skill => skill.name)).toEqual(["review", "tdd", "unused"]);
	});

	it("records only reads that normalize to the owning session's injected context files", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: {
				skills: [],
				contextFiles: [{ path: "AGENTS.md" }],
			},
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo/packages/widget",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: {
				skills: [],
				contextFiles: [{ path: "AGENTS.md" }],
			},
		});

		root.startTool({ toolCallId: "root-context", toolName: "read", args: { path: "docs/../AGENTS.md:5-16,20-30" } });
		root.updateTool({ toolCallId: "root-context", toolName: "read", args: { path: "./AGENTS.md:raw:2-4" } });
		root.endTool({ toolCallId: "root-context", toolName: "read", isError: false });
		root.startTool({
			toolCallId: "foreign-context",
			toolName: "read",
			args: { path: "/repo/packages/widget/AGENTS.md:50+150" },
		});
		now = 20;
		child.startTool({
			toolCallId: "child-context",
			toolName: "read",
			args: { path: "/repo/packages/widget/docs/../AGENTS.md:-60" },
		});
		child.updateTool({
			toolCallId: "child-context",
			toolName: "read",
			args: { path: "./AGENTS.md:50-:raw" },
		});
		child.endTool({ toolCallId: "child-context", toolName: "read", isError: true });

		const snapshot = root.snapshot();
		expect(snapshot.agents.find(agent => agent.id === "main")?.provenance).toEqual([
			{
				id: "root-context:context-file",
				kind: "context-file",
				label: "AGENTS.md",
				status: "complete",
				startedAt: 10,
			},
		]);
		expect(snapshot.agents.find(agent => agent.id === "a1")?.provenance).toEqual([
			{
				id: "child-context:context-file",
				kind: "context-file",
				label: "AGENTS.md",
				status: "error",
				startedAt: 20,
			},
		]);
		expect(snapshot.resourceUsage).toEqual({
			skillInvocationCount: 0,
			contextFileReadCount: 2,
			memoryOperationCount: 0,
			qmdOperationCount: 0,
			totalCount: 2,
		});
	});

	it.skipIf(process.platform === "win32")(
		"matches literal-first reads for registered files, uncatalogued shadows, and dangling symlinks",
		() => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "activity-read-selectors-"));
			try {
				for (const name of [
					"AGENTS.md",
					"AGENTS.md:20",
					"AGENTS.md:raw",
					"AGENTS.md%3A20",
					"AGENTS.md:1-20",
					"CASE.md",
					"SKILL.md",
					"CLAUDE.md",
					"CLAUDE.md:raw",
				]) {
					fs.writeFileSync(path.join(cwd, name), name);
				}
				fs.symlinkSync("missing", path.join(cwd, "AGENTS.md:2-10"));
				let now = 0;
				const bus = new ActivityTelemetryBus({ now: () => now });
				const root = bus.registerSession({
					sessionId: "root",
					hasUI: true,
					cwd,
					artifactsDir: "/sessions/root",
					sessionResources: {
						skills: [
							{ name: "tdd", description: "Test-first", path: "SKILL.md" },
							{ name: "literal", description: "Literal filename", path: "CLAUDE.md:raw" },
						],
						contextFiles: [
							{ path: "AGENTS.md" },
							{ path: "AGENTS.md:20" },
							{ path: "AGENTS.md:raw" },
							{ path: "AGENTS.md%3A20" },
							{ path: "CASE.md" },
							{ path: "CLAUDE.md" },
						],
					},
				});
				const reads = [
					{ path: "skill://tdd:50+150", kind: "skill", label: "tdd" },
					{ path: "skill://tdd:raw:2-4", kind: "skill", label: "tdd" },
					{ path: "skill://tdd/reference.md:5-16,20-30", kind: "skill", label: "tdd" },
					{ path: "SKILL.md:raw", kind: "skill", label: "tdd" },
					{ path: "AGENTS.md%3A20:2-4", kind: "context-file", label: "AGENTS.md%3A20" },
					{ path: "AGENTS.md:conflicts", kind: "context-file", label: "AGENTS.md" },
					{ path: "CASE.md:RAW", kind: "context-file", label: "CASE.md" },
					{ path: "AGENTS.md:L2..L4:RaW", kind: "context-file", label: "AGENTS.md" },
					{ path: "AGENTS.md:raw:raw", kind: "context-file", label: "AGENTS.md:raw" },
					{ path: "AGENTS.md:20:30", kind: "context-file", label: "AGENTS.md:20" },
					{ path: "AGENTS.md:raw:raw:2-4", kind: "context-file", label: "AGENTS.md:raw" },
					{ path: "skill://tdd:RAW:L2..L4", kind: "skill", label: "tdd" },
					{
						path: `${pathToFileURL(path.join(cwd, "AGENTS.md")).href}%3A20:2-4`,
						kind: "context-file",
						label: "AGENTS.md:20",
					},
					{
						path: `${pathToFileURL(path.join(cwd, "AGENTS.md%3A20")).href}:2-4`,
						kind: "context-file",
						label: "AGENTS.md%3A20",
					},
					{ path: "skill://tdd?section=rules:raw", kind: "skill", label: "tdd" },
					{ path: "AGENTS.md:raw", kind: "context-file", label: "AGENTS.md:raw" },
					{ path: "AGENTS.md:20", kind: "context-file", label: "AGENTS.md:20" },
					{ path: "CLAUDE.md:raw", kind: "skill", label: "literal" },
				] as const;
				for (const [index, read] of reads.entries()) {
					now++;
					const toolCallId = `selected-${index}`;
					root.startTool({ toolCallId, toolName: "read", args: { path: read.path } });
					root.endTool({ toolCallId, toolName: "read", isError: index === 1 });
				}
				for (const target of [
					"AGENTS.md:1-20",
					"AGENTS.md:2-10",
					"AGENTS.md:unrecognized",
					"AGENTS.md:conflicts:raw",
					"AGENTS.md:-60",
					"AGENTS.md:img",
					"SKILL.md:raw:raw",
				]) {
					root.startTool({ toolCallId: `literal-${target}`, toolName: "read", args: { path: target } });
				}
				expect(root.snapshot().agents[0]?.provenance).toEqual(
					reads.map((read, index) => ({
						id: `selected-${index}:${read.kind}`,
						kind: read.kind,
						label: read.label,
						status: index === 1 ? "error" : "complete",
						startedAt: index + 1,
					})),
				);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	it("records exact memory-operation provenance without exposing arguments", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});

		const operations = [
			["recall", "recall"],
			["reflect", "reflect"],
			["retain", "retain"],
			["memory_edit", "memory edit"],
			["learn", "learn"],
		] as const;
		for (const [toolName, label] of operations) {
			const toolCallId = `memory-${toolName}`;
			const args = { query: "secret query", recordId: "private-record", content: "private content" };
			root.startTool({ toolCallId, toolName, args });
			root.updateTool({ toolCallId, toolName, args });
			root.endTool({ toolCallId, toolName, isError: toolName === "memory_edit" });
			now += 10;
			expect(root.snapshot().agents[0]?.provenance.at(-1)?.label).toBe(label);
		}
		child.startTool({
			toolCallId: "memory-read",
			toolName: "read",
			args: { path: "memory://private-record?query=secret" },
		});
		child.updateTool({
			toolCallId: "memory-read",
			toolName: "read",
			args: { path: "memory://private-record?query=secret" },
		});
		child.endTool({ toolCallId: "memory-read", toolName: "read", isError: true });

		const snapshot = root.snapshot();
		expect(snapshot.agents.find(agent => agent.id === "main")?.provenance).toEqual([
			{ id: "memory-recall:memory", kind: "memory", label: "recall", status: "complete", startedAt: 10 },
			{ id: "memory-reflect:memory", kind: "memory", label: "reflect", status: "complete", startedAt: 20 },
			{ id: "memory-retain:memory", kind: "memory", label: "retain", status: "complete", startedAt: 30 },
			{ id: "memory-memory_edit:memory", kind: "memory", label: "memory edit", status: "error", startedAt: 40 },
			{ id: "memory-learn:memory", kind: "memory", label: "learn", status: "complete", startedAt: 50 },
		]);
		expect(snapshot.agents.find(agent => agent.id === "a1")?.provenance).toEqual([
			{ id: "memory-read:memory", kind: "memory", label: "read", status: "error", startedAt: 60 },
		]);
		expect(snapshot.resourceUsage).toEqual({
			skillInvocationCount: 0,
			contextFileReadCount: 0,
			memoryOperationCount: 6,
			qmdOperationCount: 0,
			totalCount: 6,
		});
		expect(JSON.stringify(snapshot)).not.toContain("secret query");
		expect(JSON.stringify(snapshot)).not.toContain("private-record");
		expect(JSON.stringify(snapshot)).not.toContain("private content");
	});

	it("records direct QMD operations with privacy-safe labels and exact completion status", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const operations = [
			["mcp__qmd_query", "QMD query"],
			["mcp__qmd_get", "QMD get"],
			["mcp__qmd_multi_get", "QMD multi-get"],
			["mcp__qmd_status", "QMD status"],
		] as const;

		for (const [toolName] of operations) {
			const toolCallId = `direct-${toolName}`;
			const args = { query: "secret query", document: "private document", recordId: "private-record" };
			root.startTool({ toolCallId, toolName, args });
			root.updateTool({ toolCallId, toolName, args });
			root.endTool({ toolCallId, toolName, isError: toolName === "mcp__qmd_multi_get" });
			now += 10;
		}

		const snapshot = root.snapshot();
		expect(snapshot.agents[0]?.provenance).toEqual(
			operations.map(([toolName, label], index) => ({
				id: `direct-${toolName}:qmd`,
				kind: "qmd",
				label,
				status: toolName === "mcp__qmd_multi_get" ? "error" : "complete",
				startedAt: 10 + index * 10,
			})),
		);
		expect(snapshot.resourceUsage).toEqual({
			skillInvocationCount: 0,
			contextFileReadCount: 0,
			memoryOperationCount: 0,
			qmdOperationCount: 4,
			totalCount: 4,
		});
		expect(JSON.stringify(snapshot)).not.toContain("secret query");
		expect(JSON.stringify(snapshot)).not.toContain("private document");
		expect(JSON.stringify(snapshot)).not.toContain("private-record");
	});

	it("records QMD bridge writes without treating internal URLs as file activity", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const operations = [
			["xd://mcp__qmd_query", "QMD query"],
			["xd://mcp__qmd_get", "QMD get"],
			["xd://mcp__qmd_multi_get", "QMD multi-get"],
			["xd://mcp__qmd_status", "QMD status"],
		] as const;

		for (const [bridgePath] of operations) {
			const toolCallId = `bridge-${bridgePath}`;
			const args = { path: bridgePath, content: { query: "secret query", document: "private document" } };
			child.startTool({ toolCallId, toolName: "write", args });
			child.updateTool({ toolCallId, toolName: "write", args });
			child.endTool({ toolCallId, toolName: "write", isError: bridgePath.endsWith("status") });
			now += 10;
		}
		child.startTool({
			toolCallId: "ordinary-internal",
			toolName: "write",
			args: { path: "xd://unrelated", content: "private document" },
		});

		const snapshot = root.snapshot();
		expect(snapshot.agents.find(agent => agent.id === "main")?.provenance).toEqual([]);
		expect(snapshot.agents.find(agent => agent.id === "a1")?.provenance).toEqual(
			operations.map(([bridgePath, label], index) => ({
				id: `bridge-${bridgePath}:qmd`,
				kind: "qmd",
				label,
				status: bridgePath.endsWith("status") ? "error" : "complete",
				startedAt: 10 + index * 10,
			})),
		);
		expect(snapshot.agents.find(agent => agent.id === "a1")?.steps.every(step => step.kind === "tool")).toBe(true);
		expect(snapshot.operations).toEqual([]);
		expect(snapshot.resourceUsage).toEqual({
			skillInvocationCount: 0,
			contextFileReadCount: 0,
			memoryOperationCount: 0,
			qmdOperationCount: 4,
			totalCount: 4,
		});
		expect(JSON.stringify(snapshot)).not.toContain("secret query");
		expect(JSON.stringify(snapshot)).not.toContain("private document");
	});

	it("keeps a bounded immutable provenance trail after display expiry and drops evicted agent usage", () => {
		let now = 0;
		const bus = new ActivityTelemetryBus({ now: () => now, activityTrailMs: 8_000, retentionMs: 10_000 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});

		for (let index = 0; index < 40; index++) {
			now = index;
			const event = {
				toolCallId: `skill-${index}`,
				toolName: "read",
				args: { path: `skill://skill-${index}` },
			};
			child.startTool(event);
			child.updateTool(event);
			child.endTool({ toolCallId: event.toolCallId, toolName: event.toolName, isError: false });
		}

		now = 8_040;
		const snapshot = root.snapshot();
		const agent = snapshot.agents.find(candidate => candidate.id === "a1");
		expect(agent?.steps).toEqual([]);
		expect(agent?.provenance.length).toBeGreaterThan(0);
		expect(agent?.provenance.length).toBeLessThan(40);
		expect(agent?.provenance.at(-1)?.label).toBe("skill-39");
		expect(agent?.provenance.map(entry => entry.startedAt)).toEqual(
			[...(agent?.provenance ?? [])].map(entry => entry.startedAt).toSorted((left, right) => left - right),
		);
		expect(Object.isFrozen(agent?.provenance)).toBe(true);
		expect(Object.isFrozen(agent?.provenance[0])).toBe(true);
		expect(snapshot.resourceUsage.skillInvocationCount).toBe(40);
		expect(Object.isFrozen(snapshot.resourceUsage)).toBe(true);

		child.complete();
		now = 18_041;
		expect(root.snapshot().agents.map(candidate => candidate.id)).toEqual(["main"]);
		expect(root.snapshot().resourceUsage.skillInvocationCount).toBe(0);
	});
});
