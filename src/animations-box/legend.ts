/**
 * Animations Box — legend overlay.
 *
 * On-demand explainer for detailed mode's status-line grammar: the fixed
 * semantic-dot table, required summaries in canonical order, then optional
 * animations in deterministic toggle order. The two composition groups come
 * from the same registries as the controller and remain visually distinct.
 */
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveGlyph } from "../glyph-presets";
import { OPTIONAL_SEGMENT_REGISTRY, REQUIRED_SEGMENT_REGISTRY } from "./segments";
import { DOT_GLYPH_KEY, type StatusDot } from "./status-line";

/** D2's fixed dot vocabulary in escalation order, with the legend's one-line meanings. */
const DOT_MEANINGS: readonly { readonly dot: StatusDot; readonly meaning: string }[] = [
	{ dot: "idle", meaning: "idle — nothing yet, or metric not available here" },
	{ dot: "live", meaning: "live — healthy" },
	{ dot: "notable", meaning: "notable — worth a glance" },
	{ dot: "alert", meaning: "alert — act" },
];

/**
 * Render the legend: dot vocabulary, required summaries, then optional
 * animations. Blank lines mirror the composition boundaries.
 */
export function renderLegend(preset: SymbolPreset = "unicode"): readonly string[] {
	const dots = DOT_MEANINGS.map(({ dot, meaning }) => `${resolveGlyph(DOT_GLYPH_KEY[dot], preset)} ${meaning}`);
	const required = REQUIRED_SEGMENT_REGISTRY.map(segment => `${segment.label} — ${segment.description}`);
	const optional = OPTIONAL_SEGMENT_REGISTRY.map(segment => `${segment.label} — ${segment.description}`);
	return [...dots, "", ...required, "", ...optional];
}
