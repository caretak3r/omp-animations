import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AutoCompactionStartEvent,
	MessageEndEvent,
	SessionSwitchEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AccentColor } from "../appearance";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { CacheMeterState, type CacheRequestSample } from "./state";
import {
	type CacheMeterColors,
	type CacheMeterTheme,
	CacheMeterWidget,
	cacheMeterColors,
	renderCacheMeterOffText,
	renderCacheMeterPanel,
} from "./widget";

export const WIDGET_KEY = "cache-meter";
const DEFAULT_PLACEMENT: WidgetPlacement = "aboveEditor";

/**
 * Per-event surface the controller needs, adapted from the extension
 * `ExtensionContext` at the call site so the controller stays unit-testable
 * with a plain object.
 */
export interface CacheMeterContext {
	/** False in print/RPC modes with no widget surface — the ledger stays fully dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: CacheMeterTheme;
	/** The host's live symbol preset (see `../glyph-presets.ts`). */
	glyphPreset: SymbolPreset;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

export interface CacheMeterControllerOptions {
	scheduler?: FrameScheduler;
	placement?: WidgetPlacement;
	accentColor?: AccentColor;
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
 * Narrow a finalized `message_end` event to the provider/model/usage triple
 * the ledger needs. Only an `AssistantMessage` carries prompt-cache usage;
 * every other role (user, toolResult) is not this meter's concern.
 */
function toCacheRequestSample(message: MessageEndEvent["message"]): CacheRequestSample | undefined {
	if (message.role !== "assistant") return undefined;
	return {
		provider: message.provider,
		model: message.model,
		usage: {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			totalTokens: message.usage.totalTokens,
			cost: message.usage.cost,
			cttl: message.usage.cttl,
		},
	};
}

/**
 * Drives Cache Meter: owns the session-scoped {@link CacheMeterState} and its
 * one ambient surface. Mounts lazily on the first `message_end` that carries
 * usable prompt-cache telemetry — mirroring both the coding-agent prototype
 * and Audit Trail Box: there is nothing to show before the first metered
 * request lands, so there is no unconditional `session_start` mount here.
 * `off` tier repaints a static text line on every recorded request, since
 * there is no frame clock in that mode; `subtle`/`full` hand the shared state
 * to the animated widget, whose own frame subscription re-renders it.
 */
export class CacheMeterController {
	#scheduler: FrameScheduler;
	#state = new CacheMeterState();
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#accentColor: AccentColor | undefined;
	#colors: CacheMeterColors;

	constructor(options: CacheMeterControllerOptions = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
		this.#colors = cacheMeterColors(options.accentColor);
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): CacheMeterState {
		return this.#state;
	}

	/** `message_end`: record a finalized assistant response's prompt-cache usage. */
	onMessageEnd(event: MessageEndEvent, ctx: CacheMeterContext): void {
		if (!ctx.hasUI) return;
		const sample = toCacheRequestSample(event.message);
		if (sample === undefined) return;
		const { recorded } = this.#state.recordUsage(sample, this.#scheduler.now());
		if (!recorded) return;
		this.#refresh(ctx);
	}

	/** `session_compact`: mark a compaction as the most recent event, so a nearby cache invalidation gets credited to it instead of surfacing unexplained. */
	onSessionCompact(ctx: Pick<CacheMeterContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#state.recordEvent("compact", this.#scheduler.now());
	}

	/** `auto_compaction_start`: same attribution as {@link onSessionCompact}, kept as a distinct cause since an automatic compaction says something different about the session than a manual/extension-triggered one. */
	onAutoCompactionStart(_event: AutoCompactionStartEvent, ctx: Pick<CacheMeterContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#state.recordEvent("auto-compact", this.#scheduler.now());
	}

	/**
	 * `session_switch`: exists for symmetry with the other attribution
	 * handlers and is independently testable, but is NOT wired to the
	 * `session_switch` extension event in `index.ts` — {@link dispose} already
	 * runs on that event and replaces the whole ledger, which would discard
	 * whatever this recorded before anything could ever read it back. Reset
	 * wins over attribute-then-reset.
	 */
	onSessionSwitch(_event: SessionSwitchEvent, ctx: Pick<CacheMeterContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#state.recordEvent("session-switch", this.#scheduler.now());
	}

	/** The slash command's panel: the whole session ledger, grouped by provider+model. */
	panel(ctx: Pick<CacheMeterContext, "theme" | "glyphPreset">): readonly string[] {
		return renderCacheMeterPanel(this.#state.snapshot(), ctx.theme, {
			colors: this.#colors,
			now: this.#scheduler.now(),
			preset: ctx.glyphPreset,
		});
	}

	/**
	 * Tear down the live mount and reset the session-owned ledger. Matches the
	 * prototype's `dispose`: unconditional, and used for both `session_switch`
	 * and `session_shutdown` — a mid-session switch starts the ledger fresh
	 * rather than blending two sessions' cache economics together.
	 */
	dispose(ctx: Pick<CacheMeterContext, "setWidget">): void {
		this.#state = new CacheMeterState();
		if (this.#mount?.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
	}

	#refresh(ctx: CacheMeterContext): void {
		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (this.#mount.mode === "static") {
			ctx.setWidget(
				WIDGET_KEY,
				[renderCacheMeterOffText(this.#state.snapshot(), ctx.glyphPreset)],
				this.#widgetOptions,
			);
		}
		// Animated mode: the widget's own frame subscription re-renders from the shared state.
	}

	#mountWidget(ctx: CacheMeterContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(
				WIDGET_KEY,
				[renderCacheMeterOffText(this.#state.snapshot(), ctx.glyphPreset)],
				this.#widgetOptions,
			);
			return { mode: "static" };
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
				return new CacheMeterWidget({
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
