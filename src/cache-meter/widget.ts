/**
 * Cache Meter — the pure renderers plus the animated widget.
 *
 * One row renderer serves every surface: the ambient widget (a real,
 * shrinking terminal width), the `off`-tier static line, and the `/cache`
 * panel behind the slash command. It degrades in tiers, widest first: `full`
 * (money + sparkline + spelled-out READ/WRITE/MISS) -> `wide` (the same
 * money + sparkline, but abbreviated counts — the tier most real terminal
 * panes actually land on) -> `counts` (abbreviated counts, no money) -> a
 * single headline percentage -> the bare badge — copied from Audit Trail
 * Box's `renderAuditMeterRow` width-tiering approach
 * (`../audit-trail-box/widget`). Only `full`/`wide` carry the money/warmth
 * work below; `counts`, `headline`, and `bare` are exactly what they were
 * before it — `wide` in fact reuses their exact abbreviated cells rather
 * than rebuilding them, so there's only one place that text can drift.
 *
 * The percentage that eases and the badge that alerts both track something
 * that just changed, not a lifetime total — see `state.ts`'s `warmth` doc for
 * why a lagging cumulative `hitRate` was replaced there. Concretely:
 * - The hit-fraction percentage eases toward `warmth` (not `hitRate`) after
 *   each recorded request ({@link easedHitRate}, unchanged mechanism — only
 *   its input changed) instead of snapping, so a session with a handful of
 *   huge requests reads as a settling motion rather than a jump-cut.
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
 * - The badge briefly alerts (color + an optional blink in the `full` motion
 *   tier) when a cache invalidation is detected — the one ledger event that
 *   isn't just "the numbers went up," and so the one thing worth a distinct
 *   visual cue.
 */
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import { resolveGlyph } from "../glyph-presets";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
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
export function cacheMeterColors(accentColor?: ThemeColor): CacheMeterColors {
	return accentColor === undefined ? CACHE_METER_COLORS : { ...CACHE_METER_COLORS, badge: accentColor };
}

/** Resting badge glyph, resolved for `preset` via `../glyph-presets.ts`. Defaults to `"unicode"` — the original hardcoded value. */
export function badgeGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("cacheMeter.badge", preset);
}
/** Hollow badge shown on the off-beat of the invalidation blink (`full` motion tier only), resolved for `preset`. */
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
 * flash window (the caller — the widget, or the static/panel surfaces, which
 * always pass false — decides that); the badge's color reflects it steadily,
 * and the `full` motion tier additionally blinks the glyph between filled and
 * hollow, mirroring Audit Trail Box's alarm-pulse badge.
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
 */
function formatCost(amountUsd: number): string {
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
 * value actually drawn for the percentage that tracks the live window — the
 * widget passes its eased value ({@link easedHitRate} fed `warmth` instead of
 * `hitRate`, see the widget class); every other caller defaults to the
 * snapshot's true current `warmth`. `elapsedMs`/`tier` only drive the
 * invalidation badge's blink phase.
 *
 * `full` and `wide` carry the money/warmth work; `counts`, `headline`, and
 * `bare` are untouched — `counts` in fact reuses the exact same abbreviated
 * cell objects `wide` builds, so there's only one place that text can drift
 * — and the value that flows into every tier's own `pct` text is still
 * `displayWarmth`, exactly as it was `displayHitRate` before (the rename is
 * the only change there).
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

/**
 * Static one-line fallback for the motion-`off` tier: plain text, no color,
 * no phase. Cost and savings only ever appear when there's a real dollar
 * figure to show — a session with no cost telemetry (or a $0 one) stays as
 * quiet as it always has.
 */
export function renderCacheMeterOffText(snapshot: CacheMeterSnapshot, preset: SymbolPreset = "unicode"): string {
	const badge = badgeGlyph(preset);
	if (snapshot.promptTokens === 0) return `${badge} ${IDLE_TEXT}`;
	const pct = `${(snapshot.hitRate * 100).toFixed(1)}%`;
	const parts = [
		`${badge} HIT ${pct} (${snapshot.hitCount}/${snapshot.requestCount})`,
		`R ${formatNumber(snapshot.cacheReadTokens)}`,
		`W ${formatNumber(snapshot.cacheWriteTokens)}`,
		`M ${formatNumber(snapshot.missTokens)}`,
	];
	if (snapshot.costTotal > 0) parts.push(formatCost(snapshot.costTotal));
	if (snapshot.savedCost !== undefined) parts.push(`saved ${formatCost(snapshot.savedCost)}`);
	if (snapshot.invalidationCount > 0) parts.push(`${invalidationGlyph(preset)}${snapshot.invalidationCount}`);
	return parts.join(" ");
}

export interface CacheMeterPanelOptions {
	readonly colors?: CacheMeterColors;
	/** Reference instant for the invalidation timeline's relative ages; defaults to `Date.now()`. The controller passes its scheduler clock so tests stay deterministic. */
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
	// same "don't clutter, don't fabricate" rule as the off-tier text. Causes
	// ride along after the count so `invalidations N` stays intact for anyone
	// already matching on that substring.
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

/** Ease-out cubic: fast start, slow settle — reads as the percentage "catching up" rather than snapping. */
function easeOutCubic(t: number): number {
	const clamped = Math.min(1, Math.max(0, t));
	return 1 - (1 - clamped) ** 3;
}

/** Duration of the percentage ease after each recorded request — named for its original use (hit rate), now reused as-is for `warmth`. */
export const HIT_RATE_EASE_DURATION_MS = 600;

/** How long the badge stays alerted after a detected invalidation. */
export const INVALIDATION_ALERT_DURATION_MS = 1_200;

/**
 * Interpolate a displayed `[0, 1]` value from `from` toward `to`, easing out
 * over `durationMs` — the widget feeds it `warmth`, not `hitRate`, despite
 * the name; the interpolation itself has never cared what it's easing. Pure
 * function of its numeric inputs — no wall-clock reads — so it is testable
 * without a widget or a frame clock at all.
 */
export function easedHitRate(
	from: number,
	to: number,
	elapsedMs: number,
	durationMs: number = HIT_RATE_EASE_DURATION_MS,
): number {
	if (durationMs <= 0) return to;
	return from + (to - from) * easeOutCubic(elapsedMs / durationMs);
}

/** Minimal clock seam the widget needs — shared with the controller so ease/alert timestamps agree. */
export type CacheMeterClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface CacheMeterWidgetState {
	snapshot(): CacheMeterSnapshot;
}

export interface CacheMeterWidgetOptions extends AnimatedWidgetOptions {
	state: CacheMeterWidgetState;
	theme: CacheMeterTheme;
	/** Same clock the controller/scheduler use — NOT the host's mount-relative elapsed-ms. */
	clock: CacheMeterClock;
	/** Accent override for the primary accent slot (the badge); `undefined` keeps the built-in palette. */
	accentColor?: ThemeColor;
	/** The host's live symbol preset; `undefined` keeps the `"unicode"` default (see `../glyph-presets.ts`). */
	glyphPreset?: SymbolPreset;
}

/**
 * Ambient widget for the session cache ledger. Each frame it takes a snapshot,
 * advances the hit-rate ease and the invalidation-alert window
 * ({@link onFrame}), then draws the row at the current width and live
 * {@link MotionPolicy} tier. Reads the injected {@link CacheMeterClock} rather
 * than `this.elapsedMs` for the same reason as every other widget in this kit:
 * the host's relative elapsed-ms is anchored to whenever the host's first
 * subscriber attached, not to any particular ledger event, so ease/alert phase
 * math needs its own shared clock seam. The {@link AnimatedWidget} base owns
 * the subscribe-on-mount / unsubscribe-on-dispose lifecycle.
 */
export class CacheMeterWidget extends AnimatedWidget {
	#state: CacheMeterWidgetState;
	#theme: CacheMeterTheme;
	#policy: MotionPolicy;
	#clock: CacheMeterClock;
	#colors: CacheMeterColors;
	#glyphPreset: SymbolPreset;

	#easeFrom: number;
	#easeTarget: number;
	#easeStartMs: number;
	#lastInvalidationCount: number;
	#alertUntilMs: number | undefined;

	constructor(options: CacheMeterWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#colors = cacheMeterColors(options.accentColor);
		this.#glyphPreset = options.glyphPreset ?? "unicode";

		const snapshot = this.#state.snapshot();
		this.#easeFrom = snapshot.warmth;
		this.#easeTarget = snapshot.warmth;
		this.#easeStartMs = this.#clock.now();
		this.#lastInvalidationCount = snapshot.invalidationCount;
	}

	onFrame(_elapsedMs: number): void {
		const now = this.#clock.now();
		const snapshot = this.#state.snapshot();
		if (snapshot.warmth !== this.#easeTarget) {
			// Re-target from wherever the displayed percentage currently sits, not from
			// the old target — a second update mid-ease continues smoothly instead of
			// jumping back.
			this.#easeFrom = this.#displayWarmth(now);
			this.#easeTarget = snapshot.warmth;
			this.#easeStartMs = now;
		}
		if (snapshot.invalidationCount > this.#lastInvalidationCount) {
			this.#alertUntilMs = now + INVALIDATION_ALERT_DURATION_MS;
		}
		this.#lastInvalidationCount = snapshot.invalidationCount;
	}

	renderFrame(width: number): readonly string[] {
		if (this.#policy.tier === "off") {
			// Defensive: a live tier change can leave this widget mounted with no frame
			// subscription (see AnimatedWidget#syncToTier) — render() may still be
			// invoked (e.g. on resize), so this must degrade to the static line too.
			return [renderCacheMeterOffText(this.#state.snapshot(), this.#glyphPreset)];
		}
		const now = this.#clock.now();
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		const alerted = this.#alertUntilMs !== undefined && now < this.#alertUntilMs;
		return [
			renderCacheMeterRow(
				this.#state.snapshot(),
				width,
				now,
				this.#theme,
				tier,
				this.#displayWarmth(now),
				alerted,
				this.#colors,
				this.#glyphPreset,
			),
		];
	}

	#displayWarmth(now: number): number {
		return easedHitRate(this.#easeFrom, this.#easeTarget, now - this.#easeStartMs);
	}
}
