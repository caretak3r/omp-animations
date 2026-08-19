import { describe, expect, it } from "bun:test";
import { buildLiveFilesSegment, LiveFilesState } from "../src/live-files";

function taskProgress(
	id: string,
	status: "running" | "completed",
	currentTool?: string,
	currentToolArgs?: string,
): unknown {
	return { details: { progress: [{ index: 0, id, status, currentTool, currentToolArgs }] } };
}

describe("LiveFilesState", () => {
	it("tracks only in-flight main edit/write calls and resolves project paths", () => {
		const state = new LiveFilesState(() => 10);
		state.onToolCall({ toolCallId: "read", toolName: "read", input: { path: "/repo/a.ts" } }, "/repo");
		state.onToolCall({ toolCallId: "edit", toolName: "edit", input: { path: "/repo/src/a.ts" } }, "/repo");
		expect(state.snapshot().entries).toEqual([{ owner: "main", path: "src/a.ts", tool: "edit", startedAt: 10 }]);

		state.onToolResult("edit");
		expect(state.snapshot().entries).toEqual([]);
	});

	it("extracts every file from a hashline patch without turning the row into edit history", () => {
		const state = new LiveFilesState();
		state.onToolCall(
			{
				toolCallId: "patch",
				toolName: "edit",
				input: { patch: "[/repo/src/a.ts#A1B2]\nPUT 1.=1:\n+x\n[/repo/src/b.ts#C3D4]\nPUT 2.=2:\n+y" },
			},
			"/repo",
		);
		expect(state.snapshot().entries.map(entry => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
		state.onToolResult("patch");
		expect(state.snapshot().entries).toEqual([]);
	});

	it("projects concurrent task-agent writes and removes a worker when its active tool changes", () => {
		const state = new LiveFilesState();
		state.onTaskProgress("task", taskProgress("worker-a", "running", "edit", '{"path":"/repo/a.ts"}'), "/repo");
		state.onTaskProgress("task", taskProgress("worker-b", "running", "write", '{"path":"/repo/b.ts"}'), "/repo");
		expect(
			state
				.snapshot()
				.entries.map(entry => entry.path)
				.sort(),
		).toEqual(["a.ts", "b.ts"]);

		state.onTaskProgress("task", taskProgress("worker-a", "running", "bash", "bun check"), "/repo");
		expect(state.snapshot().entries.map(entry => entry.path)).toEqual(["b.ts"]);
	});

	it("renders paths only and keeps the idle row explicit for the Audit Box", () => {
		const state = new LiveFilesState();
		state.onToolCall({ toolCallId: "edit", toolName: "edit", input: { path: "/repo/src/a.ts" } }, "/repo");
		const active = buildLiveFilesSegment(state, 1);
		expect(active.line.spans.map(span => span.text)).toEqual(["src/a.ts"]);
		expect(active.variants).toEqual(["src/a.ts", "a.ts"]);
		state.onToolResult("edit");
		expect(buildLiveFilesSegment(state, 1).active).toBeFalse();
	});
});
