/**
 * Audit Trail Box — the pure renderers.
 *
 * Three surfaces, one snapshot, no duplicated state:
 * - {@link renderAuditMeterRow} is the compact glyph+counts line. It takes an
 *   explicit width and degrades in tiers, ending at a single count, so the same
 *   function serves both the ambient widget (which is handed a real width) and
 *   the footer status line (whose width the controller supplies).
 * - {@link renderAuditPanel} is the risk-sorted table behind the slash command.
 * - {@link renderAuditOffText} is the static one-liner for the `off` motion tier.
 *
 * Everything here is a pure function of an {@link AuditSnapshot} plus a phase —
 * no wall-clock reads, no filesystem, no state of its own.
 */
import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AccentColor, accentToThemeColor } from "../appearance";
import { resolveGlyph } from "../glyph-presets";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import { hyperlinkPath } from "../osc8-hyperlink";
import type { RenderTier } from "../terminal-capabilities";
import type { AuditSnapshot, LedgerMetrics, PathStatus } from "./state";
import { SIGNAL_FAMILIES, STATUS_RISK_ORDER } from "./state";

/** The slice of {@link Theme} the renderers need — just foreground coloring. */
export type AuditTrailBoxTheme = Pick<Theme, "fg">;

/**
 * Named color map. `badge` — the box glyph that leads every surface — is the
 * primary accent slot and the only token an accent override replaces; the
 * per-status colors are a semantic risk ramp (error -> warning -> dim) and stay
 * fixed, because recoloring "poisoned" would make the alarm unreadable.
 */
export interface AuditTrailBoxColors {
	badge: ThemeColor;
	poisoned: ThemeColor;
	dirty: ThemeColor;
	redundant: ThemeColor;
	cold: ThemeColor;
	fresh: ThemeColor;
	/** Secondary text: economics tail, headers, remainder notes. */
	label: ThemeColor;
}

/** Built-in palette. */
export const AUDIT_TRAIL_BOX_COLORS: AuditTrailBoxColors = {
	badge: "accent",
	poisoned: "error",
	dirty: "warning",
	redundant: "syntaxType",
	cold: "muted",
	fresh: "success",
	label: "dim",
};

/**
 * The palette with the accent slot applied. Shared by the widget and the
 * controller's status line so an accent override lands on both surfaces from one
 * place; the semantic risk ramp is deliberately not overridable.
 */
export function auditColors(accentColor?: AccentColor): AuditTrailBoxColors {
	return accentColor === undefined
		? AUDIT_TRAIL_BOX_COLORS
		: { ...AUDIT_TRAIL_BOX_COLORS, badge: accentToThemeColor(accentColor) };
}

/** One width-1 glyph per status, highest risk first, resolved for `preset` via `../glyph-presets.ts`. Defaults to `"unicode"` — the original hardcoded values. */
export function statusGlyphs(preset: SymbolPreset = "unicode"): Readonly<Record<PathStatus, string>> {
	return {
		poisoned: resolveGlyph("auditTrail.status.poisoned", preset),
		dirty: resolveGlyph("auditTrail.status.dirty", preset),
		redundant: resolveGlyph("auditTrail.status.redundant", preset),
		cold: resolveGlyph("auditTrail.status.cold", preset),
		fresh: resolveGlyph("auditTrail.status.fresh", preset),
	};
}

/** Resting badge; the box itself. Resolved for `preset`. */
export function badgeGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("auditTrail.badge", preset);
}

/** Hollow badge shown on the off-beat of the poisoned pulse. Resolved for `preset`. */
export function badgePulseGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("auditTrail.badgePulse", preset);
}

/** Full period of the alarm pulse, in ms. Slow on purpose — an ambient row that strobes is a row people turn off. */
export const PULSE_PERIOD_MS = 1_200;

/** Rows the panel prints before collapsing to a remainder count. */
export const DEFAULT_MAX_PANEL_ROWS = 12;

/** Column budget for the panel's path column before a path is elided from the left. */
export const PANEL_PATH_WIDTH = 44;

/** Shown by every surface when nothing has been touched yet. */
const IDLE_TEXT = "nothing tracked";

/**
 * Whether the badge is on its bright beat. Only meaningful while a poisoned path
 * is outstanding — the caller decides that; this is pure phase math.
 */
export function alarmPulse(elapsedMs: number): boolean {
	const phase = ((elapsedMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
	return phase < PULSE_PERIOD_MS / 2;
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

function paint(cells: readonly Cell[], theme: AuditTrailBoxTheme): string {
	return cells.map(cell => theme.fg(cell.color, cell.text)).join(" ");
}

function badgeCell(
	snapshot: AuditSnapshot,
	elapsedMs: number,
	tier: "full" | "subtle",
	colors: AuditTrailBoxColors,
	preset: SymbolPreset,
): Cell {
	const pulsing = tier === "full" && snapshot.counts.poisoned > 0 && !alarmPulse(elapsedMs);
	return {
		text: pulsing ? badgePulseGlyph(preset) : badgeGlyph(preset),
		color: snapshot.counts.poisoned > 0 ? colors.poisoned : colors.badge,
	};
}

/** One `<count><glyph>` cell per non-empty status, highest risk first. */
function countCells(snapshot: AuditSnapshot, colors: AuditTrailBoxColors, preset: SymbolPreset): readonly Cell[] {
	const glyphs = statusGlyphs(preset);
	return STATUS_RISK_ORDER.filter(status => snapshot.counts[status] > 0).map(status => ({
		text: `${snapshot.counts[status]}${glyphs[status]}`,
		color: colors[status],
	}));
}

/** The economics tail: read/write ledger, write amplification, redundant-read ratio. */
function economicsCells(metrics: LedgerMetrics, colors: AuditTrailBoxColors): readonly Cell[] {
	return [
		{ text: `r/w ${metrics.reads}/${metrics.writes}`, color: colors.label },
		{ text: `×${metrics.writeAmplification.toFixed(1)}`, color: colors.label },
		{ text: `↻${Math.round(metrics.redundantReadRatio * 100)}%`, color: colors.label },
	];
}

/** The single most urgent non-empty status, or `undefined` when nothing is tracked. */
export function topRiskStatus(snapshot: AuditSnapshot): PathStatus | undefined {
	return STATUS_RISK_ORDER.find(status => snapshot.counts[status] > 0);
}

/**
 * Compact glyph+counts row, degraded to fit `width`. Four tiers, widest first:
 * badge + counts + economics, badge + counts, badge + the single highest-risk
 * count, and finally the bare badge. Pure: `elapsedMs` only drives the badge
 * pulse, and only in the `full` tier while a path is poisoned.
 */
export function renderAuditMeterRow(
	snapshot: AuditSnapshot,
	width: number,
	elapsedMs: number,
	theme: AuditTrailBoxTheme,
	tier: "full" | "subtle",
	colors: AuditTrailBoxColors = AUDIT_TRAIL_BOX_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";

	const badge = badgeCell(snapshot, elapsedMs, tier, colors, preset);
	const top = topRiskStatus(snapshot);
	if (top === undefined) {
		const idle: readonly Cell[] = [badge, { text: IDLE_TEXT, color: colors.label }];
		return cellsWidth(idle) <= width ? paint(idle, theme) : paint([badge], theme);
	}

	const counts = countCells(snapshot, colors, preset);
	const single: readonly Cell[] = [
		badge,
		{ text: `${snapshot.counts[top]}${statusGlyphs(preset)[top]}`, color: colors[top] },
	];
	const candidates: readonly (readonly Cell[])[] = [
		[badge, ...counts, ...economicsCells(snapshot.metrics, colors)],
		[badge, ...counts],
		single,
		[badge],
	];

	for (const cells of candidates) {
		if (cellsWidth(cells) <= width) return paint(cells, theme);
	}
	return paint([badge], theme);
}

/** Elide a long path from the left (`…rc/audit-trail-box/state.ts`) — the tail is the part that identifies a file. */
export function elidePath(path: string, max: number): string {
	if (max <= 1) return path.slice(-Math.max(1, max));
	return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

function padRight(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export interface AuditPanelOptions {
	/** Rows before the remainder note. Defaults to {@link DEFAULT_MAX_PANEL_ROWS}. */
	readonly maxRows?: number;
	/** Column budget for the path column. Defaults to {@link PANEL_PATH_WIDTH}. */
	readonly pathWidth?: number;
	readonly colors?: AuditTrailBoxColors;
	/** The host's live symbol preset (see `../glyph-presets.ts`). Defaults to `"unicode"`. */
	readonly preset?: SymbolPreset;
	/** Terminal program for hyperlink support. When provided, absolute paths become clickable OSC-8 hyperlinks. */
	readonly program?: RenderTier["program"];
}

/**
 * The panel: every tracked path as a risk-sorted table. The snapshot's paths
 * already arrive highest-risk first (poisoned, dirty, redundant, cold, fresh,
 * then confidence desc), so the cap drops the least urgent rows and the
 * remainder note says how many. Each row carries the evidence that put it there
 * — the firing families and the severity gate's verdict — because a table that
 * only shows a status is one the reader has to go re-derive.
 */
export function renderAuditPanel(
	snapshot: AuditSnapshot,
	theme: AuditTrailBoxTheme,
	options: AuditPanelOptions = {},
): readonly string[] {
	const colors = options.colors ?? AUDIT_TRAIL_BOX_COLORS;
	const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_PANEL_ROWS);
	const pathWidth = Math.max(4, options.pathWidth ?? PANEL_PATH_WIDTH);
	const preset = options.preset ?? "unicode";
	const glyphs = statusGlyphs(preset);

	const heading = `${theme.fg(colors.badge, badgeGlyph(preset))} ${theme.fg(colors.label, `audit trail box · turn ${snapshot.turn} · ${snapshot.paths.length} path${snapshot.paths.length === 1 ? "" : "s"}`)}`;
	if (snapshot.paths.length === 0) {
		return [heading, theme.fg(colors.label, `  ${IDLE_TEXT}`)];
	}

	const lines: string[] = [heading];
	for (const record of snapshot.paths.slice(0, maxRows)) {
		const glyph = theme.fg(colors[record.status], glyphs[record.status]);
		const displayPath = padRight(elidePath(record.path, pathWidth), pathWidth);
		const coloredPath = theme.fg(colors[record.status], displayPath);
		// Wrap absolute paths with OSC-8 file:// hyperlinks when terminal supports it
		const path = options.program ? hyperlinkPath(coloredPath, record.path, options.program) : coloredPath;
		// Canonical family order, not the set's insertion order — the same path must
		// render identically whichever signal happened to fire for it first.
		const fired = SIGNAL_FAMILIES.filter(family => record.families.has(family));
		const evidence = fired.length === 0 ? "—" : fired.join("+");
		const detail = `${padRight(record.severity, 5)} ${evidence}`;
		lines.push(`  ${glyph} ${path} ${theme.fg(colors.label, detail)}`);
	}

	const hidden = snapshot.paths.length - Math.min(snapshot.paths.length, maxRows);
	if (hidden > 0) lines.push(theme.fg(colors.label, `  ⋯ +${hidden} more`));

	const m = snapshot.metrics;
	lines.push(
		theme.fg(
			colors.label,
			`  r/w ${m.reads}/${m.writes} · write amp ×${m.writeAmplification.toFixed(1)} · redundant ${Math.round(m.redundantReadRatio * 100)}% · bloat ${Math.round(m.workingSetBloat * 100)}%`,
		),
	);
	return lines;
}

/**
 * Static one-line fallback for the motion-`off` tier: no color, no phase, no
 * frame clock — just the counts that matter, leading with risk.
 */
export function renderAuditOffText(snapshot: AuditSnapshot, preset: SymbolPreset = "unicode"): string {
	const badge = badgeGlyph(preset);
	const top = topRiskStatus(snapshot);
	if (top === undefined) return `${badge} ${IDLE_TEXT}`;
	const cells = STATUS_RISK_ORDER.filter(status => snapshot.counts[status] > 0).map(
		status => `${snapshot.counts[status]} ${status}`,
	);
	return `${badge} ${snapshot.paths.length} tracked · ${cells.join(", ")}`;
}

/** Minimal clock seam the widget needs — shared with the controller so the pulse phase and probe timestamps agree. */
export type AuditTrailBoxClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface AuditTrailBoxWidgetState {
	snapshot(): AuditSnapshot;
}

export interface AuditTrailBoxWidgetOptions extends AnimatedWidgetOptions {
	state: AuditTrailBoxWidgetState;
	theme: AuditTrailBoxTheme;
	/** Same clock the controller stamps probe ticks with — NOT the host's mount-relative elapsed-ms. */
	clock: AuditTrailBoxClock;
	/** Accent override for the primary accent slot (the box badge); `undefined` keeps the built-in palette. */
	accentColor?: AccentColor;
	/** The host's live symbol preset; `undefined` keeps the `"unicode"` default (see `../glyph-presets.ts`). */
	glyphPreset?: SymbolPreset;
}

/**
 * Ambient widget for the working-set meter. A thin renderer over the shared
 * {@link AuditLedgerState}: each frame it takes a snapshot and draws the compact
 * row at the current width and live {@link MotionPolicy} tier. Reads the injected
 * {@link AuditTrailBoxClock} rather than `this.elapsedMs` for the same reason as
 * every other feature in the suite — the host's frame ticks drive repaint
 * cadence, not the pulse phase, so mounting after the first tracked path does
 * not skew it. The {@link AnimatedWidget} base owns the subscribe-on-mount /
 * unsubscribe-on-dispose lifecycle.
 */
export class AuditTrailBoxWidget extends AnimatedWidget {
	#state: AuditTrailBoxWidgetState;
	#theme: AuditTrailBoxTheme;
	#policy: MotionPolicy;
	#clock: AuditTrailBoxClock;
	#colors: AuditTrailBoxColors;
	#glyphPreset: SymbolPreset;

	constructor(options: AuditTrailBoxWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#colors = auditColors(options.accentColor);
		this.#glyphPreset = options.glyphPreset ?? "unicode";
	}

	renderFrame(width: number): readonly string[] {
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		return [
			renderAuditMeterRow(
				this.#state.snapshot(),
				width,
				this.#clock.now(),
				this.#theme,
				tier,
				this.#colors,
				this.#glyphPreset,
			),
		];
	}
}
