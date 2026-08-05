import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { ConstellationState } from "./state";
import { type ConstellationTheme, renderConstellationTally, ToolConstellationWidget } from "./widget";

const WIDGET_KEY = "tool-constellation";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface ToolConstellationContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: ConstellationTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "static" };

/**
 * The {@link AnimationHost} backpressure field must be wired at construction,
 * before the widget factory supplies the real `tui` — this adapter lets the
 * host read a live signal once {@link attach} runs from inside that factory.
 */
function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: object): void } {
	let live: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return live?.underPressure ?? false;
			},
		},
		attach(tui) {
			live = backpressureFromTui(tui);
		},
	};
}

/**
 * Drives the tool-activity star map: mounts once, on the first `tool_call`
 * seen this session, and keeps a single shared {@link ConstellationState} for
 * the rest of the session (stars spawn lazily per tool the session actually
 * uses, so an idle session stays an empty sky). Motion gating goes through
 * the kit's {@link MotionPolicy}; a resolved tier of `off` (setting off,
 * non-TTY, `NO_COLOR`/`CI`/dumb terminal) renders a single static tally line
 * instead of an animated widget and repaints it directly on every fire —
 * there is no frame clock in that mode to pick the change up on its own.
 *
 * Fire timestamps and the widget's render clock both read the same injected
 * {@link FrameScheduler}, not the {@link AnimationHost}'s internal relative
 * clock — the host only drives repaint cadence here, so star decay math stays
 * correct regardless of exactly when the UI layer invokes the widget factory.
 */
export class ToolConstellationController {
	#scheduler: FrameScheduler;
	#state = new ConstellationState();
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;

	constructor(options: { scheduler?: FrameScheduler; placement?: WidgetPlacement } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): ConstellationState {
		return this.#state;
	}

	onToolCall(event: ToolCallEvent, ctx: ToolConstellationContext): void {
		if (!ctx.hasUI) return;
		this.#state.recordFire(event.toolName, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(
				WIDGET_KEY,
				[renderConstellationTally(this.#state.categoryCounts(), ctx.theme)],
				this.#widgetOptions,
			);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<ToolConstellationContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
	}

	#mountWidget(ctx: ToolConstellationContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(
				WIDGET_KEY,
				[renderConstellationTally(this.#state.categoryCounts(), ctx.theme)],
				this.#widgetOptions,
			);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new ToolConstellationWidget({ tui, host, policy, state, theme, clock });
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host };
	}
}
