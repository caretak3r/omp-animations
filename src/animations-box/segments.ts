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
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	AUDIT_TRAIL_BOX_COLORS,
	type AuditLedgerState,
	type AuditTrailBoxColors,
	type PathRecord,
	renderAuditMeterRow,
} from "../audit-trail-box";
import { CACHE_METER_COLORS, type CacheMeterColors, type CacheMeterState, formatCost } from "../cache-meter";
import { ageText } from "../duration";
import { getContextUsageLevel, getContextUsageThemeColor } from "../host/runtime";
import type { ContextUsageLevel, SymbolPreset, Theme } from "../host/types";
import { renderProgressBar } from "../progress-bar";
import {
	classifyStatus,
	type ProviderHealthSnapshot,
	type RateLimitTidepoolState,
	refillLevel,
	type StatusClass,
	TIDEPOOL_COLORS,
	type TidepoolColors,
} from "../rate-limit-tidepool";
import type { ContextGaugeState } from "./context-gauge";
import { BOX_SEGMENT_IDS, type BoxSegmentId } from "./settings";
import type { PhraseSpan, SegmentLine, StatusDot } from "./status-line";

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

/** A sustained cold workload warrants a quiet observation, not a capability claim. */
const NO_CACHE_REQUEST_FLOOR = 8;

const NO_REUSE_SPANS: readonly PhraseSpan[] = [{ key: "no-reuse", text: "no reuse observed", tone: "dim" }];

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
 * Gauge visuals render plain text. The widget applies the span gradient once,
 * after the selected renderer has produced its fixed-width rail.
 */
const PLAIN_GAUGE_THEME: BoxTheme = { fg: (_color, text) => text };

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
 * the selected visual shows quota fill at a glance, `pct` names it, and
 * `used` gives the raw tokens against the real window. The tail carries what
 * a wide pane can afford — the turn forecast, the compactions that reset it,
 * and the ceiling itself, shed in that order right-to-left, so the last thing
 * to go is the most actionable.
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
	const quotaGradient: NonNullable<PhraseSpan["gradient"]> = {
		ratio: snapshot.quotaRatio,
		direction: "down-good",
	};
	const visual = renderProgressBar(
		snapshot.quotaRatio,
		PLAIN_GAUGE_THEME,
		accent,
		"dim",
		preset === "ascii" ? "ascii" : "unicode",
	);
	const pct = `${Math.round(snapshot.quotaRatio * 100)}% budget`;
	const used = `${formatNumber(snapshot.tokens)}/${formatNumber(snapshot.contextWindow)} window`;
	const turnsLeft = snapshot.turnsLeft;

	return {
		id: "contextGauge",
		priority,
		active: true,
		// Simple mode is one shared row for the whole box, and the composer spends
		// budget top-priority-first: a three-part widest variant here would leave
		// the cache row a bare glyph. The visual and its percentage are one fact,
		// so the ladder stops there — raw token counts live on the detail row,
		// which has a whole line to spend.
		variants: dedupe([`${visual} ${pct}`, pct]),
		line: {
			dot: CONTEXT_DOT[level],
			label: CONTEXT_GAUGE_SEGMENT.label,
			accent,
			spans: [
				{
					key: "visual",
					text: visual,
					neverTruncate: true,
					priority: 1,
					gradient: quotaGradient,
				},
				// A space, not the default ` · `: the visual and its percentage
				// are one reading, and a dot between them would read as two facts.
				{ key: "pct", text: pct, sep: " ", priority: 0 },
				// Narrow priority inverted: bar+pct is one reading of fill, `turns` is
				// the only *forecast* (the differentiator against the status line), and
				// `used` restates fill in raw tokens (detail-width tail can afford it, 45 cols cannot).
				{ key: "used", text: used, wideOnly: true },
				...(turnsLeft !== null && turnsLeft <= 99
					? [
							{
								key: "turns",
								text: `~${turnsLeft} turn${turnsLeft === 1 ? "" : "s"} left`,
							},
						]
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
 * Recent token reuse is the mean of the last ten requests' individual
 * cacheRead / (input + cacheRead + cacheWrite) fractions. Session requests
 * with reuse are a separate count. Both modes derive their text from the
 * same spans; neither money nor invalidation counts are eased or blinked.
 */
export function buildCacheMeterSegment(
	state: CacheMeterState,
	_now: number,
	_theme: BoxTheme,
	colors: CacheMeterColors = CACHE_METER_COLORS,
	_preset: SymbolPreset = "unicode",
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

	if (
		snapshot.requestCount >= NO_CACHE_REQUEST_FLOOR &&
		snapshot.cacheReadTokens === 0 &&
		snapshot.cacheWriteTokens === 0
	) {
		return {
			id: "cacheMeter",
			priority,
			active: true,
			variants: NO_REUSE_SPANS.map(span => span.text),
			line: { dot: "idle", label: "cache", accent: colors.badge, spans: NO_REUSE_SPANS },
		};
	}
	const reusePercent = Math.round(snapshot.warmth * 100);
	const spans: readonly PhraseSpan[] = [
		{
			key: "pct",
			text: `${reusePercent}% recent token reuse`,
			gradient: { ratio: snapshot.warmth, direction: "up-good" },
		},
		...(snapshot.savedCost !== undefined ? [{ key: "saved", text: `saved ${formatCost(snapshot.savedCost)}` }] : []),
		{ key: "hits", text: `${snapshot.hitCount}/${snapshot.requestCount} session requests with reuse` },
		...(snapshot.missTokens > 0
			? [{ key: "uncached", text: `${formatNumber(snapshot.missTokens)} uncached`, wideOnly: true }]
			: []),
		{ key: "read", text: `${formatNumber(snapshot.cacheReadTokens)} reused`, wideOnly: true },
		{ key: "write", text: `${formatNumber(snapshot.cacheWriteTokens)} stored`, wideOnly: true },
	];
	const invalidations: readonly PhraseSpan[] =
		snapshot.invalidationCount > 0
			? [{ key: "invalidations", text: `${snapshot.invalidationCount} invalidations`, tone: "notable" }]
			: [];
	const core = spans.filter(span => !span.wideOnly);
	const variants = dedupe(
		[
			core,
			core.filter(span => span.key !== "hits"),
			core.slice(0, 1),
			[{ key: "pct", text: `recent reuse ${reusePercent}%` }],
			[{ key: "pct", text: `reuse ${reusePercent}%` }],
			...(invalidations.length > 0 ? [[]] : []),
		].map(body => [...invalidations, ...body].map(span => span.text).join(" · ")),
	);
	return {
		id: "cacheMeter",
		priority,
		active: true,
		variants,
		line: {
			dot: "live",
			label: "cache",
			accent: colors.badge,
			spans: [...invalidations, ...spans],
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

	const spans: PhraseSpan[] = [];
	if (metrics.reads > 0) spans.push({ key: "reads", text: `${metrics.reads} read${metrics.reads === 1 ? "" : "s"}` });
	if (metrics.writes > 0)
		spans.push({ key: "writes", text: `${metrics.writes} write${metrics.writes === 1 ? "" : "s"}` });
	if (poisoned > 0) spans.push({ key: "poisoned", text: `${poisoned} changed on disk`, tone: "alert" });
	if (dirty > 0) spans.push({ key: "dirty", text: `${dirty} edited`, tone: "notable" });
	if (lastTouched !== undefined)
		spans.push({ key: "last", text: `last ${path.basename(lastTouched.path)}`, wideOnly: true });

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

/** Worst-first: pushback and outages outrank auth, which outranks the unclassified rest. */
const TROUBLE_ORDER: readonly Exclude<StatusClass, "ok">[] = ["throttle", "server", "auth", "other"];

/** Rate-Limit Tidepool segment metadata for legend. */
export const RATE_LIMIT_TIDEPOOL_SEGMENT = {
	id: "rateLimitTidepool" as const,
	label: "limits",
	description: "Provider response health and rate-limit headroom",
} satisfies { id: BoxSegmentId; label: string; description: string };

/**
 * `limits` row. Idle until the first `after_provider_response` of the session;
 * then it leads with response health read straight off the HTTP status —
 * `http 200 · 12 ok` while healthy, per-class non-2xx counts worst-first plus
 * the newest failure's status and age once anything went wrong. The dot
 * escalates with the newest failure and holds (D6): one 200 after five 429s
 * must not read as healthy. The header-derived pool level, reset ETA, and
 * provider stay as the wide-width tail whenever a whitelisted family
 * (`{anthropic, openai}`, gated upstream in `controller.ts`) has reported.
 */
export function buildRateLimitTidepoolSegment(
	state: RateLimitTidepoolState,
	now: number,
	_theme: BoxTheme,
	colors: TidepoolColors = TIDEPOOL_COLORS,
	_preset: SymbolPreset = "unicode",
	health?: ProviderHealthSnapshot,
): SegmentSample {
	const priority = priorityOf("rateLimitTidepool");
	if (health === undefined) {
		return {
			id: "rateLimitTidepool",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "limits", accent: colors.water, spans: IDLE_SPANS },
		};
	}

	const spans: PhraseSpan[] = [];
	let dot: StatusDot = "live";
	let narrow: string;
	const trouble = TROUBLE_ORDER.filter(cls => (health.troubleCounts[cls] ?? 0) > 0);
	const last = health.lastTrouble;
	if (trouble.length === 0 || last === undefined) {
		narrow = `http ${health.lastStatus}`;
		spans.push({ key: "status", text: narrow }, { key: "ok", text: `${health.okCount} ok` });
	} else {
		const severity = classifyStatus(last.status) === "other" ? ("notable" as const) : ("alert" as const);
		dot = severity;
		const age = ageText(now - last.observedAtMs);
		const lead = `${trouble[0]} ×${health.troubleCounts[trouble[0]]}`;
		spans.push({ key: trouble[0], text: lead, tone: severity });
		for (const cls of trouble.slice(1)) spans.push({ key: cls, text: `${cls} ×${health.troubleCounts[cls]}` });
		spans.push({ key: "last", text: `last ${last.status} ${age} ago` });
		if (health.okCount > 0) spans.push({ key: "ok", text: `${health.okCount} ok` });
		narrow = `${lead} · ${age}`;
	}

	const pool = state.snapshot();
	if (pool !== undefined) {
		const level = refillLevel(pool.level, now, pool.observedAtMs, pool.resetAtMs);
		const clampedLevel = level <= 0 ? 0 : level >= 1 ? 1 : level;
		const resetEta = resetEtaLabel(pool.resetAtMs, now);
		// ≤10% remaining is an act-now alert, ≤20% notable; healthy levels carry
		// the up-good gradient (the ratio is the *remaining* fraction).
		const poolDot: StatusDot = clampedLevel <= 0.1 ? "alert" : clampedLevel <= 0.2 ? "notable" : "live";
		spans.push({
			key: "pct",
			text: `${Math.round(clampedLevel * 100)}% left`,
			wideOnly: true,
			...(poolDot === "live"
				? { gradient: { ratio: clampedLevel, direction: "up-good" as const } }
				: { tone: poolDot }),
		});
		if (resetEta !== "") spans.push({ key: "reset", text: resetEta, wideOnly: true });
		spans.push({ key: "provider", text: pool.provider, wideOnly: true });
		if (poolDot === "alert" || (poolDot === "notable" && dot === "live")) dot = poolDot;
	}

	const variants = dedupe([
		spans.map(span => span.text).join(" · "),
		spans
			.filter(span => span.wideOnly !== true)
			.map(span => span.text)
			.join(" · "),
		narrow,
	]);

	return {
		id: "rateLimitTidepool",
		priority,
		active: true,
		variants,
		line: { dot, label: "limits", accent: colors.water, spans },
	};
}

/** Live Files metadata for the legend. Its builder lives in `../live-files`. */
export const LIVE_FILES_SEGMENT = {
	id: "filesLive" as const,
	label: "files",
	description: "Paths with an active edit or write owner",
} satisfies { id: BoxSegmentId; label: string; description: string };

/** Audit Box summary metadata in immutable row order. */
export const SEGMENT_REGISTRY = [
	CONTEXT_GAUGE_SEGMENT,
	CACHE_METER_SEGMENT,
	AUDIT_TRAIL_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	LIVE_FILES_SEGMENT,
] as const;
