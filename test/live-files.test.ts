import { describe, expect, it } from "bun:test";
import { buildLiveFilesSegment, LiveFilesState } from "../src/live-files";
import { buildLiveFilesSnapshotSegment } from "../src/live-files/render";

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

	it("renders collision-free snapshots byte-identically regardless of collidingPaths presence", () => {
		const withoutField = buildLiveFilesSnapshotSegment(
			{ entries: [{ owner: "main", path: "a.ts", tool: "edit", startedAt: 10 }] },
			1,
		);
		const withEmptyField = buildLiveFilesSnapshotSegment(
			{ entries: [{ owner: "main", path: "a.ts", tool: "edit", startedAt: 10 }], collidingPaths: [] },
			1,
		);
		expect(withoutField).toEqual(withEmptyField);
		expect(withoutField.line.dot).toBe("live");
		expect(withoutField.line.spans.some(span => span.tone === "alert")).toBeFalse();
	});

	it("escalates dot to alert and marks colliding path spans when distinct agents write to one path", () => {
		const snapshot = buildLiveFilesSnapshotSegment(
			{
				entries: [
					{ owner: "agentA", path: "shared.ts", tool: "edit", startedAt: 10 },
					{ owner: "agentB", path: "shared.ts", tool: "write", startedAt: 11 },
					{ owner: "agentA", path: "solo.ts", tool: "edit", startedAt: 12 },
				],
				collidingPaths: ["shared.ts"],
			},
			1,
		);
		expect(snapshot.line.dot).toBe("alert");
		const sharedSpan = snapshot.line.spans.find(span => span.text === "shared.ts");
		expect(sharedSpan?.tone).toBe("alert");
		const soloSpan = snapshot.line.spans.find(span => span.text === "solo.ts");
		expect(soloSpan?.tone).toBeUndefined();
		const clashSpan = snapshot.line.spans.find(span => span.key === "clash");
		expect(clashSpan?.text).toBe("2 writers");
	});

	it("clears alert when collision resolves without oscillation", () => {
		const colliding = buildLiveFilesSnapshotSegment(
			{
				entries: [
					{ owner: "agentA", path: "file.ts", tool: "edit", startedAt: 10 },
					{ owner: "agentB", path: "file.ts", tool: "edit", startedAt: 11 },
				],
				collidingPaths: ["file.ts"],
			},
			1,
		);
		expect(colliding.line.dot).toBe("alert");

		const resolved = buildLiveFilesSnapshotSegment(
			{ entries: [{ owner: "agentA", path: "file.ts", tool: "edit", startedAt: 10 }], collidingPaths: [] },
			1,
		);
		expect(resolved.line.dot).toBe("live");
		expect(resolved.line.spans.some(span => span.tone === "alert")).toBeFalse();
		expect(resolved.line.spans.some(span => span.key === "clash")).toBeFalse();
	});
});
