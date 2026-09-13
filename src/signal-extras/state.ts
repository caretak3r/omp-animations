import { normalizeToolName } from "../host/runtime";
import { type RetryFuseState, reduceRetryFuse } from "./lifecycle-effects";
import {
	createMemoryTideState,
	type MemoryErrorIdentifier,
	type MemoryTideState,
	reduceMemoryTide,
} from "./memory-tide";
import { appendDurationSample, type DurationSample } from "./metric-effects";

const SCAR_TURNS = 4;

export interface RecurrenceSignal {
	readonly turns: number;
	readonly observedAt: number;
}

export interface RewriteSignal {
	readonly shown: number;
	readonly sent: number;
	readonly stripped: number;
	/** True when `sent` came from provider-reported usage; false when estimated from chars÷4. */
	readonly sentIsActual: boolean;
}

export interface CompactionScarSignal {
	readonly cutTokens: number;
	readonly rereadCount: number;
}

export interface ConsentSignal {
	readonly tool: string;
}

export interface PhylogenySignal {
	readonly depth: number;
	readonly siblings: number;
	readonly offPathCostUsd?: number;
}

export interface ThinkActSignal {
	readonly thinkingTokens: number;
	readonly actingTokens: number;
	readonly shape: "balanced" | "thinking" | "acting";
}

export interface ErrorSignal {
	readonly count: number;
	readonly truncated?: number;
	readonly droppedFeatures?: readonly string[];
	readonly reroutedTo?: string;
}

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface GoalSignal {
	readonly status: GoalStatus;
	readonly tokensUsed: number;
	readonly tokenBudget?: number;
}

export interface AssistantTimingSignal {
	readonly ttftMs?: number;
	readonly durationMs?: number;
}

export interface RetryFallbackSignal {
	readonly from: string;
	readonly to: string;
	readonly succeeded: boolean;
}

export interface SignalExtrasSnapshot {
	readonly recurrence?: RecurrenceSignal;
	readonly rewrite?: RewriteSignal;
	readonly scar?: CompactionScarSignal;
	readonly consent?: ConsentSignal;
	readonly phylogeny?: PhylogenySignal;
	readonly thinkAct?: ThinkActSignal;
	readonly error?: ErrorSignal;
	readonly retry?: RetryFuseState;
	readonly retryFallback?: RetryFallbackSignal;
	readonly goal?: GoalSignal;
	readonly assistantTiming?: AssistantTimingSignal;
	readonly ttftHistory: readonly DurationSample[];
	readonly durationHistory: readonly DurationSample[];
	readonly unverifiedWrites: number;
	readonly memoryTide: MemoryTideState;
	readonly credentialAlerts: readonly string[];
}

export interface GoalObservation {
	readonly status: GoalStatus;
	readonly tokensUsed: number;
	readonly tokenBudget?: number;
}

function contentCharacters(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce((total, item) => total + contentCharacters(item), 0);
	if (typeof value !== "object" || value === null) return 0;
	const record = value as Record<string, unknown>;
	return contentCharacters(record.text ?? record.thinking ?? record.content ?? record.message);
}

export function estimateContentTokens(value: unknown): number {
	return Math.ceil(contentCharacters(value) / 4);
}

/**
 * Activation threshold for the `rewrite` row: render only when the transcript
 * was stripped by ≥ 512 tokens. Reason: `shown` is a chars÷4 estimate, so
 * sub-1% deltas are estimator noise; corpus no-ops were 0–8 tokens, while real
 * host rewrites (compaction, pruning) strip thousands.
 */
export const REWRITE_MIN_STRIPPED_TOKENS = 512;

function safeDuration(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "budget-limited", "complete", "dropped"];

function safeCount(value: number): number | undefined {
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function freezeMemoryTide(state: MemoryTideState): MemoryTideState {
	const lastGood =
		state.lastGood === undefined
			? undefined
			: Object.freeze({
					...state.lastGood,
					status: Object.freeze({ ...state.lastGood.status }),
					working: Object.freeze({
						...state.lastGood.working,
						change: Object.freeze({ ...state.lastGood.working.change }),
					}),
					episodic: Object.freeze({
						...state.lastGood.episodic,
						change: Object.freeze({ ...state.lastGood.episodic.change }),
					}),
					triples: Object.freeze({
						...state.lastGood.triples,
						change: Object.freeze({ ...state.lastGood.triples.change }),
					}),
				});
	return Object.freeze({
		sequence: state.sequence,
		lastGood,
		pollFailure: state.pollFailure === undefined ? undefined : Object.freeze({ ...state.pollFailure }),
	});
}

/** Pure event-derived state for the zero-height-when-idle signal sidecar. */
export class SignalExtrasState {
	#turnTools: string[] = [];
	#previousToolSignature: string | undefined;
	#recurrenceStreak = 0;
	#recurrenceObservedAt: number | undefined;
	#rewrite: RewriteSignal | undefined;
	#sentTokensActual: number | undefined;
	#preCompactTokens: number | undefined;
	#scar: { cutTokens: number; rereadCount: number; turnsLeft: number } | undefined;
	#approvals = new Map<string, ConsentSignal>();
	#phylogeny: PhylogenySignal | undefined;
	#thinkAct: ThinkActSignal | undefined;
	#errorCount = 0;
	#truncatedCount = 0;
	#droppedFeatures = new Set<string>();
	#route: { upstream: string | undefined; changed: boolean } = { upstream: undefined, changed: false };
	#retry: RetryFuseState | undefined;
	#fallback: { from: string; to: string; succeeded: boolean } | undefined;
	#goal: GoalSignal | undefined;
	#assistantTiming: AssistantTimingSignal | undefined;
	#ttftHistory: readonly DurationSample[] = [];
	#durationHistory: readonly DurationSample[] = [];
	#memoryTide: MemoryTideState = createMemoryTideState();
	#credentialAlerts = new Set<string>();
	#sealMutationGen = 0;
	#sealVerifiedGen = -1;

	onTurnStart(): void {
		this.#turnTools = [];
		this.#recurrenceObservedAt = undefined;
		this.#assistantTiming = undefined;
	}

	onTurnEnd(now: number): void {
		const signature = this.#turnTools.join("→");
		if (signature.length > 0) {
			const repeated = signature === this.#previousToolSignature;
			this.#recurrenceStreak = repeated ? this.#recurrenceStreak + 1 : 0;
			this.#recurrenceObservedAt = repeated ? now : undefined;
			this.#previousToolSignature = signature;
		} else {
			this.#previousToolSignature = undefined;
			this.#recurrenceStreak = 0;
			this.#recurrenceObservedAt = undefined;
		}
		if (this.#scar !== undefined) {
			this.#scar.turnsLeft--;
			if (this.#scar.turnsLeft <= 0) this.#scar = undefined;
		}
	}

	onToolCall(toolName: string): void {
		this.#turnTools.push(toolName);
		if (toolName === "read") this.noteRead();
	}

	#sealKind(toolName: string): "write" | "bash" | "other" {
		const normalized = normalizeToolName(toolName);
		if (normalized === "edit" || normalized === "write") return "write";
		if (normalized === "bash") return "bash";
		return "other";
	}

	noteToolSettled(toolName: string, isError: boolean): void {
		const kind = this.#sealKind(toolName);
		if (kind === "bash" && isError) this.#sealVerifiedGen = -1;
		if (isError) return;
		if (kind === "write") this.#sealMutationGen++;
		if (kind === "bash") this.#sealVerifiedGen = this.#sealMutationGen;
	}

	noteUsageSent(promptTokens: number): void {
		this.#sentTokensActual = Math.max(0, Math.round(promptTokens));
	}

	noteContext(shownTokens: number | undefined, estimatedSent: number): void {
		if (shownTokens === undefined || shownTokens === 0) {
			this.#rewrite = undefined;
			return;
		}
		const shown = Math.max(0, Math.round(shownTokens));
		const actualSent = this.#sentTokensActual;
		const sent = actualSent !== undefined ? actualSent : Math.max(0, Math.round(estimatedSent));
		const stripped = Math.max(0, shown - sent);
		this.#rewrite =
			stripped >= REWRITE_MIN_STRIPPED_TOKENS
				? { shown, sent, stripped, sentIsActual: actualSent !== undefined }
				: undefined;
	}

	noteCompactionStart(tokens: number | undefined): void {
		this.#preCompactTokens = tokens;
	}

	noteCompactionEnd(tokens: number | undefined): void {
		const before = this.#preCompactTokens;
		this.#preCompactTokens = undefined;
		if (before === undefined || tokens === undefined) return;
		this.#scar = { cutTokens: Math.max(0, before - tokens), rereadCount: 0, turnsLeft: SCAR_TURNS };
	}

	noteRead(): void {
		if (this.#scar !== undefined) this.#scar.rereadCount++;
	}

	noteApprovalRequested(id: string, tool: string): void {
		this.#approvals.set(id, { tool });
	}

	noteApprovalResolved(id: string): void {
		this.#approvals.delete(id);
	}

	notePhylogeny(signal: PhylogenySignal): void {
		this.#phylogeny = {
			depth: Math.min(999, safeCount(signal.depth) ?? 0),
			siblings: Math.min(999, safeCount(signal.siblings) ?? 0),
			...(Number.isFinite(signal.offPathCostUsd) && (signal.offPathCostUsd ?? 0) > 0
				? { offPathCostUsd: signal.offPathCostUsd }
				: {}),
		};
	}

	noteAssistant(thinkingChars: number, actingChars: number): void {
		const thinkingTokens = Math.ceil(Math.max(0, thinkingChars) / 4);
		const actingTokens = Math.ceil(Math.max(0, actingChars) / 4);
		if (thinkingTokens + actingTokens === 0) return;
		const ratio = thinkingTokens / Math.max(1, actingTokens);
		this.#thinkAct = {
			thinkingTokens,
			actingTokens,
			shape: ratio > 2 ? "thinking" : ratio < 0.5 ? "acting" : "balanced",
		};
	}

	noteAssistantTiming(ttftMs: number | undefined, durationMs: number | undefined): void {
		const ttft = safeDuration(ttftMs);
		const duration = safeDuration(durationMs);
		if (ttft === undefined && duration === undefined) return;
		this.#assistantTiming = {
			...(ttft === undefined ? {} : { ttftMs: ttft }),
			...(duration === undefined ? {} : { durationMs: duration }),
		};
		if (ttft !== undefined) {
			this.#ttftHistory = appendDurationSample(this.#ttftHistory, {
				operationClass: "ttft",
				durationMs: ttft,
			});
		}
		if (duration !== undefined) {
			this.#durationHistory = appendDurationSample(this.#durationHistory, {
				operationClass: "provider-request",
				durationMs: duration,
			});
		}
	}

	noteError(): void {
		this.#errorCount++;
	}

	noteAssistantIntegrity(input: {
		stopReason: string;
		provider: string;
		upstreamProvider?: string;
		disabledFeatures?: string[];
	}): void {
		if (input.stopReason === "length") this.#truncatedCount++;
		for (const feature of input.disabledFeatures ?? []) this.#droppedFeatures.add(feature);
		const upstream = input.upstreamProvider;
		this.#route = {
			upstream,
			changed: upstream !== undefined && upstream !== this.#route.upstream && this.#route.upstream !== undefined,
		};
	}

	noteRetrySchedule(attempt: number, maxAttempts: number, delayMs: number, now: number): void {
		const deadline = Number.isFinite(delayMs) && delayMs >= 0 ? now + delayMs : undefined;
		this.#retry =
			this.#retry === undefined
				? reduceRetryFuse(this.#retry, {
						type: "schedule",
						at: now,
						attempt,
						maxAttempts,
						...(deadline === undefined ? {} : { deadline }),
					})
				: reduceRetryFuse(this.#retry, {
						type: "reschedule",
						at: now,
						attempt,
						maxAttempts,
						...(deadline === undefined ? {} : { deadline }),
					});
	}

	noteRetryEnd(now: number): void {
		this.#retry = reduceRetryFuse(this.#retry, { type: "terminal", at: now });
	}

	noteRetryFallback(from: string, to: string): void {
		this.#fallback = { from, to, succeeded: false };
	}

	noteRetryFallbackSucceeded(): void {
		if (this.#fallback !== undefined) this.#fallback = { ...this.#fallback, succeeded: true };
	}

	noteGoal(goal: GoalObservation | undefined): void {
		if (goal === undefined) {
			this.#goal = undefined;
			return;
		}
		if (!GOAL_STATUSES.includes(goal.status)) {
			this.#goal = undefined;
			return;
		}
		const tokensUsed = safeCount(goal.tokensUsed);
		const tokenBudget = goal.tokenBudget === undefined ? undefined : safeCount(goal.tokenBudget);
		if (tokensUsed === undefined || (goal.tokenBudget !== undefined && tokenBudget === undefined)) {
			this.#goal = undefined;
			return;
		}
		this.#goal = {
			status: goal.status,
			tokensUsed,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		};
	}

	noteMemoryPollSuccess(sequence: number, status: unknown, observedAt: number): boolean {
		const next = reduceMemoryTide(this.#memoryTide, {
			kind: "success",
			sequence,
			observedAt,
			status,
		});
		if (next === this.#memoryTide) return false;
		this.#memoryTide = next;
		return true;
	}

	noteMemoryPollFailure(sequence: number, error: MemoryErrorIdentifier | undefined, observedAt: number): boolean {
		const next = reduceMemoryTide(this.#memoryTide, {
			kind: "failure",
			sequence,
			observedAt,
			error,
		});
		if (next === this.#memoryTide) return false;
		this.#memoryTide = next;
		return true;
	}

	noteCredentialDisabled(provider: string): void {
		const clamped = provider.length > 24 ? provider.slice(0, 24) : provider;
		this.#credentialAlerts.add(clamped);
	}

	resetSession(): void {
		this.#turnTools = [];
		this.#previousToolSignature = undefined;
		this.#recurrenceStreak = 0;
		this.#recurrenceObservedAt = undefined;
		this.#rewrite = undefined;
		this.#sentTokensActual = undefined;
		this.#preCompactTokens = undefined;
		this.#scar = undefined;
		this.#approvals.clear();
		this.#phylogeny = undefined;
		this.#thinkAct = undefined;
		this.#errorCount = 0;
		this.#truncatedCount = 0;
		this.#droppedFeatures.clear();
		this.#route = { upstream: undefined, changed: false };
		this.#retry = undefined;
		this.#fallback = undefined;
		this.#goal = undefined;
		this.#assistantTiming = undefined;
		this.#ttftHistory = [];
		this.#durationHistory = [];
		this.#memoryTide = createMemoryTideState();
		this.#sealMutationGen = 0;
		this.#sealVerifiedGen = -1;
		// credentialAlerts NOT cleared: disabled credentials do not heal on session switch
	}

	snapshot(): SignalExtrasSnapshot {
		const recurrence =
			this.#recurrenceObservedAt === undefined
				? undefined
				: Object.freeze({
						turns: this.#recurrenceStreak + 1,
						observedAt: this.#recurrenceObservedAt,
					});
		return Object.freeze({
			recurrence,
			rewrite: this.#rewrite === undefined ? undefined : Object.freeze({ ...this.#rewrite }),
			scar:
				this.#scar === undefined
					? undefined
					: Object.freeze({ cutTokens: this.#scar.cutTokens, rereadCount: this.#scar.rereadCount }),
			consent: this.#approvals.values().next().value,
			phylogeny: this.#phylogeny === undefined ? undefined : Object.freeze({ ...this.#phylogeny }),
			thinkAct: this.#thinkAct === undefined ? undefined : Object.freeze({ ...this.#thinkAct }),
			error:
				this.#errorCount >= 2 || this.#truncatedCount > 0 || this.#droppedFeatures.size > 0 || this.#route.changed
					? Object.freeze({
							count: this.#errorCount,
							...(this.#truncatedCount > 0 ? { truncated: this.#truncatedCount } : {}),
							...(this.#droppedFeatures.size > 0
								? { droppedFeatures: Object.freeze(Array.from(this.#droppedFeatures).sort()) }
								: {}),
							...(this.#route.changed && this.#route.upstream !== undefined
								? { reroutedTo: this.#route.upstream }
								: {}),
						})
					: undefined,
			retry: this.#retry === undefined ? undefined : Object.freeze({ ...this.#retry }),
			retryFallback: this.#fallback === undefined ? undefined : Object.freeze({ ...this.#fallback }),
			goal: this.#goal === undefined ? undefined : Object.freeze({ ...this.#goal }),
			assistantTiming: this.#assistantTiming === undefined ? undefined : Object.freeze({ ...this.#assistantTiming }),
			ttftHistory: Object.freeze(this.#ttftHistory.map(sample => Object.freeze({ ...sample }))),
			durationHistory: Object.freeze(this.#durationHistory.map(sample => Object.freeze({ ...sample }))),
			unverifiedWrites: Math.max(0, this.#sealMutationGen - Math.max(this.#sealVerifiedGen, 0)),
			memoryTide: freezeMemoryTide(this.#memoryTide),
			credentialAlerts: Object.freeze(Array.from(this.#credentialAlerts).sort()),
		});
	}
}
