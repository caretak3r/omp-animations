/**
 * Cache Meter — the pure session-cache ledger.
 *
 * Session-scoped accounting of the provider's own prompt-cache split: every
 * finalized assistant response reports how much of its prompt was served from
 * cache (`cacheRead`), how much was freshly written to it (`cacheWrite`), and
 * how much missed entirely (`input` — the provider's own uncached-input
 * bucket). A "hit" is a request with `cacheRead > 0`; "miss" is only ever the
 * reported uncached input, never a cache write, so a freshly warmed prefix is
 * never mistaken for either reuse or a miss. Ported from the coding-agent's
 * own cache-meter prototype (`packages/coding-agent/src/cache-meter/state.ts`)
 * — its token accounting is sound, only its static widget wasn't.
 *
 * Totals are kept both session-wide and per provider+model, because a session
 * that switches models mid-stream has one cache lineage per model: folding
 * them together would hide, say, a well-warmed Anthropic cache behind a cold
 * Gemini one.
 *
 * Two economics layers sit on top of the token ledger:
 * - **Cost/savings** — `Usage.cost` (`@oh-my-pi/pi-catalog`) puts a dollar
 *   figure on every bucket already tracked in tokens. `savedCost` further
 *   estimates what a request's cache reads would have cost at full price,
 *   using the most recent full-price-per-token rate this provider+model has
 *   demonstrated. That rate is only ever derived, never assumed — a group
 *   that has never shown a derivable rate reports `undefined` savings, not a
 *   fabricated zero.
 * - **Invalidation attribution** — a bare `invalidationCount` says something
 *   broke but not what. `recordEvent` lets the controller mark the last thing
 *   that happened (a compaction, an auto-compaction, a session switch); this
 *   module also detects a provider/model switch on its own. A cache
 *   invalidation is then credited to whichever of those happened most
 *   recently, within {@link ATTRIBUTION_WINDOW_MS} — otherwise it's
 *   `"unattributed"`.
 *
 * A third field, `warmth`, exists alongside — not instead of — `hitRate`:
 * `hitRate` is a lifetime average and stops moving in any session long enough
 * to matter, so it can't answer "is the cache warm right now". `warmth` is
 * the mean of the last {@link WARMTH_WINDOW} requests' own hit fractions,
 * kept in a small rolling window purely for that live read.
 */

export interface CacheUsageSample {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	/**
	 * Dollar cost for this request. `Usage.cost` (`@oh-my-pi/pi-catalog`) is a
	 * required field on every real host sample — the controller always
	 * supplies it — but stays optional here so this type keeps its own
	 * "minimal, dependency-free" contract rather than assuming the caller has
	 * a full `Usage`.
	 */
	readonly cost?: CacheCostSample;
	/** Anthropic cache-write TTL split (`Usage.cttl`); absent for every other provider. */
	readonly cttl?: CacheCttlSample;
}

/** The dollar-cost slice of `Usage.cost` this ledger tracks. */
export interface CacheCostSample {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** The dollar-cost slice of `Usage.cttl` this ledger tracks. */
export interface CacheCttlSample {
	readonly ephemeral5m?: number;
	readonly ephemeral1h?: number;
}

/** One finalized assistant response, as the controller adapts it off `message_end`. */
export interface CacheRequestSample {
	readonly provider: string;
	readonly model: string;
	readonly usage: CacheUsageSample;
}

/** The token buckets {@link detectCacheInvalidation} reads — a minimal, dependency-free slice of `Usage`. */
export interface CacheInvalidationUsage {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** Minimum prefix the previous request must have read from cache before a collapse counts as an invalidation. */
export const MIN_CACHE_FOOTPRINT = 2_048;

/**
 * Pure, value-only port of the host's own `detectCacheInvalidation`
 * (`@oh-my-pi/pi-coding-agent`'s `modes/components/cache-invalidation-marker.ts`,
 * verified in the installed package). That module cannot be imported here as a
 * value — see `src/index.ts`'s header comment for the darwin-arm64
 * native-binding blocker this whole package works around — so its semantics
 * are reproduced by hand and must be kept in sync by hand too.
 *
 * Flags only a demonstrably warm -> cold transition: `prev` must have actually
 * read a meaningful prefix back from cache, and `current` collapsed to zero
 * cache-read while still reprocessing a non-trivial prompt. Crucially it also
 * requires `current.cacheWrite > 0` — only an explicit, prefix-controlled
 * cache (Anthropic/Bedrock) re-creates the prefix on a cold turn that way.
 * Implicit best-effort caches (Google/OpenAI/Fireworks) report `cacheWrite: 0`
 * and drop `cacheRead` to zero intermittently as routine propagation noise, so
 * this never flags them — flagging it would be a wall of false alarms.
 */
export function detectCacheInvalidation(
	prev: CacheInvalidationUsage | undefined,
	current: CacheInvalidationUsage,
): boolean {
	if (prev === undefined) return false;
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return false;
	if (current.cacheRead > 0) return false;
	if (current.cacheWrite <= 0) return false;
	return current.cacheWrite + current.input >= MIN_CACHE_FOOTPRINT;
}

/**
 * What most recently happened that could plausibly explain a cache
 * invalidation. `"model-switch"` is detected internally by {@link
 * CacheMeterState.recordUsage}; the other causes are reported by the
 * controller via {@link CacheMeterState.recordEvent}. `"unattributed"` is
 * never stored as an event — it's only ever the attribution result when no
 * event is recent enough to credit.
 */
export type CacheEventCause = "compact" | "auto-compact" | "session-switch" | "model-switch" | "unattributed";

/** How recent a recorded event must be, relative to the invalidating request, to be credited as its cause. */
export const ATTRIBUTION_WINDOW_MS = 60_000;

/** Most invalidation records a session snapshot retains; oldest drop first. */
const MAX_RETAINED_INVALIDATIONS = 20;

/**
 * How many of the most recent recorded requests feed the rolling warmth
 * window (see {@link CacheMeterSnapshot.warmth}). Small on purpose: this is
 * meant to answer "is the cache warm right now", not to be another lifetime
 * average — `hitRate` already is that.
 */
export const WARMTH_WINDOW = 10;

/** One retained invalidation, as exposed on the session snapshot. */
export interface CacheInvalidationRecord {
	readonly cause: CacheEventCause;
	readonly atMs: number;
}

/** Immutable per-provider+model aggregate, same shape as the session total. */
export interface CacheGroupSnapshot {
	readonly provider: string;
	readonly model: string;
	readonly requestCount: number;
	readonly hitCount: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly missTokens: number;
	readonly hitRate: number;
	readonly promptTokens: number;
	readonly invalidationCount: number;
	readonly costTotal: number;
	readonly costCacheRead: number;
	readonly costCacheWrite: number;
	readonly costInput: number;
	readonly costOutput: number;
	readonly cttlEphemeral5m: number;
	readonly cttlEphemeral1h: number;
	/**
	 * Cumulative (full-price value of this group's cache reads) minus (what
	 * they actually cost), using the most recent derivable unit rate at the
	 * time of each request (see the module doc). `undefined` when this group
	 * has never had a request with both `input > 0` and `cost.input > 0` to
	 * derive a rate from — genuinely unknown, never a fabricated zero.
	 */
	readonly savedCost: number | undefined;
}

/** Immutable session aggregate handed to the pure renderers and the slash command. */
export interface CacheMeterSnapshot {
	/** Assistant responses with prompt-token telemetry. */
	readonly requestCount: number;
	/** Requests that reused at least one provider cache token. */
	readonly hitCount: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly missTokens: number;
	/** `cacheReadTokens / promptTokens`; zero when no prompt-token telemetry exists. */
	readonly hitRate: number;
	readonly promptTokens: number;
	/**
	 * The true, uncapped session total — "how many times did this happen."
	 * Distinct from `invalidations.length`, which answers "what were the
	 * recent ones" and is capped at {@link MAX_RETAINED_INVALIDATIONS}; once a
	 * session passes that many invalidations, `invalidationCount` keeps
	 * counting while the retained list stops growing.
	 */
	readonly invalidationCount: number;
	/** The most recent invalidations, oldest first, capped at {@link MAX_RETAINED_INVALIDATIONS}. */
	readonly invalidations: readonly CacheInvalidationRecord[];
	readonly costTotal: number;
	readonly costCacheRead: number;
	readonly costCacheWrite: number;
	readonly costInput: number;
	readonly costOutput: number;
	readonly cttlEphemeral5m: number;
	readonly cttlEphemeral1h: number;
	/** Sum of every group's own `savedCost`; `undefined` only when no group has ever derived a rate. */
	readonly savedCost: number | undefined;
	/**
	 * Mean of {@link warmthWindow} — a live read on "is the cache warm right
	 * now", unlike `hitRate`'s lifetime average, which stops moving in any
	 * meaningfully long session. `0` when nothing has been recorded yet.
	 */
	readonly warmth: number;
	/**
	 * Each of the last {@link WARMTH_WINDOW} recorded requests' own
	 * `cacheRead / (cacheRead + cacheWrite + input)`, oldest first — what
	 * {@link warmth} averages, and what the sparkline draws from directly.
	 */
	readonly warmthWindow: readonly number[];
	/** One row per provider+model seen this session, in first-seen order. */
	readonly groups: readonly CacheGroupSnapshot[];
}

interface MutableGroup {
	provider: string;
	model: string;
	requestCount: number;
	hitCount: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	missTokens: number;
	invalidationCount: number;
	lastUsage: CacheInvalidationUsage | undefined;
	costTotal: number;
	costCacheRead: number;
	costCacheWrite: number;
	costInput: number;
	costOutput: number;
	cttlEphemeral5m: number;
	cttlEphemeral1h: number;
	/** This group's most recently demonstrated full-price input rate (`cost.input / input`); sticky once derived. */
	lastCacheReadUnitRate: number | undefined;
	savedCost: number;
	/** Whether `savedCost` has ever been computed from a real rate — distinguishes "$0 saved" from "unknown". */
	hasSavings: boolean;
}

/** Provider-reported buckets are clamped to a sane non-negative, finite number before they enter the ledger. */
function normalize(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function freezeGroup(group: MutableGroup): CacheGroupSnapshot {
	const promptTokens = group.cacheReadTokens + group.cacheWriteTokens + group.missTokens;
	return {
		provider: group.provider,
		model: group.model,
		requestCount: group.requestCount,
		hitCount: group.hitCount,
		cacheReadTokens: group.cacheReadTokens,
		cacheWriteTokens: group.cacheWriteTokens,
		missTokens: group.missTokens,
		hitRate: promptTokens > 0 ? group.cacheReadTokens / promptTokens : 0,
		promptTokens,
		invalidationCount: group.invalidationCount,
		costTotal: group.costTotal,
		costCacheRead: group.costCacheRead,
		costCacheWrite: group.costCacheWrite,
		costInput: group.costInput,
		costOutput: group.costOutput,
		cttlEphemeral5m: group.cttlEphemeral5m,
		cttlEphemeral1h: group.cttlEphemeral1h,
		savedCost: group.hasSavings ? group.savedCost : undefined,
	};
}

/** Collision-safe key for a provider+model pair — either string may itself contain arbitrary characters. */
function groupKey(provider: string, model: string): string {
	return JSON.stringify([provider, model]);
}

/**
 * Mutable, session-scoped prompt-cache ledger. `recordUsage` is called once
 * per finalized assistant response; `snapshot` is a pure read with no
 * side effects.
 */
export class CacheMeterState {
	#groups = new Map<string, MutableGroup>();
	#requestCount = 0;
	#hitCount = 0;
	#cacheReadTokens = 0;
	#cacheWriteTokens = 0;
	#missTokens = 0;
	#costTotal = 0;
	#costCacheRead = 0;
	#costCacheWrite = 0;
	#costInput = 0;
	#costOutput = 0;
	#cttlEphemeral5m = 0;
	#cttlEphemeral1h = 0;
	/** True session total, uncapped — see {@link CacheMeterSnapshot.invalidationCount}. */
	#invalidationCount = 0;
	#invalidations: CacheInvalidationRecord[] = [];
	#lastEvent: CacheInvalidationRecord | undefined;
	/** Provider+model of the last *recorded* sample (`groupKey`-encoded) — drives automatic model-switch detection. */
	#lastSampleKey: string | undefined;
	/** Per-request warmth ratios, oldest first, capped at {@link WARMTH_WINDOW} — backs `warmth`/`warmthWindow`. */
	#warmthWindow: number[] = [];

	/**
	 * Record the most recent externally-caused event this ledger should
	 * credit a future invalidation to — see the module doc. Only the single
	 * most recent event is kept; a later call always wins, regardless of
	 * cause. `recordUsage` calls this itself when it detects a provider/model
	 * switch, so `"model-switch"` never needs to be recorded by a caller.
	 */
	recordEvent(cause: CacheEventCause, atMs: number): void {
		this.#lastEvent = { cause, atMs };
	}

	/** `"unattributed"` when no event was recorded, or the most recent one has aged out of {@link ATTRIBUTION_WINDOW_MS}. */
	#attributeCause(atMs: number): CacheEventCause {
		if (this.#lastEvent === undefined) return "unattributed";
		const delta = atMs - this.#lastEvent.atMs;
		return delta >= 0 && delta <= ATTRIBUTION_WINDOW_MS ? this.#lastEvent.cause : "unattributed";
	}

	/**
	 * Record one finalized assistant response. `recorded` is false when the
	 * sample carried no usable prompt-token telemetry (an all-zero/invalid
	 * triple), matching the prototype's degradation. `invalidated` is true when
	 * this request lost a warm cache this provider+model pair was demonstrably
	 * reusing (see {@link detectCacheInvalidation}); the check — and the "last
	 * usage" baseline it compares against — is scoped per provider+model, since
	 * switching models already breaks the prefix and is not itself a
	 * user-visible invalidation.
	 *
	 * `atMs` timestamps the sample for invalidation attribution and cost
	 * bookkeeping; it defaults to wall-clock time but the controller always
	 * passes its scheduler clock so callers stay deterministic under test.
	 */
	recordUsage(sample: CacheRequestSample, atMs: number = Date.now()): { recorded: boolean; invalidated: boolean } {
		const usage: CacheInvalidationUsage = {
			input: normalize(sample.usage.input),
			cacheRead: normalize(sample.usage.cacheRead),
			cacheWrite: normalize(sample.usage.cacheWrite),
		};
		if (usage.input + usage.cacheRead + usage.cacheWrite === 0) return { recorded: false, invalidated: false };

		// This request's own warmth, independent of grouping — the denominator is
		// guaranteed positive by the early return above.
		this.#warmthWindow.push(usage.cacheRead / (usage.cacheRead + usage.cacheWrite + usage.input));
		if (this.#warmthWindow.length > WARMTH_WINDOW) this.#warmthWindow.shift();

		const cost = sample.usage.cost;
		const costInput = normalize(cost?.input ?? 0);
		const costOutput = normalize(cost?.output ?? 0);
		const costCacheRead = normalize(cost?.cacheRead ?? 0);
		const costCacheWrite = normalize(cost?.cacheWrite ?? 0);
		const costTotal = normalize(cost?.total ?? 0);
		const cttlEphemeral5m = normalize(sample.usage.cttl?.ephemeral5m ?? 0);
		const cttlEphemeral1h = normalize(sample.usage.cttl?.ephemeral1h ?? 0);

		const key = groupKey(sample.provider, sample.model);
		if (this.#lastSampleKey !== undefined && this.#lastSampleKey !== key) {
			this.recordEvent("model-switch", atMs);
		}
		this.#lastSampleKey = key;

		let group = this.#groups.get(key);
		if (group === undefined) {
			group = {
				provider: sample.provider,
				model: sample.model,
				requestCount: 0,
				hitCount: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				missTokens: 0,
				invalidationCount: 0,
				lastUsage: undefined,
				costTotal: 0,
				costCacheRead: 0,
				costCacheWrite: 0,
				costInput: 0,
				costOutput: 0,
				cttlEphemeral5m: 0,
				cttlEphemeral1h: 0,
				lastCacheReadUnitRate: undefined,
				savedCost: 0,
				hasSavings: false,
			};
			this.#groups.set(key, group);
		}

		const invalidated = detectCacheInvalidation(group.lastUsage, usage);
		if (invalidated) {
			this.#invalidationCount++;
			this.#invalidations.push({ cause: this.#attributeCause(atMs), atMs });
			if (this.#invalidations.length > MAX_RETAINED_INVALIDATIONS) this.#invalidations.shift();
			group.invalidationCount++;
		}
		group.lastUsage = usage;

		group.requestCount++;
		this.#requestCount++;
		if (usage.cacheRead > 0) {
			group.hitCount++;
			this.#hitCount++;
		}
		group.cacheReadTokens += usage.cacheRead;
		this.#cacheReadTokens += usage.cacheRead;
		group.cacheWriteTokens += usage.cacheWrite;
		this.#cacheWriteTokens += usage.cacheWrite;
		group.missTokens += usage.input;
		this.#missTokens += usage.input;

		group.costTotal += costTotal;
		this.#costTotal += costTotal;
		group.costCacheRead += costCacheRead;
		this.#costCacheRead += costCacheRead;
		group.costCacheWrite += costCacheWrite;
		this.#costCacheWrite += costCacheWrite;
		group.costInput += costInput;
		this.#costInput += costInput;
		group.costOutput += costOutput;
		this.#costOutput += costOutput;
		group.cttlEphemeral5m += cttlEphemeral5m;
		this.#cttlEphemeral5m += cttlEphemeral5m;
		group.cttlEphemeral1h += cttlEphemeral1h;
		this.#cttlEphemeral1h += cttlEphemeral1h;

		// A full-price rate is only derivable from a request that actually paid
		// for uncached input; sticky once seen so a later all-cache-hit request
		// doesn't erase it. Computed with THIS request's own numbers first, so a
		// request that both sets the rate and reads from cache prices its own
		// savings at its own rate rather than a stale one.
		if (usage.input > 0 && costInput > 0) group.lastCacheReadUnitRate = costInput / usage.input;
		if (group.lastCacheReadUnitRate !== undefined) {
			group.savedCost += usage.cacheRead * group.lastCacheReadUnitRate - costCacheRead;
			group.hasSavings = true;
		}

		return { recorded: true, invalidated };
	}

	snapshot(): CacheMeterSnapshot {
		const promptTokens = this.#cacheReadTokens + this.#cacheWriteTokens + this.#missTokens;
		const groups = [...this.#groups.values()].map(freezeGroup);
		const savingsGroups = groups.filter(g => g.savedCost !== undefined);
		return {
			requestCount: this.#requestCount,
			hitCount: this.#hitCount,
			cacheReadTokens: this.#cacheReadTokens,
			cacheWriteTokens: this.#cacheWriteTokens,
			missTokens: this.#missTokens,
			hitRate: promptTokens > 0 ? this.#cacheReadTokens / promptTokens : 0,
			promptTokens,
			invalidationCount: this.#invalidationCount,
			invalidations: [...this.#invalidations],
			costTotal: this.#costTotal,
			costCacheRead: this.#costCacheRead,
			costCacheWrite: this.#costCacheWrite,
			costInput: this.#costInput,
			costOutput: this.#costOutput,
			cttlEphemeral5m: this.#cttlEphemeral5m,
			cttlEphemeral1h: this.#cttlEphemeral1h,
			savedCost:
				savingsGroups.length > 0 ? savingsGroups.reduce((sum, g) => sum + (g.savedCost as number), 0) : undefined,
			warmth:
				this.#warmthWindow.length > 0
					? this.#warmthWindow.reduce((sum, ratio) => sum + ratio, 0) / this.#warmthWindow.length
					: 0,
			warmthWindow: [...this.#warmthWindow],
			groups,
		};
	}
}
