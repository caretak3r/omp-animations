// The box-owned tally behind the required `tools` row — the only surviving piece of the
// deleted Tool Constellation (`omp-animations-buv.4`). The row's rendered phrase is
// covered in `animations-box-segments.test.ts`; this file pins the counting contract
// itself: classification, the reported-category restriction, and the derived summary.
import { describe, expect, it } from "bun:test";
import {
	categorizeTool,
	REPORTED_CATEGORIES,
	TOP_CATEGORY_LIMIT,
	ToolActivityState,
} from "../src/animations-box/tool-activity";

function stateWith(...toolNames: readonly string[]): ToolActivityState {
	const state = new ToolActivityState();
	for (const name of toolNames) state.record(name);
	return state;
}

describe("categorizeTool", () => {
	it("maps the builtin file, shell, search and agent tools to their categories", () => {
		expect(categorizeTool("read")).toBe("read");
		expect(categorizeTool("edit")).toBe("write");
		expect(categorizeTool("write")).toBe("write");
		expect(categorizeTool("bash")).toBe("bash");
		expect(categorizeTool("grep")).toBe("search");
		expect(categorizeTool("glob")).toBe("search");
		expect(categorizeTool("task")).toBe("agent");
	});

	it("routes every mcp bridge name to mcp on the prefix alone, whatever the server calls its tool", () => {
		expect(categorizeTool("mcp__qmd_query")).toBe("mcp");
		expect(categorizeTool("mcp__github__read")).toBe("mcp"); // the `read` suffix must not win
	});

	it("falls back to other for tools it does not know", () => {
		expect(categorizeTool("some_plugin_tool")).toBe("other");
	});

	it("normalizes host aliases through normalizeToolName rather than matching raw names", () => {
		expect(categorizeTool("Read")).toBe("read");
		expect(categorizeTool("Bash")).toBe("bash");
	});
});

describe("ToolActivityState", () => {
	it("starts empty: no total, no breakdown", () => {
		const state = new ToolActivityState();
		expect(state.total).toBe(0);
		expect(state.summary()).toEqual({ total: 0, top: [] });
	});

	it("counts every call in the total, file tools included", () => {
		expect(stateWith("read", "write", "bash").total).toBe(3);
	});

	it("keeps read and write out of the breakdown — the audit row reports those from the ledger", () => {
		const summary = stateWith("read", "read", "read", "edit", "bash").summary();
		expect(summary.total).toBe(5);
		expect(summary.top).toEqual([{ category: "bash", count: 1 }]);
	});

	it("leaves the breakdown empty when only file tools have fired", () => {
		expect(stateWith("read", "write").summary()).toEqual({ total: 2, top: [] });
	});

	it("orders the breakdown busiest-first and caps it at TOP_CATEGORY_LIMIT", () => {
		const summary = stateWith("bash", "grep", "grep", "task", "task", "task", "unknown_tool").summary();
		expect(TOP_CATEGORY_LIMIT).toBe(2);
		expect(summary.top).toEqual([
			{ category: "agent", count: 3 },
			{ category: "search", count: 2 },
		]);
	});

	it("breaks ties by REPORTED_CATEGORIES order, not by which category fired first", () => {
		expect(REPORTED_CATEGORIES.indexOf("bash")).toBeLessThan(REPORTED_CATEGORIES.indexOf("agent"));
		const summary = stateWith("task", "bash").summary();
		expect(summary.top.map(tally => tally.category)).toEqual(["bash", "agent"]);
	});

	it("re-derives the summary after a new call and reuses the same object until then", () => {
		const state = stateWith("bash");
		const first = state.summary();
		expect(state.summary()).toBe(first); // memoized: the per-frame render path never re-sorts

		state.record("bash");
		const second = state.summary();
		expect(second).not.toBe(first);
		expect(second.top).toEqual([{ category: "bash", count: 2 }]);
	});
});
