import { extractTaskProgress, skillNamesFromProgress } from "../agent-bonsai/progress";

const RECURRENCE_CELLS = 20;
const SCAR_TURNS = 4;

export interface RecurrenceSignal {
	readonly cells: readonly boolean[];
	readonly orbit: boolean;
}

export interface RewriteSignal {
	readonly shown: number;
	readonly sent: number;
	readonly stripped: number;
}

export interface CompactionScarSignal {
	readonly cutTokens: number;
	readonly rereadCount: number;
}

export interface ConsentSignal {
	readonly tool: string;
	readonly reason?: string;
}

export interface PhylogenySignal {
	readonly depth: number;
	readonly siblings: number;
	readonly node: string;
}

export interface ThinkActSignal {
	readonly thinkingTokens: number;
	readonly actingTokens: number;
	readonly shape: "balanced" | "thinking" | "acting";
}

export interface ErrorSignal {
	readonly signature: string;
	readonly count: number;
}

export interface RetrySignal {
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly delayMs: number;
	readonly error: string;
	readonly startedAt: number;
	readonly fallback?: string;
}

export interface GoalSignal {
	readonly objective: string;
	readonly status: string;
	readonly tokensUsed: number;
	readonly tokenBudget?: number;
}

export interface MemorySignal {
	readonly backend: string;
	readonly workingCount?: number;
	readonly writes: number;
	readonly recalled: boolean;
}

export interface SignalExtrasSnapshot {
	readonly recurrence?: RecurrenceSignal;
	readonly rewrite?: RewriteSignal;
	readonly scar?: CompactionScarSignal;
	readonly consent?: ConsentSignal;
	readonly phylogeny?: PhylogenySignal;
	readonly thinkAct?: ThinkActSignal;
	readonly error?: ErrorSignal;
	readonly queuePending: boolean;
	readonly skills: readonly string[];
	readonly retry?: RetrySignal;
	readonly goal?: GoalSignal;
	readonly ttftMs?: number;
	readonly memory?: MemorySignal;
}

export interface GoalObservation {
	readonly objective: string;
	readonly status: string;
	readonly tokensUsed: number;
	readonly tokenBudget?: number;
}

export interface MemoryObservation {
	readonly backend: string;
	readonly active: boolean;
	readonly workingCount?: number;
	readonly lastRecall?: boolean;
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

function compactError(message: string): { display: string; key: string } | undefined {
	const display = message.replace(/\s+/g, " ").trim().slice(0, 48);
	if (display.length === 0) return undefined;
	const key = display
		.toLowerCase()
		.replace(/[a-f0-9]{8,}/g, "#")
		.replace(/\b\d+(?:\.\d+)?\b/g, "#");
	return { display, key };
}

/** Pure event-derived state for the zero-height-when-idle signal sidecar. */
export class SignalExtrasState {
	#turnTools: string[] = [];
	#previousToolSignature: string | undefined;
	#recurrence: boolean[] = [];
	#rewrite: RewriteSignal | undefined;
	#preCompactTokens: number | undefined;
	#scar: { cutTokens: number; rereadPaths: Set<string>; turnsLeft: number } | undefined;
	#approvals = new Map<string, ConsentSignal>();
	#phylogeny: PhylogenySignal | undefined;
	#thinkAct: ThinkActSignal | undefined;
	#errorCounts = new Map<string, { display: string; count: number }>();
	#latestErrorKey: string | undefined;
	#queuePending = false;
	#skills = new Set<string>();
	#retry: RetrySignal | undefined;
	#goal: GoalSignal | undefined;
	#turnStartedAt: number | undefined;
	#ttftMs: number | undefined;
	#memory: MemorySignal | undefined;
	#previousWorkingCount: number | undefined;

	onTurnStart(now: number): void {
		this.#turnTools = [];
		this.#skills.clear();
		this.#queuePending = false;
		this.#turnStartedAt = now;
		this.#ttftMs = undefined;
	}

	onTurnEnd(pendingMessages: boolean): void {
		const signature = this.#turnTools.join("→");
		if (signature.length > 0) {
			const orbit = signature === this.#previousToolSignature;
			this.#recurrence.push(orbit);
			if (this.#recurrence.length > RECURRENCE_CELLS) this.#recurrence.shift();
			this.#previousToolSignature = signature;
		}
		this.#queuePending = pendingMessages;
		if (this.#scar !== undefined) {
			this.#scar.turnsLeft--;
			if (this.#scar.turnsLeft <= 0) this.#scar = undefined;
		}
	}

	onToolCall(toolName: string, input: object): void {
		this.#turnTools.push(toolName);
		const record = input as Record<string, unknown>;
		if (toolName === "read" && typeof record.path === "string") {
			this.noteRead(record.path);
			const match = /^skill:\/\/([^/\s]+)/.exec(record.path);
			if (match?.[1]) this.#skills.add(match[1]);
		}
	}

	onTaskProgress(payload: unknown): void {
		const progress = extractTaskProgress(payload);
		if (progress === undefined) return;
		for (const row of progress) {
			for (const skill of skillNamesFromProgress(row)) this.#skills.add(skill);
		}
	}

	noteContext(shownTokens: number, sentTokens: number): void {
		const shown = Math.max(0, Math.round(shownTokens));
		const sent = Math.max(0, Math.round(sentTokens));
		this.#rewrite = { shown, sent, stripped: Math.max(0, shown - sent) };
	}

	noteCompactionStart(tokens: number | undefined): void {
		this.#preCompactTokens = tokens;
	}

	noteCompactionEnd(tokens: number | undefined): void {
		const before = this.#preCompactTokens;
		this.#preCompactTokens = undefined;
		if (before === undefined || tokens === undefined) return;
		this.#scar = { cutTokens: Math.max(0, before - tokens), rereadPaths: new Set(), turnsLeft: SCAR_TURNS };
	}

	noteRead(filePath: string): void {
		this.#scar?.rereadPaths.add(filePath);
	}

	noteApprovalRequested(id: string, tool: string, reason?: string): void {
		this.#approvals.set(id, { tool, reason });
	}

	noteApprovalResolved(id: string): void {
		this.#approvals.delete(id);
	}

	notePhylogeny(signal: PhylogenySignal): void {
		this.#phylogeny = signal;
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

	noteAssistantStart(now: number): void {
		if (this.#turnStartedAt !== undefined && this.#ttftMs === undefined) {
			this.#ttftMs = Math.max(0, now - this.#turnStartedAt);
		}
	}

	noteError(message: string): void {
		const normalized = compactError(message);
		if (normalized === undefined) return;
		const current = this.#errorCounts.get(normalized.key);
		this.#errorCounts.set(normalized.key, {
			display: normalized.display,
			count: (current?.count ?? 0) + 1,
		});
		this.#latestErrorKey = normalized.key;
	}

	noteRetryStart(attempt: number, maxAttempts: number, delayMs: number, error: string, now: number): void {
		this.#retry = {
			attempt,
			maxAttempts,
			delayMs,
			error: error.replace(/\s+/g, " ").trim().slice(0, 48),
			startedAt: now,
		};
	}

	noteRetryEnd(): void {
		this.#retry = undefined;
	}

	noteFallback(model: string): void {
		if (this.#retry !== undefined) this.#retry = { ...this.#retry, fallback: model };
	}

	noteGoal(goal: GoalObservation | undefined): void {
		this.#goal = goal;
	}

	noteMemory(status: MemoryObservation | undefined): void {
		if (status === undefined || !status.active || status.backend === "off") {
			this.#memory = undefined;
			this.#previousWorkingCount = undefined;
			return;
		}
		const writes = Math.max(0, (status.workingCount ?? 0) - (this.#previousWorkingCount ?? status.workingCount ?? 0));
		this.#previousWorkingCount = status.workingCount;
		this.#memory = {
			backend: status.backend,
			workingCount: status.workingCount,
			writes,
			recalled: status.lastRecall === true,
		};
	}

	setQueuePending(pending: boolean): void {
		this.#queuePending = pending;
	}

	resetSession(): void {
		this.#turnTools = [];
		this.#previousToolSignature = undefined;
		this.#recurrence = [];
		this.#rewrite = undefined;
		this.#preCompactTokens = undefined;
		this.#scar = undefined;
		this.#approvals.clear();
		this.#phylogeny = undefined;
		this.#thinkAct = undefined;
		this.#errorCounts.clear();
		this.#latestErrorKey = undefined;
		this.#queuePending = false;
		this.#skills.clear();
		this.#retry = undefined;
		this.#goal = undefined;
		this.#turnStartedAt = undefined;
		this.#ttftMs = undefined;
		this.#memory = undefined;
		this.#previousWorkingCount = undefined;
	}

	snapshot(): SignalExtrasSnapshot {
		const latestError = this.#latestErrorKey === undefined ? undefined : this.#errorCounts.get(this.#latestErrorKey);
		const recurrence =
			this.#recurrence.length < 2
				? undefined
				: { cells: [...this.#recurrence], orbit: this.#recurrence.at(-1) === true };
		return {
			recurrence,
			rewrite: this.#rewrite,
			scar:
				this.#scar === undefined
					? undefined
					: { cutTokens: this.#scar.cutTokens, rereadCount: this.#scar.rereadPaths.size },
			consent: this.#approvals.values().next().value,
			phylogeny: this.#phylogeny,
			thinkAct: this.#thinkAct,
			error:
				latestError !== undefined && latestError.count >= 2
					? { signature: latestError.display, count: latestError.count }
					: undefined,
			queuePending: this.#queuePending,
			skills: [...this.#skills],
			retry: this.#retry,
			goal: this.#goal,
			ttftMs: this.#ttftMs,
			memory: this.#memory,
		};
	}
}
