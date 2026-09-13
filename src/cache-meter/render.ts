/**
 * Cache Meter — the pure renderers behind the Audit Box's cache row and the
 * `/cache` panel.
 *
 * One row renderer serves both surfaces: the box's `cache` row (a real,
 * shrinking terminal width) and the panel's own per-group lines reuse the
 * same cells and the same money format. It degrades in tiers, widest first:
 * `full` (money + sparkline + spelled-out READ/WRITE/MISS) -> `wide` (the
 * same money + sparkline, but abbreviated counts — the tier most real
 * terminal panes actually land on) -> `counts` (abbreviated counts, no
 * money) -> a single headline percentage -> the bare badge — copied from
 * Audit Trail Box's `renderAuditMeterRow` width-tiering approach. Only
 * `full`/`wide` carry the money/warmth work below; `counts`, `headline`, and
 * `bare` are exactly what they were before it — `wide` in fact reuses their
 * exact abbreviated cells rather than rebuilding them, so there's only one
 * place that text can drift.
 *
 * The percentage drawn and the badge that alerts both track something that
 * just changed, not a lifetime total — see `state.ts`'s `warmth` doc for why
 * a lagging cumulative `hitRate` was replaced there. Concretely:
 * - `displayWarmth` is a caller-supplied `[0, 1]` value defaulting to the
 *   snapshot's live `warmth` (not `hitRate`), so a session with a handful of
 *   huge requests reads as the current window rather than a stuck average.
 * - `full`/`wide`'s leading cell is the running dollar savings figure
 *   (`SAVED $1.24`) when one is derivable — the number a human actually acts
 *   on — with the hit fraction demoted to just after the sparkline. When no
 *   group has ever shown a derivable rate, the row falls back to a hit-led
 *   shape; a row must never claim `$0.00` for something it doesn't know.
 * - A per-request warmth sparkline is the *only* warmth visualization — there
 *   used to also be a fixed-width hit-rate bar, but the sparkline's rightmost
 *   glyph already is current warmth, so the bar said the same thing twice at
 *   the cost of ten columns it doesn't have to spend. The sparkline alone
 *   carries both "warm right now" and the shape of how it got there.
 * - The badge briefly alerts (color, plus an optional blink the caller opts
 *   into by passing `"full"`) when a cache invalidation is detected — the one
 *   ledger event that isn't just "the numbers went up," and so the one thing
 *   worth a distinct visual cue.
 */

import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import { type AccentColor, accentToThemeColor } from "../appearance";
import { resolveGlyph } from "../glyph-presets";
import type { SymbolPreset, Theme, ThemeColor } from "../host/types";
import type { CacheEventCause, CacheInvalidationRecord, CacheMeterSnapshot } from "./state";

/** The slice of {@link Theme} the renderers need — just foreground coloring. */
export type CacheMeterTheme = Pick<Theme, "fg">;

/**
 * Named color map. `badge` is the primary accent slot — the only token an
 * accent override replaces; `invalidation` stays fixed (a semantic alarm
 * color, same reasoning as Audit Trail Box's risk ramp — recoloring it would
 * make the alert unreadable).
 */
export interface CacheMeterColors {
	badge: ThemeColor;
	hit: ThemeColor;
	read: ThemeColor;
	write: ThemeColor;
	miss: ThemeColor;
	invalidation: ThemeColor;
	label: ThemeColor;
}

/** Built-in palette. */
export const CACHE_METER_COLORS: CacheMeterColors = {
	badge: "accent",
	hit: "success",
	read: "statusLineSpend",
	write: "statusLineOutput",
	miss: "warning",
	invalidation: "error",
	label: "dim",
};

/** The palette with the accent slot applied. `undefined` keeps the built-in badge color. */
export function cacheMeterColors(accentColor?: AccentColor): CacheMeterColors {
	return accentColor === undefined
		? CACHE_METER_COLORS
		: { ...CACHE_METER_COLORS, badge: accentToThemeColor(accentColor) };
}

/** Resting badge glyph, resolved for `preset` via `../glyph-presets.ts`. Defaults to `"unicode"` — the original hardcoded value. */
export function badgeGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("cacheMeter.badge", preset);
}
/** Hollow badge shown on the off-beat of the invalidation blink (`"full"` tier only), resolved for `preset`. */
export function badgePulseGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("cacheMeter.badgePulse", preset);
}
/**
 * Invalidation-count glyph, resolved for `preset`. Matches the host's own default icon
 * for this exact concept (`icon.cacheMiss`, `modes/theme/theme.ts`) — this package only
 * ever consumes `theme.fg`, never `theme.icon`, so the glyph is reproduced directly
 * rather than threaded through a wider theme slice for one symbol.
 */
export function invalidationGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("cacheMeter.invalidation", preset);
}

/** Full period of the invalidation blink, in ms. */
export const INVALIDATION_BLINK_PERIOD_MS = 600;

/** Shown by every surface when no request has carried prompt-cache telemetry yet. */
const IDLE_TEXT = "no prompt-cache telemetry yet";

/** Whether the badge is on its bright beat during an active invalidation alert. Pure phase math. */
function invalidationBlink(elapsedMs: number): boolean {
	const phase =
		((elapsedMs % INVALIDATION_BLINK_PERIOD_MS) + INVALIDATION_BLINK_PERIOD_MS) % INVALIDATION_BLINK_PERIOD_MS;
	return phase < INVALIDATION_BLINK_PERIOD_MS / 2;
}

/** A pre-colored fragment of a row. Kept plain until the last step so widths can be measured without ANSI noise. */
interface Cell {
	readonly text: string;
	readonly color: ThemeColor;
}

/** Width of the cells joined by single spaces, ignoring color. */
function cellsWidth(cells: readonly Cell[]): number {
	let total = 0;
	for (const cell of cells) total += cell.text.length;
	return total + Math.max(0, cells.length - 1);
}

function paint(cells: readonly Cell[], theme: CacheMeterTheme): string {
	return cells.map(cell => theme.fg(cell.color, cell.text)).join(" ");
}

/**
 * `alerted` is true while a just-detected invalidation is still within its
 * flash window (the caller decides that; the `/cache` panel always passes
 * false); the badge's color reflects it steadily, and the `"full"` tier
 * additionally blinks the glyph between filled and hollow, mirroring Audit
 * Trail Box's alarm-pulse badge.
 */
function badgeCell(
	alerted: boolean,
	elapsedMs: number,
	tier: "full" | "subtle",
	colors: CacheMeterColors,
	preset: SymbolPreset,
): Cell {
	const blinking = tier === "full" && alerted && !invalidationBlink(elapsedMs);
	return {
		text: blinking ? badgePulseGlyph(preset) : badgeGlyph(preset),
		color: alerted ? colors.invalidation : colors.badge,
	};
}

function invalidationCells(count: number, colors: CacheMeterColors, preset: SymbolPreset): readonly Cell[] {
	return count > 0 ? [{ text: `${invalidationGlyph(preset)}${count}`, color: colors.invalidation }] : [];
}

/**
 * Per-request warmth ramp, coldest to fully cached. The lowest step is `▁`,
 * never blank: a blank lowest step hides the signal exactly when it's
 * smallest. Diff Bloom's ramp (`../diff-bloom/bloom.ts`) had that bug and
 * now shares the convention.
 */
const WARMTH_RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Map a `[0, 1]` warmth ratio to a glyph on {@link WARMTH_RAMP}. Monotonic. Pure. */
function warmthGlyph(ratio: number): string {
	const clamped = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
	const index = Math.min(WARMTH_RAMP.length - 1, Math.floor(clamped * WARMTH_RAMP.length));
	return WARMTH_RAMP[index] ?? WARMTH_RAMP[0];
}

/**
 * One glyph per entry in the rolling warmth window, oldest first — as short
 * as the window currently is (it fills from empty at session start), never
 * padded out to a fixed width.
 */
function warmthSparkline(window: readonly number[]): string {
	return window.map(warmthGlyph).join("");
}

/**
 * Format a USD amount for display: two decimals (`$1.24`), or `<$0.01` for a
 * nonzero amount that would otherwise round away to nothing. Clamped to a
 * sane non-negative number first, same as the ledger's own `normalize()` —
 * every figure this renders is already a sum of normalized buckets, so this
 * is a defensive floor, not a place that hides real data.
 *
 * Exported because the Animations Box's cache row renders the same savings
 * figure in its own idiom: one money format for both surfaces, so `$1.24`
 * here can never become `$1.2` there.
 */
export function formatCost(amountUsd: number): string {
	const safe = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
	if (safe === 0) return "$0.00";
	return safe < 0.01 ? "<$0.01" : `$${safe.toFixed(2)}`;
}

/** Tally invalidations by cause and render as `cause ×count, cause ×count`; `""` when there are none. */
function summarizeInvalidationCauses(invalidations: readonly CacheInvalidationRecord[]): string {
	if (invalidations.length === 0) return "";
	const counts = new Map<CacheEventCause, number>();
	for (const { cause } of invalidations) counts.set(cause, (counts.get(cause) ?? 0) + 1);
	return [...counts].map(([cause, count]) => `${cause} ×${count}`).join(", ");
}

/**
 * Render one compact, width-aware cache-ledger row. `displayWarmth` is the
 * value actually drawn for the percentage that tracks the live window;
 * callers that have no smoothed value of their own leave it at the default —
 * the snapshot's true current `warmth`. `elapsedMs`/`tier` only drive the
 * invalidation badge's blink phase.
 *
 * `full` and `wide` carry the money/warmth work; `counts`, `headline`, and
 * `bare` are untouched — `counts` in fact reuses the exact same abbreviated
 * cell objects `wide` builds, so there's only one place that text can drift
 * — and the value that flows into every tier's own `pct` text is
 * `displayWarmth`.
 */
export function renderCacheMeterRow(
	snapshot: CacheMeterSnapshot,
	width: number,
	elapsedMs: number,
	theme: CacheMeterTheme,
	tier: "full" | "subtle",
	displayWarmth: number = snapshot.warmth,
	alerted = false,
	colors: CacheMeterColors = CACHE_METER_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";

	const badge = badgeCell(alerted, elapsedMs, tier, colors, preset);
	if (snapshot.promptTokens === 0) {
		const idle: readonly Cell[] = [badge, { text: IDLE_TEXT, color: colors.label }];
		return cellsWidth(idle) <= width ? paint(idle, theme) : paint([badge], theme);
	}

	const pct = `${(Math.max(0, Math.min(1, displayWarmth)) * 100).toFixed(1)}%`;
	const read = formatNumber(snapshot.cacheReadTokens);
	const write = formatNumber(snapshot.cacheWriteTokens);
	const miss = formatNumber(snapshot.missTokens);
	const invalidations = invalidationCells(snapshot.invalidationCount, colors, preset);
	const sparkline: Cell = { text: warmthSparkline(snapshot.warmthWindow), color: colors.hit };
	// The savings figure leads when it's known — it's the number a human acts
	// on. When it isn't (no group has ever derived a full-price rate), both
	// money-aware tiers fall back to a hit-led shape; a `$0.00` here would
	// claim knowledge the ledger doesn't have.
	const savedCell: Cell | undefined =
		snapshot.savedCost !== undefined
			? { text: `SAVED ${formatCost(snapshot.savedCost)}`, color: colors.hit }
			: undefined;

	const readCell: Cell = { text: `READ ${read}`, color: colors.read };
	const writeCell: Cell = { text: `WRITE ${write}`, color: colors.write };
	const missCell: Cell = { text: `MISS ${miss}`, color: colors.miss };
	const hitCell: Cell = { text: `HIT ${pct} (${snapshot.hitCount}/${snapshot.requestCount})`, color: colors.hit };
	const full: readonly Cell[] =
		savedCell !== undefined
			? [badge, savedCell, sparkline, hitCell, readCell, writeCell, missCell, ...invalidations]
			: [badge, hitCell, sparkline, readCell, writeCell, missCell, ...invalidations];

	// Abbreviated forms, shared between `wide` (money-aware but width-constrained
	// — the tier a real terminal pane most often lands on) and `counts` (no money at all).
	const rCell: Cell = { text: `R ${read}`, color: colors.read };
	const wCell: Cell = { text: `W ${write}`, color: colors.write };
	const mCell: Cell = { text: `M ${miss}`, color: colors.miss };
	const hCell: Cell = { text: `H ${pct} (${snapshot.hitCount}/${snapshot.requestCount})`, color: colors.hit };
	const wide: readonly Cell[] =
		savedCell !== undefined
			? [badge, savedCell, sparkline, hCell, rCell, wCell, mCell, ...invalidations]
			: [badge, hCell, sparkline, rCell, wCell, mCell, ...invalidations];
	const counts: readonly Cell[] = [badge, hCell, rCell, wCell, mCell, ...invalidations];
	const headline: readonly Cell[] = [badge, { text: pct, color: colors.hit }];
	const bare: readonly Cell[] = [badge];

	for (const cells of [full, wide, counts, headline, bare]) {
		if (cellsWidth(cells) <= width) return paint(cells, theme);
	}
	return paint([badge], theme);
}

export interface CacheMeterPanelOptions {
	readonly colors?: CacheMeterColors;
	/** Reference instant for the invalidation timeline's relative ages; defaults to `Date.now()`. The box passes its scheduler clock so tests stay deterministic. */
	readonly now?: number;
	/** The host's live symbol preset (see `../glyph-presets.ts`). Defaults to `"unicode"`. */
	readonly preset?: SymbolPreset;
}

/** Most invalidations the panel's timeline section renders, most recent first-ish (oldest of the shown set first) — older ones are noted, not silently dropped. */
const TIMELINE_LIMIT = 10;

/**
 * Chronological `⊘ cause · age ago` lines for the panel's timeline section,
 * oldest first, capped at the last {@link TIMELINE_LIMIT}. `[]` when there's
 * nothing to show; a trailing note line when older entries were cut, so
 * truncation is visible rather than a silent gap.
 *
 * `totalCount` is the ledger's true, uncapped `invalidationCount` — not
 * `invalidations.length`, which is itself already capped at
 * `MAX_RETAINED_INVALIDATIONS` (20, `state.ts`). Using the retained array's
 * own length here would silently undercount the "not shown" note in any
 * session with more than 20 invalidations, since some would already be gone
 * before this function ever sees them.
 */
function invalidationTimelineLines(
	invalidations: readonly CacheInvalidationRecord[],
	totalCount: number,
	now: number,
	theme: CacheMeterTheme,
	colors: CacheMeterColors,
	preset: SymbolPreset,
): readonly string[] {
	if (invalidations.length === 0) return [];
	const shown = invalidations.length > TIMELINE_LIMIT ? invalidations.slice(-TIMELINE_LIMIT) : invalidations;
	const lines = shown.map(({ cause, atMs }) => {
		const age = formatAge(Math.max(0, Math.round((now - atMs) / 1_000)));
		const label = age === "" ? cause : `${cause} · ${age}`;
		return `  ${theme.fg(colors.invalidation, invalidationGlyph(preset))} ${theme.fg(colors.label, label)}`;
	});
	const omitted = totalCount - shown.length;
	if (omitted > 0) {
		lines.push(theme.fg(colors.label, `  … ${omitted} earlier invalidation${omitted === 1 ? "" : "s"} not shown`));
	}
	return lines;
}

/**
 * The `/cache` panel: a heading, one row per provider+model seen this session
 * (in first-seen order), a chronological timeline of recent invalidations,
 * and a session-wide totals line — reads, writes, misses, hit rate, the
 * dollar split (spent vs. saved), the Anthropic cache-write TTL split when
 * either half is nonzero, and the invalidation count — all in one place
 * rather than scattered across per-model rows only.
 */
export function renderCacheMeterPanel(
	snapshot: CacheMeterSnapshot,
	theme: CacheMeterTheme,
	options: CacheMeterPanelOptions = {},
): readonly string[] {
	const colors = options.colors ?? CACHE_METER_COLORS;
	const preset = options.preset ?? "unicode";
	const heading = `${theme.fg(colors.badge, badgeGlyph(preset))} ${theme.fg(
		colors.label,
		`cache meter · ${snapshot.requestCount} request${snapshot.requestCount === 1 ? "" : "s"}`,
	)}`;
	if (snapshot.requestCount === 0) {
		return [heading, theme.fg(colors.label, `  ${IDLE_TEXT}`)];
	}

	const lines: string[] = [heading];
	for (const group of snapshot.groups) {
		const pct = `${(group.hitRate * 100).toFixed(1)}%`;
		const invalid =
			group.invalidationCount > 0
				? ` ${theme.fg(colors.invalidation, `${invalidationGlyph(preset)}${group.invalidationCount}`)}`
				: "";
		lines.push(
			[
				`  ${theme.fg(colors.label, `${group.provider}/${group.model}`)}`,
				theme.fg(colors.hit, `HIT ${pct} (${group.hitCount}/${group.requestCount})`),
				theme.fg(colors.read, `READ ${formatNumber(group.cacheReadTokens)}`),
				theme.fg(colors.write, `WRITE ${formatNumber(group.cacheWriteTokens)}`),
				theme.fg(colors.miss, `MISS ${formatNumber(group.missTokens)}`),
			].join(" ") + invalid,
		);
	}

	lines.push(
		...invalidationTimelineLines(
			snapshot.invalidations,
			snapshot.invalidationCount,
			options.now ?? Date.now(),
			theme,
			colors,
			preset,
		),
	);

	const totalPct = `${(snapshot.hitRate * 100).toFixed(1)}%`;
	// Money and TTL only join the totals line when there's a real figure —
	// same "don't clutter, don't fabricate" rule the row itself follows for
	// `SAVED`. Causes ride along after the count so `invalidations N` stays
	// intact for anyone already matching on that substring.
	const spentSuffix = snapshot.costTotal > 0 ? ` · SPENT ${formatCost(snapshot.costTotal)}` : "";
	const savedSuffix = snapshot.savedCost !== undefined ? ` · SAVED ${formatCost(snapshot.savedCost)}` : "";
	const cttlSuffix =
		snapshot.cttlEphemeral5m > 0 || snapshot.cttlEphemeral1h > 0
			? ` · CTTL 5m ${formatNumber(snapshot.cttlEphemeral5m)} / 1h ${formatNumber(snapshot.cttlEphemeral1h)}`
			: "";
	const causes = summarizeInvalidationCauses(snapshot.invalidations);
	const causesSuffix = causes === "" ? "" : ` (${causes})`;
	lines.push(
		theme.fg(
			colors.label,
			`  total HIT ${totalPct} (${snapshot.hitCount}/${snapshot.requestCount}) · READ ${formatNumber(snapshot.cacheReadTokens)} · WRITE ${formatNumber(snapshot.cacheWriteTokens)} · MISS ${formatNumber(snapshot.missTokens)}${spentSuffix}${savedSuffix}${cttlSuffix} · invalidations ${snapshot.invalidationCount}${causesSuffix}`,
		),
	);
	return lines;
}
