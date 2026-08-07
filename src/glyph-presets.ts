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
	| "box.reflect";

/** Breathing border's `GLYPH_RAMP`, dimmest to heaviest, plus the Animations Box's badge literals — the original hardcoded values, unchanged. */
const UNICODE_GLYPHS: Record<GlyphKey, string> = {
	"border.ramp.0": "·",
	"border.ramp.1": "─",
	"border.ramp.2": "━",
	"border.ramp.3": "█",
	"box.limits": "◗",
	"box.files": "▓",
	"box.reflect": "○",
};

/** One 7-bit-clean column per glyph — never a multi-char substitute (see module doc). */
const ASCII_GLYPHS: Record<GlyphKey, string> = {
	"border.ramp.0": ".",
	"border.ramp.1": "-",
	"border.ramp.2": "=",
	"border.ramp.3": "#",
	"box.limits": ")",
	"box.files": "%",
	"box.reflect": "o",
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
