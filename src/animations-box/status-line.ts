/**
 * Animations Box — status-line span model, renderer, and change-flash engine
 * (Plan 018).
 *
 * Each detailed-mode row is `dot · label · phrase`: one SEMANTIC status dot
 * (the only glyph on the row — D2), a fixed-width lowercase label, and a
 * phrase built from word spans (D1/D3). Builders emit PLAIN spans; all
 * coloring — dot tone, span tone, gradient percentages, change-flash — lives
 * here, called by the widget. This deliberately inverts Plan 017's
 * "segments pre-color, widget never colors" contract (Plan 018 S1, the one
 * contract change of the plan).
 *
 * Change-flash (D6): {@link FlashTracker} diffs span text frame-to-frame per
 * `(segmentId, key)`. A changed span renders bold + segment accent, then
 * decays back to its resting tone on the box's existing frame cadence — no
 * new timers. Alerts persist instead of flashing: spans resting at
 * `notable`/`alert` tone (and `dim` — idle dashes, n/a prose) never flash.
 */

import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type GlyphKey, resolveGlyph } from "../glyph-presets";
import type { SymbolPreset, ThemeColor } from "../host/types";
import { type GradientDirection, gradientColorAt, type ProgressBarTheme, parseHex } from "../progress-bar";
import { dashedUnderline } from "../styled-underline";
import type { RenderTier } from "../terminal-capabilities";
import type { BoxTheme } from "./segments";

/**
 * The row's semantic status dot — the ONLY glyph vocabulary in detailed mode
 * (D2): `idle` (dim ○ — no signal yet / metric undefined here), `live`
 * (segment-accent ●), `notable` (amber ◐ — worth a glance), `alert` (red
 * bold ●, dashed-underlined where the terminal supports it — act).
 */
export type StatusDot = "idle" | "live" | "notable" | "alert";

/** A span's resting tone. `value` is plain terminal foreground (or the gradient color when {@link PhraseSpan.gradient} is set); `dim`/`notable`/`alert` are persistent semantic colors and never participate in change-flash (alerts persist, no blinking — D6). */
export type SpanTone = "value" | "dim" | "notable" | "alert";

/** One word-group of a status line's phrase. */
export interface PhraseSpan {
	/** Stable identity for frame-to-frame change detection (e.g. `pct`, `reads`) — NOT display text. Unique within one segment's line. */
	readonly key: string;
	/** Plain, uncolored words. The renderer colors it last. */
	readonly text: string;
	/** Resting tone; `undefined` means `value`. */
	readonly tone?: SpanTone;
	/** Persistent theme color for this span. Ignored while a real change flash is active. */
	readonly color?: ThemeColor;
	/** Animated visual spans set this false so their frame changes do not masquerade as data-change flashes. */
	readonly flash?: boolean;
	/**
	 * Fixed graphics opt out of prose truncation. A span wider than the phrase
	 * budget drops whole before priority narrowing, leaving room for a fallback.
	 */
	readonly neverTruncate?: boolean;
	/**
	 * Drop order under narrow widths: higher numbers drop first, ties drop
	 * rightmost-first. `undefined` means the span's position in the list
	 * (so a plain list already drops right-to-left — the spec's default).
	 */
	readonly priority?: number;
	/**
	 * Optional trailing detail. It stays in the same ` · ` phrase as core
	 * content but sheds before core spans when the pane narrows.
	 */
	readonly wideOnly?: boolean;
	/** Separator rendered BEFORE this span (ignored for the first span). Default `" · "`. */
	readonly sep?: string;
	/** Gradient-color the span by ratio (D5 — the percentage carries the color the bar used to). Only applies at truecolor with a hex-capable theme; lower tiers bucket to success/warning/error. Ignored when `tone` is `notable`/`alert`. */
	readonly gradient?: { readonly ratio: number; readonly direction: GradientDirection };
}

/** What one segment renders as its detailed-mode status line. */
export interface SegmentLine {
	readonly dot: StatusDot;
	/** Fixed-gutter lowercase label, ≤ 7 columns (`cache`, `cadence`, …). */
	readonly label: string;
	/** Segment accent color — the `live` dot's color and the change-flash color. */
	readonly accent: ThemeColor;
	readonly spans: readonly PhraseSpan[];
	/** The row represents work happening now and should use the shared activity pulse. */
	readonly activity?: boolean;
}

/** Flash intensity, derived from the motion tier (reduced-motion forces `off`). */
export type FlashTier = "off" | "subtle" | "full";

/** `subtle` flash: bold+accent for one repaint at the box's ~4fps detailed cadence. */
export const SUBTLE_FLASH_MS = 250;
/** `full` flash: bold+accent phase. */
export const FULL_FLASH_BOLD_MS = 400;
/** `full` flash: total decay (bold+accent, then accent alone) — ~2-3 frames at the box's cadence. */
export const FULL_FLASH_MS = 800;

export type ActivityPulsePhase = "off" | "rest" | "accent" | "bold";

const ACTIVITY_PULSE_MS = 1_200;
const ACTIVITY_BOLD_MS = 300;
const ACTIVITY_ACCENT_MS = 650;

/** Shared fixed-cadence emphasis for active rows and agents. Geometry never changes. */
export function activityPulsePhase(now: number, tier: FlashTier): ActivityPulsePhase {
	if (tier === "off" || !Number.isFinite(now)) return "off";
	if (tier === "subtle") return "accent";
	const elapsed = ((now % ACTIVITY_PULSE_MS) + ACTIVITY_PULSE_MS) % ACTIVITY_PULSE_MS;
	if (elapsed < ACTIVITY_BOLD_MS) return "bold";
	return elapsed < ACTIVITY_ACCENT_MS ? "accent" : "rest";
}

interface FlashEntry {
	text: string;
	changedAt: number;
}

/**
 * Frame-to-frame span differ (D6). One instance per widget; keys are
 * `(segmentId, span.key)`. First observation of a key is a baseline, never a
 * flash. Rides the widget's existing frame clock — no timers of its own.
 */
export class FlashTracker {
	#entries = new Map<string, FlashEntry>();

	/** Record this frame's span texts for one segment. Call once per rendered line, BEFORE querying {@link phase} — same `now` the render uses. Re-observing identical text at any later `now` is a no-op, so multi-width re-renders of one frame can't re-trigger. */
	observe(segmentId: string, spans: readonly PhraseSpan[], now: number): void {
		for (const span of spans) {
			const key = `${segmentId}\u0000${span.key}`;
			if (span.flash === false) {
				this.#entries.delete(key);
				continue;
			}
			const prev = this.#entries.get(key);
			if (prev === undefined) {
				this.#entries.set(key, { text: span.text, changedAt: Number.NEGATIVE_INFINITY });
			} else if (prev.text !== span.text) {
				prev.text = span.text;
				prev.changedAt = now;
			}
		}
	}

	/** Current flash phase for one span, or `undefined` at rest. `bold` = bold+accent, `accent` = accent alone (the `full` tier's decay step). */
	phase(segmentId: string, key: string, now: number, tier: FlashTier): "bold" | "accent" | undefined {
		if (tier === "off") return undefined;
		const entry = this.#entries.get(`${segmentId}\u0000${key}`);
		if (entry === undefined) return undefined;
		const elapsed = now - entry.changedAt;
		if (tier === "subtle") return elapsed < SUBTLE_FLASH_MS ? "bold" : undefined;
		if (elapsed < FULL_FLASH_BOLD_MS) return "bold";
		return elapsed < FULL_FLASH_MS ? "accent" : undefined;
	}
}

/** Everything the renderer needs beyond the line itself. Width/tier fields are explicit (not module-resolved) so tests stay hermetic under any local terminal. */
export interface StatusLineContext {
	readonly theme: BoxTheme;
	readonly preset: SymbolPreset;
	/** Gates gradient span coloring — hex gradients at `truecolor` (with a hex-capable theme), success/warning/error buckets below. */
	readonly colorMode: RenderTier["colorMode"];
	/** Gates the alert dot's dashed underline (jj7.13). */
	readonly program: RenderTier["program"];
	/** Flash identity namespace — the segment id. */
	readonly segmentId: string;
	/** Same wall clock the widget renders with. */
	readonly now: number;
	readonly flashTier: FlashTier;
	/** Omit for flash-less rendering (goldens, one-shot tests). */
	readonly flash?: FlashTracker;
}

/** Dot column (1) + gap (2) + label gutter (7) + gap (2) — the phrase starts at column 12. */
export const STATUS_LINE_PREFIX_COLS = 12;
const LABEL_COLS = 7;

/** D2's dot → glyph-key mapping — shared with the legend overlay (D8), which documents the same four-dot vocabulary the renderer draws. */
export const DOT_GLYPH_KEY: Record<StatusDot, GlyphKey> = {
	idle: "box.dot.idle",
	live: "box.dot.live",
	notable: "box.dot.notable",
	alert: "box.dot.alert",
};

/** `theme.bold` where available; identity otherwise. A theme without `bold` is a colorless test double — injecting raw SGR there would break NO_COLOR hermeticity, and the flash still shows through the accent `fg` wrap. */
function boldText(theme: BoxTheme, text: string): string {
	return theme.bold === undefined ? text : theme.bold(text);
}

function renderDot(line: SegmentLine, ctx: StatusLineContext, activity: ActivityPulsePhase): string {
	const glyph = resolveGlyph(DOT_GLYPH_KEY[line.dot], ctx.preset);
	if (line.activity === true) {
		if (activity === "bold") return boldText(ctx.theme, ctx.theme.fg(line.accent, glyph));
		if (activity === "accent") return ctx.theme.fg(line.accent, glyph);
		if (activity === "rest") return ctx.theme.fg("dim", glyph);
	}
	switch (line.dot) {
		case "idle":
			return ctx.theme.fg("dim", glyph);
		case "live":
			return ctx.theme.fg(line.accent, glyph);
		case "notable":
			return ctx.theme.fg("warning", glyph);
		case "alert":
			return dashedUnderline(boldText(ctx.theme, ctx.theme.fg("error", glyph)), ctx.program);
	}
}

/**
 * Gradient color for a span's ratio (D5). Truecolor + hex-capable theme →
 * the exact `progress-bar.ts` ramp as a foreground SGR (fg-only reset, so
 * surrounding text is untouched). Below that, bucket goodness — the
 * direction-corrected ratio — into the three semantic colors.
 */
function gradientText(text: string, ratio: number, direction: GradientDirection, ctx: StatusLineContext): string {
	const clamped = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
	if (ctx.colorMode === "truecolor" && ctx.theme.getColorHex !== undefined) {
		const hex = gradientColorAt(clamped, direction, ctx.theme as Required<ProgressBarTheme>);
		return `\x1b[38;2;${parseHex(hex).join(";")}m${text}\x1b[39m`;
	}
	const goodness = direction === "up-good" ? clamped : 1 - clamped;
	return ctx.theme.fg(goodness >= 0.5 ? "success" : goodness >= 0.25 ? "warning" : "error", text);
}

/** Color one span at its resting tone, current change-flash phase, or active-row pulse. `text` may be a truncated form of `span.text`. */
function colorSpan(
	span: PhraseSpan,
	text: string,
	accent: ThemeColor,
	activity: ActivityPulsePhase,
	ctx: StatusLineContext,
): string {
	const tone = span.tone ?? "value";
	// Only value-toned spans flash — dim (idle/n-a prose) stays quiet, and
	// notable/alert are persistent states, not events (D6).
	const phase =
		tone === "value" && span.flash !== false
			? ctx.flash?.phase(ctx.segmentId, span.key, ctx.now, ctx.flashTier)
			: undefined;
	if (phase === "bold") return boldText(ctx.theme, ctx.theme.fg(accent, text));
	if (phase === "accent") return ctx.theme.fg(accent, text);
	if (tone === "value" && activity === "bold") return boldText(ctx.theme, ctx.theme.fg(accent, text));
	if (tone === "value" && activity === "accent") return ctx.theme.fg(accent, text);
	switch (tone) {
		case "alert":
			return boldText(ctx.theme, ctx.theme.fg("error", text));
		case "notable":
			return ctx.theme.fg("warning", text);
		case "dim":
			return ctx.theme.fg("dim", text);
		case "value":
			if (span.gradient !== undefined) return gradientText(text, span.gradient.ratio, span.gradient.direction, ctx);
			return span.color === undefined ? text : ctx.theme.fg(span.color, text);
	}
}

/** Plain (uncolored) width of `spans` joined by their separators. */
function phraseWidth(spans: readonly PhraseSpan[]): number {
	let width = 0;
	for (let i = 0; i < spans.length; i++) {
		const span = spans[i] as PhraseSpan;
		if (i > 0) width += visibleWidth(span.sep ?? " · ");
		width += visibleWidth(span.text);
	}
	return width;
}

/** Index of the next span to drop: highest {@link PhraseSpan.priority} wins, ties break rightmost-first. */
function dropIndex(spans: readonly PhraseSpan[], priorityOf: (span: PhraseSpan) => number): number {
	let index = 0;
	for (let i = 1; i < spans.length; i++) {
		if (priorityOf(spans[i] as PhraseSpan) >= priorityOf(spans[index] as PhraseSpan)) index = i;
	}
	return index;
}

/**
 * Render one status line to exactly ≤ `inner` visible columns.
 *
 * Layout: `dot␣␣label··␣␣phrase`. Every visible span uses the same separator;
 * trailing detail no longer jumps to a second column. Width degradation drops
 * `wideOnly` spans first, then body spans by {@link PhraseSpan.priority}
 * (default: rightmost-first). Spans marked `neverTruncate` drop whole if they
 * exceed the phrase budget; a final lone prose span hard-truncates as the safety
 * net. The function observes the full span list into `ctx.flash` before
 * narrowing, so dropped spans do not reset flash state.
 */
export function renderStatusLine(line: SegmentLine, inner: number, ctx: StatusLineContext): string {
	ctx.flash?.observe(ctx.segmentId, line.spans, ctx.now);
	if (inner <= 0) return "";

	const activity = line.activity === true ? activityPulsePhase(ctx.now, ctx.flashTier) : "off";
	const dot = renderDot(line, ctx, activity);
	const plainLabel = truncateToWidth(line.label, LABEL_COLS);
	const label =
		activity === "bold"
			? boldText(ctx.theme, ctx.theme.fg(line.accent, plainLabel))
			: activity === "accent"
				? ctx.theme.fg(line.accent, plainLabel)
				: activity === "rest"
					? ctx.theme.fg("dim", plainLabel)
					: plainLabel;
	const prefix = `${dot}  ${label}${" ".repeat(Math.max(0, LABEL_COLS - visibleWidth(plainLabel)))}  `;
	const available = inner - STATUS_LINE_PREFIX_COLS;
	if (available <= 0) return truncateToWidth(prefix, inner);

	const kept = line.spans.filter(span => span.neverTruncate !== true || visibleWidth(span.text) <= available);
	const priorityOf = (span: PhraseSpan): number => {
		const ownPriority = span.priority ?? line.spans.indexOf(span);
		return ownPriority + (span.wideOnly === true ? line.spans.length : 0);
	};
	while (kept.length > 1 && phraseWidth(kept) > available) {
		kept.splice(dropIndex(kept, priorityOf), 1);
	}

	let plainWidth = 0;
	let phrase = "";
	for (let i = 0; i < kept.length; i++) {
		const span = kept[i] as PhraseSpan;
		const sep = i > 0 ? (span.sep ?? " · ") : "";
		const room = available - plainWidth - visibleWidth(sep);
		const text = visibleWidth(span.text) > room ? truncateToWidth(span.text, Math.max(0, room)) : span.text;
		if (text.length === 0 && i > 0) break;
		phrase += sep + colorSpan(span, text, line.accent, activity, ctx);
		plainWidth += visibleWidth(sep) + visibleWidth(text);
	}

	return prefix + phrase;
}
