/**
 * Animations Box — tool activity state.
 *
 * One deep module owns the `tools` row: call totals, exact execution latency,
 * and the observed work phase. File read/write tallies remain owned by the
 * audit row; this module names them only when they are the active latency fact.
 */
import { normalizeToolName } from "../host/runtime";

export type ToolCategory = "read" | "write" | "bash" | "search" | "agent" | "mcp" | "other";
export type WorkPhase = "research" | "build" | "verify" | "handoff";

/** Display order, also used to break equal-count ties. */
export const REPORTED_CATEGORIES: readonly ToolCategory[] = ["bash", "search", "agent", "mcp", "other"];
export const TOP_CATEGORY_LIMIT = 2;
export const COMPLETED_DURATION_LIMIT = 32;
export const P50_MIN_SAMPLES = 5;

/** Stable classification of a raw tool name. */
export function categorizeTool(toolName: string): ToolCategory {
	if (toolName.startsWith("mcp__")) return "mcp";
	switch (normalizeToolName(toolName)) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "write";
		case "bash":
			return "bash";
		case "grep":
		case "glob":
			return "search";
		case "task":
			return "agent";
		default:
			return "other";
	}
}

export interface CategoryTally {
	readonly category: ToolCategory;
	readonly count: number;
}

export interface ToolActivitySummary {
	readonly total: number;
	readonly top: readonly CategoryTally[];
	readonly phase: WorkPhase;
	readonly phaseRewound: boolean;
	readonly activeCategory: ToolCategory | null;
	readonly activeElapsedMs: number;
	readonly completedSamples: number;
	readonly p50Ms: number | null;
	readonly slowestCategory: ToolCategory | null;
	readonly slowestMs: number;
}

interface ActiveTool {
	readonly category: ToolCategory;
	readonly startedAt: number;
}

interface CompletedDuration {
	readonly category: ToolCategory;
	readonly elapsedMs: number;
}

interface MutableToolActivitySummary {
	total: number;
	top: readonly CategoryTally[];
	phase: WorkPhase;
	phaseRewound: boolean;
	activeCategory: ToolCategory | null;
	activeElapsedMs: number;
	completedSamples: number;
	p50Ms: number | null;
	slowestCategory: ToolCategory | null;
	slowestMs: number;
}

function safeTime(now: number): number {
	return Number.isFinite(now) ? now : 0;
}

/** Request-scoped state behind the existing `tools` row. */
export class ToolActivityState {
	readonly #counts = new Map<ToolCategory, number>();
	readonly #active = new Map<string, ActiveTool>();
	readonly #durations: CompletedDuration[] = [];
	#oldestActiveId: string | undefined;
	#total = 0;
	#phase: WorkPhase = "research";
	#phaseRewound = false;
	#mutationGeneration = 0;
	#verifiedGeneration = -1;
	#talliesStale = false;
	readonly #summary: MutableToolActivitySummary = {
		total: 0,
		top: [],
		phase: "research",
		phaseRewound: false,
		activeCategory: null,
		activeElapsedMs: 0,
		completedSamples: 0,
		p50Ms: null,
		slowestCategory: null,
		slowestMs: 0,
	};

	/** Count one `tool_call`. Execution timing is recorded separately. */
	record(toolName: string): void {
		const category = categorizeTool(toolName);
		this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
		this.#total++;
		this.#talliesStale = true;
	}

	/** Start exact execution timing and update the observed phase. */
	start(toolCallId: string, toolName: string, now: number): void {
		const active: ActiveTool = { category: categorizeTool(toolName), startedAt: safeTime(now) };
		this.#active.set(toolCallId, active);
		this.#recomputeOldestActive();
		this.#observePhaseStart(active.category);
	}

	/** Complete exact timing. Failed operations never advance verification or mutation generations. */
	end(toolCallId: string, toolName: string, isError: boolean, now: number): void {
		const active = this.#active.get(toolCallId);
		if (active !== undefined) {
			this.#active.delete(toolCallId);
			const elapsedMs = Math.max(0, safeTime(now) - active.startedAt);
			this.#durations.push({ category: active.category, elapsedMs });
			if (this.#durations.length > COMPLETED_DURATION_LIMIT) this.#durations.shift();
			this.#recomputeLatency();
			this.#recomputeOldestActive();
		}

		const category = categorizeTool(toolName);
		if (category === "bash" && isError) this.#verifiedGeneration = -1;
		if (isError) return;
		if (category === "write") this.#mutationGeneration++;
		if (category === "bash") this.#verifiedGeneration = this.#mutationGeneration;
	}

	/** Settle to handoff only after a successful bash covered the latest successful write. */
	settle(): void {
		if (this.#active.size > 0 || this.#verifiedGeneration !== this.#mutationGeneration) return;
		this.#phase = "handoff";
		this.#phaseRewound = false;
	}

	/** Clear request/session state without replacing the module instance. */
	reset(): void {
		this.#counts.clear();
		this.#active.clear();
		this.#durations.length = 0;
		this.#oldestActiveId = undefined;
		this.#total = 0;
		this.#phase = "research";
		this.#phaseRewound = false;
		this.#mutationGeneration = 0;
		this.#verifiedGeneration = -1;
		this.#talliesStale = false;
		Object.assign(this.#summary, {
			total: 0,
			top: [],
			phase: "research",
			phaseRewound: false,
			activeCategory: null,
			activeElapsedMs: 0,
			completedSamples: 0,
			p50Ms: null,
			slowestCategory: null,
			slowestMs: 0,
		});
	}

	get total(): number {
		return this.#total;
	}

	/**
	 * Return one reusable live view. Callers must consume it immediately rather
	 * than retaining it; active elapsed time is refreshed in place per frame.
	 */
	summary(now = 0): ToolActivitySummary {
		if (this.#talliesStale) {
			this.#summary.top = REPORTED_CATEGORIES.filter(category => (this.#counts.get(category) ?? 0) > 0)
				.sort((a, b) => (this.#counts.get(b) ?? 0) - (this.#counts.get(a) ?? 0))
				.slice(0, TOP_CATEGORY_LIMIT)
				.map(category => ({ category, count: this.#counts.get(category) ?? 0 }));
			this.#talliesStale = false;
		}
		this.#summary.total = this.#total;
		this.#summary.phase = this.#phase;
		this.#summary.phaseRewound = this.#phaseRewound;
		const oldest = this.#oldestActiveId === undefined ? undefined : this.#active.get(this.#oldestActiveId);
		this.#summary.activeCategory = oldest?.category ?? null;
		this.#summary.activeElapsedMs = oldest === undefined ? 0 : Math.max(0, safeTime(now) - oldest.startedAt);
		return this.#summary;
	}

	#observePhaseStart(category: ToolCategory): void {
		if (category === "write") {
			this.#phaseRewound = this.#phase === "verify" || this.#phase === "handoff";
			this.#phase = "build";
			return;
		}
		if (category === "bash") {
			this.#phase = "verify";
			this.#phaseRewound = false;
		}
	}

	#recomputeOldestActive(): void {
		let oldestId: string | undefined;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [toolCallId, active] of this.#active) {
			if (active.startedAt < oldestAt) {
				oldestId = toolCallId;
				oldestAt = active.startedAt;
			}
		}
		this.#oldestActiveId = oldestId;
	}

	#recomputeLatency(): void {
		this.#summary.completedSamples = this.#durations.length;
		let slowest = this.#durations[0];
		for (const duration of this.#durations) {
			if (slowest === undefined || duration.elapsedMs > slowest.elapsedMs) slowest = duration;
		}
		this.#summary.slowestCategory = slowest?.category ?? null;
		this.#summary.slowestMs = slowest?.elapsedMs ?? 0;
		if (this.#durations.length < P50_MIN_SAMPLES) {
			this.#summary.p50Ms = null;
			return;
		}
		const sorted = this.#durations.map(duration => duration.elapsedMs).sort((a, b) => a - b);
		this.#summary.p50Ms = sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
	}
}
