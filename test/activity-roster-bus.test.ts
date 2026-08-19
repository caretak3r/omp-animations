import { describe, expect, it } from "bun:test";
import { ActivityTelemetryBus } from "../src/activity-roster";

describe("ActivityTelemetryBus", () => {
	it("joins root and headless plugin instances into one exact writer roster", () => {
		let now = 100;
		const bus = new ActivityTelemetryBus({ now: () => now, completionFlashMs: 1_200, retentionMs: 300_000 });
		const root = bus.registerSession({
			sessionId: "root-session",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root-session",
			model: "gpt-5.6",
		});
		const agentOne = bus.registerSession({
			sessionId: "agent-session-1",
			hasUI: false,
			cwd: "/repo",
			sessionFile: "/sessions/root-session/a1.jsonl",
			artifactsDir: "/sessions/root-session/a1",
			model: "sonnet",
		});
		const agentTwo = bus.registerSession({
			sessionId: "agent-session-2",
			hasUI: false,
			cwd: "/repo",
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
			artifactsDir: "/sessions/root",
		});
		const agent = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
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

	it("isolates simultaneous root sessions and derives nested ancestry from artifact paths", () => {
		const bus = new ActivityTelemetryBus();
		const first = bus.registerSession({
			sessionId: "root-1",
			hasUI: true,
			cwd: "/one",
			artifactsDir: "/sessions/one",
		});
		const second = bus.registerSession({
			sessionId: "root-2",
			hasUI: true,
			cwd: "/two",
			artifactsDir: "/sessions/two",
		});
		const nested = bus.registerSession({
			sessionId: "nested",
			hasUI: false,
			cwd: "/one",
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
			artifactsDir: "/sessions/one",
		});
		const second = bus.registerSession({
			sessionId: "root-2",
			hasUI: true,
			cwd: "/two",
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
			artifactsDir: "/sessions/root",
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
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
});
