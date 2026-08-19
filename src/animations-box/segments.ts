/**
 * Animations Box — segment sources.
 *
 * One pure builder per core Audit Box signal, each producing a
 * {@link SegmentSample}. The simple-mode `variants` ladder feeds
 * `composeSegments`; the detailed-mode spans feed one status line. Live Files
 * is built in `../live-files`. The breathing border contributes no row.
 *
 * `active` means "this segment's state has something real to report". An
 * inactive segment still produces a `line` — a dim resting status line
 * (`○ label   —`) — so detailed-mode height is a pure function of the ENABLED
 * set, never of runtime activity (Plan 017 Decision 5). Spans are PLAIN text:
 * the widget colors dots, tones, gradients, and change-flash at render time
 * (Plan 018's one deliberate inversion of 017's "segments pre-color"
 * contract).
 *
 * `now` is always a wall-clock reading from the box's own `FrameScheduler`,
 * never the `AnimatedWidget` base class's mount-relative `elapsedMs`
 * (Decision 4).
 */
import * as path from "node:path";
import {
	type ContextUsageLevel,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/context-thresholds";
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	AUDIT_TRAIL_BOX_COLORS,
	type AuditLedgerState,
	type AuditTrailBoxColors,
	type PathRecord,
	renderAuditMeterRow,
} from "../audit-trail-box";
import {
	CACHE_METER_COLORS,
	type CacheMeterColors,
	type CacheMeterState,
	formatCost,
	renderCacheMeterRow,
} from "../cache-meter";
import {
	type CadenceEqualizerColors,
	type CadenceEqualizerState,
	cadenceEqualizerColors,
	renderCompactEqualizer,
	renderEqualizerRow,
	renderEqualizerText,
} from "../cadence-equalizer";
import { MAX_REFERENCE_RATE } from "../cadence-equalizer/scale";
import { renderProgressBar } from "../progress-bar";
import {
	type RateLimitTidepoolState,
	refillLevel,
	renderTidepoolRow,
	TIDEPOOL_COLORS,
	type TidepoolColors,
} from "../rate-limit-tidepool";
import {
	REFLECTION_RIPPLE_COLORS,
	type ReflectionRippleColors,
	type ReflectionRippleState,
	renderReflectionRippleRow,
} from "../reflection-ripple";
import type { ContextGaugeState } from "./context-gauge";
import { BOX_SEGMENT_IDS, type BoxSegmentId } from "./settings";
import type { PhraseSpan, SegmentLine, StatusDot } from "./status-line";
import type { ToolActivityState } from "./tool-activity";

/** The slice of {@link Theme} every segment builder needs — foreground coloring, plus color hex for gradients and bold for flash emphasis where available. */
export type BoxTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "getColorHex" | "bold">>;

/** What one segment contributes this frame, in both box detail levels. */
export interface SegmentSample {
	readonly id: string;
	readonly priority: number;
	/** Whether this segment currently has real content to show. Gates `composeSegments` participation (simple mode) only — `variants` is empty when `false`, so an idle segment contributes nothing to that one composed row. */
	readonly active: boolean;
	/** Widest-first, for `composeSegments`. Empty when `!active`. */
	readonly variants: readonly string[];
	/** Detailed-mode status line — always populated, even when `!active` (a resting line, not an absence; see the module doc). Plain spans; the widget colors them at render time (Plan 018). */
	readonly line: SegmentLine;
}

const INACTIVE = { active: false as const, variants: [] as const };

/** The shared idle phrase — a lone dim em-dash (D4's *idle* resting shape: nothing yet this session). */
const IDLE_SPANS: readonly PhraseSpan[] = [{ key: "idle", text: "—", tone: "dim" }];

/** D4's n/a heuristic floor: this many requests with zero cache traffic latches the "no caching" resting shape. */
const NO_CACHE_REQUEST_FLOOR = 8;

/** D4's *n/a* resting phrase — dim words, no numbers (the metric is structurally absent, not zero). */
const NO_CACHING_SPANS: readonly PhraseSpan[] = [{ key: "na", text: "no caching on this provider", tone: "dim" }];

/** Priority order derives from `BOX_SEGMENT_IDS` so it can never drift from the settings module's own list. */
function priorityOf(id: BoxSegmentId): number {
	return BOX_SEGMENT_IDS.indexOf(id) + 1;
}

function dedupe(variants: readonly string[]): readonly string[] {
	const out: string[] = [];
	for (const v of variants) if (out.at(-1) !== v) out.push(v);
	return out;
}

/**
 * The gauge bar renders PLAIN: its span carries a `gradient`, and the widget
 * paints every cell from that at render time (Plan 018). Handing
 * `renderProgressBar` the real theme would bake ANSI into the string the
 * gradient then has to color again.
 */
const PLAIN_BAR_THEME: BoxTheme = { fg: (_color, text) => text };

/**
 * Dot escalation rides the host's own threshold bands, not a second opinion.
 * `warning` and `purple` are both "worth a glance" — the box has one *notable*
 * dot, so they share it — and only `error` is "act now". Nothing here flashes:
 * a filling context window is a persistent state, not an event (D6).
 */
const CONTEXT_DOT: Readonly<Record<ContextUsageLevel, StatusDot>> = {
	normal: "live",
	warning: "notable",
	purple: "notable",
	error: "alert",
};

/** Context Quota Gauge segment metadata for legend. */
export const CONTEXT_GAUGE_SEGMENT = {
	id: "contextGauge" as const,
	label: "context",
	description: "Context window fill against the compaction quota, and turns of headroom left",
} satisfies { id: BoxSegmentId; label: string; description: string };

/**
 * Context Quota Gauge segment — the box's top row, and the only one that
 * forecasts rather than reports. A dim resting row until the host reports a
 * usable context window: before that there is no window to be a percentage of,
 * and `0%` would read as an empty context rather than a missing measurement
 * (D4's undefined-≠-zero rule).
 *
 * The live line states the same fact three ways, narrowing as the pane does:
 * the bar shows quota fill at a glance, `pct` names it, `used` gives the raw
 * tokens against the real window. The tail carries what a wide pane can
 * afford — the turn forecast, the compactions that reset it, and the ceiling
 * itself, shed in that order right-to-left, so the last thing to go is the
 * most actionable.
 *
 * Both the accent and the dot come from `getContextUsageLevel` against the
 * WINDOW percentage, not the quota fill: the quota is this plugin's own
 * budget, while the thresholds are the host's, and a row that turned red at
 * its own ceiling would disagree with the status line beside it.
 */
export function buildContextGaugeSegment(
	state: ContextGaugeState,
	_now: number,
	_theme: BoxTheme,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("contextGauge");
	const snapshot = state.snapshot();
	if (snapshot.contextWindow === 0) {
		return {
			id: "contextGauge",
			priority,
			...INACTIVE,
			line: {
				dot: "idle",
				label: CONTEXT_GAUGE_SEGMENT.label,
				accent: getContextUsageThemeColor("normal"),
				spans: IDLE_SPANS,
			},
		};
	}

	const level = getContextUsageLevel(snapshot.windowPercent, snapshot.contextWindow);
	const accent = getContextUsageThemeColor(level);
	// UAX #11 classifies block elements as East Asian Ambiguous; pi-tui assumes
	// ambiguous-narrow. Host Nerd selection is automatic, not explicit consent to
	// fallback-prone eighth-block boundaries, so the live bar uses the whole-cell
	// Unicode alphabet unless the user selected ASCII.
	const barPreset: SymbolPreset = preset === "ascii" ? "ascii" : "unicode";
	const bar = renderProgressBar(snapshot.quotaRatio, PLAIN_BAR_THEME, accent, "dim", barPreset);
	const pct = `${Math.round(snapshot.quotaRatio * 100)}% quota`;
	const used = `${formatNumber(snapshot.tokens)}/${formatNumber(snapshot.contextWindow)}`;
	const turnsLeft = snapshot.turnsLeft;

	return {
		id: "contextGauge",
		priority,
		active: true,
		// Simple mode is one shared row for the whole box, and the composer spends
		// budget top-priority-first: a three-part widest variant here would leave
		// the cache row a bare glyph. The bar and its percentage are one fact, so
		// the ladder stops there — raw token counts live on the detail row, which
		// has a whole line to spend.
		variants: dedupe([`${bar} ${pct}`, pct]),
		line: {
			dot: CONTEXT_DOT[level],
			label: CONTEXT_GAUGE_SEGMENT.label,
			accent,
			spans: [
				{ key: "bar", text: bar, gradient: { ratio: snapshot.quotaRatio, direction: "down-good" } },
				// A space, not the default ` · `: the bar and its percentage are one
				// reading, and a dot between them would read as two facts.
				{ key: "pct", text: pct, sep: " " },
				{ key: "used", text: used },
				...(turnsLeft !== null
					? [{ key: "turns", text: `~${turnsLeft} turn${turnsLeft === 1 ? "" : "s"} left`, wideOnly: true }]
					: []),
				...(snapshot.compactions > 0
					? [
							{
								key: "compactions",
								text: `${snapshot.compactions} compaction${snapshot.compactions === 1 ? "" : "s"}`,
								wideOnly: true,
							},
						]
					: []),
				{ key: "quota", text: `${formatNumber(snapshot.quotaTokens)} quota`, wideOnly: true },
			],
		},
	};
}

/** Cache Meter segment metadata for legend. */
export const CACHE_METER_SEGMENT = {
	id: "cacheMeter" as const,
	label: "cache",
	description: "Prompt cache hit rate and cost savings",
} satisfies { id: BoxSegmentId; label: string; description: string };

/**
 * Cache Meter segment — the box's sole owner of prompt-cache telemetry. A dim
 * resting row until `message_end` has delivered at least one usable
 * prompt-cache sample: there is nothing honest to show before the first
 * metered request lands.
 *
 * The live line carries the ledger's whole contract in one phrase: hit
 * percentage, dollars saved, hits/requests, and the uncached/reused/stored
 * token split. Every figure comes from ONE `state.snapshot()` per frame and is
 * formatted with `../cache-meter`'s own `formatCost`/`formatNumber`, so this
 * row and `/cache` can never disagree. The percentage is never eased and the
 * invalidation badge never blinks — the row always draws the snapshot's true
 * current `warmth`, unalerted.
 */
export function buildCacheMeterSegment(
	state: CacheMeterState,
	now: number,
	theme: BoxTheme,
	colors: CacheMeterColors = CACHE_METER_COLORS,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("cacheMeter");
	const snapshot = state.snapshot();
	if (snapshot.promptTokens === 0) {
		return {
			id: "cacheMeter",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "cache", accent: colors.badge, spans: IDLE_SPANS },
		};
	}

	const variants = dedupe(
		[999, 40, 18, 3].map(width =>
			renderCacheMeterRow(snapshot, width, now, theme, "subtle", snapshot.warmth, false, colors, preset),
		),
	);

	// D4 — undefined ≠ zero. Enough requests with zero cache traffic in either
	// direction means the provider structurally lacks prompt caching. The
	// snapshot counters are monotone within one session-model, so the latch
	// derives per-frame: once the floor is crossed the shape holds, and a
	// single later cache hit makes the condition permanently false (un-latch).
	// Simple-mode variants are untouched — D4 is a detailed-mode distinction.
	if (
		snapshot.requestCount >= NO_CACHE_REQUEST_FLOOR &&
		snapshot.cacheReadTokens === 0 &&
		snapshot.cacheWriteTokens === 0
	) {
		return {
			id: "cacheMeter",
			priority,
			active: true,
			variants,
			line: { dot: "idle", label: "cache", accent: colors.badge, spans: NO_CACHING_SPANS },
		};
	}
	return {
		id: "cacheMeter",
		priority,
		active: true,
		variants,
		line: {
			dot: "live",
			label: "cache",
			accent: colors.badge,
			spans: [
				{
					key: "pct",
					text: `${Math.round(snapshot.warmth * 100)}% hit`,
					gradient: { ratio: snapshot.warmth, direction: "up-good" },
				},
				// `undefined` savings ≠ `$0.00` — a row must never claim money it
				// hasn't derived a full-price rate for (state.ts's `hasSavings`).
				...(snapshot.savedCost !== undefined
					? [{ key: "saved", text: `saved ${formatCost(snapshot.savedCost)}` }]
					: []),
				{ key: "hits", text: `${snapshot.hitCount}/${snapshot.requestCount}` },
				// The token split rides the wide tail, widest-detail-last. The
				// renderer sheds tail spans from the right, so `uncached` stays
				// nearest the body. Reused/stored avoids colliding with the
				// audit row's file read/write vocabulary.
				...(snapshot.missTokens > 0
					? [{ key: "uncached", text: `${formatNumber(snapshot.missTokens)} uncached`, wideOnly: true }]
					: []),
				{ key: "read", text: `${formatNumber(snapshot.cacheReadTokens)} reused`, wideOnly: true },
				{ key: "write", text: `${formatNumber(snapshot.cacheWriteTokens)} stored`, wideOnly: true },
			],
		},
	};
}

/** The detailed row uses the box-wide idle glyph when no live rate exists. */
function cadenceRateLabel(tokensPerSecond: number | null): string {
	if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "—";
	return `${Math.round(tokensPerSecond)} t/s`;
}

/**
 * Cadence Equalizer segment. Unlike every other builder in this file, its
 * `state` alone can't answer "has anything ever happened" — the EMA bands
 * decay back toward (but never quite reach) zero between turns. So the box
 * controller tracks `hasStreamed` itself (latched `true` on the first
 * assistant `message_start`) and passes in the live sampled rate from the
 * shared `calculateTokensPerSecond` provider; neither value lives on
 * `CadenceEqualizerState`.
 */
/** Cadence Equalizer segment metadata for legend. */
export const CADENCE_EQUALIZER_SEGMENT = {
	id: "cadenceEqualizer" as const,
	label: "cadence",
	description: "Token streaming rate and response cadence",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildCadenceEqualizerSegment(
	state: CadenceEqualizerState,
	hasStreamed: boolean,
	tokensPerSecond: number | null,
	_now: number,
	theme: BoxTheme,
	colors: CadenceEqualizerColors = cadenceEqualizerColors(),
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("cadenceEqualizer");
	const inactive = (): SegmentSample => ({
		id: "cadenceEqualizer",
		priority,
		...INACTIVE,
		line: { dot: "idle", label: "cadence", accent: colors.burst, spans: IDLE_SPANS },
	});
	if (!hasStreamed) return inactive();

	const bands = state.snapshotBands();
	const peaks = state.snapshotPeaks();
	let peakAmplitude = 0;
	for (const peak of peaks) if (peak > peakAmplitude) peakAmplitude = peak;

	// `message_start` can arrive before the first measurable token sample.
	// Keep the row idle until it has an honest current rate or historical peak.
	const hasLiveRate = tokensPerSecond !== null && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0;
	if (!hasLiveRate && peakAmplitude <= 0) return inactive();

	const variants = dedupe([
		renderEqualizerRow(bands, peaks, theme, colors, preset),
		renderCompactEqualizer(bands, theme, colors),
		renderEqualizerText(tokensPerSecond),
	]);

	return {
		id: "cadenceEqualizer",
		priority,
		active: true,
		variants,
		line: {
			dot: "live",
			label: "cadence",
			accent: colors.burst,
			spans: [
				{ key: "rate", text: cadenceRateLabel(tokensPerSecond) },
				{ key: "peak", text: `peak ${Math.round(peakAmplitude * MAX_REFERENCE_RATE)}` },
			],
		},
	};
}

/**
 * Audit Trail segment. A dim resting row until the first tracked touch lands
 * (`state.size > 0`) — the ledger has nothing to report before its first
 * `noteRead`/`noteWrite`. Like Cache Meter, this line never blinks: the alarm
 * escalates the dot and holds it (D6 below), so a real risk stays visible
 * instead of flashing in and out of view.
 */
/** Audit Trail segment metadata for legend. */
export const AUDIT_TRAIL_SEGMENT = {
	id: "auditTrailBox" as const,
	label: "audit",
	description: "File touch ledger and edit history",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildAuditTrailBoxSegment(
	state: AuditLedgerState,
	now: number,
	theme: BoxTheme,
	colors: AuditTrailBoxColors = AUDIT_TRAIL_BOX_COLORS,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("auditTrailBox");
	if (state.size === 0) {
		return {
			id: "auditTrailBox",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "audit", accent: colors.badge, spans: IDLE_SPANS },
		};
	}

	const snapshot = state.snapshot();
	const variants = dedupe(
		[999, 40, 18].map(width => renderAuditMeterRow(snapshot, width, now, theme, "subtle", colors, preset)),
	);

	// D3: statuses surface as words, and only the risk-bearing two — `poisoned`
	// is "changed on disk", `dirty` is "edited"; redundant/cold/fresh are
	// bookkeeping and never make the phrase. `amp N×` is cut entirely.
	const poisoned = snapshot.counts.poisoned;
	const dirty = snapshot.counts.dirty;
	// Most recently touched path, for the wide-width tail — snapshot.paths is
	// already risk-sorted, not recency-sorted, so this needs its own scan.
	let lastTouched: PathRecord | undefined;
	for (const record of snapshot.paths) {
		if (lastTouched === undefined || record.lastTouchTurn > lastTouched.lastTouchTurn) lastTouched = record;
	}
	const metrics = snapshot.metrics;

	const spans: PhraseSpan[] = [
		{ key: "reads", text: `${metrics.reads} read${metrics.reads === 1 ? "" : "s"}` },
		{ key: "writes", text: `${metrics.writes} write${metrics.writes === 1 ? "" : "s"}` },
	];
	if (poisoned > 0) spans.push({ key: "poisoned", text: `${poisoned} changed on disk`, tone: "alert" });
	if (dirty > 0) spans.push({ key: "dirty", text: `${dirty} edited`, tone: "notable" });
	if (lastTouched !== undefined) spans.push({ key: "last", text: path.basename(lastTouched.path), wideOnly: true });

	// D6: alerts persist — the dot escalates with the worst outstanding status.
	const dot: StatusDot = poisoned > 0 ? "alert" : dirty > 0 ? "notable" : "live";

	return {
		id: "auditTrailBox",
		priority,
		active: true,
		variants,
		line: { dot, label: "audit", accent: colors.badge, spans },
	};
}

/** `resets <N>m`/`resets <N>s`-style ETA to the binding bucket's reset, or `""` when the response reported none. */
function resetEtaLabel(resetAtMs: number | undefined, now: number): string {
	if (resetAtMs === undefined) return "";
	const remainingMs = resetAtMs - now;
	if (remainingMs <= 0) return "resets now";
	const minutes = Math.floor(remainingMs / 60_000);
	if (minutes >= 1) return `resets ${minutes}m`;
	return `resets ${Math.max(1, Math.round(remainingMs / 1000))}s`;
}

/**
 * Rate-Limit Tidepool segment. A dim resting row until the first recognized,
 * provider-whitelisted response lands (`state.snapshot() !== undefined`). The
 * `{anthropic, openai}` family whitelist is enforced upstream, in
 * `controller.ts`'s `onMessageStart` — this builder only ever sees a snapshot
 * that already passed that gate, so it never re-checks it. Every variant
 * renders at the fixed `subtle` motion tier: the box asks for no shimmer, so
 * the level reads as a level rather than as motion. The near-empty `sand`
 * alarm color is fixed regardless of `colors` — `TidepoolColors`/
 * `tidepoolColors` only ever override the `water` slot, so an accent override
 * recolors the water alone.
 */
/** Rate-Limit Tidepool segment metadata for legend. */
export const RATE_LIMIT_TIDEPOOL_SEGMENT = {
	id: "rateLimitTidepool" as const,
	label: "limits",
	description: "API rate limits and request capacity",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildRateLimitTidepoolSegment(
	state: RateLimitTidepoolState,
	now: number,
	theme: BoxTheme,
	colors: TidepoolColors = TIDEPOOL_COLORS,
	_preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("rateLimitTidepool");
	const snapshot = state.snapshot();
	if (snapshot === undefined) {
		return {
			id: "rateLimitTidepool",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "limits", accent: colors.water, spans: IDLE_SPANS },
		};
	}

	const level = refillLevel(snapshot.level, now, snapshot.observedAtMs, snapshot.resetAtMs);
	const variants = dedupe(
		[999, 30, 12].map(width => renderTidepoolRow(level, snapshot.provider, now, width, theme, "subtle", colors)),
	);
	const clampedLevel = level <= 0 ? 0 : level >= 1 ? 1 : level;
	const resetEta = resetEtaLabel(snapshot.resetAtMs, now);

	// D6 — alerts persist, no blinking: ≤10% remaining is an act-now alert
	// (red, bold), ≤20% is notable (amber). The persistent tone replaces the
	// gradient on the pct span; healthy levels carry the D5 gradient instead
	// (up-good: the ratio is the *remaining* fraction, high = good).
	const dot: StatusDot = clampedLevel <= 0.1 ? "alert" : clampedLevel <= 0.2 ? "notable" : "live";
	const pct: PhraseSpan = {
		key: "pct",
		text: `${Math.round(clampedLevel * 100)}% left`,
		...(dot === "live"
			? { gradient: { ratio: clampedLevel, direction: "up-good" as const } }
			: { tone: dot === "alert" ? ("alert" as const) : ("notable" as const) }),
	};
	const spans: PhraseSpan[] = [pct];
	if (resetEta !== "") spans.push({ key: "reset", text: resetEta });
	spans.push({ key: "provider", text: snapshot.provider });

	return {
		id: "rateLimitTidepool",
		priority,
		active: true,
		variants,
		line: { dot, label: "limits", accent: colors.water, spans },
	};
}

/**
 * The `tools` row's single accent. Tool Constellation's seven-way per-category
 * rainbow died with it — one row, one color, like every other segment.
 */
const TOOL_ACTIVITY_ACCENT: ThemeColor = "syntaxKeyword";

/** The `tools` phrase in both detail levels: the headline total, then the reported categories. */
function toolActivityPhrase(total: string, tallies: readonly string[]): string {
	return tallies.length === 0 ? total : `${total} — ${tallies.join(" · ")}`;
}

/**
 * Tool activity segment. A dim resting row until the first `tool_call` is
 * recorded. This row is the plugin's only tool-activity surface and has no
 * pure renderer behind it in an animation directory, so the phrase is derived
 * straight from {@link ToolActivityState}'s own summary.
 *
 * The breakdown never names `read`/`write` — the `audit` row above it already
 * reports those from the file ledger, and repeating them here would be the
 * duplication this row exists to remove. They still count toward `total`.
 * Variants and spans share one vocabulary via {@link toolActivityPhrase}; the
 * simple-mode ladder just drops the tail the same way the detailed line's
 * rightmost-first span degradation does: total + top-2, total + top-1, then
 * the bare total.
 */
/** Tool activity segment metadata for legend. */
export const TOOL_ACTIVITY_SEGMENT = {
	id: "toolActivity" as const,
	label: "tools",
	description: "Tool call volume by category",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildToolActivitySegment(state: ToolActivityState, _now: number, _theme: BoxTheme): SegmentSample {
	const priority = priorityOf("toolActivity");
	const summary = state.summary();
	if (summary.total === 0) {
		return {
			id: "toolActivity",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "tools", accent: "dim", spans: IDLE_SPANS },
		};
	}

	const total = `${summary.total} call${summary.total === 1 ? "" : "s"}`;
	const tallies = summary.top.map(({ category, count }) => `${category} (${count})`);
	const variants = dedupe([toolActivityPhrase(total, tallies), toolActivityPhrase(total, tallies.slice(0, 1)), total]);

	// One span per tally so the renderer's rightmost-first degradation walks the
	// same ladder `variants` spells out, and a single category's count changing
	// flashes only that category.
	const spans: PhraseSpan[] = [
		{ key: "total", text: total },
		...summary.top.map(({ category, count }, index) => ({
			key: `cat:${category}`,
			text: `${category} (${count})`,
			sep: index === 0 ? " — " : undefined,
		})),
	];

	return {
		id: "toolActivity",
		priority,
		active: true,
		variants,
		line: { dot: "live", label: "tools", accent: TOOL_ACTIVITY_ACCENT, spans },
	};
}

/** Live Files metadata for the legend. Its builder lives in `../live-files`. */
export const LIVE_FILES_SEGMENT = {
	id: "filesLive" as const,
	label: "files",
	description: "Paths with an active edit or write owner",
} satisfies { id: BoxSegmentId; label: string; description: string };

/**
 * Reflection Ripple segment. Unlike every other segment in this file, its
 * resting state — `phase === "idle"` — is the COMMON case (Decision 1): a
 * ripple is only ever in flight for the ~1.6s its wave takes to settle, so
 * `active` here means "a ripple is CURRENTLY in flight," not "has ever
 * fired" (contrast Cadence Equalizer's `hasStreamed`, which latches
 * permanently once true). `now` is the box's own `FrameScheduler` wall
 * clock — the SAME clock `controller.ts` stamps `applyTrigger`'s trigger
 * timestamp with — so `state.rippleElapsedMs(now)` renders the correct phase
 * even when the trigger landed before the box's first repaint (Decision 4).
 */
/** Reflection Ripple segment metadata for legend. */
export const REFLECTION_RIPPLE_SEGMENT = {
	id: "reflectionRipple" as const,
	label: "reflect",
	description: "Active reflection triggers and rules",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildReflectionRippleSegment(
	state: ReflectionRippleState,
	now: number,
	theme: BoxTheme,
	colors: ReflectionRippleColors = REFLECTION_RIPPLE_COLORS,
	_preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("reflectionRipple");
	const snapshot = state.snapshot();
	if (snapshot.phase !== "rippling") {
		return {
			id: "reflectionRipple",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "reflect", accent: colors.ring, spans: IDLE_SPANS },
		};
	}

	const elapsed = state.rippleElapsedMs(now);
	const variants = dedupe(
		[999, 40, 12].map(width => renderReflectionRippleRow(elapsed, width, theme, "subtle", colors)),
	);

	return {
		id: "reflectionRipple",
		priority,
		active: true,
		variants,
		line: {
			dot: "live",
			label: "reflect",
			accent: colors.ring,
			spans: [
				{ key: "rules", text: snapshot.ruleNames.join(", ") },
				{ key: "count", text: String(snapshot.triggerCount) },
			],
		},
	};
}

/** Audit Box summary metadata in immutable row order. */
export const REQUIRED_SEGMENT_REGISTRY = [
	LIVE_FILES_SEGMENT,
	CONTEXT_GAUGE_SEGMENT,
	CACHE_METER_SEGMENT,
	AUDIT_TRAIL_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	TOOL_ACTIVITY_SEGMENT,
] as const;

/** Optional animation metadata in deterministic toggle/render order. */
export const OPTIONAL_SEGMENT_REGISTRY = [CADENCE_EQUALIZER_SEGMENT, REFLECTION_RIPPLE_SEGMENT] as const;

/** Complete segment metadata in simple-mode priority order. */
export const SEGMENT_REGISTRY = [...REQUIRED_SEGMENT_REGISTRY, ...OPTIONAL_SEGMENT_REGISTRY] as const;
