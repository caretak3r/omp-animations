/**
 * Animations Box — legend overlay.
 *
 * On-demand explainer for detailed mode's status-line grammar (Plan 018 D8):
 * D2's four-row semantic dot table, then one line per DEFAULT-VISIBLE segment
 * with its label and description. Both halves derive from live sources — the
 * renderer's own {@link DOT_GLYPH_KEY} and {@link SEGMENT_REGISTRY} filtered
 * through the D7 visibility map — never a hand-duplicated list.
 */
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveGlyph } from "../glyph-presets";
import { SEGMENT_REGISTRY } from "./segments";
import { BOX_SEGMENT_DEFAULT_VISIBLE } from "./settings";
import { DOT_GLYPH_KEY, type StatusDot } from "./status-line";

/** D2's fixed dot vocabulary in escalation order, with the legend's one-line meanings. */
const DOT_MEANINGS: readonly { readonly dot: StatusDot; readonly meaning: string }[] = [
	{ dot: "idle", meaning: "idle — nothing yet, or metric not available here" },
	{ dot: "live", meaning: "live — healthy" },
	{ dot: "notable", meaning: "notable — worth a glance" },
	{ dot: "alert", meaning: "alert — act" },
];

/**
 * Render the legend: the four dot rows, a blank separator, then one
 * `label — description` line per default-visible segment in priority order.
 *
 * @param preset - Symbol preset to resolve the dot glyphs with
 * @returns Array of legend lines
 */
export function renderLegend(preset: SymbolPreset = "unicode"): readonly string[] {
	const dots = DOT_MEANINGS.map(({ dot, meaning }) => `${resolveGlyph(DOT_GLYPH_KEY[dot], preset)} ${meaning}`);
	const rows = SEGMENT_REGISTRY.filter(segment => BOX_SEGMENT_DEFAULT_VISIBLE[segment.id]).map(
		segment => `${segment.label} — ${segment.description}`,
	);
	return [...dots, "", ...rows];
}
