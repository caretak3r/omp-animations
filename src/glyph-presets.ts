/**
 * Terminal symbol-preset-aware glyph lookup for this plugin's rows and chrome.
 *
 * Mirrors the host's own three-tier symbol preset system (`unicode`/`nerd`/`ascii`,
 * default `unicode`, read at runtime via `ExtensionContext.ui.theme.getSymbolPreset()`)
 * instead of the hardcoded Unicode literals once scattered across this package.
 * `unicode` values are byte-identical to what shipped before this module existed — zero
 * visual regression for the default, live-in-production posture. `nerd` aliases
 * `unicode` exactly for v1: none of these glyphs were ever true Nerd Font private-use
 * characters, so plain Unicode already renders fine on nerd-font-configured terminals —
 * no fake "nerd-exclusive" upgrade is invented here. `ascii` substitutes exactly one
 * 7-bit column per glyph, never a multi-char string — the box widget's width is an
 * asserted golden-test surface a wider substitute would break.
 *
 * `GlyphKey` is a flat, extensible union backed by a `Record<SymbolPreset,
 * Record<GlyphKey, string>>` table. Extend by adding more union members and table
 * rows — never restructure the shape.
 */
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/** Every glyph this table currently resolves, namespaced by owning surface. */
export type GlyphKey =
	| "border.ramp.0"
	| "border.ramp.1"
	| "border.ramp.2"
	| "border.ramp.3"
	| "box.limits"
	| "box.files"
	| "box.reflect"
	| "box.dot.idle"
	| "box.dot.live"
	| "box.dot.notable"
	| "box.dot.alert"
	| "box.bar.filled"
	| "box.bar.empty"
	| "box.bar.eighths.1"
	| "box.bar.eighths.2"
	| "box.bar.eighths.3"
	| "box.bar.eighths.4"
	| "box.bar.eighths.5"
	| "box.bar.eighths.6"
	| "box.bar.eighths.7"
	| "cacheMeter.badge"
	| "cacheMeter.badgePulse"
	| "cacheMeter.invalidation"
	| "auditTrail.badge"
	| "auditTrail.badgePulse"
	| "auditTrail.status.poisoned"
	| "auditTrail.status.dirty"
	| "auditTrail.status.redundant"
	| "auditTrail.status.cold"
	| "auditTrail.status.fresh"
	| "rateLimitTidepool.water"
	| "rateLimitTidepool.waterShimmer"
	| "rateLimitTidepool.pebble"
	| "rateLimitTidepool.sand"
	| "reflectionRipple.ring.0"
	| "reflectionRipple.ring.1"
	| "reflectionRipple.ring.2"
	| "reflectionRipple.ring.3"
	| "reflectionRipple.ring.4";

/** The border ramp, the Animations Box's badge literals, and every row's own badge/status/ramp glyphs — the original hardcoded values, unchanged. */
const UNICODE_GLYPHS: Record<GlyphKey, string> = {
	"border.ramp.0": "·",
	"border.ramp.1": "─",
	"border.ramp.2": "━",
	"border.ramp.3": "█",
	"box.limits": "◗",
	"box.files": "▓",
	"box.reflect": "○",
	"box.dot.idle": "○",
	"box.dot.live": "●",
	"box.dot.notable": "◐",
	"box.dot.alert": "●",
	"box.bar.filled": "█",
	"box.bar.empty": "░",
	"box.bar.eighths.1": "▏",
	"box.bar.eighths.2": "▎",
	"box.bar.eighths.3": "▍",
	"box.bar.eighths.4": "▌",
	"box.bar.eighths.5": "▋",
	"box.bar.eighths.6": "▊",
	"box.bar.eighths.7": "▉",
	"cacheMeter.badge": "▤",
	"cacheMeter.badgePulse": "▥",
	"cacheMeter.invalidation": "⊘",
	"auditTrail.badge": "▣",
	"auditTrail.badgePulse": "▢",
	"auditTrail.status.poisoned": "⊘",
	"auditTrail.status.dirty": "✎\uFE0E", // U+270E + VS15: has emoji variant
	"auditTrail.status.redundant": "⟳",
	"auditTrail.status.cold": "❄\uFE0E", // U+2744 + VS15: default emoji presentation
	"auditTrail.status.fresh": "✓\uFE0E", // U+2713 + VS15: has emoji variant
	"rateLimitTidepool.water": "≈",
	"rateLimitTidepool.waterShimmer": "~",
	"rateLimitTidepool.pebble": "∘",
	"rateLimitTidepool.sand": "·",
	"reflectionRipple.ring.0": " ",
	"reflectionRipple.ring.1": "·",
	"reflectionRipple.ring.2": "∘",
	"reflectionRipple.ring.3": "○",
	"reflectionRipple.ring.4": "◉",
};

/**
 * One 7-bit-clean column per glyph — never a multi-char substitute (see module doc).
 * Two glyphs share an ascii column only when they either belong to different widgets
 * that never render together, or are already the identical unicode glyph upstream —
 * never two DISTINCT unicode glyphs a single widget renders side by side.
 *
 * `box.bar.filled`/`box.bar.empty` are the one deliberate exception to "never render
 * together": the Animations Box's cache/rate-limit rows draw their own badge glyph
 * (`cacheMeter.badge`/`box.limits`) immediately followed by a 10-cell bar built from
 * these two — same row, same frame, always. `box.bar.filled` reuses `"#"`
 * (`cacheMeter.badge`'s own ascii, and `border.ramp.3`'s "heaviest" ascii) on purpose:
 * a repeated, bracketed `[##########]` run reads unambiguously as a bar regardless of
 * which single character fills it, so it can't be mistaken for the single badge glyph
 * a few columns to its left — the distinctness concern this comment otherwise guards
 * against is about single-glyph slots that could be swapped for each other, not a
 * multi-cell bar shape against an icon.
 */
const ASCII_GLYPHS: Record<GlyphKey, string> = {
	"border.ramp.0": ".",
	"border.ramp.1": "-",
	"border.ramp.2": "=",
	"border.ramp.3": "#",
	"box.limits": ")",
	"box.files": "%",
	"box.reflect": "o",
	"box.dot.idle": ".",
	"box.dot.live": "*",
	"box.dot.notable": "!",
	"box.dot.alert": "!",
	"box.bar.filled": "#",
	"box.bar.empty": "-",
	"box.bar.eighths.1": "-",
	"box.bar.eighths.2": "-",
	"box.bar.eighths.3": "-",
	"box.bar.eighths.4": "-",
	"box.bar.eighths.5": "-",
	"box.bar.eighths.6": "-",
	"box.bar.eighths.7": "-",
	"cacheMeter.badge": "#",
	"cacheMeter.badgePulse": "*",
	"cacheMeter.invalidation": "x",
	"auditTrail.badge": "@",
	"auditTrail.badgePulse": "+",
	"auditTrail.status.poisoned": "x",
	"auditTrail.status.dirty": "/",
	"auditTrail.status.redundant": "~",
	"auditTrail.status.cold": "o",
	"auditTrail.status.fresh": "v",
	"rateLimitTidepool.water": "~",
	"rateLimitTidepool.waterShimmer": "-",
	"rateLimitTidepool.pebble": ".",
	"rateLimitTidepool.sand": ",",
	"reflectionRipple.ring.0": " ",
	"reflectionRipple.ring.1": ".",
	"reflectionRipple.ring.2": ",",
	"reflectionRipple.ring.3": "o",
	"reflectionRipple.ring.4": "@",
};

/** `nerd` is the SAME object as `unicode` (v1 alias, not a duplicated literal set — see module doc). */
const GLYPHS: Record<SymbolPreset, Record<GlyphKey, string>> = {
	unicode: UNICODE_GLYPHS,
	nerd: UNICODE_GLYPHS,
	ascii: ASCII_GLYPHS,
};

/** Resolve one glyph for the given preset. */
export function resolveGlyph(key: GlyphKey, preset: SymbolPreset): string {
	return GLYPHS[preset][key];
}

const BORDER_RAMP_KEYS = [
	"border.ramp.0",
	"border.ramp.1",
	"border.ramp.2",
	"border.ramp.3",
] as const satisfies readonly GlyphKey[];

/** The breathing border's dimmest-to-heaviest ramp, resolved for one preset — the `border.ramp.*` rows of the table above, in bucket order. */
export function resolveGlyphRamp(preset: SymbolPreset): readonly string[] {
	return BORDER_RAMP_KEYS.map(key => resolveGlyph(key, preset));
}

const RING_RAMP_KEYS = [
	"reflectionRipple.ring.0",
	"reflectionRipple.ring.1",
	"reflectionRipple.ring.2",
	"reflectionRipple.ring.3",
	"reflectionRipple.ring.4",
] as const satisfies readonly GlyphKey[];

/** Reflection Ripple's faintest-to-brightest ring ramp, resolved for one preset — feeds `reflection-ripple/ripple.ts`'s `ringGlyph` bucket lookup. */
export function resolveRingGlyphRamp(preset: SymbolPreset): readonly string[] {
	return RING_RAMP_KEYS.map(key => resolveGlyph(key, preset));
}
