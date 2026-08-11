/**
 * Terminal symbol-preset-aware glyph lookup for this plugin's keeper segments.
 *
 * Mirrors the host's own three-tier symbol preset system (`unicode`/`nerd`/`ascii`,
 * default `unicode`, read at runtime via `ExtensionContext.ui.theme.getSymbolPreset()`)
 * instead of the hardcoded Unicode literals scattered across this package's keepers.
 * `unicode` values are byte-identical to what shipped before this module existed — zero
 * visual regression for the default, live-in-production posture. `nerd` aliases
 * `unicode` exactly for v1: none of these glyphs were ever true Nerd Font private-use
 * characters, so plain Unicode already renders fine on nerd-font-configured terminals —
 * no fake "nerd-exclusive" upgrade is invented here. `ascii` substitutes exactly one
 * 7-bit column per glyph, never a multi-char string — the box widget's width is an
 * asserted golden-test surface a wider substitute would break.
 *
 * `GlyphKey` is a flat, extensible union backed by a `Record<SymbolPreset,
 * Record<GlyphKey, string>>` table. Extend by adding more union members and table rows
 * — never restructure the shape (Phase 2 builds on this for the other keepers).
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
	| "toolConstellation.star.0"
	| "toolConstellation.star.1"
	| "toolConstellation.star.2"
	| "toolConstellation.star.3"
	| "toolConstellation.comet"
	| "toolConstellation.empty"
	| "toolConstellation.category.read"
	| "toolConstellation.category.write"
	| "toolConstellation.category.bash"
	| "toolConstellation.category.search"
	| "toolConstellation.category.agent"
	| "toolConstellation.category.mcp"
	| "toolConstellation.category.other"
	| "rateLimitTidepool.water"
	| "rateLimitTidepool.waterShimmer"
	| "rateLimitTidepool.pebble"
	| "rateLimitTidepool.sand"
	| "reflectionRipple.ring.0"
	| "reflectionRipple.ring.1"
	| "reflectionRipple.ring.2"
	| "reflectionRipple.ring.3"
	| "reflectionRipple.ring.4";

/** Breathing border's `GLYPH_RAMP`, the Animations Box's badge literals, and every other keeper's own badge/status/ramp glyphs — the original hardcoded values, unchanged. */
const UNICODE_GLYPHS: Record<GlyphKey, string> = {
	"border.ramp.0": "·",
	"border.ramp.1": "─",
	"border.ramp.2": "━",
	"border.ramp.3": "█",
	"box.limits": "◗",
	"box.files": "▓",
	"box.reflect": "○",
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
	"toolConstellation.star.0": "·",
	"toolConstellation.star.1": "•",
	"toolConstellation.star.2": "✦\uFE0E", // U+2726 + VS15: has emoji variant
	"toolConstellation.star.3": "✹\uFE0E", // U+2739 + VS15: has emoji variant
	"toolConstellation.comet": "☄\uFE0E", // U+2604 + VS15: default emoji presentation
	"toolConstellation.empty": "·",
	"toolConstellation.category.read": "⛏\uFE0E", // U+26CF + VS15: default emoji presentation
	"toolConstellation.category.write": "✎\uFE0E", // U+270E + VS15: has emoji variant
	"toolConstellation.category.bash": "↯",
	"toolConstellation.category.search": "◈",
	"toolConstellation.category.agent": "◆",
	"toolConstellation.category.mcp": "⬡",
	"toolConstellation.category.other": "∘",
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
 * that never render together, or are already the identical unicode glyph upstream
 * (`toolConstellation.empty`/`star.0` are both literally `"·"` today) — never two
 * DISTINCT unicode glyphs a single widget renders side by side.
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
	"toolConstellation.star.0": ".",
	"toolConstellation.star.1": ",",
	"toolConstellation.star.2": "*",
	"toolConstellation.star.3": "#",
	"toolConstellation.comet": "@",
	"toolConstellation.empty": ".",
	"toolConstellation.category.read": "^",
	"toolConstellation.category.write": "/",
	"toolConstellation.category.bash": "!",
	"toolConstellation.category.search": "<",
	"toolConstellation.category.agent": "#",
	"toolConstellation.category.mcp": "o",
	"toolConstellation.category.other": ".",
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

/** The breathing border's dimmest-to-heaviest ramp, resolved for one preset — feeds `breathing-border/breath.ts`'s `brightnessGlyph` bucket lookup. */
export function resolveGlyphRamp(preset: SymbolPreset): readonly string[] {
	return BORDER_RAMP_KEYS.map(key => resolveGlyph(key, preset));
}

const STAR_RAMP_KEYS = [
	"toolConstellation.star.0",
	"toolConstellation.star.1",
	"toolConstellation.star.2",
	"toolConstellation.star.3",
] as const satisfies readonly GlyphKey[];

/** Tool Constellation's dimmest-to-brightest star ramp (excludes the comet-head glyph), resolved for one preset — feeds `tool-constellation/sky.ts`'s `starGlyph` bucket lookup. */
export function resolveStarGlyphRamp(preset: SymbolPreset): readonly string[] {
	return STAR_RAMP_KEYS.map(key => resolveGlyph(key, preset));
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
