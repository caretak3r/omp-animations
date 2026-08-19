/**
 * Animations Box — the bordered widget itself.
 *
 * Each instance hosts required and optional sample groups. The Audit Box uses
 * both groups. The signal sidecar uses only the optional group. The border
 * costs 2 rows and 4 columns (`"│ "` + `" │"`). Each content line uses
 * `width - 4` columns and is padded or truncated to the target width.
 *
 * `simple` draws one composed row from active segments. `detailed` draws the
 * required rows, then one separator only when both groups have rows, then the
 * optional rows. An idle required segment still draws its dim resting line.
 * A sidecar with no meaningful optional rows returns zero rows.
 *
 * `status-line.ts` renders the plain spans that each segment source emits.
 * This widget applies dot tone, span tones, gradient percentages, and change
 * flashes at render time. Both modes use `buildSampleGroups(now)` as their
 * only composition input; this class contains no segment-specific business
 * logic.
 *
 * The border chrome itself breathes (Decision 2): every glyph of the top
 * row, bottom row, and side pipes is colored uniformly, per frame, via
 * `#resolveBorderColor` — the live envelope from `getBorderBrightness`
 * bucketed through `../breathing-border`'s `brightnessToken` classification
 * and this widget's accent-aware palette. `undefined` (motion tier `off`,
 * checked directly against this widget's own `policy`, or `breathingBorder`
 * disabled in config, reported by `getBorderBrightness` itself) falls back to
 * the plain, uncolored chrome.
 */

import type { SymbolPreset, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AgentBonsaiSnapshot } from "../agent-bonsai";
import { hyperlinksSupported, renderAgentBonsaiRows } from "../agent-bonsai";
import type { AccentColor } from "../appearance";
import {
	type BorderBrightnessToken,
	type BreathingBorderColors,
	breathingBorderColors,
	brightnessToken,
} from "../breathing-border";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
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
function colorize(theme: BoxTheme, color: ThemeColor | undefined, text: string): string {
	return color === undefined ? text : theme.fg(color, text);
}

/** Resolve a raw {@link brightnessToken} classification through the configured palette. The palette slots come from `../breathing-border/colors.ts`; picking one per token is this widget's job, because it owns the chrome. */
function colorForToken(token: BorderBrightnessToken, colors: BreathingBorderColors): ThemeColor {
	if (token === "borderMuted") return colors.muted;
	if (token === "border") return colors.base;
	return colors.peak;
}

function borderTop(width: number, theme: BoxTheme, color: ThemeColor | undefined): string {
	if (width <= 2) return colorize(theme, color, "─".repeat(Math.max(0, width)));
	return colorize(theme, color, `╭${"─".repeat(width - 2)}╮`);
}

function borderBottom(width: number, theme: BoxTheme, color: ThemeColor | undefined): string {
	if (width <= 2) return colorize(theme, color, "─".repeat(Math.max(0, width)));
	return colorize(theme, color, `╰${"─".repeat(width - 2)}╯`);
}

/** Wrap one content line in the box's side borders, padded to exactly `width`. Only the pipes take the border color — the inner content is colored (or not) by whatever built `text`. */
function contentLine(
	text: string,
	inner: number,
	width: number,
	theme: BoxTheme,
	color: ThemeColor | undefined,
): string {
	if (width < BORDER_COLS) return cell(text, width);
	const pipe = colorize(theme, color, "│");
	return `${pipe} ${cell(text, inner)} ${pipe}`;
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
	 * Live border brightness for this frame (Decision 2): the breathing
	 * border's `0..1` envelope, re-read every call same as `getDetail`.
	 * `undefined` means `breathingBorder` is disabled in config — this
	 * widget's cue to fall back to the plain, uncolored chrome. Motion tier
	 * `off` is a separate, harder override this widget checks itself against
	 * its own `policy`, so the seam never needs to encode that case.
	 */
	getBorderBrightness: (nowMs: number) => number | undefined;
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
	#getBorderBrightness: (nowMs: number) => number | undefined;
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
		this.#getBorderBrightness = options.getBorderBrightness;
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
		const borderColor = this.#resolveBorderColor(now);

		// Reduced-motion forces off-tier flash regardless of setting (D6/jj7.7);
		// otherwise the flash rides the motion tier itself.
		const flashTier: FlashTier = this.#policy.reducedMotion ? "off" : this.#policy.tier;
		const bonsaiRows = renderAgentBonsaiRows(this.#getAgentBonsai(), inner, {
			theme,
			glyphPreset: this.#preset,
			now,
			flashTier,
			flash: this.#bonsaiFlash,
			seenIds: this.#bonsaiSeen,
			hyperlinks: this.#hyperlinks,
		});

		if (this.#getDetail() === "detailed") {
			const rows: string[] = [borderTop(width, theme, borderColor)];
			const appendSample = (sample: SegmentSample): void => {
				rows.push(
					contentLine(
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
						inner,
						width,
						theme,
						borderColor,
					),
				);
			};
			for (const sample of groups.required) appendSample(sample);
			if (groups.required.length > 0 && (groups.optional.length > 0 || bonsaiRows.length > 0)) {
				rows.push(contentLine("", inner, width, theme, borderColor));
			}
			for (const sample of groups.optional) appendSample(sample);
			if (bonsaiRows.length > 0) {
				rows.push(contentLine(theme.fg("dim", "agents"), inner, width, theme, borderColor));
				for (const row of bonsaiRows) rows.push(contentLine(row, inner, width, theme, borderColor));
			}
			rows.push(borderBottom(width, theme, borderColor));
			return rows;
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
		const rows = [borderTop(width, theme, borderColor), contentLine(row, inner, width, theme, borderColor)];
		if (bonsaiRows.length > 0) {
			rows.push(contentLine("", inner, width, theme, borderColor));
			rows.push(contentLine(theme.fg("dim", "agents"), inner, width, theme, borderColor));
			for (const bonsaiRow of bonsaiRows) {
				rows.push(contentLine(bonsaiRow, inner, width, theme, borderColor));
			}
		}
		rows.push(borderBottom(width, theme, borderColor));
		return rows;
	}

	/**
	 * Border color for this frame. `undefined` — the plain, uncolored chrome —
	 * when the motion tier is `off`, a hard override applied before anything
	 * else, or when `getBorderBrightness` reports `breathingBorder` is
	 * disabled. Otherwise the live envelope buckets through
	 * `../breathing-border`'s `brightnessToken` classification, resolved
	 * through this widget's own accent-aware palette.
	 */
	#resolveBorderColor(now: number): ThemeColor | undefined {
		if (this.#policy.tier === "off") return undefined;
		const brightness = this.#getBorderBrightness(now);
		if (brightness === undefined) return undefined;
		return colorForToken(brightnessToken(brightness), this.#colors);
	}
}

/** Fixed border cost. Detailed mode adds one row per segment and one separator when optionals exist. */
export const BOX_BORDER_ROWS = BORDER_ROWS;
export const BOX_BORDER_COLS = BORDER_COLS;
