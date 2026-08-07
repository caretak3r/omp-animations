/**
 * Animations Box — controller.
 *
 * Owns a FRESH `CacheMeterState` instance — never `CacheMeterController`'s own
 * instance, and never `CacheMeterController` itself. That controller only
 * ever constructs its animated `CacheMeterWidget` (where the hit-rate ease and
 * invalidation-alert blink live, see `../cache-meter/widget.ts`) from inside
 * the very `ctx.ui.setWidget(...)` factory callback this box must never
 * invoke — reusing it unmodified would either silently mount a second, real
 * standalone Cache Meter widget (defeating "stop mounting the standalone
 * row"), or require threading a "suppress but still construct my widget
 * somewhere else" seam through an existing module, a much larger, riskier
 * change than this bead calls for (Plan 017 Decision 6). `CacheMeterState` is
 * the actual unit of reuse: this controller calls its public API exactly as
 * `CacheMeterController` does, and hands the resulting snapshot to
 * `segments.ts`'s `buildCacheMeterSegment`, which in turn calls Cache Meter's
 * own exported pure `renderCacheMeterRow`. Net effect: the hit-rate ease and
 * invalidation blink are the one piece of per-widget cosmetic behavior this
 * box does not reproduce (see `segments.ts`'s own doc) — the ledger
 * accounting itself comes through unmodified.
 *
 * Cache Meter is the only segment wired in this bead (`oh-my-pi-dxi.2`); the
 * remaining six keepers land in `dxi.3`/`dxi.4`/`dxi.5`. Registrar wiring —
 * actually mounting this controller from `session_start` — is `dxi.7`'s scope;
 * this controller is fully unit-testable in isolation until then.
 */
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AutoCompactionStartEvent,
	MessageEndEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { CacheMeterState, type CacheRequestSample } from "../cache-meter";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { type BoxTheme, buildCacheMeterSegment, type SegmentSample } from "./segments";
import { type AnimationsBoxConfig, segmentActive } from "./settings";
import { AnimationsBoxWidget } from "./widget";

/** Namespaced per the native-vs-plugin key-collision memory — never a keeper's own `WIDGET_KEY` (only 2 of 8 even export theirs). */
export const BOX_WIDGET_KEY = "oh-my-pi-animations-box";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/** Narrow a finalized `message_end` event to the provider/model/usage triple the ledger needs — identical to `../cache-meter/controller.ts`'s own private helper of the same name. */
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
 * The {@link AnimationHost} backpressure field must be wired at construction,
 * before the widget factory supplies the real `tui` — this adapter lets the
 * host read a live signal once {@link attach} runs from inside that factory.
 * Identical to every other controller's own copy in this package.
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

/** Per-event surface the controller needs — decoupled from the full `ExtensionContext` for unit-testability, same convention as every other controller in this package. */
export interface AnimationsBoxContext {
	/** False in print/RPC modes with no widget surface — every segment stays fully dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

export interface AnimationsBoxControllerOptions {
	scheduler?: FrameScheduler;
	placement?: WidgetPlacement;
	motionSetting?: MotionSetting;
	/** Wire-time initial config, from the registrar's synchronous settings read (`dxi.7`). */
	initialConfig: AnimationsBoxConfig;
}

/** Drives the Animations Box. See the module doc above for why this owns a fresh `CacheMeterState` rather than delegating to `CacheMeterController`. */
export class AnimationsBoxController {
	#scheduler: FrameScheduler;
	#widgetOptions: ExtensionWidgetOptions;
	#motionSetting: MotionSetting;

	#config: AnimationsBoxConfig;
	#mount: { host: AnimationHost } | undefined;

	#cacheMeterState: CacheMeterState = new CacheMeterState();

	constructor(options: AnimationsBoxControllerOptions) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#motionSetting = options.motionSetting ?? "full";
		this.#config = options.initialConfig;
	}

	/** Live-resolved box config — read-only accessor for tests/introspection. */
	get config(): AnimationsBoxConfig {
		return this.#config;
	}

	/** Mount the box widget once, unconditionally. Idempotent; stays dormant with no UI surface. */
	mount(ctx: AnimationsBoxContext): void {
		if (this.#mount || !ctx.hasUI) return;

		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, this.#motionSetting);
		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const scheduler = this.#scheduler;

		ctx.setWidget(
			BOX_WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new AnimationsBoxWidget({
					tui,
					host,
					policy,
					theme,
					clock: scheduler,
					onTick: now => this.#onTick(now),
					buildSamples: now => this.#buildSamples(now, theme),
					getDetail: () => this.#config.detail,
				});
			},
			this.#widgetOptions,
		);
		this.#mount = { host };
	}

	/** Seam for future per-tick state mutation (cadence sampling, ripple settle, ...) — no-op until a later bead wires a segment that needs one. */
	#onTick(_now: number): void {}

	#buildSamples(now: number, theme: BoxTheme): readonly SegmentSample[] {
		const all: readonly SegmentSample[] = [buildCacheMeterSegment(this.#cacheMeterState, now, theme)];
		return all.filter(s => segmentActive(this.#config, s.id));
	}

	/** `message_end`: feed a finalized assistant response's prompt-cache usage into the ledger. */
	onMessageEnd(event: MessageEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const sample = toCacheRequestSample(event.message);
		if (sample === undefined) return;
		this.#cacheMeterState.recordUsage(sample, this.#scheduler.now());
	}

	/** `session_compact`: attribute a nearby cache invalidation to this compaction. */
	onSessionCompact(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("compact", this.#scheduler.now());
	}

	/** `auto_compaction_start`: same attribution, distinct cause. */
	onAutoCompactionStart(_event: AutoCompactionStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("auto-compact", this.#scheduler.now());
	}

	/**
	 * `session_switch`: reset Cache Meter's ledger to a fresh, empty state —
	 * mirroring `CacheMeterController`'s own `session_switch` -> `dispose()`
	 * wiring, without tearing down the box's own mount (Decision 6 — other
	 * segments may be unconditionally mounted and should keep showing
	 * immediately in the new session).
	 */
	onSessionSwitch(_event: unknown, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState = new CacheMeterState();
	}

	/** Tear down the live mount: dispose the host and clear the widget. Idempotent. */
	dispose(ctx: Pick<AnimationsBoxContext, "setWidget">): void {
		if (!this.#mount) return;
		this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(BOX_WIDGET_KEY, undefined, this.#widgetOptions);
	}
}
