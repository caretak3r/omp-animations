/**
 * Animations Box — segment sources.
 *
 * One pure builder per box-owned animation, each producing a {@link
 * SegmentSample}: the simple-mode `variants` ladder (fed straight into the
 * kit's `composeSegments`) plus the detailed-mode status-line spans (Plan
 * 018), both derived
 * from that animation's own exported pure renderers/state — never reinvented
 * text. Cache Meter (`oh-my-pi-dxi.2`), Audit Trail, Tool Constellation,
 * Palimpsest, Cadence Equalizer, Rate-Limit Tidepool and Reflection Ripple
 * (`oh-my-pi-dxi.3`/`oh-my-pi-dxi.4`) are wired here; the breathing border
 * lands in `oh-my-pi-dxi.5`.
 *
 * `active` mirrors the animation's own real mount policy (quiet until the
 * first usable event, mirroring `CacheMeterController`'s lazy mount), but
 * unlike the standalone widget's absence, an inactive segment here still
 * produces a `line` — a dim resting status line (`○ label   —`) — so
 * detailed-mode height is a pure function of the ENABLED set, never of
 * runtime activity (Plan 017 Decision 5). Spans are PLAIN text: the widget
 * colors dots, tones, gradients, and change-flash at render time (Plan 018's
 * one deliberate inversion of 017's "segments pre-color" contract).
 *
 * `now` is always a wall-clock reading from the box's own `FrameScheduler`,
 * never the host `AnimatedWidget`'s mount-relative `elapsedMs` (Decision 4).
 */
import { basename } from "node:path";
import type { SymbolPreset, Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	AUDIT_TRAIL_BOX_COLORS,
	type AuditLedgerState,
	type AuditTrailBoxColors,
	type PathRecord,
	renderAuditMeterRow,
} from "../audit-trail-box";
import { CACHE_METER_COLORS, type CacheMeterColors, type CacheMeterState, renderCacheMeterRow } from "../cache-meter";
import {
	type CadenceEqualizerColors,
	type CadenceEqualizerState,
	cadenceEqualizerColors,
	renderCompactEqualizer,
	renderEqualizerRow,
	renderEqualizerText,
} from "../cadence-equalizer";
// `MAX_REFERENCE_RATE` lives in `scale.ts`, which the keeper's own `index.ts`
// barrel does not re-export (only `bars`/`controller`/`state`/`widget` do) —
// a deep import, not a reinvented constant, since editing that barrel is a
// keeper-directory change out of this bead's scope (see `dxi.4`'s report).
import { MAX_REFERENCE_RATE } from "../cadence-equalizer/scale";
import {
	GLOW_THRESHOLD,
	PALIMPSEST_COLORS,
	type PalimpsestColors,
	type PalimpsestRow,
	type PalimpsestState,
} from "../palimpsest";
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
import {
	CATEGORY_ORDER,
	CATEGORY_THEME_COLOR,
	type ConstellationState,
	renderConstellationTally,
	type ToolCategory,
} from "../tool-constellation";
import { BOX_SEGMENT_IDS, type BoxSegmentId } from "./settings";
import type { PhraseSpan, SegmentLine, StatusDot } from "./status-line";

/** The slice of {@link Theme} every segment builder needs — foreground coloring, plus color hex for gradients and bold for flash emphasis where available. */
export type BoxTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "getColorHex" | "bold">>;

/** What one segment contributes this frame, in both box detail levels. */
export interface SegmentSample {
	readonly id: BoxSegmentId;
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

/** `<$0.01`/`$1.24`-style USD formatting — a local copy of `cache-meter/widget.ts`'s module-private `formatCost` (not exported from that module's barrel). */
function formatCost(amountUsd: number): string {
	const safe = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
	if (safe === 0) return "$0.00";
	return safe < 0.01 ? "<$0.01" : `$${safe.toFixed(2)}`;
}

/**
 * Cache Meter segment. A dim resting row until `message_end` has delivered at
 * least one usable prompt-cache sample — mirrors `CacheMeterController`'s own
 * lazy mount ("nothing to show before the first metered request lands").
 * Unlike the standalone `CacheMeterWidget`, this segment never eases the
 * displayed percentage or blinks the invalidation badge — both live inside
 * that widget's own per-frame state, which this box does not reuse (see
 * `controller.ts`'s module doc) — so it always draws the snapshot's true
 * current `warmth`, unalerted.
 */
/** Cache Meter segment metadata for legend. */
export const CACHE_METER_SEGMENT = {
	id: "cacheMeter" as const,
	label: "cache",
	description: "Prompt cache hit rate and cost savings",
} satisfies { id: BoxSegmentId; label: string; description: string };

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
				snapshot.savedCost !== undefined
					? { key: "saved", text: `saved ${formatCost(snapshot.savedCost)}` }
					: { key: "hits", text: `${snapshot.hitCount}/${snapshot.requestCount}` },
				...(snapshot.missTokens > 0
					? [{ key: "uncached", text: `${formatNumber(snapshot.missTokens)} uncached`, wideOnly: true }]
					: []),
			],
		},
	};
}

/** Same idle convention as the keeper's own `renderEqualizerText` ("--" when nothing is streaming), without that renderer's `eq ` row prefix — this is a span value, not a standalone row, so it carries no alignment padding. */
function cadenceRateLabel(tokensPerSecond: number | null): string {
	if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "--";
	return `${Math.round(tokensPerSecond)} t/s`;
}

/**
 * Cadence Equalizer segment. Unlike every other builder in this file, its
 * `state` alone can't answer "has anything ever happened" — the EMA bands
 * decay back toward (but never quite reach) zero between turns, so the box
 * controller tracks `hasStreamed` itself (latched `true` on the first
 * assistant `message_start`, mirroring `CadenceEqualizerController`'s own
 * mount trigger) and the live sampled rate (from the same
 * `calculateTokensPerSecond` provider that controller's `sampleRate` calls),
 * neither of which lives on `CadenceEqualizerState`.
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
	if (!hasStreamed) {
		return {
			id: "cadenceEqualizer",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "cadence", accent: colors.burst, spans: IDLE_SPANS },
		};
	}

	const bands = state.snapshotBands();
	const peaks = state.snapshotPeaks();
	const variants = dedupe([
		renderEqualizerRow(bands, peaks, theme, colors, preset),
		renderCompactEqualizer(bands, theme, colors),
		renderEqualizerText(tokensPerSecond),
	]);

	// The peak-hold ceiling across every band, denormalized back to a tok/s-ish
	// reading — same amplitude-to-rate projection `MAX_REFERENCE_RATE` anchors
	// throughout `scale.ts` (see `normalizeAmplitude`'s inverse).
	let peakAmplitude = 0;
	for (const peak of peaks) if (peak > peakAmplitude) peakAmplitude = peak;

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
 * (`state.size > 0`) — mirrors `AuditTrailBoxController`'s own real mount
 * policy, which pushes its first widget content from the very first
 * `noteRead`/`noteWrite`. Like Cache Meter, this segment never reproduces
 * the standalone widget's per-frame cosmetics: the alarm badge's pulse blink
 * lives inside `AuditTrailBoxWidget` itself (see `controller.ts`'s module
 * doc), so this line never blinks.
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
	if (lastTouched !== undefined) spans.push({ key: "last", text: basename(lastTouched.path), wideOnly: true });

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
 * provider-whitelisted response lands (`state.snapshot() !== undefined`) —
 * mirrors `RateLimitTidepoolController`'s own lazy mount. The `{anthropic,
 * openai}` family whitelist is enforced upstream, in `controller.ts`'s
 * `onMessageStart` (mirroring `RateLimitTidepoolController.onMessageStart`
 * exactly) — this builder only ever sees a snapshot that already passed that
 * gate, so it never re-checks it. Like Cache Meter and Audit Trail, this
 * segment never reproduces the standalone widget's per-frame cosmetic (the
 * filled-edge-cell shimmer lives inside `TidepoolWidget` itself, gated on the
 * `full` motion tier this box never requests), so every variant renders at
 * the fixed `subtle` motion tier. The near-empty `sand` alarm color is fixed
 * regardless of `colors` — `TidepoolColors`/`tidepoolColors` only ever
 * override the `water` slot, so an accent override recolors the water alone,
 * exactly as the standalone widget's own accent contract promises.
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

/** Highest-fire-count category, ties broken by {@link CATEGORY_ORDER}'s own canonical order. `undefined` when nothing has fired. */
function dominantCategory(counts: ReadonlyMap<ToolCategory, number>): ToolCategory | undefined {
	let best: ToolCategory | undefined;
	let bestCount = 0;
	for (const category of CATEGORY_ORDER) {
		const count = counts.get(category) ?? 0;
		if (count > bestCount) {
			best = category;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Tool Constellation segment. A dim resting row until the first `tool_call`
 * fires a star (`state.snapshot().stars.length > 0`) — mirrors
 * `ToolConstellationController`'s own mount policy. Its grid renderer is 3
 * rows tall and does not fit a one-row segment (Decision 1's first stated
 * exception), so both the widest and truncated simple-mode variants reuse
 * the exported `renderConstellationTally` instead — the widest variant over
 * every category that has fired, the truncated one over the dominant
 * category alone. Keeps the 7-way `CATEGORY_THEME_COLOR` rainbow: unlike
 * every other segment, there is no single accent slot to override here, so
 * this builder takes no `colors` parameter.
 */
/** Tool Constellation segment metadata for legend. */
export const TOOL_CONSTELLATION_SEGMENT = {
	id: "toolConstellation" as const,
	label: "tools",
	description: "Tool call frequency by category",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildToolConstellationSegment(
	state: ConstellationState,
	_now: number,
	theme: BoxTheme,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("toolConstellation");
	const snapshot = state.snapshot();
	if (snapshot.stars.length === 0) {
		return {
			id: "toolConstellation",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "tools", accent: "dim", spans: IDLE_SPANS },
		};
	}

	const counts = state.categoryCounts();
	const dominant = dominantCategory(counts);
	const full = renderConstellationTally(counts, theme, preset);
	const narrow =
		dominant === undefined
			? full
			: renderConstellationTally(new Map([[dominant, counts.get(dominant) ?? 0]]), theme, preset);
	const variants = dedupe([full, narrow]);

	// D3+D6: category icons are gone from the box; the phrase is the total plus
	// a top-2 words tally — the dominant category appears there once and is
	// repeated nowhere else. Stable sort keeps CATEGORY_ORDER as the tie-break,
	// matching dominantCategory's own first-canonical-wins rule.
	const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
	const top = CATEGORY_ORDER.filter(category => (counts.get(category) ?? 0) > 0)
		.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
		.slice(0, 2)
		.map(category => `${category} (${counts.get(category)})`)
		.join(" · ");

	const spans: PhraseSpan[] = [{ key: "total", text: `${total} calls` }];
	if (top.length > 0) spans.push({ key: "top", text: top, sep: " — " });

	return {
		id: "toolConstellation",
		priority,
		active: true,
		variants,
		line: {
			dot: "live",
			label: "tools",
			accent: dominant === undefined ? "dim" : CATEGORY_THEME_COLOR[dominant],
			spans,
		},
	};
}

/**
 * Same recency/overlap/path ordering `renderPalimpsestRows` sorts its visible
 * rows by — reproduced here since that comparator lives inline in that
 * function, not exported (same precedent as `formatCost` above).
 */
function compareVisibleRows(a: PalimpsestRow, b: PalimpsestRow): number {
	return b.lastTouchedTurn - a.lastTouchedTurn || b.overlapCount - a.overlapCount || a.path.localeCompare(b.path);
}

/**
 * Palimpsest segment. `renderPalimpsestRows` is multi-row and width-blind
 * (Decision 1's second stated exception), so this segment derives its own
 * one-line summary straight from `snapshot().rows` instead of calling it:
 * the single hottest visible row (overlap count at or above
 * `GLOW_THRESHOLD`, same threshold `PalimpsestController` mounts on),
 * narrowing from the full path to the basename to the bare count. Resting
 * until at least one row clears that threshold, mirroring
 * `PalimpsestController`'s own visibility-driven mount policy. Never
 * reproduces the ember tier's per-frame hot-pulse bolding — an
 * `AnimatedWidget`-only cosmetic, the same accepted gap as Cache Meter's
 * hit-rate ease (see `controller.ts`'s module doc).
 */
/** Palimpsest segment metadata for legend. */
export const PALIMPSEST_SEGMENT = {
	id: "palimpsest" as const,
	label: "files",
	description: "Most-edited files and overlap patterns",
} satisfies { id: BoxSegmentId; label: string; description: string };

export function buildPalimpsestSegment(
	state: PalimpsestState,
	_now: number,
	_theme: BoxTheme,
	colors: PalimpsestColors = PALIMPSEST_COLORS,
	_preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("palimpsest");
	const visible = state
		.snapshot()
		.rows.filter(row => row.overlapCount >= GLOW_THRESHOLD)
		.sort(compareVisibleRows);
	if (visible.length === 0) {
		return {
			id: "palimpsest",
			priority,
			...INACTIVE,
			line: { dot: "idle", label: "files", accent: colors.ember, spans: IDLE_SPANS },
		};
	}

	const hottest = visible[0] as PalimpsestRow;
	const variants = dedupe([
		`${hottest.path} ×${hottest.overlapCount}`,
		`${basename(hottest.path)} ×${hottest.overlapCount}`,
		`×${hottest.overlapCount}`,
	]);

	return {
		id: "palimpsest",
		priority,
		active: true,
		variants,
		line: {
			dot: "live",
			label: "files",
			accent: colors.ember,
			spans: [
				{ key: "hot", text: `${basename(hottest.path)} ×${hottest.overlapCount}` },
				{ key: "count", text: `${visible.length} hot file${visible.length === 1 ? "" : "s"}` },
			],
		},
	};
}

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

/** All segment metadata in priority order for legend rendering. */
export const SEGMENT_REGISTRY = [
	CACHE_METER_SEGMENT,
	CADENCE_EQUALIZER_SEGMENT,
	AUDIT_TRAIL_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	TOOL_CONSTELLATION_SEGMENT,
	PALIMPSEST_SEGMENT,
	REFLECTION_RIPPLE_SEGMENT,
] as const;
