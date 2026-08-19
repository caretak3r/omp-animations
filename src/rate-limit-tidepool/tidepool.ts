/**
 * Rate-Limit Tidepool — pure header parsing, family whitelist, and the
 * level/refill math the Audit Box's `limits` line draws from.
 *
 * **This is not Provider Aurora.** Aurora (Round 1) tried to pair
 * `before_provider_request` with `after_provider_response` by correlation ID
 * and died when no ID existed to pair on. Tidepool does no pairing at all: it
 * is a memoryless *latest-response* level gauge. `AfterProviderResponseEvent`
 * carries the response headers but not which provider they came from
 * (`ProviderResponseMetadata` has no `provider`/`model` field); the *only*
 * ordering guarantee this module leans on is that a response's headers are
 * always emitted before the `message_start` of the assistant message that
 * response produced (the extension host fires `after_provider_response` when
 * headers land, "before its stream body is consumed" — and `message_start`
 * for the assistant fires on the first consumed chunk of that same body).
 * `../animations-box/controller.ts` uses exactly that ordering — never a
 * correlation ID — to know whose headers just arrived: it stashes them on
 * `after_provider_response` and claims them on the next assistant
 * `message_start`. Retry Radar is the after-the-429 view of a rate limit;
 * Tidepool is the before view: how much headroom is left, read straight off
 * the last response's own numbers.
 *
 * Whitelist known families ONLY. A gateway/provider this module doesn't
 * recognize never renders a level — never guessed, never interpolated from a
 * sibling family.
 */

/** The two header shapes this module knows how to read. */
export type RateLimitFamily = "anthropic" | "openai";

/**
 * `AssistantMessage.provider` -> the family whose headers to look for.
 * Keyed on `provider` (the configured gateway actually called), never on
 * `model` or `upstreamProvider` (who an aggregator routed to) — an
 * OpenRouter call to an Anthropic model does not necessarily emit
 * `anthropic-ratelimit-*` headers, since OpenRouter's own proxy headers vary
 * by deployment. Rather than guess, `openrouter` (and every other gateway) is
 * simply absent from this whitelist, so it never mounts a pool — exactly the
 * "whitelist known families only" rule this module is built around.
 */
const FAMILY_BY_PROVIDER: Readonly<Record<string, RateLimitFamily>> = {
	anthropic: "anthropic",
	openai: "openai",
};

/** `undefined` for any provider not explicitly whitelisted above. */
export function familyForProvider(provider: string): RateLimitFamily | undefined {
	return FAMILY_BY_PROVIDER[provider];
}

/**
 * Case-insensitive header lookup. The real path always delivers headers
 * pre-lowercased (`ProviderResponseMetadata.headers` — see
 * `pi-agent-core`'s telemetry docstring), so the direct/exact lookup is the
 * hit path on every real response. The case-insensitive fallback exists only
 * for mocked streams and non-HTTP transports that bypass that normalizer —
 * defensive, not load-bearing for the real path.
 */
function headerLookup(headers: Readonly<Record<string, string>>, key: string): string | undefined {
	const direct = headers[key];
	if (direct !== undefined) return direct;
	const lowerKey = key.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lowerKey) return v;
	}
	return undefined;
}

/** Finite, non-negative. Rejects `NaN`/negative/malformed rather than fabricating a bucket from garbage. */
function parseNonNegativeInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Same as {@link parseNonNegativeInt} but excludes zero — a `limit` of 0 would divide-by-zero the level fraction. */
function parsePositiveInt(raw: string | undefined): number | undefined {
	const n = parseNonNegativeInt(raw);
	return n !== undefined && n > 0 ? n : undefined;
}

/** RFC3339 timestamp (Anthropic's `*-reset` shape) -> absolute epoch ms. `undefined` for anything `Date.parse` can't read. */
function parseRfc3339ToEpochMs(raw: string): number | undefined {
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? ms : undefined;
}

/** `<amount><unit>` token, unit one of ms/s/m/h — the subset of Go's duration grammar OpenAI's `*-reset` headers actually use (e.g. `"6m0s"`, `"1s"`, `"180ms"`). */
const DURATION_TOKEN = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse a Go-style duration string (OpenAI's `*-reset` shape) into
 * milliseconds. Every character must be consumed by a recognized token — a
 * leading sign, an unrecognized unit, or trailing junk all fail closed to
 * `undefined` rather than returning a partial, misleading duration.
 */
export function parseGoDurationMs(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	DURATION_TOKEN.lastIndex = 0;
	let total = 0;
	let consumed = 0;
	let match: RegExpExecArray | null = DURATION_TOKEN.exec(trimmed);
	while (match !== null) {
		const [full, amount, unit] = match as unknown as [string, string, string];
		total += Number(amount) * (DURATION_UNIT_MS[unit] ?? 0);
		consumed += full.length;
		match = DURATION_TOKEN.exec(trimmed);
	}
	return consumed === trimmed.length ? total : undefined;
}

/** One recognized rate-limit resource off a single response's headers. */
interface RawBucket {
	readonly limit: number;
	readonly remaining: number;
	readonly resetAtMs: number | undefined;
}

/**
 * Read one `{limit, remaining, reset}` triple. Both `limit` and `remaining`
 * must parse for the bucket to count at all; `reset` is independently
 * optional (a response can report headroom without a reset, e.g. the
 * boundary is not currently the binding one) and never blocks the bucket.
 * `remaining` is clamped to `limit` defensively — a provider reporting
 * `remaining > limit` must never produce a level fraction above 1.
 */
function extractBucket(
	headers: Readonly<Record<string, string>>,
	limitKey: string,
	remainingKey: string,
	resetKey: string,
	resetToEpochMs: (raw: string, nowMs: number) => number | undefined,
	nowMs: number,
): RawBucket | undefined {
	const limit = parsePositiveInt(headerLookup(headers, limitKey));
	const remaining = parseNonNegativeInt(headerLookup(headers, remainingKey));
	if (limit === undefined || remaining === undefined) return undefined;
	const resetRaw = headerLookup(headers, resetKey);
	const resetAtMs = resetRaw === undefined ? undefined : resetToEpochMs(resetRaw, nowMs);
	return { limit, remaining: Math.min(remaining, limit), resetAtMs };
}

/** Anthropic's four possible rate-limited resources — whichever the response actually reports. */
const ANTHROPIC_RESOURCES: readonly string[] = ["requests", "tokens", "input-tokens", "output-tokens"];

/** `anthropic-ratelimit-{resource}-{field}` — resource before field. Reset is an absolute RFC3339 timestamp. */
function anthropicBuckets(headers: Readonly<Record<string, string>>, nowMs: number): RawBucket[] {
	const buckets: RawBucket[] = [];
	for (const resource of ANTHROPIC_RESOURCES) {
		const bucket = extractBucket(
			headers,
			`anthropic-ratelimit-${resource}-limit`,
			`anthropic-ratelimit-${resource}-remaining`,
			`anthropic-ratelimit-${resource}-reset`,
			raw => parseRfc3339ToEpochMs(raw),
			nowMs,
		);
		if (bucket) buckets.push(bucket);
	}
	return buckets;
}

const OPENAI_RESOURCES: readonly string[] = ["requests", "tokens"];

/** `x-ratelimit-{field}-{resource}` — field before resource (reversed word order from Anthropic's). Reset is a Go-style duration, normalized to `nowMs + duration`. */
function openaiBuckets(headers: Readonly<Record<string, string>>, nowMs: number): RawBucket[] {
	const buckets: RawBucket[] = [];
	for (const resource of OPENAI_RESOURCES) {
		const bucket = extractBucket(
			headers,
			`x-ratelimit-limit-${resource}`,
			`x-ratelimit-remaining-${resource}`,
			`x-ratelimit-reset-${resource}`,
			(raw, now) => {
				const durationMs = parseGoDurationMs(raw);
				return durationMs === undefined ? undefined : now + durationMs;
			},
			nowMs,
		);
		if (bucket) buckets.push(bucket);
	}
	return buckets;
}

/** One family's worth of a single response, reduced to the single binding (most-depleted) bucket. */
export interface RateLimitReading {
	/** `remaining / limit` of the most-depleted recognized bucket, in `[0, 1]`. */
	readonly level: number;
	/**
	 * The binding bucket's own reset, already normalized to an absolute epoch
	 * ms (RFC3339 parsed directly; a duration string resolved against the
	 * `nowMs` this read was given) — `undefined` only when that bucket's
	 * response carried no reset header at all. Computed once here, at ingest,
	 * so every downstream reader (the renderer) stays a pure function of
	 * `(nowMs, resetAtMs)` and never re-reads the wall clock itself.
	 */
	readonly resetAtMs: number | undefined;
}

/**
 * Parse `headers` for `family` and reduce every recognized bucket to the
 * single most-depleted one — "water level = min(remaining/limit) across
 * every recognized bucket on the latest response." `undefined` when zero
 * buckets parsed (headers absent, `{}`, or simply lacking every field this
 * family looks for) — the Audit Box controller's cue that this response has
 * nothing to show, not that the pool is empty.
 */
export function readRateLimitHeaders(
	family: RateLimitFamily,
	headers: Readonly<Record<string, string>>,
	nowMs: number,
): RateLimitReading | undefined {
	const buckets = family === "anthropic" ? anthropicBuckets(headers, nowMs) : openaiBuckets(headers, nowMs);
	if (buckets.length === 0) return undefined;

	let binding = buckets[0] as RawBucket;
	let bindingLevel = binding.remaining / binding.limit;
	for (const bucket of buckets.slice(1)) {
		const level = bucket.remaining / bucket.limit;
		if (level < bindingLevel) {
			binding = bucket;
			bindingLevel = level;
		}
	}
	return { level: bindingLevel, resetAtMs: binding.resetAtMs };
}

function clamp01(x: number): number {
	return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/**
 * The displayed level: the observed reading eased toward full (`1`) as
 * `nowMs` advances from `observedAtMs` toward `resetAtMs` — the "slow refill
 * between requests" the reset headers drive. Pure given its four numeric
 * inputs; the wall-clock read that produces `nowMs` happens once, in the
 * Audit Box's injected frame scheduler, never here. `resetAtMs === undefined`
 * (the binding bucket reported no reset) or a non-positive window both hold
 * the raw observed level rather than fabricating a refill with no data
 * behind it.
 */
export function refillLevel(level: number, nowMs: number, observedAtMs: number, resetAtMs: number | undefined): number {
	if (resetAtMs === undefined) return level;
	const span = resetAtMs - observedAtMs;
	if (!(span > 0)) return level;
	const progress = clamp01((nowMs - observedAtMs) / span);
	return level + (1 - level) * progress;
}

/**
 * `calm`: at/above {@link POOL_CALM_THRESHOLD} — a full pool. `pebbles`:
 * between the two thresholds — the water has receded enough to expose the
 * pool's floor. `sand`: below {@link POOL_SAND_THRESHOLD} — read as
 * near-empty wet sand. Guarded with `!(level < threshold)` rather than
 * `level >= threshold` — the same "`<` used as a gate is backwards for NaN"
 * shape Drift Buoy's `driftTier` hardened — so a non-finite level reads as
 * the calm, unalarming default instead of propagating NaN into the tier.
 */
export type PoolTier = "calm" | "pebbles" | "sand";

/** At or above this fraction the pool reads as a calm, full pool. */
export const POOL_CALM_THRESHOLD = 0.66;
/** Below this fraction the pool reads as nearly-empty wet sand. */
export const POOL_SAND_THRESHOLD = 0.25;

export function poolTier(level: number): PoolTier {
	if (!(level < POOL_CALM_THRESHOLD)) return "calm";
	if (level < POOL_SAND_THRESHOLD) return "sand";
	return "pebbles";
}

/** How many of `cells` read as filled water at this level. `NaN`/non-positive levels fill zero cells; levels at/above 1 fill every cell. */
export function poolFilledCells(level: number, cells: number): number {
	if (cells <= 0) return 0;
	if (!(level > 0)) return 0;
	const clamped = level >= 1 ? 1 : level;
	return Math.round(cells * clamped);
}
