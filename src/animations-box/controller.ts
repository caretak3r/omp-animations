/**
 * Owns the complete Animations Box.
 *
 * One widget, one `AnimationHost`, and one scheduler render operational
 * summaries and meaningful optional signals together on the configured side
 * of the editor.
 *
 * `#onTick` is the only per-frame mutation seam. Money and risk values render
 * their current values without easing or blinking.
 */

import type { ActivityProbe } from "../activity-roster/bus";
import { projectActivityAgents, projectActivityTitleFiles } from "../activity-roster/projection";
import type { AgentBonsaiController } from "../agent-bonsai";
import type { AccentColor } from "../appearance";
import { AuditLedgerState, auditTouchesFromToolResult } from "../audit-trail-box";
import {
	BreathingBorderState,
	breathEnvelope,
	EXHALE_DURATION_MS,
	exhaleEnvelope,
	GLOSS_TRAIL_FRACTION,
	GLOSS_TRAIL_FRACTION_SUBTLE,
	SUBTLE_BREATH_AMPLITUDE_SCALE,
	SUBTLE_GLOSS_HEAD_SCALE,
} from "../breathing-border";
import { CacheMeterState, type CacheRequestSample } from "../cache-meter";
import type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	AsyncJobSnapshot,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
	ContextUsage,
	CredentialDisabledEvent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	GoalUpdatedEvent,
	MessageEndEvent,
	MessageStartEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	SessionBeforeCompactEvent,
	SymbolPreset,
	ToolApprovalRequestedEvent,
	ToolApprovalResolvedEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	WidgetPlacement,
} from "../host/types";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { LiveFilesState } from "../live-files";
import {
	familyForProvider,
	ProviderHealthState,
	RateLimitTidepoolState,
	readRateLimitHeaders,
} from "../rate-limit-tidepool";
import {
	buildDarkroomTitle,
	buildSignalExtraSegments,
	DEFAULT_SIGNAL_EXTRAS_CONFIG,
	estimateContentTokens,
	type PhylogenySignal,
	type SignalExtrasConfig,
	SignalExtrasState,
} from "../signal-extras";
import { rootSkillName } from "../signal-extras/lifecycle-effects";
import { normalizeMemoryError } from "../signal-extras/memory-tide";
import {
	type CollisionPriority,
	type CollisionSampleId,
	composeCollisionDiffraction,
} from "../signal-extras/metric-effects";
import { ContextGaugeState } from "./context-gauge";
import { CORE_ROW_ORDER, CORE_ROWS, type CoreRowDeps } from "./row-registry";
import type { BoxTheme, SegmentSample } from "./segments";
import type { AnimationsBoxConfig } from "./settings";
import { type TemporalEvidenceSnapshot, TemporalEvidenceStore } from "./temporal-evidence";
import { type AnimationsBoxBorderFrame, type AnimationsBoxSampleGroups, AnimationsBoxWidget } from "./widget";

/** Namespaced per the native-vs-plugin key-collision memory — a plugin's widget key must never collide with a host-owned one. */
export const BOX_WIDGET_KEY = "oh-my-pi-animations-box";
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
	getMemoryStatus?(): Promise<unknown>;
	getAsyncJobSnapshot?(): AsyncJobSnapshot | null;
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

/** Drives the complete Animations Box. See the module documentation above for its lifecycle contract. */
export class AnimationsBoxController {
	#scheduler: FrameScheduler;
	#widgetOptions: ExtensionWidgetOptions;
	#motionSetting: MotionSetting;
	#accentColor: AccentColor | undefined;
	#config: AnimationsBoxConfig;
	#extrasConfig: SignalExtrasConfig;
	#mount: { host: AnimationHost; widget?: AnimationsBoxWidget } | undefined;
	#glyphPreset: SymbolPreset = "unicode";
	#contextGaugeState: ContextGaugeState;
	#getContextUsage: (() => ContextUsage | undefined) | undefined;
	#getTranscriptTokens: (() => number) | undefined;
	#getSessionTopology: (() => PhylogenySignal) | undefined;
	#getMemoryStatus: (() => Promise<unknown>) | undefined;
	#getAsyncJobSnapshot: (() => AsyncJobSnapshot | null) | undefined;
	#setTitle: ((title: string) => void) | undefined;
	#contextPercent: number | undefined;
	#memoryEpoch = 0;
	#memorySequence = 0;
	#cacheMeterState: CacheMeterState = new CacheMeterState();
	#auditTrailState: AuditLedgerState;
	#ownsAuditTrailState: boolean;
	#agentBonsai: AgentBonsaiController | undefined;
	#activityProbe: ActivityProbe | undefined;
	#activityUnsubscribe: (() => void) | undefined;
	#liveFilesState: LiveFilesState = new LiveFilesState();
	#signalState: SignalExtrasState = new SignalExtrasState();
	#skillReads = new Map<string, string>();
	#tidepoolState: RateLimitTidepoolState = new RateLimitTidepoolState();
	#providerHealthState: ProviderHealthState = new ProviderHealthState();
	#breathingBorderState: BreathingBorderState = new BreathingBorderState();
	#tidepoolPendingHeaders: Readonly<Record<string, string>> | undefined;
	#temporalEvidenceStore: TemporalEvidenceStore;
	#temporalEvidenceSnapshot: TemporalEvidenceSnapshot | undefined;
	#temporalEvidenceSession = 0;
	#motionPolicy: MotionPolicy | undefined;

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
		this.#temporalEvidenceStore = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } });
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
		this.#motionPolicy = policy;
		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const scheduler = this.#scheduler;
		const mount: { host: AnimationHost; widget?: AnimationsBoxWidget } = { host };
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
					getBorderFrame: now => this.#getBorderFrame(now),
					getCollisionDiffraction: (now, width) => this.#getCollisionDiffraction(now, width),
					getBorderAlert: () => this.#signalState.snapshot().credentialAlerts.length > 0,
					accentColor: this.#accentColor,
					preset: this.#glyphPreset,
					getAgentBonsai: () => {
						const roster = this.#activityProbe?.snapshot();
						return projectActivityAgents(roster, this.#agentBonsai?.snapshot(roster?.retiredAgentIds));
					},
				});
				mount.widget = widget;
				return widget;
			},
			this.#widgetOptions,
		);

		this.#refreshMemory();
		this.#refreshTitle();
	}

	requestRender(): void {
		this.#mount?.widget?.requestRender();
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
		this.#getMemoryStatus = ctx.getMemoryStatus?.bind(ctx);
		this.#getAsyncJobSnapshot = ctx.getAsyncJobSnapshot?.bind(ctx);
		this.#setTitle = ctx.setTitle?.bind(ctx);
	}

	#onTick(now: number): void {
		this.#breathingBorderState.settleIfDone(now);
	}

	#getBorderFrame(now: number): AnimationsBoxBorderFrame | undefined {
		if (!this.#config.breathingBorder) return undefined;
		const phase = this.#breathingBorderState.phase;
		const motionNow = this.#mount?.host.motionTime(now) ?? now;
		const subtle = this.#mount?.host.effectiveTier === "subtle";
		let brightness: number;
		switch (phase) {
			case "idle":
				brightness = 0;
				break;
			case "active": {
				const period = this.#breathingBorderState.breathPeriodMs();
				brightness = breathEnvelope(this.#breathingBorderState.breathElapsedMs(motionNow), period);
				if (subtle) brightness *= SUBTLE_BREATH_AMPLITUDE_SCALE;
				break;
			}
			case "exhaling":
				brightness = exhaleEnvelope(this.#breathingBorderState.exhaleElapsedMs(now), EXHALE_DURATION_MS);
				break;
		}
		const baseGlossStrength = phase === "active" ? 1 : phase === "exhaling" ? brightness : 0;
		return {
			phase,
			brightness,
			glossProgress: this.#breathingBorderState.glossProgress(motionNow),
			glossStrength: subtle && phase === "active" ? baseGlossStrength * SUBTLE_GLOSS_HEAD_SCALE : baseGlossStrength,
			glossTrailFraction: subtle ? GLOSS_TRAIL_FRACTION_SUBTLE : GLOSS_TRAIL_FRACTION,
		};
	}

	#getCollisionDiffraction(now: number, width: number): string | undefined {
		const snapshot = this.#temporalEvidenceSnapshot;
		if (snapshot === undefined) return undefined;
		const facts = new Map<
			CollisionSampleId,
			{ readonly sampleId: CollisionSampleId; readonly priority: CollisionPriority }
		>();
		let observedAt = Number.NEGATIVE_INFINITY;
		for (const entry of snapshot.entries) {
			if (entry.stage !== "fresh") continue;
			let fact: { readonly sampleId: CollisionSampleId; readonly priority: CollisionPriority } | undefined;
			switch (entry.kind) {
				case "memory-observation":
					fact = { sampleId: "memoryBackendTide", priority: 2 };
					break;
				case "retry-schedule":
					fact = { sampleId: "retryRadar", priority: 1 };
					break;
				case "skill-invocation":
					fact = { sampleId: "skillChromatograph", priority: 2 };
					break;
				case "latency-sample":
					fact = { sampleId: "ttftSplit", priority: 3 };
					break;
				default:
					break;
			}
			if (fact === undefined || facts.has(fact.sampleId)) continue;
			facts.set(fact.sampleId, fact);
			observedAt = Math.max(observedAt, entry.observedAt);
		}
		const token = composeCollisionDiffraction({ phase: "changed", observedAt, facts: [...facts.values()] }, now, {
			width,
			unicode: this.#glyphPreset !== "ascii",
			color: true,
			reducedMotion: (this.#motionPolicy?.reducedMotion ?? true) || this.#mount?.host.effectiveTier === "off",
		});
		return token?.fringe;
	}

	#observeContext(): void {
		const usage = this.#getContextUsage?.();
		this.#contextGaugeState.observe(usage);
		this.#contextPercent = usage?.percent;
	}

	#buildAuditSampleGroups(now: number, theme: BoxTheme): AnimationsBoxSampleGroups {
		this.#temporalEvidenceSnapshot = this.#temporalEvidenceStore.snapshot(now);
		const evidence = this.#temporalEvidenceSnapshot;
		const activityRoster = this.#activityProbe?.snapshot();
		this.#observeContext();
		const deps: CoreRowDeps = {
			now,
			theme,
			glyphPreset: this.#glyphPreset,
			contextGauge: this.#contextGaugeState,
			cacheMeter: this.#cacheMeterState,
			auditTrail: this.#auditTrailState,
			tidepool: this.#tidepoolState,
			providerHealth: this.#providerHealthState.snapshot(),
			roster: activityRoster,
			liveFiles: this.#liveFilesState.snapshot(),
			extrasConfig: this.#extrasConfig,
		};
		const required: SegmentSample[] = [];
		for (const id of CORE_ROW_ORDER) {
			const spec = CORE_ROWS[id];
			if (spec.enabled !== undefined && !spec.enabled(deps)) continue;
			required.push(spec.build(deps));
		}
		// Retry deadlines and evidence expiry remain real-time facts, even when
		// the governor asks the optional renderers for their static motion form.
		const optional = buildSignalExtraSegments(
			this.#signalState.snapshot(),
			this.#extrasConfig,
			now,
			evidence,
			{
				unicode: this.#glyphPreset !== "ascii",
				reducedMotion: (this.#motionPolicy?.reducedMotion ?? true) || this.#mount?.host.effectiveTier === "off",
			},
			activityRoster,
			this.#getAsyncJobSnapshot?.() ?? null,
		);
		return { required, optional };
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
		const epoch = this.#memoryEpoch;
		const sequence = ++this.#memorySequence;
		void this.#getMemoryStatus()
			.then(status => {
				if (epoch !== this.#memoryEpoch) return;
				const now = this.#scheduler.now();
				if (!this.#signalState.noteMemoryPollSuccess(sequence, status, now)) return;
				this.#observeMemoryEvidence(now);
				this.#changed();
			})
			.catch(error => {
				if (epoch !== this.#memoryEpoch) return;
				const now = this.#scheduler.now();
				if (!this.#signalState.noteMemoryPollFailure(sequence, normalizeMemoryError(error), now)) return;
				this.#observeMemoryEvidence(now);
				this.#changed();
			});
	}

	#observeMemoryEvidence(now: number): void {
		const memory = this.#signalState.snapshot().memoryTide;
		const good = memory.lastGood;
		if (good === undefined && memory.pollFailure === undefined) return;
		const status =
			memory.pollFailure !== undefined
				? "degraded"
				: good?.status.active === true && good.status.error === undefined
					? "available"
					: good?.status.active === false || good?.status.backend === "off"
						? "unavailable"
						: "degraded";
		this.#temporalEvidenceStore.observe({
			kind: "memory-observation",
			slot: 0,
			observedAt: now,
			payload: {
				status,
				tier: good?.status.backend === "local" ? "local" : "unknown",
			},
		});
	}

	onMessageStart(event: MessageStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
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

	onAfterProviderResponse(event: AfterProviderResponseEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#tidepoolPendingHeaders = event.headers;
		this.#providerHealthState.noteStatus(event.status, this.#scheduler.now());
		this.#changed();
	}

	onMessageEnd(event: MessageEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		const cacheSample = toCacheRequestSample(event.message);
		if (cacheSample !== undefined) this.#cacheMeterState.recordUsage(cacheSample, now);
		if (event.message.role === "assistant") {
			const sizes = assistantContentSizes(event.message);
			if (sizes !== undefined) this.#signalState.noteAssistant(sizes.thinking, sizes.acting);
			this.#signalState.noteAssistantTiming(event.message.ttft, event.message.duration);
			this.#signalState.noteAssistantIntegrity({
				stopReason: event.message.stopReason,
				provider: event.message.provider,
				upstreamProvider: event.message.upstreamProvider,
				disabledFeatures: event.message.disabledFeatures,
			});
			const usage = event.message.usage;
			this.#signalState.noteUsageSent(usage.input + usage.cacheRead + usage.cacheWrite);
			if (Number.isFinite(event.message.ttft) && (event.message.ttft ?? -1) >= 0) {
				this.#temporalEvidenceStore.observe({
					kind: "latency-sample",
					slot: 0,
					observedAt: now,
					payload: { durationMs: event.message.ttft!, phase: "first-byte" },
				});
			}
			if (Number.isFinite(event.message.duration) && (event.message.duration ?? -1) >= 0) {
				this.#temporalEvidenceStore.observe({
					kind: "latency-sample",
					slot: 1,
					observedAt: now,
					payload: { durationMs: event.message.duration!, phase: "completion" },
				});
			}
		}
		this.#changed();
	}

	onToolResult(event: ToolResultEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		if (this.#ownsAuditTrailState) {
			for (const touch of auditTouchesFromToolResult(event, ctx.cwd)) {
				if (touch.kind === "read") this.#auditTrailState.noteRead(touch.path, touch.observed);
				else this.#auditTrailState.noteWrite(touch.path, now, touch.observed);
			}
		}
		this.#liveFilesState.onToolResult(event.toolCallId);
		const skillName = this.#skillReads.get(event.toolCallId);
		if (skillName !== undefined) {
			this.#skillReads.delete(event.toolCallId);
			this.#temporalEvidenceStore.observe({
				kind: "skill-invocation",
				slot: 0,
				observedAt: now,
				payload: { phase: event.isError ? "failed" : "completed", source: "unknown" },
			});
		}
		if (event.isError) this.#signalState.noteError();
		this.#changed();
	}

	onToolCall(
		event: ToolCallEvent,
		ctx: Pick<AnimationsBoxContext, "hasUI"> & Partial<Pick<AnimationsBoxContext, "cwd">>,
	): void {
		if (!ctx.hasUI) return;
		const cwd = ctx.cwd ?? "";
		const now = this.#scheduler.now();
		this.#liveFilesState.onToolCall(event, cwd);
		this.#signalState.onToolCall(event.toolName);
		const path =
			event.toolName === "read" && typeof (event.input as Record<string, unknown>).path === "string"
				? ((event.input as Record<string, unknown>).path as string)
				: undefined;
		const skillName = path === undefined ? undefined : rootSkillName(event.toolName, path);
		if (skillName !== undefined) {
			this.#skillReads.set(event.toolCallId, skillName);
			this.#temporalEvidenceStore.observe({
				kind: "skill-invocation",
				slot: 0,
				observedAt: now,
				payload: { phase: "started", source: "unknown" },
			});
		}
		this.#changed();
	}

	onToolExecutionStart(_event: ToolExecutionStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#changed();
	}

	onToolExecutionUpdate(event: ToolExecutionUpdateEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		this.#liveFilesState.onTaskProgress(event.toolCallId, event.partialResult, ctx.cwd);
		this.#changed();
	}

	onToolExecutionEnd(event: ToolExecutionEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteToolSettled(event.toolName, event.isError);
		this.#liveFilesState.onTaskEnd(event.toolCallId, event.result, ctx.cwd);
		this.#changed();
	}

	onAgentStart(_event: AgentStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		this.#breathingBorderState.applyAgentStart(now);
		this.#changed();
	}

	onAgentEnd(_event: AgentEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		this.#breathingBorderState.applyAgentEnd(now);
		this.#changed();
	}

	onTurnStart(event: TurnStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		this.#skillReads.clear();
		this.#breathingBorderState.applyTurnStart(event.turnIndex, now);
		this.#signalState.onTurnStart();
		this.#changed();
	}

	onTurnEnd(event: TurnEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const now = this.#scheduler.now();
		if (this.#ownsAuditTrailState) this.#auditTrailState.noteTurn();
		this.#breathingBorderState.applyTurnEnd(event.turnIndex, now);
		this.#observeContext();
		this.#contextGaugeState.noteTurn();
		this.#signalState.onTurnEnd(now);
		this.#skillReads.clear();
		this.#refreshMemory();
		this.#changed();
	}

	onContext(event: ContextEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "getTranscriptTokens">): void {
		if (!ctx.hasUI) return;
		const estimated = estimateContentTokens(event.messages);
		const measured = ctx.getTranscriptTokens?.() ?? this.#getTranscriptTokens?.();
		const shown = measured !== undefined && measured > 0 ? measured : estimated;
		this.#signalState.noteContext(shown, estimated);
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
		this.#signalState.noteApprovalRequested(event.toolCallId, event.toolName);
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
		const now = this.#scheduler.now();
		this.#signalState.noteRetrySchedule(event.attempt, event.maxAttempts, event.delayMs, now);
		if (
			Number.isSafeInteger(event.attempt) &&
			event.attempt > 0 &&
			Number.isFinite(event.delayMs) &&
			event.delayMs >= 0
		) {
			this.#temporalEvidenceStore.observe({
				kind: "retry-schedule",
				slot: 0,
				observedAt: now,
				payload: { attempt: event.attempt, delayMs: event.delayMs },
			});
		}
		this.#changed();
	}

	onAutoRetryEnd(_event: AutoRetryEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteRetryEnd(this.#scheduler.now());
		this.#changed();
	}

	onRetryFallbackApplied(event: RetryFallbackAppliedEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteRetryFallback(event.from, event.to);
		this.#changed();
	}

	onRetryFallbackSucceeded(_event: RetryFallbackSucceededEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteRetryFallbackSucceeded();
		this.#changed();
	}

	onCredentialDisabled(event: CredentialDisabledEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#signalState.noteCredentialDisabled(event.provider);
		this.#changed();
	}

	onGoalUpdated(event: GoalUpdatedEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const goal = event.goal;
		this.#signalState.noteGoal(
			goal == null
				? undefined
				: {
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
		this.#providerHealthState.reset();
		this.#contextGaugeState = new ContextGaugeState(this.#config.contextQuota);
		this.#liveFilesState.reset();
		this.#skillReads.clear();
		this.#signalState.resetSession();
		this.#temporalEvidenceSession++;
		this.#temporalEvidenceStore.switchScope({ root: 0, session: this.#temporalEvidenceSession });
		this.#temporalEvidenceSnapshot = undefined;
		this.#memoryEpoch++;
		this.#memorySequence = 0;
		this.#refreshMemory();
		this.#changed();
	}

	dispose(ctx: Pick<AnimationsBoxContext, "setWidget"> & Partial<Pick<AnimationsBoxContext, "setTitle">>): void {
		this.#activityUnsubscribe?.();
		this.#activityUnsubscribe = undefined;
		this.#activityProbe = undefined;
		this.#skillReads.clear();
		this.#temporalEvidenceStore.dispose();
		this.#temporalEvidenceSnapshot = undefined;
		if (!this.#mount) return;
		this.#mount.host.dispose();
		this.#mount = undefined;
		this.#motionPolicy = undefined;
		this.#memoryEpoch++;
		ctx.setWidget(BOX_WIDGET_KEY, undefined, this.#widgetOptions);
		if (this.#extrasConfig.darkroomTitle) (ctx.setTitle ?? this.#setTitle)?.("omp");
	}
}
