import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AfterProviderResponseEvent,
	MessageStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AccentColor } from "../appearance";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { RateLimitTidepoolState } from "./state";
import { familyForProvider, readRateLimitHeaders } from "./tidepool";
import { renderTidepoolOffText, type TidepoolTheme, TidepoolWidget } from "./widget";

const WIDGET_KEY = "rate-limit-tidepool";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface TidepoolContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: TidepoolTheme;
	/** The host's live symbol preset (see `../glyph-presets.ts`). */
	glyphPreset: SymbolPreset;
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
 * Drives Rate-Limit Tidepool: `after_provider_response` carries the response
 * headers but never the provider they came from
 * (`ProviderResponseMetadata` has no `provider`/`model` field), so this stays
 * a genuinely memoryless gauge — see `tidepool.ts`'s module doc for why this
 * is not Provider Aurora's request/response pairing — and instead leans on a
 * single ordering guarantee the extension host already provides: a
 * response's headers are always emitted before the `message_start` of the
 * assistant message that response produced. Concretely: `onAfterProviderResponse`
 * stashes the latest unconsumed header sample; `onMessageStart` consumes it
 * the moment an *assistant* message starts (the role guard matters — only the
 * assistant variant of `AgentMessage` carries `provider`), reads which
 * provider it belongs to off that message, and — if `provider` is on the
 * family whitelist — parses and applies it. A `message_start` for any other
 * role (user, toolResult) never touches the pending sample, so it survives
 * until the assistant message that actually follows it. If two
 * `after_provider_response`s somehow fire before an assistant `message_start`
 * consumes either (e.g. a retried request), the newer one simply overwrites
 * the older — "latest response only," never a queue.
 *
 * Mounts lazily on the first response whose provider is whitelisted AND whose
 * headers actually parsed to at least one recognized bucket; a provider that
 * sends none (or one this whitelist doesn't recognize, e.g. an OpenRouter
 * gateway call) never mounts anything at all — the honest "invisible, never
 * guessed" contract for both a header-poor provider and one this module has
 * simply not been taught. Once mounted, the widget never tears itself back
 * down (unlike Drift Buoy/Diff Bloom's one-shot ripples/blooms) — a new
 * recognized sample, whatever its provider, unconditionally replaces the
 * single live snapshot (see `state.ts`), so a provider switch swaps the pool
 * outright rather than blending two providers' numbers together, and a
 * response from an unrecognized/whitelist-missing provider simply leaves the
 * existing pool exactly as it was (never cleared to a stale zero, never
 * guessed at).
 */
export class RateLimitTidepoolController {
	#scheduler: FrameScheduler;
	#state = new RateLimitTidepoolState();
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#accentColor: AccentColor | undefined;
	/** The most recent `after_provider_response`'s headers, not yet claimed by an assistant `message_start`. */
	#pendingHeaders: Readonly<Record<string, string>> | undefined;

	constructor(options: { scheduler?: FrameScheduler; placement?: WidgetPlacement; accentColor?: AccentColor } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): RateLimitTidepoolState {
		return this.#state;
	}

	/** `after_provider_response`: stash the headers until the next assistant `message_start` reveals whose they are. */
	onAfterProviderResponse(event: AfterProviderResponseEvent, ctx: Pick<TidepoolContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#pendingHeaders = event.headers;
	}

	/** `message_start`: only an assistant message carries `provider`; consumes (and clears) any pending header sample. */
	onMessageStart(event: MessageStartEvent, ctx: TidepoolContext): void {
		if (!ctx.hasUI) return;
		if (event.message.role !== "assistant") return;
		const headers = this.#pendingHeaders;
		this.#pendingHeaders = undefined;
		if (headers === undefined) return;

		const provider = event.message.provider;
		const family = familyForProvider(provider);
		if (family === undefined) return; // unwhitelisted gateway — stays invisible, never guessed

		const now = this.#scheduler.now();
		const reading = readRateLimitHeaders(family, headers, now);
		if (reading === undefined) return; // absent or empty headers — nothing recognized to show

		this.#state.applySample({
			provider,
			family,
			level: reading.level,
			resetAtMs: reading.resetAtMs,
			observedAtMs: now,
		});
		this.#refresh(ctx);
	}

	/**
	 * Tear down the live mount and reset the session-owned pool — matching Cache
	 * Meter's `dispose`: a mid-session switch starts the gauge fresh rather than
	 * carrying a prior session's provider/level into the new one. Also drops
	 * the pending header buffer, and is idempotent.
	 */
	dispose(ctx: Pick<TidepoolContext, "setWidget">): void {
		this.#pendingHeaders = undefined;
		this.#state = new RateLimitTidepoolState();
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
	}

	#refresh(ctx: TidepoolContext): void {
		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "off") {
			const snapshot = this.#state.snapshot();
			if (snapshot) {
				ctx.setWidget(WIDGET_KEY, [renderTidepoolOffText(snapshot, ctx.glyphPreset)], this.#widgetOptions);
			}
		}
		// Animated mode: the shared AnimationHost's next tick re-renders from the mutated state.
	}

	#mountWidget(ctx: TidepoolContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			const snapshot = this.#state.snapshot();
			if (snapshot) {
				ctx.setWidget(WIDGET_KEY, [renderTidepoolOffText(snapshot, ctx.glyphPreset)], this.#widgetOptions);
			}
			return { mode: "off" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		const glyphPreset = ctx.glyphPreset;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new TidepoolWidget({
					tui,
					host,
					policy,
					state,
					theme,
					clock,
					accentColor: this.#accentColor,
					glyphPreset,
				});
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host };
	}
}
