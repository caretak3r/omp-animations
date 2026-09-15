/**
 * Animations Box — the bordered widget itself.
 *
 * The single instance hosts required and optional sample groups. The border
 * costs 2 rows and 4 columns (`"│ "` + `" │"`). Each content line uses
 * `width - 4` columns. The widget pads or truncates each line to this width.
 *
 * `simple` draws one composed row from active segments. `readable` and
 * `detailed` both draw the required rows and then the active optional rows;
 * they differ only in how the Agent Bonsai optional group renders its own
 * rows. It draws one separator when both groups have rows. An idle required
 * segment draws its dim resting line. An optional segment with no meaningful
 * state uses no row.
 *
 * `status-line.ts` renders the plain spans that each segment source emits.
 * This widget applies dot tone, span tones, gradient percentages, and change
 * flashes at render time. Both modes use `buildSampleGroups(now)` as their
 * only composition input; this class contains no segment-specific business
 * logic.
 *
 * The border chrome layers one clockwise cell gloss over the uniform breathing
 * envelope. Both inputs arrive in one `getBorderFrame` sample derived from the
 * shared clock and Phase 4A state. `undefined` (motion tier `off`, checked
 * directly against this widget's policy, or `breathingBorder` disabled in
 * config) falls back to the plain, uncolored chrome. The four corner cells get
 * one exemption from the head-only peak rule: while a corner's own gloss
 * trail (its {@link borderGlossIntensity} falloff, not the ambient breathing
 * brightness) is still hot enough, it keeps the peak token instead of being
 * demoted, so a passing gloss head reads as a brief corner flash — still the
 * same three-token palette, still bounded by the existing falloff.
 */

import { sliceWithWidth, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AgentBonsaiSnapshot } from "../agent-bonsai";
import { hyperlinksSupported, renderAgentBonsaiRows, sharedBonsaiModel } from "../agent-bonsai";
import type { AccentColor } from "../appearance";
import {
	type BorderBrightnessToken,
	type BreathingBorderColors,
	type BreathingBorderPhase,
	borderGlossIntensity,
	breathingBorderColors,
	brightnessToken,
} from "../breathing-border";
import type { SymbolPreset, ThemeColor } from "../host/types";
import type { AnimatedWidgetOptions, AnimationHost, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget, composeSegments, segment as toKitSegment } from "../kit";
import { resolveRenderTier, styledUnderlineProgram } from "../terminal-capabilities";
import type { BoxTheme, SegmentSample } from "./segments";
import type { BoxDetail } from "./settings";
import { type FlashTier, FlashTracker, renderStatusLine } from "./status-line";

const BORDER_COLS = 4;
const BORDER_ROWS = 2;

// Resolved once at module load, same as `segments.ts`: gradient gating rides the
// real color mode; styled underlines honor the test escape hatch.
const RENDER_TIER = resolveRenderTier();
const TERMINAL_PROGRAM = styledUnderlineProgram(RENDER_TIER);
/** Pad/truncate `text` to exactly `width` visible columns — never over, never under. */
function cell(text: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width);
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

/** `color === undefined` is the plain, uncolored fallback — never wraps `theme.fg` at all. */
function borderText(theme: BoxTheme, color: ThemeColor | undefined, text: string, heavy: boolean): string {
	const colored = color === undefined ? text : theme.fg(color, text);
	return heavy && theme.bold !== undefined ? theme.bold(colored) : colored;
}

/** Resolve a raw {@link brightnessToken} classification through the configured palette. The palette slots come from `../breathing-border/colors.ts`; picking one per token is this widget's job, because it owns the chrome. */
function colorForToken(token: BorderBrightnessToken, colors: BreathingBorderColors): ThemeColor {
	if (token === "borderMuted") return colors.muted;
	if (token === "border") return colors.base;
	return colors.peak;
}

export interface AnimationsBoxBorderFrame {
	readonly phase: BreathingBorderPhase;
	readonly brightness: number;
	readonly glossProgress: number;
	readonly glossStrength: number;
	/** Perimeter gloss trail width, as a fraction of the perimeter. Omitted means the `full`-tier trail. */
	readonly glossTrailFraction?: number;
}

interface BorderPaint {
	readonly frame: AnimationsBoxBorderFrame;
	readonly width: number;
	readonly perimeterLength: number;
	readonly baseToken: BorderBrightnessToken;
	readonly heavy: boolean;
	readonly colors: BreathingBorderColors;
	readonly theme: BoxTheme;
}

/** Clockwise numbering from `borderTop`/`contentLine`/`borderBottom`: the bottom row starts at half the perimeter and runs right to left. */
function isCornerIndex(perimeterIndex: number, paint: BorderPaint): boolean {
	const bottomRight = paint.perimeterLength / 2;
	return (
		perimeterIndex === 0 ||
		perimeterIndex === paint.width - 1 ||
		perimeterIndex === bottomRight ||
		perimeterIndex === bottomRight + paint.width - 1
	);
}

/**
 * Local trail intensity a corner must clear to keep its peak token instead of
 * being demoted like every other non-head cell. Gated on the gloss's own
 * falloff (not on ambient breathing brightness) so the corner flash is
 * bounded to the head actually passing nearby, not to a bright crest alone.
 */
const CORNER_ACCENT_MIN_TRAIL = 0.5;

function hasSpatialGloss(paint: BorderPaint | undefined): paint is BorderPaint {
	return paint !== undefined && paint.frame.glossStrength > 0;
}

function uniformBorderText(text: string, paint: BorderPaint | undefined): string {
	if (paint === undefined) return text;
	return borderText(paint.theme, colorForToken(paint.baseToken, paint.colors), text, paint.heavy);
}

function borderCell(text: string, perimeterIndex: number, paint: BorderPaint | undefined): string {
	if (paint === undefined) return text;
	const progress = Number.isFinite(paint.frame.glossProgress)
		? paint.frame.glossProgress - Math.floor(paint.frame.glossProgress)
		: 0;
	const headIndex = Math.floor(progress * paint.perimeterLength);
	const trail = borderGlossIntensity(
		perimeterIndex,
		paint.perimeterLength,
		paint.frame.glossProgress,
		paint.frame.glossStrength,
		paint.frame.glossTrailFraction,
	);
	const glossAlpha = perimeterIndex === headIndex ? paint.frame.glossStrength : trail;
	const brightness = paint.frame.brightness + (1 - paint.frame.brightness) * glossAlpha;
	let token = brightnessToken(brightness);
	// Every non-head cell is demoted off the peak token so exactly one cell reads as the
	// gloss head. A corner gets one exemption, gated on the gloss trail itself (not on
	// ambient breathing brightness, which a bright crest could satisfy from any distance):
	// while the head has just passed close enough, the corner flashes to peak too.
	const isCornerFlash =
		perimeterIndex !== headIndex && trail >= CORNER_ACCENT_MIN_TRAIL && isCornerIndex(perimeterIndex, paint);
	if (isCornerFlash) {
		token = "borderAccent";
	} else if (perimeterIndex !== headIndex && token === "borderAccent") {
		token = "border";
	}
	return borderText(paint.theme, colorForToken(token, paint.colors), text, paint.heavy);
}

function diffractionCells(token: string): readonly string[] {
	const cells: string[] = [];
	const width = visibleWidth(token);
	for (let column = 0; column < width; column++) {
		cells.push(sliceWithWidth(token, column, 1, true).text);
	}
	return cells;
}

function borderTop(
	width: number,
	diffraction: string | undefined,
	heavy: boolean,
	paint: BorderPaint | undefined,
): string {
	const horizontal = heavy ? "━" : "─";
	if (width <= 2) {
		if (!hasSpatialGloss(paint)) return uniformBorderText(horizontal.repeat(Math.max(0, width)), paint);
		let row = "";
		for (let column = 0; column < Math.max(0, width); column++) {
			row += borderCell(horizontal, column, paint);
		}
		return row;
	}
	const inner = width - 2;
	const token = diffraction === undefined ? "" : truncateToWidth(diffraction, inner);
	const tokenWidth = visibleWidth(token);
	const leftCorner = heavy ? "┏" : "┌";
	const rightCorner = heavy ? "┓" : "┐";
	const left = Math.floor((inner - tokenWidth) / 2);
	const right = inner - tokenWidth - left;
	if (!hasSpatialGloss(paint)) {
		return uniformBorderText(
			`${leftCorner}${horizontal.repeat(left)}${token}${horizontal.repeat(right)}${rightCorner}`,
			paint,
		);
	}
	let row = borderCell(leftCorner, 0, paint);
	let column = 1;
	for (let count = 0; count < left; count++, column++) row += borderCell(horizontal, column, paint);
	for (const tokenCell of diffractionCells(token)) {
		row += borderCell(tokenCell, column, paint);
		column++;
	}
	for (let count = 0; count < right; count++, column++) row += borderCell(horizontal, column, paint);
	return row + borderCell(rightCorner, width - 1, paint);
}

function borderBottom(width: number, contentRows: number, heavy: boolean, paint: BorderPaint | undefined): string {
	const horizontal = heavy ? "━" : "─";
	const firstIndex = paint === undefined ? 0 : width + (width >= BORDER_COLS ? contentRows : 0);
	if (width <= 2) {
		if (!hasSpatialGloss(paint)) return uniformBorderText(horizontal.repeat(Math.max(0, width)), paint);
		let row = "";
		for (let column = 0; column < Math.max(0, width); column++) {
			row += borderCell(horizontal, firstIndex + width - 1 - column, paint);
		}
		return row;
	}
	const leftCorner = heavy ? "┗" : "└";
	const rightCorner = heavy ? "┛" : "┘";
	if (!hasSpatialGloss(paint)) {
		return uniformBorderText(`${leftCorner}${horizontal.repeat(width - 2)}${rightCorner}`, paint);
	}
	let row = borderCell(leftCorner, firstIndex + width - 1, paint);
	for (let column = 1; column < width - 1; column++) {
		row += borderCell(horizontal, firstIndex + width - 1 - column, paint);
	}
	return row + borderCell(rightCorner, firstIndex, paint);
}

/** Wrap one content line in the box's side borders, padded to exactly `width`. Only the pipes take the border treatment — the inner content is colored (or not) by whatever built `text`. */
function contentLine(
	text: string,
	inner: number,
	width: number,
	rowIndex: number,
	contentRows: number,
	paint: BorderPaint | undefined,
): string {
	if (width < BORDER_COLS) return cell(text, width);
	const heavy = paint?.heavy ?? false;
	const pipe = heavy ? "┃" : "│";
	if (!hasSpatialGloss(paint)) {
		const styledPipe = uniformBorderText(pipe, paint);
		return `${styledPipe} ${cell(text, inner)} ${styledPipe}`;
	}
	const leftIndex = width + contentRows + width + (contentRows - 1 - rowIndex);
	const rightIndex = width + rowIndex;
	return `${borderCell(pipe, leftIndex, paint)} ${cell(text, inner)} ${borderCell(pipe, rightIndex, paint)}`;
}

/** Composition groups the box controller builds each frame. The widget alone decides how those groups are separated on screen. */
export interface AnimationsBoxSampleGroups {
	readonly required: readonly SegmentSample[];
	readonly optional: readonly SegmentSample[];
}

export interface AnimationsBoxWidgetOptions extends AnimatedWidgetOptions {
	/** Foreground coloring, for both segment content and the border chrome (Decision 2). */
	theme: BoxTheme;
	/** Same wall clock the controller stamps its own state's timestamps with — NOT the host's mount-relative `elapsedMs` (Decision 4). */
	clock: Pick<FrameScheduler, "now">;
	/** Per-frame state mutation, called once per tick before the next render. No-op until a wired segment needs one (e.g. a settle/ripple timer). */
	onTick: (nowMs: number) => void;
	/** Build this frame's required summaries and enabled optional animations. Pure given `nowMs`. */
	buildSampleGroups: (nowMs: number) => AnimationsBoxSampleGroups;
	/** Live detail level. Re-read every call — the controller updates its backing value on settings changes, not just at construction. */
	getDetail: () => BoxDetail;
	/**
	 * One live border sample for this frame, re-read every call from the shared
	 * clock. `undefined` means `breathingBorder` is disabled in config. Motion
	 * tier `off` is a harder override checked against this widget's own policy.
	 */
	getBorderFrame: (nowMs: number) => AnimationsBoxBorderFrame | undefined;
	/** A finite fixed-width diffraction token for simultaneous facts in this frame. */
	getCollisionDiffraction?: (nowMs: number, width: number) => string | undefined;
	/** Whether any credential alert exists; escalates the border peak token to error. */
	getBorderAlert?: () => boolean;
	/** Accent override for the border's peak brightness — the existing `breathingBorderAccentColor` setting; `undefined` keeps the palette `../breathing-border/colors.ts` ships. */
	accentColor?: AccentColor;
	/** Host glyph preset for the semantic status dots (detailed mode). Mirrors the controller's mount-captured preset; defaults to `unicode`. */
	preset?: SymbolPreset;
	/** Optional Agent Bonsai snapshot. Main-only snapshots are intentionally invisible. */
	getAgentBonsai?: () => AgentBonsaiSnapshot;
	/**
	 * Whether Bonsai's active-skill chip may carry an OSC 8 hyperlink. Resolved
	 * once at construction from the plugin's own capability gate
	 * (`hyperlinksSupported()`), never from the host's `isHyperlinkEnabled()` —
	 * that one reads a `Settings` singleton belonging to the host bundle's
	 * module graph and is therefore permanently false from a plugin. Injected
	 * only by tests, which pin it so golden rows never vary with the terminal
	 * running the suite.
	 */
	hyperlinks?: boolean;
}

export class AnimationsBoxWidget extends AnimatedWidget {
	#theme: BoxTheme;
	#clock: Pick<FrameScheduler, "now">;
	#onTick: (nowMs: number) => void;
	#buildSampleGroups: (nowMs: number) => AnimationsBoxSampleGroups;
	#getDetail: () => BoxDetail;
	#policy: MotionPolicy;
	#motionHost: AnimationHost;
	#getBorderFrame: (nowMs: number) => AnimationsBoxBorderFrame | undefined;
	#getCollisionDiffraction: (nowMs: number, width: number) => string | undefined;
	#getBorderAlert: () => boolean;
	#colors: BreathingBorderColors;
	#preset: SymbolPreset;
	#flash = new FlashTracker();
	#bonsaiFlash = new FlashTracker();
	#bonsaiSeen = new Set<string>();
	#getAgentBonsai: () => AgentBonsaiSnapshot;
	#hyperlinks: boolean;

	constructor(options: AnimationsBoxWidgetOptions) {
		super(options);
		this.#theme = options.theme;
		this.#clock = options.clock;
		this.#onTick = options.onTick;
		this.#buildSampleGroups = options.buildSampleGroups;
		this.#getDetail = options.getDetail;
		this.#policy = options.policy;
		this.#motionHost = options.host;
		this.#getBorderFrame = options.getBorderFrame;
		this.#getCollisionDiffraction = options.getCollisionDiffraction ?? (() => undefined);
		this.#getBorderAlert = options.getBorderAlert ?? (() => false);
		this.#colors = breathingBorderColors(options.accentColor);
		this.#preset = options.preset ?? "unicode";
		this.#getAgentBonsai = options.getAgentBonsai ?? (() => ({ nodes: [], hiddenCount: 0, visible: false }));
		this.#hyperlinks = options.hyperlinks ?? hyperlinksSupported();
	}

	onFrame(_elapsedMs: number): void {
		this.#onTick(this.#clock.now());
	}

	renderFrame(width: number): readonly string[] {
		if (width <= 0) return [];

		const now = this.#clock.now();
		const groups = this.#buildSampleGroups(now);
		if (groups.required.length === 0 && groups.optional.length === 0) return [];
		const inner = Math.max(0, width - BORDER_COLS);
		const theme = this.#theme;
		const borderFrame = this.#resolveBorderFrame(now);
		// Optional emphasis follows the governor without changing semantic status.
		const flashTier: FlashTier = this.#policy.reducedMotion ? "off" : this.#motionHost.effectiveTier;
		const detail = this.#getDetail();
		const bonsaiSnapshot = this.#getAgentBonsai();
		const bonsaiRows = renderAgentBonsaiRows(bonsaiSnapshot, inner, {
			theme,
			glyphPreset: this.#preset,
			now,
			flashTier,
			flash: this.#bonsaiFlash,
			seenIds: this.#bonsaiSeen,
			hyperlinks: this.#hyperlinks,
			detail,
		});
		// Every visible agent on one model: state it once here rather than on
		// each row, where it would repeat without distinguishing anything.
		const sharedModel = sharedBonsaiModel(bonsaiSnapshot.nodes);
		const bonsaiHeader = sharedModel === undefined ? "agents" : `agents · ${sharedModel}`;

		if (detail !== "simple") {
			const contentRows: string[] = [];
			const appendSample = (sample: SegmentSample): void => {
				contentRows.push(
					renderStatusLine(sample.line, inner, {
						theme,
						preset: this.#preset,
						colorMode: RENDER_TIER.colorMode,
						program: TERMINAL_PROGRAM,
						segmentId: sample.id,
						now,
						flashTier,
						flash: this.#flash,
					}),
				);
			};
			for (const sample of groups.required) appendSample(sample);
			if (groups.required.length > 0 && (groups.optional.length > 0 || bonsaiRows.length > 0)) {
				contentRows.push("");
			}
			for (const sample of groups.optional) appendSample(sample);
			if (bonsaiRows.length > 0) {
				contentRows.push(theme.fg("dim", bonsaiHeader));
				for (const row of bonsaiRows) contentRows.push(row);
			}
			return this.#renderBox(contentRows, width, now, borderFrame);
		}

		// Simple mode keeps its composed status row, then appends Agent Bonsai as
		// a conditional group. Main-only snapshots retain the original 3-row box.
		const activeSegments = [];
		for (const sample of groups.required) {
			if (sample.active) activeSegments.push(toKitSegment(sample.id, sample.priority, sample.variants));
		}
		for (const sample of groups.optional) {
			if (sample.active) activeSegments.push(toKitSegment(sample.id, sample.priority, sample.variants));
		}
		const { row } = composeSegments(activeSegments, inner);
		const contentRows = [row];
		if (bonsaiRows.length > 0) {
			contentRows.push("");
			contentRows.push(theme.fg("dim", bonsaiHeader));
			for (const bonsaiRow of bonsaiRows) {
				contentRows.push(bonsaiRow);
			}
		}
		return this.#renderBox(contentRows, width, now, borderFrame);
	}

	#renderBox(
		contentRows: readonly string[],
		width: number,
		now: number,
		frame: AnimationsBoxBorderFrame | undefined,
	): readonly string[] {
		const perimeterLength = 2 * width + (width >= BORDER_COLS ? 2 * contentRows.length : 0);
		const baseToken = frame === undefined ? undefined : brightnessToken(frame.brightness);
		const colors = this.#getBorderAlert() ? { ...this.#colors, peak: "error" as ThemeColor } : this.#colors;
		const paint: BorderPaint | undefined =
			frame === undefined || baseToken === undefined
				? undefined
				: {
						frame,
						width,
						perimeterLength,
						baseToken,
						heavy: baseToken === "borderAccent",
						colors,
						theme: this.#theme,
					};
		const heavy = paint?.heavy ?? false;
		const rows = [borderTop(width, this.#getCollisionDiffraction(now, width), heavy, paint)];
		for (let rowIndex = 0; rowIndex < contentRows.length; rowIndex++) {
			rows.push(
				contentLine(
					contentRows[rowIndex] ?? "",
					Math.max(0, width - BORDER_COLS),
					width,
					rowIndex,
					contentRows.length,
					paint,
				),
			);
		}
		rows.push(borderBottom(width, contentRows.length, heavy, paint));
		return rows;
	}

	/** Border state for this frame. `undefined` means plain, static chrome. */
	#resolveBorderFrame(now: number): AnimationsBoxBorderFrame | undefined {
		if (this.#policy.tier === "off") return undefined;
		const frame = this.#getBorderFrame(now);
		if (frame === undefined || (!this.#policy.reducedMotion && this.#motionHost.effectiveTier !== "off")) {
			return frame;
		}
		return {
			...frame,
			brightness: frame.phase === "idle" ? 0 : 0.3,
			glossProgress: 0,
			glossStrength: 0,
		};
	}
}

/** Fixed border cost. Readable and detailed modes add one row per segment and one separator when optionals exist. */
export const BOX_BORDER_ROWS = BORDER_ROWS;
export const BOX_BORDER_COLS = BORDER_COLS;
