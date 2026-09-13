import { describe, expect, it } from "bun:test";
import {
	COMPLETED_DURATION_LIMIT,
	categorizeTool,
	P50_MIN_SAMPLES,
	REPORTED_CATEGORIES,
	TOP_CATEGORY_LIMIT,
	ToolActivityState,
} from "../src/animations-box/tool-activity";

function stateWith(...toolNames: readonly string[]): ToolActivityState {
	const state = new ToolActivityState();
	for (const name of toolNames) state.record(name);
	return state;
}

function recordDuration(
	state: ToolActivityState,
	id: string,
	toolName: string,
	startedAt: number,
	elapsedMs: number,
	isError = false,
): void {
	state.start(id, toolName, startedAt);
	state.end(id, toolName, isError, startedAt + elapsedMs);
}

describe("categorizeTool", () => {
	it("maps builtin file, shell, search, and agent tools to stable categories", () => {
		expect(categorizeTool("read")).toBe("read");
		expect(categorizeTool("edit")).toBe("write");
		expect(categorizeTool("write")).toBe("write");
		expect(categorizeTool("bash")).toBe("bash");
		expect(categorizeTool("grep")).toBe("search");
		expect(categorizeTool("glob")).toBe("search");
		expect(categorizeTool("task")).toBe("agent");
	});

	it("routes MCP bridge names by prefix before builtin suffixes", () => {
		expect(categorizeTool("mcp__qmd_query")).toBe("mcp");
		expect(categorizeTool("mcp__github__read")).toBe("mcp");
	});

	it("normalizes host aliases and falls back to other", () => {
		expect(categorizeTool("Read")).toBe("read");
		expect(categorizeTool("Bash")).toBe("bash");
		expect(categorizeTool("some_plugin_tool")).toBe("other");
	});
});

describe("ToolActivityState — call ledger", () => {
	it("starts with an empty ledger in the research phase", () => {
		const state = new ToolActivityState();
		expect(state.total).toBe(0);
		expect(state.summary()).toEqual({
			total: 0,
			top: [],
			phase: "research",
			phaseRewound: false,
			activeCategory: null,
			activeElapsedMs: 0,
			completedSamples: 0,
			p50Ms: null,
			slowestCategory: null,
			slowestMs: 0,
		});
	});

	it("counts every call but leaves file tools out of the category breakdown", () => {
		const summary = stateWith("read", "read", "edit", "bash").summary();
		expect(summary.total).toBe(4);
		expect(summary.top).toEqual([{ category: "bash", count: 1 }]);
	});

	it("orders reported categories busiest-first, caps them, and breaks ties by display order", () => {
		const summary = stateWith("task", "bash", "grep", "grep", "task", "task", "unknown_tool").summary();
		expect(TOP_CATEGORY_LIMIT).toBe(2);
		expect(REPORTED_CATEGORIES.indexOf("bash")).toBeLessThan(REPORTED_CATEGORIES.indexOf("agent"));
		expect(summary.top).toEqual([
			{ category: "agent", count: 3 },
			{ category: "search", count: 2 },
		]);

		const tie = stateWith("task", "bash").summary();
		expect(tie.top.map(tally => tally.category)).toEqual(["bash", "agent"]);
	});

	it("reuses one live summary while refreshing changed counts", () => {
		const state = stateWith("bash");
		const summary = state.summary();
		expect(state.summary()).toBe(summary);
		state.record("bash");
		expect(state.summary()).toBe(summary);
		expect(summary.top).toEqual([{ category: "bash", count: 2 }]);
	});
});

describe("ToolActivityState — exact execution latency", () => {
	it("reports the oldest active call with rollback-safe elapsed time", () => {
		const state = new ToolActivityState();
		state.start("bash", "bash", 100);
		state.start("read", "read", 200);
		expect(state.summary(500)).toMatchObject({ activeCategory: "bash", activeElapsedMs: 400 });
		expect(state.summary(50)).toMatchObject({ activeCategory: "bash", activeElapsedMs: 0 });

		state.end("bash", "bash", false, 550);
		expect(state.summary(550)).toMatchObject({ activeCategory: "read", activeElapsedMs: 350 });
	});

	it("clamps a completed duration when the clock moves backward", () => {
		const state = new ToolActivityState();
		recordDuration(state, "rollback", "bash", 1_000, -100);
		expect(state.summary()).toMatchObject({
			completedSamples: 1,
			slowestCategory: "bash",
			slowestMs: 0,
		});
	});

	it("withholds p50 until five samples, then reports the median and slowest call", () => {
		const state = new ToolActivityState();
		const durations = [100, 500, 300, 200, 400] as const;
		for (const [index, duration] of durations.entries()) {
			recordDuration(state, String(index), index === 1 ? "bash" : "read", index * 1_000, duration);
			if (index + 1 < P50_MIN_SAMPLES) expect(state.summary().p50Ms).toBeNull();
		}
		expect(state.summary()).toMatchObject({
			completedSamples: 5,
			p50Ms: 300,
			slowestCategory: "bash",
			slowestMs: 500,
		});
	});

	it("bounds completed samples to the newest 32 executions", () => {
		const state = new ToolActivityState();
		recordDuration(state, "dropped", "bash", 0, 1_000);
		for (let duration = 1; duration <= COMPLETED_DURATION_LIMIT; duration++) {
			recordDuration(state, `kept-${duration}`, "read", duration * 2_000, duration);
		}
		expect(state.summary()).toMatchObject({
			completedSamples: COMPLETED_DURATION_LIMIT,
			slowestCategory: "read",
			slowestMs: COMPLETED_DURATION_LIMIT,
		});
	});
});

describe("ToolActivityState — work phase", () => {
	it("advances research to build to verify to handoff without regressing on incidental reads", () => {
		const state = new ToolActivityState();
		recordDuration(state, "research", "read", 0, 10);
		expect(state.summary().phase).toBe("research");

		recordDuration(state, "build", "write", 20, 10);
		expect(state.summary().phase).toBe("build");
		recordDuration(state, "incidental", "grep", 40, 10);
		expect(state.summary().phase).toBe("build");

		recordDuration(state, "verify", "bash", 60, 10);
		expect(state.summary().phase).toBe("verify");
		state.settle();
		expect(state.summary().phase).toBe("handoff");
	});

	it("records a literal rewind when a write follows verification", () => {
		const state = new ToolActivityState();
		recordDuration(state, "write-1", "write", 0, 10);
		recordDuration(state, "verify", "bash", 20, 10);
		state.start("write-2", "edit", 40);
		expect(state.summary()).toMatchObject({ phase: "build", phaseRewound: true });
		state.start("read", "read", 50);
		expect(state.summary()).toMatchObject({ phase: "build", phaseRewound: true });
	});

	it("does not settle after failed verification", () => {
		const state = new ToolActivityState();
		recordDuration(state, "write", "write", 0, 10);
		recordDuration(state, "verify", "bash", 20, 10, true);
		state.settle();
		expect(state.summary().phase).toBe("verify");
	});

	it("resets counts, latency, and phase together", () => {
		const state = stateWith("write", "bash");
		recordDuration(state, "write", "write", 0, 10);
		recordDuration(state, "verify", "bash", 20, 10);
		state.settle();
		state.reset();
		expect(state.summary()).toMatchObject({
			total: 0,
			top: [],
			phase: "research",
			activeCategory: null,
			completedSamples: 0,
			p50Ms: null,
		});
	});
});
