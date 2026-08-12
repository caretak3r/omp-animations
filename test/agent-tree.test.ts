import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentRef, RegistryEvent } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	AGENT_TREE_POLL_MS,
	type AgentRegistryLike,
	type AgentTreeContext,
	AgentTreeController,
} from "../src/agent-tree/controller";
import { createAgentTreeExtension } from "../src/agent-tree/index";
import {
	type AgentTreeRef,
	type AgentTreeSnapshot,
	type AgentTreeStatus,
	buildAgentTree,
	GIST_MAX_CHARS,
	MAX_TREE_ROWS,
	normalizeAgentLine,
} from "../src/agent-tree/state";
import { type AgentTreeTheme, type AgentTreeWidget, renderAgentTreeRows } from "../src/agent-tree/widget";
import { FlashTracker } from "../src/animations-box/status-line";
import type { FrameScheduler } from "../src/kit";

const TREE_SYMBOLS = {
	"tree.branch": "├─",
	"tree.last": "└─",
	"tree.vertical": "│",
} as const;

const idTheme: AgentTreeTheme = {
	fg: (_color, text) => text,
	bold: text => text,
	symbol: key => TREE_SYMBOLS[key as keyof typeof TREE_SYMBOLS] ?? "",
};

const taggedTheme: AgentTreeTheme = {
	fg: (color, text) => `${color}:${text}`,
	bold: text => `B(${text})`,
	symbol: key => TREE_SYMBOLS[key as keyof typeof TREE_SYMBOLS] ?? "",
};

function treeRef(
	id: string,
	options: {
		kind?: "main" | "sub" | "advisor";
		parentId?: string;
		createdAt?: number;
		status?: AgentTreeStatus;
		activity?: string;
		name?: string;
	} = {},
): AgentTreeRef {
	return {
		id,
		kind: options.kind ?? (id === "Main" ? "main" : "sub"),
		parentId: options.parentId,
		createdAt: options.createdAt ?? 0,
		status: options.status ?? "running",
		activity: options.activity,
		displayName: options.name ?? id,
	};
}

function liveRef(
	id: string,
	options: {
		kind?: "main" | "sub" | "advisor";
		parentId?: string;
		createdAt?: number;
		status?: AgentTreeStatus;
		activity?: string;
		name?: string;
		model?: string;
		task?: string;
		live?: boolean;
	} = {},
): AgentRef {
	const base = treeRef(id, options);
	return {
		...base,
		summary: null,
		session:
			options.live === false
				? null
				: {
						model: options.model === undefined ? undefined : { id: options.model },
						messages: options.task === undefined ? [] : [{ role: "user", content: options.task, timestamp: 0 }],
					},
	} as unknown as AgentRef;
}

class FakeRegistry implements AgentRegistryLike {
	refs: AgentRef[];
	listCalls = 0;
	#listeners = new Set<(event: RegistryEvent) => void>();

	constructor(refs: AgentRef[]) {
		this.refs = refs;
	}

	list(): AgentRef[] {
		this.listCalls++;
		return this.refs;
	}

	onChange(listener: (event: RegistryEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get listenerCount(): number {
		return this.#listeners.size;
	}

	emitRegistered(ref: AgentRef): void {
		const event = { type: "registered", ref, generation: 1 } as RegistryEvent;
		for (const listener of this.#listeners) listener(event);
	}

	emitStatus(ref: AgentRef, previousStatus: AgentTreeStatus): void {
		const event = { type: "status_changed", ref, previousStatus } as RegistryEvent;
		for (const listener of this.#listeners) listener(event);
	}

	emitRemoved(ref: AgentRef): void {
		const event = { type: "removed", ref, generation: 1 } as RegistryEvent;
		for (const listener of this.#listeners) listener(event);
	}
}

function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

interface WidgetCall {
	readonly key: string;
	readonly content: ExtensionWidgetContent;
}

function recordingContext(overrides: Partial<AgentTreeContext> = {}): {
	ctx: AgentTreeContext;
	calls: WidgetCall[];
} {
	const calls: WidgetCall[] = [];
	const ctx: AgentTreeContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		motionSetting: "full",
		theme: idTheme,
		glyphPreset: "unicode",
		setWidget: (key, content) => calls.push({ key, content }),
		...overrides,
	};
	return { ctx, calls };
}

class RecordingTui {
	requests = 0;
	renderUnderPressure = false;
	requestComponentRender(): void {
		this.requests++;
	}
}

function instantiateWidget(call: WidgetCall, tui = new RecordingTui()): { widget: AgentTreeWidget; tui: RecordingTui } {
	if (typeof call.content !== "function") throw new Error("Expected an Agent Tree widget factory");
	const widget = call.content(tui as never, idTheme as Theme) as AgentTreeWidget;
	return { widget, tui };
}

function renderContext(overrides: Partial<Parameters<typeof renderAgentTreeRows>[2]> = {}) {
	return {
		theme: idTheme,
		glyphPreset: "unicode" as const,
		accent: "accent" as const,
		now: 0,
		flashTier: "off" as const,
		...overrides,
	};
}

describe("Agent Tree state", () => {
	it("builds a stable depth-first tree and excludes advisors, orphans, and restored parked refs", () => {
		const refs = [
			treeRef("Main", { createdAt: 1 }),
			treeRef("beta", { parentId: "Main", createdAt: 3 }),
			treeRef("alpha", { parentId: "Main", createdAt: 2 }),
			treeRef("nested", { parentId: "alpha", createdAt: 4 }),
			treeRef("advisor", { kind: "advisor", parentId: "Main", createdAt: 0 }),
			treeRef("orphan", { parentId: "missing", createdAt: 5 }),
			treeRef("restored", { parentId: "Main", createdAt: 6, status: "parked" }),
			treeRef("known-parked", { parentId: "Main", createdAt: 7, status: "parked" }),
		];
		const snapshot = buildAgentTree(refs, { seen: new Set(["known-parked"]) });

		expect(snapshot.nodes.map(node => node.id)).toEqual(["Main", "alpha", "nested", "beta", "known-parked"]);
		expect(snapshot.nodes.map(node => node.depth)).toEqual([0, 1, 2, 1, 1]);
		expect(snapshot.nodes[2]?.ancestorsLast).toEqual([false]);
		expect(snapshot.nodes[4]).toMatchObject({ isLast: true, status: "parked" });
		expect(snapshot.visible).toBe(true);
	});

	it("caps agent rows, reports overflow, and bounds display text before width fitting", () => {
		const refs = [
			treeRef("Main", { name: "Main\tAgent" }),
			...Array.from({ length: 10 }, (_, index) =>
				treeRef(`sub-${index}`, {
					parentId: "Main",
					createdAt: index + 1,
					activity: index === 0 ? "x".repeat(GIST_MAX_CHARS + 50) : undefined,
				}),
			),
		];
		const snapshot = buildAgentTree(refs);

		expect(snapshot.nodes).toHaveLength(MAX_TREE_ROWS);
		expect(snapshot.hiddenCount).toBe(3);
		expect(snapshot.nodes[0]?.name).toBe("Main Agent");
		expect(snapshot.nodes[1]?.gist?.length).toBe(GIST_MAX_CHARS);
		expect(snapshot.nodes[1]?.gist?.endsWith("…")).toBe(true);
	});

	it("removes terminal controls and truncates without splitting astral code points", () => {
		const normalized = normalizeAgentLine("\u001b]52;c;secret\u0007safe\u202e😀😀😀", 6);
		expect(normalized).toBe("safe😀…");
		expect(normalized).not.toMatch(/[\p{Cc}\p{Cf}]/u);
		expect(normalized).not.toContain("secret");
	});
});

describe("Agent Tree renderer", () => {
	const snapshot: AgentTreeSnapshot = {
		visible: true,
		hiddenCount: 0,
		nodes: [
			{
				id: "Main",
				name: "Main",
				depth: 0,
				isLast: true,
				ancestorsLast: [],
				status: "running",
				modelTail: "sonnet",
				gist: "coordinating",
			},
			{
				id: "alpha",
				name: "Alpha",
				depth: 1,
				isLast: true,
				ancestorsLast: [],
				status: "running",
				modelTail: "claude",
				gist: "streaming implementation details",
				task: "investigate thing",
			},
		],
	};

	it("uses theme tree symbols and applies the task, gist, then model width ladder", () => {
		const wide = renderAgentTreeRows(snapshot, 200, renderContext());
		expect(wide[1]).toContain("└─ ●  Alpha");
		expect(wide[1]).toContain("claude");
		expect(wide[1]).toContain("streaming implementation details");
		expect(wide[1]).toContain("· investigate thing");

		const withoutTaskWidth = visibleWidth(wide[1] as string) - visibleWidth("  · investigate thing");
		const withoutTask = renderAgentTreeRows(snapshot, withoutTaskWidth, renderContext());
		expect(withoutTask[1]).toContain("streaming implementation details");
		expect(withoutTask[1]).not.toContain("investigate thing");

		const shortened = renderAgentTreeRows(snapshot, 35, renderContext());
		expect(shortened[1]).toContain("claude");
		expect(shortened[1]).not.toContain("streaming implementation details");
		expect(visibleWidth(shortened[1] as string)).toBeLessThanOrEqual(35);

		const withoutModel = renderAgentTreeRows(snapshot, 20, renderContext());
		expect(withoutModel[1]).not.toContain("claude");
		expect(withoutModel[1]).toContain("str");
		expect(visibleWidth(withoutModel[1] as string)).toBeLessThanOrEqual(20);
	});

	it("continues ancestor connector columns for nested agents", () => {
		const nested: AgentTreeSnapshot = {
			visible: true,
			hiddenCount: 0,
			nodes: [
				snapshot.nodes[0]!,
				{ ...snapshot.nodes[1]!, isLast: false },
				{
					...snapshot.nodes[1]!,
					id: "nested",
					name: "Nested",
					depth: 2,
					ancestorsLast: [false],
				},
				{ ...snapshot.nodes[1]!, id: "beta", name: "Beta", isLast: true },
			],
		};
		const rows = renderAgentTreeRows(nested, 200, renderContext());
		expect(rows[2]).toContain("│  └─ ●  Nested");
	});

	it("flashes new and changed spans, then returns them to their resting style", () => {
		const flash = new FlashTracker();
		const seenIds = new Set<string>();
		const initial = renderAgentTreeRows(
			snapshot,
			200,
			renderContext({ theme: taggedTheme, flash, seenIds, flashTier: "full", now: 0 }),
		);
		expect(initial[1]).toContain("B(accent:Alpha)");
		expect(initial[1]).toContain("B(accent:streaming implementation details)");

		const settled = renderAgentTreeRows(
			snapshot,
			200,
			renderContext({ theme: taggedTheme, flash, seenIds, flashTier: "full", now: 800 }),
		);
		expect(settled[1]).not.toContain("B(accent:Alpha)");
		expect(settled[1]).toContain("streaming implementation details");

		const activityChanged: AgentTreeSnapshot = {
			...snapshot,
			nodes: snapshot.nodes.map(node => (node.id === "alpha" ? { ...node, gist: "reviewing tests" } : node)),
		};
		const activityFlash = renderAgentTreeRows(
			activityChanged,
			200,
			renderContext({ theme: taggedTheme, flash, seenIds, flashTier: "full", now: 801 }),
		);
		expect(activityFlash[1]).toContain("B(accent:reviewing tests)");

		const statusChanged: AgentTreeSnapshot = {
			...activityChanged,
			nodes: activityChanged.nodes.map(node =>
				node.id === "alpha" ? { ...node, gist: undefined, status: "idle" } : node,
			),
		};
		const statusFlash = renderAgentTreeRows(
			statusChanged,
			200,
			renderContext({ theme: taggedTheme, flash, seenIds, flashTier: "full", now: 802 }),
		);
		expect(statusFlash[1]).toContain("B(accent:○)");
	});

	it("keeps aborted status as a persistent alert and appends the overflow tail", () => {
		const aborted: AgentTreeSnapshot = {
			visible: true,
			hiddenCount: 4,
			nodes: [{ ...snapshot.nodes[0]!, status: "aborted" }],
		};
		const rows = renderAgentTreeRows(aborted, 80, renderContext({ theme: taggedTheme }));
		expect(rows[0]).toContain("B(error:●)");
		expect(rows[1]).toContain("… +4 more");
	});

	it("uses parked as the model fallback only when no cached model remains", () => {
		const parked: AgentTreeSnapshot = {
			visible: true,
			hiddenCount: 0,
			nodes: [{ ...snapshot.nodes[0]!, status: "parked", modelTail: undefined, gist: undefined }],
		};
		const rows = renderAgentTreeRows(parked, 80, renderContext());
		expect(rows[0]).toContain("(parked)");
	});
});

describe("AgentTreeController", () => {
	it("mounts on the first subagent, polls activity on the shared frame clock, and tears down on removal", () => {
		const main = liveRef("Main", { model: "anthropic/sonnet" });
		let child = liveRef("alpha", {
			parentId: "Main",
			createdAt: 1,
			activity: "reading source",
			model: "anthropic/haiku",
			task: "Inspect\tthe source\ncarefully",
		});
		const registry = new FakeRegistry([main]);
		const scheduler = manualScheduler();
		const controller = new AgentTreeController(registry, { scheduler });
		const { ctx, calls } = recordingContext();
		controller.mount(ctx);
		expect(calls).toHaveLength(0);
		expect(registry.listenerCount).toBe(1);

		registry.refs = [main, child];
		registry.emitRegistered(child);
		expect(calls).toHaveLength(1);
		const mounted = instantiateWidget(calls[0] as WidgetCall);
		expect(mounted.widget.render(200).join("\n")).toContain("Inspect the source carefully");
		expect(scheduler.running).toBe(true);

		child = liveRef("alpha", {
			parentId: "Main",
			createdAt: 1,
			activity: "writing tests",
			model: "anthropic/haiku",
			task: "Inspect the source carefully",
		});
		registry.refs = [main, child];
		const callsBeforePoll = registry.listCalls;
		scheduler.advance(AGENT_TREE_POLL_MS - 1);
		expect(registry.listCalls).toBe(callsBeforePoll);
		scheduler.advance(1);
		expect(registry.listCalls).toBe(callsBeforePoll + 1);
		expect(mounted.widget.render(200).join("\n")).toContain("writing tests");

		const idle = liveRef("alpha", {
			parentId: "Main",
			createdAt: 1,
			status: "idle",
			model: "anthropic/haiku",
		});
		registry.refs = [main, idle];
		registry.emitStatus(idle, "running");
		expect(mounted.tui.requests).toBeGreaterThan(0);
		expect(mounted.widget.render(200).join("\n")).toContain("(idle)");

		const parked = liveRef("alpha", {
			parentId: "Main",
			createdAt: 1,
			status: "parked",
			live: false,
		});
		registry.refs = [main, parked];
		registry.emitStatus(parked, "idle");
		const parkedRow = mounted.widget.render(200).join("\n");
		expect(parkedRow).toContain("haiku");
		expect(parkedRow).toContain("Inspect the source carefully");

		registry.refs = [main];
		registry.emitRemoved(parked);
		expect(calls.at(-1)?.content).toBeUndefined();
		expect(scheduler.running).toBe(false);

		const reappeared = liveRef("alpha", {
			parentId: "Main",
			createdAt: 1,
			activity: "new lifecycle",
		});
		registry.refs = [main, reappeared];
		registry.emitRegistered(reappeared);
		const remounted = instantiateWidget(calls.at(-1) as WidgetCall);
		const remountedRow = remounted.widget.render(200).join("\n");
		expect(remountedRow).toContain("new lifecycle");
		expect(remountedRow).not.toContain("haiku");
		expect(remountedRow).not.toContain("Inspect the source carefully");

		controller.dispose();
		expect(registry.listenerCount).toBe(0);
	});

	it("captures the live theme preset from the session context", () => {
		const registry = new FakeRegistry([liveRef("Main"), liveRef("alpha", { parentId: "Main", createdAt: 1 })]);
		const controller = new AgentTreeController(registry);
		const { ctx, calls } = recordingContext({ glyphPreset: "ascii" });
		controller.mount(ctx);
		const mounted = instantiateWidget(calls[0] as WidgetCall);
		expect(mounted.widget.render(100).join("\n")).toContain("*  alpha");
		controller.dispose();
	});

	it("resets and remounts against the new context on session switch", () => {
		const refs = [liveRef("Main"), liveRef("alpha", { parentId: "Main", createdAt: 1 })];
		const registry = new FakeRegistry(refs);
		const controller = new AgentTreeController(registry);
		const first = recordingContext();
		const second = recordingContext();
		controller.mount(first.ctx);
		expect(first.calls).toHaveLength(1);

		controller.onSessionSwitch(second.ctx);
		expect(first.calls.at(-1)?.content).toBeUndefined();
		expect(second.calls).toHaveLength(1);
		expect(registry.listenerCount).toBe(1);
		controller.dispose();
	});

	it("keeps decorative motion off while activity continues to poll", () => {
		const main = liveRef("Main");
		let child = liveRef("alpha", { parentId: "Main", activity: "first activity" });
		const registry = new FakeRegistry([main, child]);
		const scheduler = manualScheduler();
		const controller = new AgentTreeController(registry, { scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });
		controller.mount(ctx);
		const mounted = instantiateWidget(calls[0] as WidgetCall);
		expect(scheduler.running).toBe(true);
		expect(mounted.widget.render(100).join("\n")).toContain("first activity");

		child = liveRef("alpha", { parentId: "Main", activity: "poll refresh" });
		registry.refs = [main, child];
		const callsBeforePoll = registry.listCalls;
		scheduler.advance(AGENT_TREE_POLL_MS - 1);
		expect(registry.listCalls).toBe(callsBeforePoll);
		scheduler.advance(1);
		expect(registry.listCalls).toBe(callsBeforePoll + 1);
		expect(mounted.widget.render(100).join("\n")).toContain("poll refresh");

		child = liveRef("alpha", { parentId: "Main", activity: "pressure-delayed" });
		registry.refs = [main, child];
		mounted.tui.renderUnderPressure = true;
		const callsBeforePressure = registry.listCalls;
		scheduler.advance(AGENT_TREE_POLL_MS);
		expect(registry.listCalls).toBe(callsBeforePressure);
		mounted.tui.renderUnderPressure = false;
		scheduler.advance(AGENT_TREE_POLL_MS);
		expect(registry.listCalls).toBe(callsBeforePressure + 1);
		expect(mounted.widget.render(100).join("\n")).toContain("pressure-delayed");
		controller.dispose();
		expect(scheduler.running).toBe(false);
	});

	it("stays inert when no UI exists", () => {
		const registry = new FakeRegistry([liveRef("Main"), liveRef("alpha", { parentId: "Main" })]);
		const controller = new AgentTreeController(registry);
		const { ctx, calls } = recordingContext({ hasUI: false });
		controller.mount(ctx);
		expect(registry.listCalls).toBe(0);
		expect(registry.listenerCount).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe("Agent Tree extension factory", () => {
	it("registers no handlers when a legacy API stub has no registry", () => {
		const events: string[] = [];
		const api = { on: (event: string) => events.push(event) } as unknown as ExtensionAPI;
		createAgentTreeExtension()(api);
		expect(events).toEqual([]);
	});

	it("registers the complete session lifecycle when a registry is available", () => {
		const events: string[] = [];
		const registry = new FakeRegistry([]);
		const api = { on: (event: string) => events.push(event) } as unknown as ExtensionAPI;
		createAgentTreeExtension({ registry })(api);
		expect(events).toEqual(["session_start", "session_switch", "session_shutdown"]);
	});
});
