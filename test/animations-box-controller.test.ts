import { describe, expect, it } from "bun:test";
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { MessageEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
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
		const rows = widget.renderFrame(69).join("\n");
		expect(rows).toContain("cache");
		expect(rows).not.toContain("—     "); // the resting placeholder is gone
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
		expect(activeWidget.renderFrame(69).join("\n")).not.toContain("—     ");
		activeWidget.dispose();

		controller.onSessionSwitch(undefined, ctx);
		// The mount itself is untouched — setWidget was never called again for a teardown.
		expect(calls).toHaveLength(1);

		const afterSwitch = buildWidget(calls[0] as SetWidgetCall);
		expect(afterSwitch.renderFrame(69).join("\n")).toContain("—");
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
		expect(widget.renderFrame(69)).toEqual([]);
		widget.dispose();
	});
});
