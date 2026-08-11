/**
 * Animations Box — legend overlay.
 *
 * On-demand listing that renders one line per registered segment with its
 * glyph (resolved from the active preset), label, and description — built
 * FROM the live {@link SEGMENT_REGISTRY}, never a hand-duplicated list.
 */
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveGlyph } from "../glyph-presets";
import { SEGMENT_REGISTRY } from "./segments";

/**
 * Render the legend: one line per registered segment in priority order.
 * Each line shows: `{glyph} {label} — {description}`.
 *
 * @param preset - Symbol preset to resolve glyphs with
 * @returns Array of legend lines, one per segment
 */
export function renderLegend(preset: SymbolPreset = "unicode"): readonly string[] {
	return SEGMENT_REGISTRY.map(segment => {
		const glyph = resolveGlyph(segment.glyphKey, preset);
		return `${glyph} ${segment.label} — ${segment.description}`;
	});
}
