import { describe, expect, it } from "bun:test";
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	MessageEndEvent,
	ToolCallEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type AnimationsBoxContext, AnimationsBoxController, BOX_WIDGET_KEY } from "../src/animations-box/controller";
import { resolveAnimationsBoxConfig } from "../src/animations-box/settings";
import type { AnimationsBoxWidget } from "../src/animations-box/widget";
import type { FrameScheduler } from "../src/kit";

const idTheme = { fg: (_color: string, text: string) => text };
const noopTui = { requestComponentRender: () => {} };

/** Manual frame scheduler: deterministic `now()`, never ticks on its own. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void } {
	let current = 0;
	return {
		now: () => current,
		start: () => () => {},
		advance(ms) {
			current += ms;
		},
	};
}

interface SetWidgetCall {
	key: string;
	content: ExtensionWidgetContent;
	options?: ExtensionWidgetOptions;
}

/** Recording context double + a helper to pull the mounted widget factory back out. */
function recordingContext(overrides: Partial<AnimationsBoxContext> = {}): {
	ctx: AnimationsBoxContext;
	calls: SetWidgetCall[];
} {
	const calls: SetWidgetCall[] = [];
	const ctx: AnimationsBoxContext = {
		hasUI: true,
		isTTY: true,
		env: {},
		cwd: "/repo",
		setWidget: (key, content, options) => {
			calls.push({ key, content, options });
		},
		...overrides,
	};
	return { ctx, calls };
}

/** Builds the widget from the factory `setWidget` was called with, so state-wiring tests can inspect real render output. */
function buildWidget(call: SetWidgetCall): AnimationsBoxWidget {
	const factory = call.content as (tui: unknown, theme: unknown) => AnimationsBoxWidget;
	return factory(noopTui, idTheme);
}

interface UsageOverrides {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function messageEnd(usage: UsageOverrides = {}): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...usage },
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as MessageEndEvent;
}

function toolCall(toolName: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "tc-1", toolName, input: {} } as unknown as ToolCallEvent;
}

function readResult(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-read",
		toolName: "read",
		input: { path },
		content: [],
		isError: false,
		details: { resolvedPath: path },
	} as unknown as ToolResultEvent;
}

function writeResult(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-write",
		toolName: "write",
		input: { path, content: "hello" },
		content: [],
		isError: false,
		details: undefined,
	} as unknown as ToolResultEvent;
}

/** An `edit` tool result carrying one parseable hunk header — feeds both Audit Trail's ledger and Palimpsest's span ledger from the same event. */
function editResult(path: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-edit",
		toolName: "edit",
		input: { path },
		content: [],
		isError: false,
		details: { path, op: "update", diff: "@@ -1,3 +1,5 @@\n" },
	} as unknown as ToolResultEvent;
}

function turnEnd(turnIndex: number): TurnEndEvent {
	return { type: "turn_end", turnIndex, message: {}, toolResults: [] } as unknown as TurnEndEvent;
}

describe("AnimationsBoxController — mount lifecycle", () => {
	it("does nothing when the context has no UI", () => {
		const { ctx, calls } = recordingContext({ hasUI: false });
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		expect(calls).toEqual([]);
	});

	it("mounts exactly once under the namespaced widget key, even across repeated mount() calls", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		controller.mount(ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.key).toBe(BOX_WIDGET_KEY);
		expect(BOX_WIDGET_KEY).toBe("oh-my-pi-animations-box");
	});

	it("defaults placement to belowEditor, and honors an explicit override", () => {
		const { ctx, calls } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		}).mount(ctx);
		expect(calls[0]?.options).toEqual({ placement: "belowEditor" });

		const { ctx: ctx2, calls: calls2 } = recordingContext();
		new AnimationsBoxController({
			scheduler: manualScheduler(),
			placement: "aboveEditor",
			initialConfig: resolveAnimationsBoxConfig({}),
		}).mount(ctx2);
		expect(calls2[0]?.options).toEqual({ placement: "aboveEditor" });
	});

	it("dispose tears down the mount and clears the widget; is idempotent", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		controller.dispose(ctx);
		controller.dispose(ctx);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ key: BOX_WIDGET_KEY, content: undefined, options: { placement: "belowEditor" } });
	});

	it("exposes the initial config unchanged via the read-only accessor", () => {
		const config = resolveAnimationsBoxConfig({ animationsBoxDetail: "simple" });
		const controller = new AnimationsBoxController({ scheduler: manualScheduler(), initialConfig: config });
		expect(controller.config).toBe(config);
	});
});

describe("AnimationsBoxController — cache-meter state wiring", () => {
	it("the mounted widget starts on the resting row before any message_end lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).toContain("cache");
		expect(rows).toContain("—");
		widget.dispose();
	});

	it("onMessageEnd feeds the ledger, flipping the segment to its active row on the next render", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600, cacheWrite: 200 }), ctx);
		const frame = widget.renderFrame(69);
		const cacheRow = frame.find(row => row.includes("cache"));
		expect(cacheRow).toBeDefined();
		expect(cacheRow).not.toContain("—     "); // the resting placeholder is gone, even though the other enabled-but-idle segments still show theirs
		widget.dispose();
	});

	it("ignores every event when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600 }), { hasUI: false });
		expect(widget.renderFrame(69).join("\n")).toContain("—");
		widget.dispose();
	});

	it("a message_end with no usable telemetry (all-zero usage) leaves the segment resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onMessageEnd(messageEnd({ input: 0, cacheRead: 0, cacheWrite: 0 }), ctx);
		expect(widget.renderFrame(69).join("\n")).toContain("—");
		widget.dispose();
	});

	it("onSessionCompact / onAutoCompactionStart attribute a later invalidation to the right cause", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);

		controller.onMessageEnd(messageEnd({ cacheRead: 6_000 }), ctx); // warms the lineage
		controller.onSessionCompact(ctx);
		scheduler.advance(10);
		controller.onMessageEnd(messageEnd({ input: 6_000, cacheWrite: 6_000 }), ctx); // collapses it, cold

		const widget = buildWidget(calls[0] as SetWidgetCall);
		expect(widget.renderFrame(200).join("\n")).toContain("cache");
		widget.dispose();
	});

	it("onSessionSwitch resets the ledger to a fresh, empty state without tearing down the mount", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600 }), ctx);

		const activeWidget = buildWidget(calls[0] as SetWidgetCall);
		const activeCacheRow = activeWidget.renderFrame(69).find(row => row.includes("cache"));
		expect(activeCacheRow).not.toContain("—     ");
		activeWidget.dispose();

		controller.onSessionSwitch(undefined, ctx);
		// The mount itself is untouched — setWidget was never called again for a teardown.
		expect(calls).toHaveLength(1);

		const afterSwitch = buildWidget(calls[0] as SetWidgetCall);
		const restingCacheRow = afterSwitch.renderFrame(69).find(row => row.includes("cache"));
		expect(restingCacheRow).toContain("—");
		afterSwitch.dispose();
	});

	it("respects the enabled gate — a disabled cacheMeter segment never appears, active or resting", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler,
			initialConfig: resolveAnimationsBoxConfig({ cacheMeter: false }),
		});
		controller.mount(ctx);
		controller.onMessageEnd(messageEnd({ input: 400, cacheRead: 600 }), ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).not.toContain("cache");
		widget.dispose();
	});
});

describe("AnimationsBoxController — audit trail state wiring", () => {
	it("the mounted widget starts on the resting row before any tool_result lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toContain("—");
		widget.dispose();
	});

	it("onToolResult(read) feeds the ledger, flipping the segment to its active row", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(readResult("/repo/src/foo.ts"), ctx);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toBeDefined();
		expect(auditRow).not.toContain("—     ");
		widget.dispose();
	});

	it("onToolResult(write) feeds the ledger too", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(writeResult("/repo/src/foo.ts"), ctx);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).not.toContain("—     ");
		widget.dispose();
	});

	it("ignores tool_result when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(readResult("/repo/src/foo.ts"), { hasUI: false, cwd: "/repo" });
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).toContain("—");
		widget.dispose();
	});

	it("onSessionCompact / onAutoCompactionEnd run cleanly as Audit Trail's recovery-correlation signal", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onToolResult(readResult("/repo/src/foo.ts"), ctx);
		controller.onSessionCompact(ctx);
		controller.onAutoCompactionEnd(ctx);

		const widget = buildWidget(calls[0] as SetWidgetCall);
		const auditRow = widget.renderFrame(69).find(row => row.includes("audit"));
		expect(auditRow).not.toContain("—     ");
		widget.dispose();
	});

	it("onSessionSwitch resets the ledger to a fresh, empty state without tearing down the mount", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		controller.onToolResult(readResult("/repo/src/foo.ts"), ctx);

		const activeWidget = buildWidget(calls[0] as SetWidgetCall);
		const activeAuditRow = activeWidget.renderFrame(69).find(row => row.includes("audit"));
		expect(activeAuditRow).not.toContain("—     ");
		activeWidget.dispose();

		controller.onSessionSwitch(undefined, ctx);
		expect(calls).toHaveLength(1); // the mount itself is untouched

		const afterSwitch = buildWidget(calls[0] as SetWidgetCall);
		const restingAuditRow = afterSwitch.renderFrame(69).find(row => row.includes("audit"));
		expect(restingAuditRow).toContain("—");
		afterSwitch.dispose();
	});
});

describe("AnimationsBoxController — tool constellation state wiring", () => {
	it("the mounted widget starts on the resting row before any tool_call lands", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const toolsRow = widget.renderFrame(69).find(row => row.includes("tools"));
		expect(toolsRow).toContain("—");
		widget.dispose();
	});

	it("onToolCall fires a star, flipping the segment to its active row", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("read"), ctx);
		const toolsRow = widget.renderFrame(69).find(row => row.includes("tools"));
		expect(toolsRow).toBeDefined();
		expect(toolsRow).not.toContain("—     ");
		widget.dispose();
	});

	it("ignores tool_call when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolCall(toolCall("read"), { hasUI: false });
		const toolsRow = widget.renderFrame(69).find(row => row.includes("tools"));
		expect(toolsRow).toContain("—");
		widget.dispose();
	});
});

describe("AnimationsBoxController — palimpsest state wiring", () => {
	it("the mounted widget starts on the resting row before any region crosses GLOW_THRESHOLD", () => {
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({
			scheduler: manualScheduler(),
			initialConfig: resolveAnimationsBoxConfig({}),
		});
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);
		const filesRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(filesRow).toContain("—");
		widget.dispose();
	});

	it("a second onToolResult(edit) touch on the same region flips the segment to its active row, and onTurnEnd fades it back out", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		const oneTouchRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(oneTouchRow).toContain("—"); // one touch alone doesn't cross GLOW_THRESHOLD

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		const twoTouchRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(twoTouchRow).not.toContain("—     ");

		// FADE_AFTER_TURNS turns without a re-touch and the region ages back out.
		for (let turn = 1; turn <= 3; turn++) controller.onTurnEnd(turnEnd(turn), ctx);
		const fadedRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(fadedRow).toContain("—");
		widget.dispose();
	});

	it("ignores tool_result when hasUI is false", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(editResult("/repo/src/foo.ts"), { hasUI: false, cwd: "/repo" });
		controller.onToolResult(editResult("/repo/src/foo.ts"), { hasUI: false, cwd: "/repo" });
		const filesRow = widget.renderFrame(69).find(row => row.includes("files"));
		expect(filesRow).toContain("—");
		widget.dispose();
	});

	it("one edit tool_result feeds both Audit Trail's ledger and Palimpsest's span ledger from the same event", () => {
		const scheduler = manualScheduler();
		const { ctx, calls } = recordingContext();
		const controller = new AnimationsBoxController({ scheduler, initialConfig: resolveAnimationsBoxConfig({}) });
		controller.mount(ctx);
		const widget = buildWidget(calls[0] as SetWidgetCall);

		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);
		controller.onToolResult(editResult("/repo/src/foo.ts"), ctx);

		const frame = widget.renderFrame(69);
		const auditRow = frame.find(row => row.includes("audit"));
		const filesRow = frame.find(row => row.includes("files"));
		expect(auditRow).not.toContain("—     ");
		expect(filesRow).not.toContain("—     ");
		widget.dispose();
	});
});
