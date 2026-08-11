import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AccentColor, accentToThemeColor } from "../appearance";
import type { AnimatedWidgetOptions, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import { GLOW_THRESHOLD, isEmberHot, regionGlow } from "./spans";
import type { PalimpsestRow, PalimpsestSnapshot } from "./state";

/** The slice of {@link Theme} the renderer needs: foreground coloring plus the underline/bold text styles the three glow tiers draw from. */
export type PalimpsestTheme = Pick<Theme, "fg" | "underline" | "bold">;

/** Named color map for the three visible glow tiers. `ember` is the primary accent slot — the only token an accent override replaces; `underline`/`amber` keep their fixed semantic tokens (a faint, still-cool touch vs. a warming one). */
export interface PalimpsestColors {
	underline: ThemeColor;
	amber: ThemeColor;
	ember: ThemeColor;
}

/** Built-in palette — the exact tokens the renderer used before colors were configurable. */
export const PALIMPSEST_COLORS: PalimpsestColors = { underline: "dim", amber: "warning", ember: "error" };

/** Merge an accent override into the ember slot (the only overridable one), or the built-in palette if none is given. Pure — shared by the widget constructor and the controller's static `off`-tier content, so both agree on the resolved accent. */
export function resolvePalimpsestColors(accentColor: AccentColor | undefined): PalimpsestColors {
	return accentColor === undefined
		? PALIMPSEST_COLORS
		: { ...PALIMPSEST_COLORS, ember: accentToThemeColor(accentColor) };
}

/** Rows drawn before the rest collapse out of view — keeps the strip to at most this many lines regardless of how many files are thrashing. */
export const MAX_ROWS_SHOWN = 3;

/** `path:line` for a single-line region, `path:start-end` for a multi-line one, or the bare `path` for a degraded (path-level) row. Pure. */
function regionLabel(row: PalimpsestRow): string {
	if (row.start === undefined || row.end === undefined) return row.path;
	return row.start === row.end ? `${row.path}:${row.start}` : `${row.path}:${row.start}-${row.end}`;
}

/**
 * Pure renderer for one row at its current glow tier. `underline` draws the
 * label faintly underlined; `amber` draws it in the warning token, flat;
 * `ember` draws it in the accent token, briefly bolding during
 * {@link isEmberHot}'s pulse window on the `full` tier only — `subtle` (and
 * a `full` frame outside the hot window) render the same ember row with no
 * bold, i.e. the static "hot" state the bead calls for. A `hidden`-tier row
 * (overlap count below {@link GLOW_THRESHOLD}) renders as an empty string;
 * callers filter these out before reaching here, but the mapping stays total.
 */
function renderRegionRow(
	row: PalimpsestRow,
	elapsedMs: number,
	theme: PalimpsestTheme,
	tier: "full" | "subtle",
	colors: PalimpsestColors,
): string {
	const label = regionLabel(row);
	const glow = regionGlow(row.overlapCount);
	if (glow === "hidden") return "";
	if (glow === "underline") return theme.fg(colors.underline, theme.underline(label));
	if (glow === "amber") return theme.fg(colors.amber, label);
	const hot = tier === "full" && isEmberHot(elapsedMs);
	return theme.fg(colors.ember, hot ? theme.bold(label) : label);
}

/**
 * Pure renderer: the thrash-detector strip for the current frame. Filters to
 * rows at or above {@link GLOW_THRESHOLD} (healthy forward progress renders
 * nothing at all), orders the most recently re-touched first so the freshest
 * thrashing is what survives the cap, and keeps at most
 * {@link MAX_ROWS_SHOWN}. Deterministic given `snapshot` and `elapsedMs` — no
 * wall-clock reads.
 */
export function renderPalimpsestRows(
	snapshot: PalimpsestSnapshot,
	elapsedMs: number,
	theme: PalimpsestTheme,
	tier: "full" | "subtle",
	colors: PalimpsestColors = PALIMPSEST_COLORS,
): readonly string[] {
	const visible = snapshot.rows
		.filter(row => row.overlapCount >= GLOW_THRESHOLD)
		.sort(
			(a, b) =>
				b.lastTouchedTurn - a.lastTouchedTurn || b.overlapCount - a.overlapCount || a.path.localeCompare(b.path),
		)
		.slice(0, MAX_ROWS_SHOWN);
	return visible.map(row => renderRegionRow(row, elapsedMs, theme, tier, colors));
}

/** Minimal state seam the widget needs. */
export interface PalimpsestWidgetState {
	snapshot(): PalimpsestSnapshot;
}

export interface PalimpsestWidgetOptions extends AnimatedWidgetOptions {
	state: PalimpsestWidgetState;
	theme: PalimpsestTheme;
	/** Accent override for the primary accent slot (the ember tier); `undefined` keeps the built-in palette. */
	accentColor?: AccentColor;
}

/**
 * Ambient widget for Palimpsest. A thin renderer over the shared
 * {@link PalimpsestState}: each frame it takes a snapshot and draws the
 * current rows at the live {@link MotionPolicy} tier. `off` is a real
 * rendering mode, not a no-op: it draws the exact same rows/sort/cap as
 * `subtle` (both fall through to the same static, non-pulsing style below —
 * `off` just never subscribes to the frame clock in the first place, via the
 * {@link AnimatedWidget} base's own tier gate, so there is nothing to
 * distinguish in `renderFrame` itself). In practice the controller never
 * constructs this widget while its {@link MotionPolicy} resolves to `off` at
 * mount time — it pushes the same static rows directly as plain widget
 * content instead — so this only matters for a *live* `full`/`subtle` ->
 * `off` policy crossing on an already-mounted widget, which now degrades to
 * the static summary rather than going blank. Reads its own inherited
 * `elapsedMs` (the host's frame clock) for the ember pulse phase rather than
 * a shared clock seam: unlike every other Wave 2/3 widget, nothing in
 * {@link PalimpsestState} stores an absolute timestamp for this widget to
 * stay in sync with — turns, not wall time, drive the fade — so the pulse
 * has no external phase to anchor to and the host's own clock is enough.
 */
export class PalimpsestWidget extends AnimatedWidget {
	#state: PalimpsestWidgetState;
	#theme: PalimpsestTheme;
	#policy: MotionPolicy;
	#colors: PalimpsestColors;

	constructor(options: PalimpsestWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#colors = resolvePalimpsestColors(options.accentColor);
	}

	renderFrame(_width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return renderPalimpsestRows(this.#state.snapshot(), this.elapsedMs, this.#theme, tier, this.#colors);
	}
}
