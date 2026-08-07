import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveGlyph } from "../glyph-presets";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import type { TidepoolSnapshot } from "./state";
import { poolFilledCells, poolTier, refillLevel } from "./tidepool";

/** The slice of {@link Theme} the renderers need — just foreground coloring. */
export type TidepoolTheme = Pick<Theme, "fg">;

/**
 * Named color map. `water` is the primary accent slot — the only token an
 * accent override replaces; `sand` stays a fixed alarm color (same reasoning
 * as Drift Buoy's `strained`), since a near-empty pool is the one state worth
 * a distinct, non-configurable visual cue.
 */
export interface TidepoolColors {
	water: ThemeColor;
	pebble: ThemeColor;
	sand: ThemeColor;
	label: ThemeColor;
}

/** Built-in palette. */
export const TIDEPOOL_COLORS: TidepoolColors = {
	water: "accent",
	pebble: "dim",
	sand: "warning",
	label: "dim",
};

/** The palette with the accent slot applied. `undefined` keeps the built-in water color. */
export function tidepoolColors(accentColor?: ThemeColor): TidepoolColors {
	return accentColor === undefined ? TIDEPOOL_COLORS : { ...TIDEPOOL_COLORS, water: accentColor };
}

/** Filled-water glyph, resolved for `preset` via `../glyph-presets.ts`. Defaults to `"unicode"` — the original hardcoded value. */
export function waterGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.water", preset);
}
/** The filled edge cell's alternate glyph on the `full` motion tier's shimmer beat, resolved for `preset`. */
export function waterShimmerGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.waterShimmer", preset);
}
/** Exposed-pool glyph while draining but not yet near-empty, resolved for `preset`. */
export function pebbleGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.pebble", preset);
}
/** Exposed-pool glyph once the pool reads as near-empty wet sand, resolved for `preset`. */
export function sandGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("rateLimitTidepool.sand", preset);
}

/** Widest the pool bar ever draws, in cells, regardless of available row width — the row-width budget caps it further. */
export const MAX_POOL_CELLS = 10;

/** Full period of the `full`-tier shimmer's two-frame flicker, in ms. */
export const SHIMMER_PERIOD_MS = 900;

/** Whether the shimmer glyph is showing at `elapsedMs` — a slow two-frame flicker, mirroring Drift Buoy's `bobbingBeat`. */
export function shimmerBeat(elapsedMs: number): boolean {
	const phase = ((elapsedMs % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS;
	return phase < SHIMMER_PERIOD_MS / 2;
}

/** A single tier's resting glyph — used for the very narrow width degradation. */
function bareGlyph(tier: ReturnType<typeof poolTier>, preset: SymbolPreset): string {
	return tier === "sand" ? sandGlyph(preset) : tier === "pebbles" ? pebbleGlyph(preset) : waterGlyph(preset);
}

/**
 * Render the proportional fill bar alone: filled cells read left-to-right as
 * water, one glyph per cell; the exposed (undrawn) remainder reads as pebbles
 * or sand depending on `tier`. `shimmerOn` only ever touches the single
 * rightmost filled (edge) cell — a shimmer, not a wave — and never applies to
 * the `sand` tier (a near-empty pool has nothing left to shimmer).
 */
export function renderTidepoolBar(
	level: number,
	cells: number,
	tier: ReturnType<typeof poolTier>,
	shimmerOn: boolean,
	theme: TidepoolTheme,
	colors: TidepoolColors = TIDEPOOL_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (cells <= 0) return "";
	const filled = poolFilledCells(level, cells);
	const exposedGlyph = tier === "sand" ? sandGlyph(preset) : pebbleGlyph(preset);
	const exposedColor = tier === "sand" ? colors.sand : colors.pebble;
	const parts: string[] = [];
	for (let i = 0; i < cells; i++) {
		if (i < filled) {
			const atEdge = i === filled - 1;
			const glyph = atEdge && shimmerOn && tier !== "sand" ? waterShimmerGlyph(preset) : waterGlyph(preset);
			parts.push(theme.fg(colors.water, glyph));
		} else {
			parts.push(theme.fg(exposedColor, exposedGlyph));
		}
	}
	return parts.join("");
}

/**
 * Pure renderer for one Tidepool row at `level` (already refill-adjusted by
 * the caller — see `refillLevel`). Degrades widest first: `full` (the bar
 * plus `NN% provider`) -> `plain` (drop the bar, keep the honest `NN%
 * provider` label) -> `bare` (just the percentage) -> a single tier glyph for
 * the narrowest widths. Deterministic given its numeric inputs — no
 * wall-clock reads.
 */
export function renderTidepoolRow(
	level: number,
	provider: string,
	elapsedMs: number,
	width: number,
	theme: TidepoolTheme,
	motionTier: "full" | "subtle",
	colors: TidepoolColors = TIDEPOOL_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";
	const tier = poolTier(level);
	const pct = Math.round((level <= 0 ? 0 : level >= 1 ? 1 : level) * 100);
	const pctLabel = `${pct}%`;
	const labelFull = `${pctLabel} ${provider}`;

	const shimmerOn = motionTier === "full" && shimmerBeat(elapsedMs);
	const bar = renderTidepoolBar(level, MAX_POOL_CELLS, tier, shimmerOn, theme, colors, preset);
	const fullWidth = MAX_POOL_CELLS + 1 + labelFull.length;
	if (fullWidth <= width) return `${bar} ${theme.fg(colors.label, labelFull)}`;

	if (labelFull.length <= width) return theme.fg(colors.label, labelFull);
	if (pctLabel.length <= width) return theme.fg(colors.label, pctLabel);

	const glyphColor = tier === "sand" ? colors.sand : tier === "pebbles" ? colors.pebble : colors.water;
	return theme.fg(glyphColor, bareGlyph(tier, preset));
}

/** Static one-line fallback for the motion-`off` tier: the same honest `NN% provider` label, no bar (no frame clock to animate one). */
export function renderTidepoolOffText(
	snapshot: Pick<TidepoolSnapshot, "level" | "provider">,
	preset: SymbolPreset = "unicode",
): string {
	const level = snapshot.level <= 0 ? 0 : snapshot.level >= 1 ? 1 : snapshot.level;
	return `${waterGlyph(preset)} ${Math.round(level * 100)}% ${snapshot.provider}`;
}

/** Minimal clock seam the widget needs — shared with the controller so `observedAtMs`/`resetAtMs` and render reads agree. */
export type TidepoolClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface TidepoolWidgetState {
	snapshot(): TidepoolSnapshot | undefined;
}

export interface TidepoolWidgetOptions extends AnimatedWidgetOptions {
	state: TidepoolWidgetState;
	theme: TidepoolTheme;
	/** Same clock the controller stamps `observedAtMs` with — NOT the host's internal relative elapsed-ms. */
	clock: TidepoolClock;
	/** Accent override for the primary accent slot (the water); `undefined` keeps the built-in palette. */
	accentColor?: ThemeColor;
	/** The host's live symbol preset; `undefined` keeps the `"unicode"` default (see `../glyph-presets.ts`). */
	glyphPreset?: SymbolPreset;
}

/**
 * Ambient widget for Rate-Limit Tidepool. Unlike Drift Buoy/Diff Bloom's
 * one-shot animations, this widget has no settle/teardown of its own — once
 * the controller mounts it (on the first recognized response), it stays
 * mounted for the rest of the session, redrawing from whatever the shared
 * state's single latest snapshot says. Each frame it reads {@link
 * TidepoolClock} (never `this.elapsedMs`, for the same dual-clock-seam reason
 * as every other widget in this kit) to compute the refill-adjusted level
 * from the snapshot's `observedAtMs`/`resetAtMs`, then renders at the current
 * width and {@link MotionPolicy} tier.
 */
export class TidepoolWidget extends AnimatedWidget {
	#state: TidepoolWidgetState;
	#theme: TidepoolTheme;
	#policy: MotionPolicy;
	#clock: TidepoolClock;
	#colors: TidepoolColors;
	#glyphPreset: SymbolPreset;

	constructor(options: TidepoolWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#colors = tidepoolColors(options.accentColor);
		this.#glyphPreset = options.glyphPreset ?? "unicode";
	}

	renderFrame(width: number): readonly string[] {
		const snapshot = this.#state.snapshot();
		// Defensive: the controller never constructs this widget before the first
		// recognized sample lands, but a live tier change can leave it mounted
		// with no frame subscription (see AnimatedWidget#syncToTier) — render()
		// may still be invoked (e.g. on resize), so this stays honest either way.
		if (snapshot === undefined) return [""];

		const now = this.#clock.now();
		const level = refillLevel(snapshot.level, now, snapshot.observedAtMs, snapshot.resetAtMs);

		if (this.#policy.tier === "off") {
			return [renderTidepoolOffText({ level, provider: snapshot.provider }, this.#glyphPreset)];
		}
		const motionTier = this.#policy.tier === "full" ? "full" : "subtle";
		return [
			renderTidepoolRow(
				level,
				snapshot.provider,
				now,
				width,
				this.#theme,
				motionTier,
				this.#colors,
				this.#glyphPreset,
			),
		];
	}
}
