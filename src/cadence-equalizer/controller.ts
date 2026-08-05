import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { CadenceEqualizerState } from "./state";
import { type CadenceEqualizerTheme, CadenceEqualizerWidget, renderEqualizerText } from "./widget";

const WIDGET_KEY = "cadence-equalizer";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/** Wall clock (epoch ms) seam — `token-rate.ts` compares against message `timestamp`, which is epoch-based. Mirrors Token Tide's `WallClock`. */
export interface WallClock {
	now(): number;
}

const defaultWallClock: WallClock = { now: () => Date.now() };

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface CadenceEqualizerContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: CadenceEqualizerTheme;
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

/** The minimal shape `calculateTokensPerSecond` needs from an assistant `AgentMessage`. */
interface AssistantSample {
	role: "assistant";
	timestamp: number;
	duration?: number;
	usage: { output: number };
}

/** Narrow a streamed message to the assistant sample shape the shared rate provider consumes. `undefined` for any other role. */
function toAssistantSample(message: MessageStartEvent["message"]): AssistantSample | undefined {
	if (message.role !== "assistant") return undefined;
	return {
		role: "assistant",
		timestamp: message.timestamp,
		duration: message.duration,
		usage: { output: message.usage.output },
	};
}

/**
 * Drives the multi-band token-throughput equalizer: mounts on the first
 * streamed assistant message (`message_start`), tracks the in-flight
 * message across `message_update`/`message_end` so the shared frame clock
 * can sample live tok/s via the existing `token-rate.ts` provider (the same
 * signal Token Tide already samples — never recomputed here), and keeps a
 * single shared {@link CadenceEqualizerState} for the rest of the session.
 * Motion gating goes through the kit's {@link MotionPolicy}; a resolved
 * tier of `off` renders a static numeric line instead, repainted directly
 * on each message event since there is no frame clock in that mode.
 *
 * `message_end` clears the tracked message rather than leaving its final
 * (now-fixed) duration/usage in place, matching Token Tide — otherwise the
 * next sample would keep reporting that turn's average rate indefinitely
 * instead of settling back to the "between turns" idle state.
 */
export class CadenceEqualizerController {
	#scheduler: FrameScheduler;
	#wallClock: WallClock;
	#state = new CadenceEqualizerState();
	#current: AssistantSample | undefined;
	#streaming = false;
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#accentColor: ThemeColor | undefined;

	constructor(
		options: {
			scheduler?: FrameScheduler;
			wallClock?: WallClock;
			placement?: WidgetPlacement;
			accentColor?: ThemeColor;
		} = {},
	) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#wallClock = options.wallClock ?? defaultWallClock;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): CadenceEqualizerState {
		return this.#state;
	}

	/** Sample the live tok/s rate at `wallNowMs` from the currently tracked message. `null` when idle. */
	sampleRate(wallNowMs: number): number | null {
		return calculateTokensPerSecond(this.#current ? [this.#current] : [], this.#streaming, wallNowMs);
	}

	onMessageStart(event: MessageStartEvent, ctx: CadenceEqualizerContext): void {
		const sample = toAssistantSample(event.message);
		if (!sample) return;
		this.#current = sample;
		this.#streaming = true;
		if (!ctx.hasUI) return;

		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") this.#repaintStatic(ctx);
		// Animated mode: the shared AnimationHost's next tick re-samples from the mutated state.
	}

	onMessageUpdate(event: MessageUpdateEvent, ctx: CadenceEqualizerContext): void {
		const sample = toAssistantSample(event.message);
		if (!sample) return;
		this.#current = sample;
		if (!ctx.hasUI || !this.#mount) return;
		if (this.#mount.mode === "static") this.#repaintStatic(ctx);
	}

	onMessageEnd(event: MessageEndEvent, ctx: CadenceEqualizerContext): void {
		if (!toAssistantSample(event.message)) return;
		this.#current = undefined;
		this.#streaming = false;
		if (!ctx.hasUI || !this.#mount) return;
		if (this.#mount.mode === "static") this.#repaintStatic(ctx);
	}

	/** Tear down the live mount: dispose the host (if animated) and clear the widget. Idempotent. */
	dispose(ctx: Pick<CadenceEqualizerContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
	}

	#repaintStatic(ctx: CadenceEqualizerContext): void {
		ctx.setWidget(WIDGET_KEY, [renderEqualizerText(this.sampleRate(this.#wallClock.now()))], this.#widgetOptions);
	}

	#mountWidget(ctx: CadenceEqualizerContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderEqualizerText(this.sampleRate(this.#wallClock.now()))], this.#widgetOptions);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const wallClock = this.#wallClock;
		const sampleRate = (wallNowMs: number): number | null => this.sampleRate(wallNowMs);
		const accentColor = this.#accentColor;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new CadenceEqualizerWidget({ tui, host, policy, state, theme, wallClock, sampleRate, accentColor });
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host };
	}
}
