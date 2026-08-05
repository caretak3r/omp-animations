import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { TtsrTriggeredEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { ReflectionRippleState } from "./state";
import { type ReflectionRippleTheme, ReflectionRippleWidget, renderReflectionRippleOffText } from "./widget";

const WIDGET_KEY = "reflection-ripple";
const WIDGET_OPTIONS: ExtensionWidgetOptions = { placement: "aboveEditor" };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface ReflectionRippleContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: ReflectionRippleTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "off" };

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
 * Drives Reflection Ripple: each `ttsr_triggered` event — TTSR interrupting
 * generation to inject a matched rule, see `agent-session.ts`'s
 * `#handleTtsrMatches` — (re)starts a single expanding-and-fading ripple plus
 * a "taking a breath" dim, both driven off the shared clock rather than the
 * event's own state. Mounts fresh on the first trigger seen this session (or
 * a later one, if a prior ripple already fully settled and tore its mount
 * down). Motion gating goes through the shared kit's {@link MotionPolicy}; a
 * resolved tier of `off` instead renders a static line naming the matched
 * rule(s), refreshed on each trigger. Once the ripple settles (the
 * `ReflectionRippleState.settleIfDone` transition, surfaced via the widget's
 * `onSettled` callback), the controller disposes the animated host and
 * removes the widget entirely — a settled reflection leaves zero
 * subscriptions and no lingering visual. A later trigger remounts fresh.
 */
export class ReflectionRippleController {
	#scheduler: FrameScheduler;
	#state = new ReflectionRippleState();
	#mount: Mount | undefined;

	constructor(options: { scheduler?: FrameScheduler } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): ReflectionRippleState {
		return this.#state;
	}

	onTtsrTriggered(event: TtsrTriggeredEvent, ctx: ReflectionRippleContext): void {
		if (!ctx.hasUI) return;
		const ruleNames = event.rules.map(rule => rule.name);
		this.#state.applyTrigger(ruleNames, this.#scheduler.now());

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "off") {
			ctx.setWidget(WIDGET_KEY, [renderReflectionRippleOffText(ruleNames)], WIDGET_OPTIONS);
		}
		// Animated mode: the shared AnimationHost's next tick re-renders the restarted ripple from the mutated state.
	}

	/** Tear down any live mount (animated host, if one exists) and clear the widget. Idempotent. */
	dispose(ctx: Pick<ReflectionRippleContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}

	#mountWidget(ctx: ReflectionRippleContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderReflectionRippleOffText(this.#state.snapshot().ruleNames)], WIDGET_OPTIONS);
			return { mode: "off" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		const onSettled = () => this.#teardownToNothing(ctx, host);
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new ReflectionRippleWidget({ tui, host, policy, state, theme, clock, onSettled });
			},
			WIDGET_OPTIONS,
		);
		return { mode: "animated", host };
	}

	/** Fires once, from the widget's `onSettled` callback, on the `rippling` -> `idle` transition. Guards against a stale callback from an already-superseded mount (e.g. a fresh trigger remounted before this one settled). */
	#teardownToNothing(ctx: Pick<ReflectionRippleContext, "setWidget">, host: AnimationHost): void {
		if (this.#mount?.mode !== "animated" || this.#mount.host !== host) return;
		host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, WIDGET_OPTIONS);
	}
}
