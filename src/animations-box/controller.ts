/**
 * Owns the Audit Box and signal sidecar.
 *
 * Both widgets share one `AnimationHost`, one scheduler, and one set of signal
 * states. Audit rows render current operational summaries below the editor.
 * The sidecar renders only meaningful optional signals above the editor.
 *
 * `#onTick` is the only per-frame mutation seam. Money and risk values render
 * their current values without easing or blinking.
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
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
	ContextUsage,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	SessionBeforeCompactEvent,
	ToolApprovalRequestedEvent,
	ToolApprovalResolvedEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { GoalUpdatedEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import type { ActivityProbe } from "../activity-roster/bus";
import {
	buildActivityFilesSegment,
	projectActivityAgents,
	projectActivityTitleFiles,
} from "../activity-roster/projection";
import type { AgentBonsaiController } from "../agent-bonsai";
import type { AccentColor } from "../appearance";
import { AuditLedgerState, auditTouchesFromToolResult } from "../audit-trail-box";
import { BreathingBorderState, breathEnvelope, EXHALE_DURATION_MS, exhaleEnvelope } from "../breathing-border";
import { CacheMeterState, type CacheRequestSample } from "../cache-meter";
import { CadenceEqualizerState } from "../cadence-equalizer";
import { normalizeAmplitude } from "../cadence-equalizer/scale";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { LiveFilesState } from "../live-files";
import { familyForProvider, RateLimitTidepoolState, readRateLimitHeaders } from "../rate-limit-tidepool";
import { ReflectionRippleState } from "../reflection-ripple";
import {
	buildDarkroomTitle,
	buildSignalExtraSegments,
	DEFAULT_SIGNAL_EXTRAS_CONFIG,
	estimateContentTokens,
	type MemoryObservation,
	type PhylogenySignal,
	type SignalExtrasConfig,
	SignalExtrasState,
} from "../signal-extras";
import { ContextGaugeState } from "./context-gauge";
import {
	type BoxTheme,
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildCadenceEqualizerSegment,
	buildContextGaugeSegment,
	buildRateLimitTidepoolSegment,
	buildReflectionRippleSegment,
	buildToolActivitySegment,
	type SegmentSample,
} from "./segments";
import { type AnimationsBoxConfig, BOX_SEGMENT_IDS } from "./settings";
import { ToolActivityState } from "./tool-activity";
import { type AnimationsBoxSampleGroups, AnimationsBoxWidget } from "./widget";

/** Namespaced per the native-vs-plugin key-collision memory — a plugin's widget key must never collide with a host-owned one. */
export const BOX_WIDGET_KEY = "oh-my-pi-animations-box";
export const SIGNAL_WIDGET_KEY = "oh-my-pi-animation-signals";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/** Narrow a finalized `message_end` event to the provider/model/usage triple the cache ledger needs. The host delivers a whole `AgentMessage`; `CacheMeterState.recordUsage` wants only this triple, so the narrowing lives beside the subscription rather than inside the pure state module. */
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

/** The minimal shape `calculateTokensPerSecond` needs from an assistant `AgentMessage` — a property of the host's rate provider, not of `CadenceEqualizerState`, so it is declared here. */
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

function assistantContentSizes(message: MessageEndEvent["message"]): { thinking: number; acting: number } | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	let thinking = 0;
	let acting = 0;
	for (const block of message.content) {
		if (block.type === "thinking") thinking += block.thinking.length;
		else if (block.type === "text") acting += block.text.length;
	}
	return { thinking, acting };
}

function toolErrorText(event: ToolResultEvent): string | undefined {
	if (!event.isError) return undefined;
	for (const block of event.content) {
		if (block.type === "text" && block.text.trim().length > 0) return block.text;
	}
	return undefined;
}

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

/** Per-event surface the controller needs — decoupled from the full `ExtensionContext` so the controller is unit-testable without a host. */
export interface AnimationsBoxContext {
	hasUI: boolean;
	isTTY: boolean;
	env?: Record<string, string | undefined>;
	cwd: string;
	glyphPreset: SymbolPreset;
	getContextUsage?(): ContextUsage | undefined;
	getTranscriptTokens?(): number;
	getSessionTopology?(): PhylogenySignal;
	hasPendingMessages?(): boolean;
	getMemoryStatus?(): Promise<MemoryObservation | undefined>;
	setTitle?(title: string): void;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

export interface AnimationsBoxControllerOptions {
	scheduler?: FrameScheduler;
	placement?: WidgetPlacement;
	motionSetting?: MotionSetting;
	initialConfig: AnimationsBoxConfig;
	initialExtrasConfig?: SignalExtrasConfig;
	accentColor?: AccentColor;
	auditTrailState?: AuditLedgerState;
	agentBonsai?: AgentBonsaiController;
}

/** Drives the Animations Box. See the module doc above for the state it owns and the two rules it holds. */
export class AnimationsBoxController {
	#scheduler: FrameScheduler;
	#widgetOptions: ExtensionWidgetOptions;
	#signalWidgetOptions: ExtensionWidgetOptions = { placement: "aboveEditor" };
	#motionSetting: MotionSetting;
	#accentColor: AccentColor | undefined;
	#config: AnimationsBoxConfig;
	#extrasConfig: SignalExtrasConfig;
	#mount: { host: AnimationHost; auditWidget?: AnimationsBoxWidget; signalWidget?: AnimationsBoxWidget } | undefined;
	#glyphPreset: SymbolPreset = "unicode";
	#contextGaugeState: ContextGaugeState;
	#getContextUsage: (() => ContextUsage | undefined) | undefined;
	#getTranscriptTokens: (() => number) | undefined;
	#getSessionTopology: (() => PhylogenySignal) | undefined;
	#hasPendingMessages: (() => boolean) | undefined;
	#getMemoryStatus: (() => Promise<MemoryObservation | undefined>) | undefined;
	#setTitle: ((title: string) => void) | undefined;
	#contextPercent: number | undefined;
	#memoryEpoch = 0;
	#cacheMeterState: CacheMeterState = new CacheMeterState();
	#auditTrailState: AuditLedgerState;
	#ownsAuditTrailState: boolean;
	#agentBonsai: AgentBonsaiController | undefined;
	#activityProbe: ActivityProbe | undefined;
	#activityUnsubscribe: (() => void) | undefined;
	#toolActivityState: ToolActivityState = new ToolActivityState();
	#liveFilesState: LiveFilesState = new LiveFilesState();
	#signalState: SignalExtrasState = new SignalExtrasState();
	#cadenceState: CadenceEqualizerState = new CadenceEqualizerState();
	#tidepoolState: RateLimitTidepoolState = new RateLimitTidepoolState();
	#reflectionRippleState: ReflectionRippleState = new ReflectionRippleState();
	#breathingBorderState: BreathingBorderState = new BreathingBorderState();
	#cadenceCurrent: AssistantSample | undefined;
	#cadenceStreaming = false;
	#cadenceHasStreamed = false;
	#tidepoolPendingHeaders: Readonly<Record<string, string>> | undefined;

	constructor(options: AnimationsBoxControllerOptions) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#motionSetting = options.motionSetting ?? "full";
		this.#config = options.initialConfig;
		this.#extrasConfig = options.initialExtrasConfig ?? DEFAULT_SIGNAL_EXTRAS_CONFIG;
		this.#contextGaugeState = new ContextGaugeState(options.initialConfig.contextQuota);
		this.#accentColor = options.accentColor;
		this.#auditTrailState = options.auditTrailState ?? new AuditLedgerState();
		this.#ownsAuditTrailState = options.auditTrailState === undefined;
		this.#agentBonsai = options.agentBonsai;
	}

	get config(): AnimationsBoxConfig {
		return this.#config;
	}

	get extrasConfig(): SignalExtrasConfig {
		return this.#extrasConfig;
	}

	get cacheMeter(): CacheMeterState {
		return this.#cacheMeterState;
	}

	mount(ctx: AnimationsBoxContext): void {
		if (this.#mount || !ctx.hasUI) return;
		this.#glyphPreset = ctx.glyphPreset;
		this.#captureRuntime(ctx);

		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, this.#motionSetting);
		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const scheduler = this.#scheduler;
		const mount: { host: AnimationHost; auditWidget?: AnimationsBoxWidget; signalWidget?: AnimationsBoxWidget } = {
			host,
		};
		this.#mount = mount;

		ctx.setWidget(
			BOX_WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				const widget = new AnimationsBoxWidget({
					tui,
					host,
					policy,
					theme,
					clock: scheduler,
					onTick: now => this.#onTick(now),
					buildSampleGroups: now => this.#buildAuditSampleGroups(now, theme),
					getDetail: () => this.#config.detail,
					getBorderBrightness: now => this.#getBorderBrightness(now),
					accentColor: this.#accentColor,
					preset: this.#glyphPreset,
					getAgentBonsai: () =>
						projectActivityAgents(this.#activityProbe?.snapshot(), this.#agentBonsai?.snapshot()),
				});
				mount.auditWidget = widget;
				return widget;
			},
			this.#widgetOptions,
		);

		ctx.setWidget(
			SIGNAL_WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				const widget = new AnimationsBoxWidget({
					tui,
					host,
					policy,
					theme,
					clock: scheduler,
					onTick: now => this.#onTick(now),
					buildSampleGroups: now => this.#buildSignalSampleGroups(now),
					getDetail: () => this.#config.detail,
					getBorderBrightness: () => undefined,
					accentColor: this.#accentColor,
					preset: this.#glyphPreset,
					getAgentBonsai: () => ({ nodes: [], hiddenCount: 0, visible: false }),
				});
				mount.signalWidget = widget;
				return widget;
			},
			this.#signalWidgetOptions,
		);
		this.#refreshMemory();
		this.#refreshTitle();
	}

	requestRender(): void {
		this.#mount?.auditWidget?.requestRender();
		this.#mount?.signalWidget?.requestRender();
	}

	attachActivityProbe(probe: ActivityProbe | undefined): void {
		if (probe === this.#activityProbe) return;
		this.#activityUnsubscribe?.();
		this.#activityProbe = probe;
		this.#activityUnsubscribe = probe?.subscribe(() => this.#changed());
		this.#changed();
	}

	#captureRuntime(ctx: AnimationsBoxContext): void {
		this.#getContextUsage = ctx.getContextUsage?.bind(ctx);
		this.#getTranscriptTokens = ctx.getTranscriptTokens?.bind(ctx);
		this.#getSessionTopology = ctx.getSessionTopology?.bind(ctx);
		this.#hasPendingMessages = ctx.hasPendingMessages?.bind(ctx);
		this.#getMemoryStatus = ctx.getMemoryStatus?.bind(ctx);
		this.#setTitle = ctx.setTitle?.bind(ctx);
	}

	#sampleCadenceRate(wallNowMs: number): number | null {
		return calculateTokensPerSecond(
			this.#cadenceCurrent ? [this.#cadenceCurrent] : [],
			this.#cadenceStreaming,
			wallNowMs,
		);
	}

	#onTick(now: number): void {
		this.#cadenceState.pushSample(normalizeAmplitude(this.#sampleCadenceRate(now) ?? 0));
		this.#reflectionRippleState.settleIfDone(now);
		this.#breathingBorderState.settleIfDone(now);
	}

	#getBorderBrightness(now: number): number | undefined {
		if (!this.#config.breathingBorder) return undefined;
		switch (this.#breathingBorderState.phase) {
			case "idle":
				return 0;
			case "active": {
				const period = this.#breathingBorderState.breathPeriodMs();
				return breathEnvelope(this.#breathingBorderState.breathElapsedMs(now), period);
			}
			case "exhaling":
				return exhaleEnvelope(this.#breathingBorderState.exhaleElapsedMs(now), EXHALE_DURATION_MS);
		}
	}

	#observeContext(): void {
		const usage = this.#getContextUsage?.();
		this.#contextGaugeState.observe(usage);
		this.#contextPercent = usage?.percent;
	}

	#buildAuditSampleGroups(now: number, theme: BoxTheme): AnimationsBoxSampleGroups {
		this.#observeContext();
		const required: SegmentSample[] = [
			buildContextGaugeSegment(this.#contextGaugeState, now, theme, this.#glyphPreset),
			buildCacheMeterSegment(this.#cacheMeterState, now, theme, undefined, this.#glyphPreset),
			buildAuditTrailBoxSegment(this.#auditTrailState, now, theme, undefined, this.#glyphPreset),
			buildRateLimitTidepoolSegment(this.#tidepoolState, now, theme, undefined, this.#glyphPreset),
			buildToolActivitySegment(this.#toolActivityState, now, theme),
		];
		if (this.#extrasConfig.liveFiles) {
			required.push(
				buildActivityFilesSegment(
					this.#activityProbe?.snapshot(),
					this.#liveFilesState.snapshot(),
					BOX_SEGMENT_IDS.indexOf("filesLive") + 1,
				),
			);
		}
		const optional: SegmentSample[] = [];
		if (this.#config.optional.cadenceEqualizer) {
			optional.push(
				buildCadenceEqualizerSegment(
					this.#cadenceState,
					this.#cadenceHasStreamed,
					this.#sampleCadenceRate(now),
					now,
					theme,
					undefined,
					this.#glyphPreset,
				),
			);
		}
		if (this.#config.optional.reflectionRipple) {
			optional.push(
				buildReflectionRippleSegment(this.#reflectionRippleState, now, theme, undefined, this.#glyphPreset),
			);
		}
		return { required, optional };
	}

	#buildSignalSampleGroups(now: number): AnimationsBoxSampleGroups {
		return {
			required: [],
			optional: buildSignalExtraSegments(this.#signalState.snapshot(), this.#extrasConfig, now),
		};
	}

	#changed(): void {
		this.requestRender();
		this.#refreshTitle();
	}

	#refreshTitle(): void {
		if (!this.#extrasConfig.darkroomTitle) return;
		this.#setTitle?.(
			buildDarkroomTitle(
				this.#signalState.snapshot(),
				this.#contextPercent,
				projectActivityTitleFiles(this.#activityProbe?.snapshot(), this.#liveFilesState.snapshot()),
			),
		);
	}

	#refreshMemory(): void {
		if (!this.#extrasConfig.memoryBackendTide || this.#getMemoryStatus === undefined) return;
		const epoch = ++this.#memoryEpoch;
		void this.#getMemoryStatus()
			.then(status => {
				if (epoch !== this.#memoryEpoch) return;
				this.#signalState.noteMemory(status);
				this.#changed();
			})
			.catch(() => undefined);
	}

	onMessageStart(event: MessageStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const assistantSample = toAssistantSample(event.message);
		if (assistantSample !== undefined) {
			this.#cadenceCurrent = assistantSample;
			this.#cadenceStreaming = true;
			this.#cadenceHasStreamed = true;
			this.#signalState.noteAssistantStart(this.#scheduler.now());
		}
		if (event.message.role === "assistant") {
			const headers = this.#tidepoolPendingHeaders;
			this.#tidepoolPendingHeaders = undefined;
			const family = familyForProvider(event.message.provider);
			if (headers !== undefined && family !== undefined) {
				const now = this.#scheduler.now();
				const reading = readRateLimitHeaders(family, headers, now);
				if (reading !== undefined) {
					this.#tidepoolState.applySample({
						provider: event.message.provider,
						family,
						level: reading.level,
						resetAtMs: reading.resetAtMs,
						observedAtMs: now,
					});
				}
			}
		}
		this.#changed();
	}

	onMessageUpdate(event: MessageUpdateEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const sample = toAssistantSample(event.message);
		if (sample !== undefined) this.#cadenceCurrent = sample;
	}

	onAfterProviderResponse(event: AfterProviderResponseEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#tidepoolPendingHeaders = event.headers;
	}

	onTtsrTriggered(event: TtsrTriggeredEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#reflectionRippleState.applyTrigger(
			event.rules.map(rule => rule.name),
			this.#scheduler.now(),
		);
		this.#changed();
	}

	onMessageEnd(event: MessageEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const cacheSample = toCacheRequestSample(event.message);
		if (cacheSample !== undefined) this.#cacheMeterState.recordUsage(cacheSample, this.#scheduler.now());
		if (toAssistantSample(event.message) !== undefined) {
			this.#cadenceCurrent = undefined;
			this.#cadenceStreaming = false;
			const sizes = assistantContentSizes(event.message);
			if (sizes !== undefined) this.#signalState.noteAssistant(sizes.thinking, sizes.acting);
		}
		this.#changed();
	}

	onToolResult(event: ToolResultEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		if (this.#ownsAuditTrailState) {
			for (const touch of auditTouchesFromToolResult(event, ctx.cwd)) {
				if (touch.kind === "read") this.#auditTrailState.noteRead(touch.path, touch.observed);
				else this.#auditTrailState.noteWrite(touch.path, this.#scheduler.now(), touch.observed);
			}
		}
		this.#liveFilesState.onToolResult(event.toolCallId);
		const error = toolErrorText(event);
		if (error !== undefined) this.#signalState.noteError(error);
		this.#changed();
	}

	onToolCall(
		event: ToolCallEvent,
		ctx: Pick<AnimationsBoxContext, "hasUI"> & Partial<Pick<AnimationsBoxContext, "cwd">>,
	): void {
		if (!ctx.hasUI) return;
		const cwd = ctx.cwd ?? "";
		this.#toolActivityState.record(event.toolName);
		this.#liveFilesState.onToolCall(event, cwd);
		this.#signalState.onToolCall(event.toolName, event.input);
		this.#changed();
	}

	onToolExecutionUpdate(event: ToolExecutionUpdateEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		this.#liveFilesState.onTaskProgress(event.toolCallId, event.partialResult, ctx.cwd);
		this.#signalState.onTaskProgress(event.partialResult);
		this.#changed();
	}

	onToolExecutionEnd(event: ToolExecutionEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		this.#liveFilesState.onTaskEnd(event.toolCallId, event.result, ctx.cwd);
		this.#signalState.onTaskProgress(event.result);
		this.#changed();
	}

	onAgentStart(_event: AgentStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#breathingBorderState.applyAgentStart(this.#scheduler.now());
		this.#changed();
	}

	onAgentEnd(_event: AgentEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "hasPendingMessages">): void {
		if (!ctx.hasUI) return;
		this.#breathingBorderState.applyAgentEnd(this.#scheduler.now());
		this.#signalState.setQueuePending(ctx.hasPendingMessages?.() ?? this.#hasPendingMessages?.() ?? false);
		this.#changed();
	}

	onTurnStart(event: TurnStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		this.#breathingBorderState.applyTurnStart(event.turnIndex, now);
		this.#signalState.onTurnStart(now);
		this.#changed();
	}

	onTurnEnd(event: TurnEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "hasPendingMessages">): void {
		if (!ctx.hasUI) return;
		if (this.#ownsAuditTrailState) this.#auditTrailState.noteTurn();
		this.#breathingBorderState.applyTurnEnd(event.turnIndex, this.#scheduler.now());
		this.#observeContext();
		this.#contextGaugeState.noteTurn();
		this.#signalState.onTurnEnd(ctx.hasPendingMessages?.() ?? this.#hasPendingMessages?.() ?? false);
		this.#refreshMemory();
		this.#changed();
	}

	onContext(event: ContextEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "getTranscriptTokens">): void {
		if (!ctx.hasUI) return;
		const sent = estimateContentTokens(event.messages);
		this.#signalState.noteContext(ctx.getTranscriptTokens?.() ?? this.#getTranscriptTokens?.() ?? sent, sent);
		this.#changed();
	}

	onSessionBeforeCompact(
		_event: SessionBeforeCompactEvent,
		ctx: Pick<AnimationsBoxContext, "hasUI" | "getContextUsage">,
	): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteCompactionStart(ctx.getContextUsage?.()?.tokens ?? this.#getContextUsage?.()?.tokens);
	}

	onSessionCompact(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("compact", this.#scheduler.now());
		if (this.#ownsAuditTrailState) this.#auditTrailState.noteRecovery(this.#scheduler.now());
		this.#contextGaugeState.noteCompaction();
		this.#signalState.noteCompactionEnd(this.#getContextUsage?.()?.tokens);
		this.#changed();
	}

	onAutoCompactionStart(_event: AutoCompactionStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("auto-compact", this.#scheduler.now());
		this.#signalState.noteCompactionStart(this.#getContextUsage?.()?.tokens);
	}

	onAutoCompactionEnd(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		if (this.#ownsAuditTrailState) this.#auditTrailState.noteRecovery(this.#scheduler.now());
		this.#signalState.noteCompactionEnd(this.#getContextUsage?.()?.tokens);
		this.#changed();
	}

	onToolApprovalRequested(event: ToolApprovalRequestedEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteApprovalRequested(event.toolCallId, event.toolName, event.reason);
		this.#changed();
	}

	onToolApprovalResolved(event: ToolApprovalResolvedEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteApprovalResolved(event.toolCallId);
		this.#changed();
	}

	onSessionTopology(_event: unknown, ctx: Pick<AnimationsBoxContext, "hasUI" | "getSessionTopology">): void {
		if (!ctx.hasUI) return;
		const topology = ctx.getSessionTopology?.() ?? this.#getSessionTopology?.();
		if (topology !== undefined) this.#signalState.notePhylogeny(topology);
		this.#changed();
	}

	onAutoRetryStart(event: AutoRetryStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteRetryStart(
			event.attempt,
			event.maxAttempts,
			event.delayMs,
			event.errorMessage,
			this.#scheduler.now(),
		);
		this.#changed();
	}

	onAutoRetryEnd(_event: AutoRetryEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteRetryEnd();
		this.#changed();
	}

	onRetryFallback(
		event: RetryFallbackAppliedEvent | RetryFallbackSucceededEvent,
		ctx: Pick<AnimationsBoxContext, "hasUI">,
	): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteFallback(event.type === "retry_fallback_applied" ? event.to : event.model);
		this.#changed();
	}

	onGoalUpdated(event: GoalUpdatedEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const goal = event.goal;
		this.#signalState.noteGoal(
			goal == null
				? undefined
				: {
						objective: goal.objective,
						status: goal.status,
						tokensUsed: goal.tokensUsed,
						tokenBudget: goal.tokenBudget,
					},
		);
		this.#changed();
	}

	onSessionSwitch(_event: unknown, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState = new CacheMeterState();
		if (this.#ownsAuditTrailState) this.#auditTrailState.noteSessionSwitch();
		this.#tidepoolPendingHeaders = undefined;
		this.#tidepoolState = new RateLimitTidepoolState();
		this.#contextGaugeState = new ContextGaugeState(this.#config.contextQuota);
		this.#liveFilesState.reset();
		this.#signalState.resetSession();
		this.#memoryEpoch++;
		this.#refreshMemory();
		this.#changed();
	}

	dispose(ctx: Pick<AnimationsBoxContext, "setWidget"> & Partial<Pick<AnimationsBoxContext, "setTitle">>): void {
		this.#activityUnsubscribe?.();
		this.#activityUnsubscribe = undefined;
		this.#activityProbe = undefined;
		if (!this.#mount) return;
		this.#mount.host.dispose();
		this.#mount = undefined;
		this.#memoryEpoch++;
		ctx.setWidget(BOX_WIDGET_KEY, undefined, this.#widgetOptions);
		ctx.setWidget(SIGNAL_WIDGET_KEY, undefined, this.#signalWidgetOptions);
		if (this.#extrasConfig.darkroomTitle) (ctx.setTitle ?? this.#setTitle)?.("omp");
	}
}
