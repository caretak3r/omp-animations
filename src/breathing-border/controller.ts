import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AgentEndEvent,
	AgentStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { BreathingBorderState } from "./state";
import { type BreathingBorderTheme, BreathingBorderWidget, renderBreathingBorderOffText } from "./widget";

const WIDGET_KEY = "breathing-border";
const DEFAULT_PLACEMENT: WidgetPlacement = "aboveEditor";

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface BreathingBorderContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: BreathingBorderTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "off" } | { mode: "animated"; host: AnimationHost } | { mode: "settled" };

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
 * Drives the breathing border: `agent_start` (re)starts the continuous
 * inhale/exhale cycle, `agent_end` fires the single wind-down exhale, and
 * `turn_start`/`turn_end` modulate the breath cadence from the just-finished
 * turn's duration. Mounts on the first `agent_start` (or `agent_end`, in the
 * unlikely case it fires first) seen this session.
 *
 * Motion gating goes through the shared kit's {@link MotionPolicy}; a
 * resolved tier of `off` renders a fixed static border instead of an
 * animated widget. Once the wind-down exhale settles into `idle` (the
 * `BreathingBorderState.settleIfDone` transition, surfaced via the widget's
 * `onSettled` callback), the controller disposes the animated host and falls
 * back to the same static widget — so a fully idle session really does carry
 * zero frame-clock subscriptions, not just an animated widget that stopped
 * changing. A later `agent_start` remounts fresh.
 */
export class BreathingBorderController {
	#scheduler: FrameScheduler;
	#state = new BreathingBorderState();
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#accentColor: ThemeColor | undefined;

	constructor(options: { scheduler?: FrameScheduler; placement?: WidgetPlacement; accentColor?: ThemeColor } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): BreathingBorderState {
		return this.#state;
	}

	onAgentStart(_event: AgentStartEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyAgentStart(this.#scheduler.now());
		if (this.#mount === undefined || this.#mount.mode === "settled") {
			this.#mount = this.#mountWidget(ctx);
		}
	}

	onAgentEnd(_event: AgentEndEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyAgentEnd(this.#scheduler.now());
		if (this.#mount === undefined) {
			this.#mount = this.#mountWidget(ctx);
		}
	}

	onTurnStart(event: TurnStartEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyTurnStart(event.turnIndex, this.#scheduler.now());
	}

	onTurnEnd(event: TurnEndEvent, ctx: BreathingBorderContext): void {
		if (!ctx.hasUI) return;
		this.#state.applyTurnEnd(event.turnIndex, this.#scheduler.now());
	}

	/** Tear down any live mount (animated host, if one exists) and clear the widget. Idempotent. */
	dispose(ctx: Pick<BreathingBorderContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
	}

	#mountWidget(ctx: BreathingBorderContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderBreathingBorderOffText(ctx.theme)], this.#widgetOptions);
			return { mode: "off" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		const onSettled = () => this.#teardownToStatic(ctx, host);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new BreathingBorderWidget({
					tui,
					host,
					policy,
					state,
					theme,
					clock,
					onSettled,
					accentColor: this.#accentColor,
				});
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host };
	}

	/** Fires once, from the widget's `onSettled` callback, on the `exhaling` -> `idle` transition. Guards against a stale callback from an already-superseded mount (e.g. a fresh `agent_start` remounted before this one settled). */
	#teardownToStatic(ctx: Pick<BreathingBorderContext, "setWidget" | "theme">, host: AnimationHost): void {
		if (this.#mount?.mode !== "animated" || this.#mount.host !== host) return;
		host.dispose();
		this.#mount = { mode: "settled" };
		ctx.setWidget(WIDGET_KEY, [renderBreathingBorderOffText(ctx.theme)], this.#widgetOptions);
	}
}
