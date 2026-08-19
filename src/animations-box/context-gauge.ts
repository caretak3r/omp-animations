/**
 * Context Quota Gauge — state.
 *
 * The Audit Box's top row answers one question the rest of the box can't:
 * *how much conversation is left before this session has to be compacted?*
 *
 * Two facts drive it, and only one of them comes from the host. The host's
 * `getContextUsage()` reports where the window stands right now — tokens,
 * window size, percentage — and is the single source of truth for the fill,
 * so this row can never disagree with the footer's own context readout. The
 * second fact is derived here: how fast the window is filling, measured as
 * the average token growth per user turn, which turns a static percentage
 * into a forecast ("~12 turns left").
 *
 * Two deliberate choices in that forecast:
 *
 * - **The ceiling is the quota, not the window.** Nobody gets to use 100% of
 *   a context window — compaction fires first. So the bar fills against
 *   `quotaPercent` of the window (`animationsContextQuota`, default
 *   {@link CONTEXT_QUOTA_DEFAULT_PERCENT}) and the turn forecast counts down
 *   to that ceiling. Past it the bar pins at full rather than overflowing:
 *   there is no such thing as 110% of your own headroom.
 *
 * - **Only growth counts.** A turn where the context shrank or stood still
 *   (an out-of-band compaction, a tool result that replaced a bigger one)
 *   contributes no sample, but still re-baselines — otherwise the next turn's
 *   delta would be measured from a window that no longer exists and read as a
 *   huge burn. Compaction itself clears the estimate outright via
 *   {@link ContextGaugeState.noteCompaction}: post-compaction burn rate is
 *   simply not knowable from pre-compaction turns, and a stale number here is
 *   worse than no number.
 *
 * Threshold *colors* are not decided here — they come from the host's own
 * `getContextUsageLevel`, so the row escalates on exactly the bands the
 * status line does (see `segments.ts`).
 */
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Default quota ceiling as a percentage of the model's context window — roughly where compaction lands. */
export const CONTEXT_QUOTA_DEFAULT_PERCENT = 80;

/** Floor for a configured quota: below this the bar is full before the session starts and says nothing. */
export const CONTEXT_QUOTA_MIN_PERCENT = 5;

/** Ceiling for a configured quota: the whole window, for anyone who wants the raw context bar. */
export const CONTEXT_QUOTA_MAX_PERCENT = 100;

/**
 * Turn deltas required before a burn rate is published. One delta is noise —
 * a single tool-heavy turn would forecast a session ending in two moves — so
 * the row stays silent until it can average.
 */
export const BURN_MIN_TURNS = 2;

/** Turn deltas kept for the rolling average. Recent turns describe the current phase of work; a session-long mean does not. */
const BURN_WINDOW_TURNS = 8;

/** Clamp a configured quota percentage into range, falling back to the default for anything unusable. */
export function clampContextQuotaPercent(raw: number): number {
	if (!Number.isFinite(raw)) return CONTEXT_QUOTA_DEFAULT_PERCENT;
	return Math.min(CONTEXT_QUOTA_MAX_PERCENT, Math.max(CONTEXT_QUOTA_MIN_PERCENT, raw));
}

/** One frame's worth of gauge truth. Every field is derived; nothing here is eased or animated. */
export interface ContextGaugeSnapshot {
	/** Model context window in tokens, or `0` when the host hasn't reported a usable one yet. */
	readonly contextWindow: number;
	/** Tokens currently in the window. */
	readonly tokens: number;
	/** Percentage of the WINDOW in use — the host's own figure whenever it gave one. */
	readonly windowPercent: number;
	/** The quota ceiling in tokens: `quotaPercent` of {@link contextWindow}. */
	readonly quotaTokens: number;
	/** Fill against the quota ceiling, clamped to `[0, 1]` — pins at `1` past the ceiling. */
	readonly quotaRatio: number;
	/** Tokens left before the quota ceiling, never negative. */
	readonly headroomTokens: number;
	/** Rolling average token growth per turn, or `null` until {@link BURN_MIN_TURNS} deltas exist. */
	readonly tokensPerTurn: number | null;
	/** Whole turns of {@link headroomTokens} left at the current burn rate, or `null` without a rate. */
	readonly turnsLeft: number | null;
	/** Compactions observed this session — the row's only history, and the reason a forecast reset. */
	readonly compactions: number;
}

const RESTING: ContextGaugeSnapshot = {
	contextWindow: 0,
	tokens: 0,
	windowPercent: 0,
	quotaTokens: 0,
	quotaRatio: 0,
	headroomTokens: 0,
	tokensPerTurn: null,
	turnsLeft: null,
	compactions: 0,
};

/** A host reading worth keeping: real tokens against a real window. */
function usable(usage: ContextUsage): boolean {
	return (
		Number.isFinite(usage.contextWindow) &&
		usage.contextWindow > 0 &&
		Number.isFinite(usage.tokens) &&
		usage.tokens >= 0
	);
}

/**
 * Context fill plus a per-turn burn estimate. Pure state: fed by the box
 * controller from `ExtensionContext.getContextUsage()` on every frame and by
 * turn/compaction events, read once per frame by
 * `buildContextGaugeSegment`.
 */
export class ContextGaugeState {
	/** Quota ceiling as a percentage of the context window, already clamped. */
	readonly quotaPercent: number;

	#usage: ContextUsage | undefined;
	/** Token count at the last turn boundary — the baseline the next delta measures from. */
	#baseline: number | undefined;
	#deltas: number[] = [];
	#compactions = 0;

	constructor(quotaPercent: number = CONTEXT_QUOTA_DEFAULT_PERCENT) {
		this.quotaPercent = clampContextQuotaPercent(quotaPercent);
	}

	/** Take the host's latest reading. Absent or unusable readings leave the previous one standing. */
	observe(usage: ContextUsage | undefined): void {
		if (usage === undefined || !usable(usage)) return;
		this.#usage = usage;
	}

	/**
	 * Close a turn: sample the growth since the last boundary. Inert until a
	 * reading exists, and contributes no sample when the window didn't grow —
	 * but always re-baselines, so a shrink is never mistaken for later burn.
	 */
	noteTurn(): void {
		const tokens = this.#usage?.tokens;
		if (tokens === undefined) return;
		const previous = this.#baseline;
		this.#baseline = tokens;
		if (previous === undefined) return;
		const delta = tokens - previous;
		if (delta <= 0) return;
		this.#deltas.push(delta);
		if (this.#deltas.length > BURN_WINDOW_TURNS) this.#deltas.shift();
	}

	/**
	 * The context was compacted. Drops the burn window and the baseline — the
	 * next turn starts a fresh forecast — and counts the compaction, which is
	 * the row's way of showing that a forecast reset rather than vanished.
	 */
	noteCompaction(): void {
		this.#compactions += 1;
		this.#deltas = [];
		this.#baseline = undefined;
	}

	snapshot(): ContextGaugeSnapshot {
		const usage = this.#usage;
		if (usage === undefined) return { ...RESTING, compactions: this.#compactions };

		const { tokens, contextWindow } = usage;
		const quotaTokens = Math.round(contextWindow * (this.quotaPercent / 100));
		const headroomTokens = Math.max(0, quotaTokens - tokens);
		const tokensPerTurn =
			this.#deltas.length >= BURN_MIN_TURNS
				? this.#deltas.reduce((sum, delta) => sum + delta, 0) / this.#deltas.length
				: null;

		return {
			contextWindow,
			tokens,
			// The host's percentage wins whenever it gave a usable one: two
			// readouts of the same window that disagree is worse than either.
			windowPercent:
				Number.isFinite(usage.percent) && usage.percent >= 0 ? usage.percent : (tokens / contextWindow) * 100,
			quotaTokens,
			quotaRatio: quotaTokens > 0 ? Math.min(1, tokens / quotaTokens) : 0,
			headroomTokens,
			tokensPerTurn,
			turnsLeft: tokensPerTurn === null ? null : Math.floor(headroomTokens / tokensPerTurn),
			compactions: this.#compactions,
		};
	}
}
