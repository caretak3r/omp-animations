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
 * Cache Meter (`oh-my-pi-dxi.2`), Audit Trail, Tool Constellation and
 * Palimpsest (`oh-my-pi-dxi.3`) are wired here the same way: a fresh `*State`
 * instance owned by this controller, fed by event handlers that reproduce
 * each standalone controller's own adapter logic where it isn't exported
 * (`applyPalimpsestTouch`/`isEditToolResult` below mirror
 * `../palimpsest/controller.ts`'s private helpers of the same names, exactly
 * as `toCacheRequestSample` above mirrors cache meter's). Audit Trail's own
 * second surface — the alarm `setStatus` line — is deliberately NOT ported
 * here (Plan 017 Decision 6): only its ledger state feeds the box, so
 * `AuditLedgerState` never sees the divergence probe's `noteProbe` either
 * (that's off-path filesystem I/O the standalone controller owns alongside
 * its `setStatus` surface, not "row/ledger state"). Cadence Equalizer,
 * Rate-Limit Tidepool and Reflection Ripple (`oh-my-pi-dxi.4`) are wired the
 * same way below — a fresh `*State` instance, fed by adapter logic mirrored
 * from each standalone controller's own private helpers where it isn't
 * exported (`toAssistantSample` mirrors `../cadence-equalizer/controller.ts`'s
 * private helper of the same name, exactly as `toCacheRequestSample` above
 * mirrors cache meter's). Cadence's live tok/s sampling and per-tick EMA-band
 * stepping, and Reflection Ripple's settle check, both run from the `#onTick`
 * seam every tick, mirroring what each standalone widget's own `onFrame` hook
 * does (this box has no per-segment `AnimatedWidget`, so there is no other
 * frame hook to hang them on). The breathing border lands in `dxi.5`.
 * Registrar wiring — actually mounting this controller from `session_start`
 * — is `dxi.7`'s scope; this controller is fully unit-testable in isolation
 * until then.
 *
 * The breathing border (`oh-my-pi-dxi.5`) is wired the same way as every
 * other segment here: a fresh `BreathingBorderState` instance owned by this
 * controller (never `BreathingBorderController`'s own instance, for the same
 * Decision 6 reason as `CacheMeterState` above — that controller only ever
 * constructs its own animated widget from inside its own `setWidget` factory,
 * which this box must never invoke), fed by `onAgentStart`/`onAgentEnd`/
 * `onTurnStart` (new) and `onTurnEnd` (extended) mirroring
 * `BreathingBorderController`'s own event handlers exactly. Unlike the other
 * segments, it contributes no row and no `SegmentSample` — `#getBorderBrightness`
 * exposes its live envelope directly to `AnimationsBoxWidget`, which paints
 * it into the border chrome itself (Decision 2), not a composed row. Its
 * `settleIfDone` check rides the SAME `#onTick` seam as Reflection Ripple's.
 */
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionStartEvent,
	EditToolResultEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolCallEvent,
	ToolResultEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getDiffStats } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import type { AccentColor } from "../appearance";
import { AuditLedgerState, auditTouchesFromToolResult } from "../audit-trail-box";
import { BreathingBorderState, breathEnvelope, EXHALE_DURATION_MS, exhaleEnvelope } from "../breathing-border";
import { CacheMeterState, type CacheRequestSample } from "../cache-meter";
import { CadenceEqualizerState } from "../cadence-equalizer";
// `normalizeAmplitude` lives in `scale.ts`, not re-exported by the keeper's
// own `index.ts` barrel — same deep-import gap `segments.ts` documents for
// `MAX_REFERENCE_RATE`.
import { normalizeAmplitude } from "../cadence-equalizer/scale";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { PalimpsestState, parseHunkSpans } from "../palimpsest";
import { familyForProvider, RateLimitTidepoolState, readRateLimitHeaders } from "../rate-limit-tidepool";
import { ReflectionRippleState } from "../reflection-ripple";
import { ConstellationState } from "../tool-constellation";
import {
	type BoxTheme,
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildCadenceEqualizerSegment,
	buildPalimpsestSegment,
	buildRateLimitTidepoolSegment,
	buildReflectionRippleSegment,
	buildToolConstellationSegment,
	type SegmentSample,
} from "./segments";
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

/** The minimal shape `calculateTokensPerSecond` needs from an assistant `AgentMessage` — identical to `../cadence-equalizer/controller.ts`'s own private `AssistantSample`. */
interface AssistantSample {
	role: "assistant";
	timestamp: number;
	duration?: number;
	usage: { output: number };
}

/** Narrow a streamed message to the assistant sample shape the shared rate provider consumes — identical to `../cadence-equalizer/controller.ts`'s own private `toAssistantSample`. `undefined` for any other role. */
function toAssistantSample(message: MessageStartEvent["message"]): AssistantSample | undefined {
	if (message.role !== "assistant") return undefined;
	return {
		role: "assistant",
		timestamp: message.timestamp,
		duration: message.duration,
		usage: { output: message.usage.output },
	};
}

/** Narrow a tool-result event to the built-in `edit` tool — identical to `../palimpsest/controller.ts`'s own private helper of the same name. */
function isEditToolResult(event: ToolResultEvent): event is EditToolResultEvent {
	return event.toolName === "edit";
}

/** One file's touch, normalized from either a single-file `EditToolDetails` or one entry of a multi-file `perFileResults` — identical shape to `../palimpsest/controller.ts`'s own private `FileTouch`, not exported from that module's barrel. */
interface PalimpsestFileTouch {
	readonly path: string | undefined;
	readonly sourcePath: string | undefined;
	readonly op: "create" | "delete" | "update" | undefined;
	readonly diff: string | undefined;
	readonly snapshotsPruned: boolean | undefined;
	readonly isError: boolean | undefined;
}

/** Apply one file's touch to the Palimpsest ledger — identical to `../palimpsest/controller.ts`'s own private `applyFileTouch`, not exported from that module's barrel (same precedent as `toCacheRequestSample` above). */
function applyPalimpsestTouch(state: PalimpsestState, touch: PalimpsestFileTouch): void {
	if (touch.isError || !touch.path) return;
	if (touch.op === "delete") {
		state.onDelete(touch.path);
		return;
	}
	if (touch.sourcePath && touch.sourcePath !== touch.path) {
		state.onRename(touch.sourcePath, touch.path);
	}
	if (touch.op === "create") {
		state.onCreate(touch.path);
	}

	const diff = touch.diff;
	if (!diff) return;
	if (touch.snapshotsPruned) {
		state.applyDegradedTouch(touch.path);
		return;
	}
	const spans = parseHunkSpans(diff);
	if (spans.length === 0) {
		const { added, removed } = getDiffStats(diff);
		if (added === 0 && removed === 0) return; // a genuine no-op (e.g. a pure rename) — nothing to record
		state.applyDegradedTouch(touch.path); // a real change with no parseable hunk header — never guess spans
		return;
	}
	state.applySpans(touch.path, spans);
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
	/** Current working directory, for resolving the relative paths Audit Trail's `tool_result` adapter tracks. */
	cwd: string;
	/** The host's live symbol preset (see `../glyph-presets.ts`), captured once at {@link AnimationsBoxController.mount}. */
	glyphPreset: SymbolPreset;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

export interface AnimationsBoxControllerOptions {
	scheduler?: FrameScheduler;
	placement?: WidgetPlacement;
	motionSetting?: MotionSetting;
	/** Wire-time initial config, from the registrar's synchronous settings read (`dxi.7`). */
	initialConfig: AnimationsBoxConfig;
	/** Accent override for the border's peak brightness — the existing `breathingBorderAccentColor` setting; `undefined` keeps the breathing-border keeper's built-in palette. */
	accentColor?: AccentColor;
}

/** Drives the Animations Box. See the module doc above for why this owns a fresh `CacheMeterState` rather than delegating to `CacheMeterController`. */
export class AnimationsBoxController {
	#scheduler: FrameScheduler;
	#widgetOptions: ExtensionWidgetOptions;
	#motionSetting: MotionSetting;
	#accentColor: AccentColor | undefined;

	#config: AnimationsBoxConfig;
	#mount: { host: AnimationHost } | undefined;
	/** The host's live symbol preset, captured once at {@link mount} — mirrors `accentColor`'s restart-required posture, no live re-read. */
	#glyphPreset: SymbolPreset = "unicode";

	#cacheMeterState: CacheMeterState = new CacheMeterState();
	#auditTrailState: AuditLedgerState = new AuditLedgerState();
	#constellationState: ConstellationState = new ConstellationState();
	#palimpsestState: PalimpsestState = new PalimpsestState();
	#cadenceState: CadenceEqualizerState = new CadenceEqualizerState();
	#tidepoolState: RateLimitTidepoolState = new RateLimitTidepoolState();
	#reflectionRippleState: ReflectionRippleState = new ReflectionRippleState();
	#breathingBorderState: BreathingBorderState = new BreathingBorderState();

	/** Cadence's in-flight message tracking — mirrors `CadenceEqualizerController`'s own private `#current`/`#streaming` fields, which live outside `CadenceEqualizerState` itself. */
	#cadenceCurrent: AssistantSample | undefined;
	#cadenceStreaming = false;
	/** Latches `true` on the first assistant `message_start` and never reverts — `CadenceEqualizerState`'s own EMA bands decay toward but never reach zero, so this is the segment's actual "has anything happened yet" signal (see `segments.ts`'s `buildCadenceEqualizerSegment` doc). */
	#cadenceHasStreamed = false;

	/** Tidepool's stashed header sample, not yet claimed by an assistant `message_start` — mirrors `RateLimitTidepoolController`'s own private `#pendingHeaders`. */
	#tidepoolPendingHeaders: Readonly<Record<string, string>> | undefined;

	constructor(options: AnimationsBoxControllerOptions) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#motionSetting = options.motionSetting ?? "full";
		this.#config = options.initialConfig;
		this.#accentColor = options.accentColor;
	}

	/** Live-resolved box config — read-only accessor for tests/introspection. */
	get config(): AnimationsBoxConfig {
		return this.#config;
	}

	/** Mount the box widget once, unconditionally. Idempotent; stays dormant with no UI surface. */
	mount(ctx: AnimationsBoxContext): void {
		if (this.#mount || !ctx.hasUI) return;
		this.#glyphPreset = ctx.glyphPreset;

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
					getBorderBrightness: now => this.#getBorderBrightness(now),
					accentColor: this.#accentColor,
					preset: this.#glyphPreset,
				});
			},
			this.#widgetOptions,
		);
		this.#mount = { host };
	}

	/** Sample the live tok/s rate at `wallNowMs` from the currently tracked message — identical call shape to `CadenceEqualizerController.sampleRate`. */
	#sampleCadenceRate(wallNowMs: number): number | null {
		return calculateTokensPerSecond(
			this.#cadenceCurrent ? [this.#cadenceCurrent] : [],
			this.#cadenceStreaming,
			wallNowMs,
		);
	}

	/**
	 * Per-tick state mutation: Cadence samples the live tok/s rate and steps its
	 * EMA bands every tick, mirroring the standalone widget's own `onFrame` ->
	 * `pushSample` (this box has no per-segment `AnimatedWidget` of its own to
	 * hang that on); Reflection Ripple checks whether its in-flight ripple has
	 * settled, mirroring the standalone widget's own `onFrame` -> `settleIfDone`;
	 * the breathing border checks whether its wind-down exhale has settled the
	 * same way, mirroring `BreathingBorderWidget`'s own `onFrame` ->
	 * `settleIfDone` (the box has no dedicated static-widget swap to perform on
	 * that transition — the ONE box widget just renders envelope 0 next frame).
	 * All three read `now` off the SAME wall clock this seam is always called
	 * with (Decision 4) — never a second clock.
	 */
	#onTick(now: number): void {
		this.#cadenceState.pushSample(normalizeAmplitude(this.#sampleCadenceRate(now) ?? 0));
		this.#reflectionRippleState.settleIfDone(now);
		this.#breathingBorderState.settleIfDone(now);
	}

	/**
	 * Border brightness (Decision 2): `undefined` when `breathingBorder` is
	 * disabled in config — the widget's cue to render the plain, uncolored
	 * chrome instead of any border token at all. Otherwise the live `0..1`
	 * envelope off the breathing-border keeper's own phase math (idle ->
	 * active -> exhaling), sampled off the SAME wall clock this seam is always
	 * called with (Decision 4) — identical math to `BreathingBorderWidget`'s
	 * own `renderFrame` phase switch, just returning the bare envelope instead
	 * of a fully rendered row (the widget itself owns coloring/tokens).
	 */
	#getBorderBrightness(now: number): number | undefined {
		if (!this.#config.breathingBorder) return undefined;
		switch (this.#breathingBorderState.phase) {
			case "idle":
				return 0;
			case "active": {
				const period = this.#breathingBorderState.breathPeriodMs();
				const elapsed = this.#breathingBorderState.breathElapsedMs(now);
				return breathEnvelope(elapsed, period);
			}
			case "exhaling": {
				const elapsed = this.#breathingBorderState.exhaleElapsedMs(now);
				return exhaleEnvelope(elapsed, EXHALE_DURATION_MS);
			}
		}
	}

	#buildSamples(now: number, theme: BoxTheme): readonly SegmentSample[] {
		// Priority order, not builder-list order — this array feeds detailed mode's
		// row-per-segment loop directly (see `widget.ts`), which does not sort by
		// priority itself.
		const all: readonly SegmentSample[] = [
			buildCacheMeterSegment(this.#cacheMeterState, now, theme, undefined, this.#glyphPreset),
			buildCadenceEqualizerSegment(
				this.#cadenceState,
				this.#cadenceHasStreamed,
				this.#sampleCadenceRate(now),
				now,
				theme,
				undefined,
				this.#glyphPreset,
			),
			buildAuditTrailBoxSegment(this.#auditTrailState, now, theme, undefined, this.#glyphPreset),
			buildRateLimitTidepoolSegment(this.#tidepoolState, now, theme, undefined, this.#glyphPreset),
			buildToolConstellationSegment(this.#constellationState, now, theme, this.#glyphPreset),
			buildPalimpsestSegment(this.#palimpsestState, now, theme, undefined, this.#glyphPreset),
			buildReflectionRippleSegment(this.#reflectionRippleState, now, theme, undefined, this.#glyphPreset),
		];
		return all.filter(s => segmentActive(this.#config, s.id));
	}

	/**
	 * `message_start`: Cadence tracks the newly-streaming assistant message and
	 * latches `hasStreamed`, mirroring `CadenceEqualizerController.onMessageStart`;
	 * Tidepool consumes any pending header sample the moment an assistant
	 * message reveals its provider, mirroring
	 * `RateLimitTidepoolController.onMessageStart`. The two standalone
	 * controllers each subscribe to this event independently, so one handler
	 * here does both — same precedent as `onToolResult`'s audit+palimpsest
	 * merge below.
	 */
	onMessageStart(event: MessageStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;

		const assistantSample = toAssistantSample(event.message);
		if (assistantSample !== undefined) {
			this.#cadenceCurrent = assistantSample;
			this.#cadenceStreaming = true;
			this.#cadenceHasStreamed = true;
		}

		if (event.message.role !== "assistant") return; // only an assistant message carries `provider`
		const headers = this.#tidepoolPendingHeaders;
		this.#tidepoolPendingHeaders = undefined;
		if (headers === undefined) return;

		const provider = event.message.provider;
		const family = familyForProvider(provider);
		if (family === undefined) return; // unwhitelisted gateway — stays invisible, never guessed

		const now = this.#scheduler.now();
		const reading = readRateLimitHeaders(family, headers, now);
		if (reading === undefined) return; // absent or empty headers — nothing recognized to show
		this.#tidepoolState.applySample({
			provider,
			family,
			level: reading.level,
			resetAtMs: reading.resetAtMs,
			observedAtMs: now,
		});
	}

	/** `message_update`: Cadence keeps the tracked in-flight message's usage current mid-stream — mirrors `CadenceEqualizerController.onMessageUpdate`. */
	onMessageUpdate(event: MessageUpdateEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const sample = toAssistantSample(event.message);
		if (sample !== undefined) this.#cadenceCurrent = sample;
	}

	/** `after_provider_response`: stash the headers until the next assistant `message_start` reveals whose they are — mirrors `RateLimitTidepoolController.onAfterProviderResponse`. */
	onAfterProviderResponse(event: AfterProviderResponseEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#tidepoolPendingHeaders = event.headers;
	}

	/**
	 * `ttsr_triggered`: (re)start the single ripple from the box's own clock —
	 * mirrors `ReflectionRippleController.onTtsrTriggered`'s state transition.
	 * That standalone controller's mount/teardown dance has no box equivalent:
	 * here the segment's own `active` flag (`phase === "rippling"`, see
	 * `segments.ts`) is the only "is it showing" signal there is.
	 */
	onTtsrTriggered(event: TtsrTriggeredEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const ruleNames = event.rules.map(rule => rule.name);
		this.#reflectionRippleState.applyTrigger(ruleNames, this.#scheduler.now());
	}

	/**
	 * `message_end`: feed a finalized assistant response's prompt-cache usage
	 * into the ledger, and clear Cadence's tracked in-flight message — mirroring
	 * `CadenceEqualizerController.onMessageEnd`'s own clear, so the next sample
	 * settles back to idle instead of reporting the just-finished turn's average
	 * rate indefinitely.
	 */
	onMessageEnd(event: MessageEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const cacheSample = toCacheRequestSample(event.message);
		if (cacheSample !== undefined) this.#cacheMeterState.recordUsage(cacheSample, this.#scheduler.now());

		if (toAssistantSample(event.message) !== undefined) {
			this.#cadenceCurrent = undefined;
			this.#cadenceStreaming = false;
		}
	}

	/**
	 * `tool_result`: Audit Trail's read/write ledger and Palimpsest's edit-span
	 * ledger both derive from tool results, so one handler feeds both, exactly
	 * as each standalone controller's own `tool_result` subscription would.
	 */
	onToolResult(event: ToolResultEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		for (const touch of auditTouchesFromToolResult(event, ctx.cwd)) {
			if (touch.kind === "read") this.#auditTrailState.noteRead(touch.path, touch.observed);
			else this.#auditTrailState.noteWrite(touch.path, this.#scheduler.now(), touch.observed);
		}

		if (!isEditToolResult(event)) return;
		const details = event.details;
		if (!details) return; // a thrown-error result always carries `details: undefined`
		if (details.perFileResults && details.perFileResults.length > 0) {
			for (const file of details.perFileResults) {
				applyPalimpsestTouch(this.#palimpsestState, {
					path: file.path,
					sourcePath: file.sourcePath,
					op: file.op,
					diff: file.diff,
					snapshotsPruned: file.snapshotsPruned,
					isError: file.isError,
				});
			}
		} else {
			applyPalimpsestTouch(this.#palimpsestState, {
				path: details.path,
				sourcePath: details.sourcePath,
				op: details.op,
				diff: details.diff,
				snapshotsPruned: details.snapshotsPruned,
				isError: undefined,
			});
		}
	}

	/** `tool_call`: fire (or refresh) Tool Constellation's star for this tool. */
	onToolCall(event: ToolCallEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#constellationState.recordFire(event.toolName, this.#scheduler.now());
	}

	/**
	 * `agent_start`: (re)start the breathing border's continuous inhale/exhale
	 * cycle — mirrors `BreathingBorderController.onAgentStart`'s own state
	 * transition. The box has no widget mount/teardown dance to mirror
	 * alongside it: the box's ONE widget is either already mounted or
	 * (`!ctx.hasUI`) never will be, independent of agent lifecycle.
	 */
	onAgentStart(_event: AgentStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#breathingBorderState.applyAgentStart(this.#scheduler.now());
	}

	/** `agent_end`: begin the breathing border's single wind-down exhale — mirrors `BreathingBorderController.onAgentEnd`. */
	onAgentEnd(_event: AgentEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#breathingBorderState.applyAgentEnd(this.#scheduler.now());
	}

	/**
	 * `turn_start`: record the breathing border's turn start, so the matching
	 * `turn_end` below can measure its duration and modulate the breath
	 * cadence — mirrors `BreathingBorderController.onTurnStart`.
	 */
	onTurnStart(event: TurnStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#breathingBorderState.applyTurnStart(event.turnIndex, this.#scheduler.now());
	}

	/**
	 * `turn_end`: Audit Trail's cold-eviction sweep and Palimpsest's region fade
	 * clock both advance on turn boundaries; the breathing border measures the
	 * just-finished turn's duration to modulate its breath cadence, mirroring
	 * `BreathingBorderController.onTurnEnd` — one more "one event, several
	 * keepers" handler, same precedent as `onMessageStart`/`onToolResult` above.
	 */
	onTurnEnd(event: TurnEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#auditTrailState.noteTurn();
		this.#palimpsestState.advanceTurn(event.turnIndex);
		this.#breathingBorderState.applyTurnEnd(event.turnIndex, this.#scheduler.now());
	}

	/** `session_compact`: attribute a nearby cache invalidation to this compaction, and correlate any recent Audit Trail poison flag with the user's recovery. */
	onSessionCompact(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("compact", this.#scheduler.now());
		this.#auditTrailState.noteRecovery(this.#scheduler.now());
	}

	/** `auto_compaction_start`: same cache-invalidation attribution, distinct cause. */
	onAutoCompactionStart(_event: AutoCompactionStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("auto-compact", this.#scheduler.now());
	}

	/** `auto_compaction_end`: Audit Trail's own recovery-correlation signal — a distinct event from `onAutoCompactionStart`'s cache attribution above. */
	onAutoCompactionEnd(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#auditTrailState.noteRecovery(this.#scheduler.now());
	}

	/**
	 * `session_switch`: reset Cache Meter's ledger to a fresh, empty state —
	 * mirroring `CacheMeterController`'s own `session_switch` -> `dispose()`
	 * wiring, without tearing down the box's own mount (Decision 6 — other
	 * segments may be unconditionally mounted and should keep showing
	 * immediately in the new session). Audit Trail's own `session_switch`
	 * wiring drops its working set the same way, via its state's own
	 * `noteSessionSwitch` (counting any still-POISONED/DIRTY path as a
	 * teardown leak) rather than a fresh instance. Rate-Limit Tidepool's own
	 * `session_switch` wiring also resets to a fresh instance and drops its
	 * pending header buffer (`RateLimitTidepoolController.dispose`) — mirrored
	 * the same way here. Tool Constellation, Palimpsest, Cadence Equalizer and
	 * Reflection Ripple wire no `session_switch` handler at all in their own
	 * standalone extensions, so their state is deliberately left untouched
	 * here too.
	 */
	onSessionSwitch(_event: unknown, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState = new CacheMeterState();
		this.#auditTrailState.noteSessionSwitch();
		this.#tidepoolPendingHeaders = undefined;
		this.#tidepoolState = new RateLimitTidepoolState();
	}

	/** Tear down the live mount: dispose the host and clear the widget. Idempotent. */
	dispose(ctx: Pick<AnimationsBoxContext, "setWidget">): void {
		if (!this.#mount) return;
		this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(BOX_WIDGET_KEY, undefined, this.#widgetOptions);
	}
}
