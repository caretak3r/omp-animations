/**
 * Animations Box — legend overlay.
 *
 * On-demand explainer for detailed mode's status-line grammar: the fixed
 * semantic-dot table and Audit Box summaries in canonical row order.
 */

import { resolveGlyph } from "../glyph-presets";
import type { SymbolPreset } from "../host/types";
import { SEGMENT_REGISTRY } from "./segments";
import { DOT_GLYPH_KEY, type StatusDot } from "./status-line";

/** D2's fixed dot vocabulary in escalation order, with the legend's one-line meanings. */
const DOT_MEANINGS: readonly { readonly dot: StatusDot; readonly meaning: string }[] = [
	{ dot: "idle", meaning: "idle — nothing yet, or metric not available here" },
	{ dot: "live", meaning: "live — healthy" },
	{ dot: "notable", meaning: "notable — worth a glance" },
	{ dot: "alert", meaning: "alert — act" },
];

/** Render the dot vocabulary and Audit Box summaries, separated by one blank line. */
export function renderLegend(preset: SymbolPreset = "unicode"): readonly string[] {
	const dots = DOT_MEANINGS.map(({ dot, meaning }) => `${resolveGlyph(DOT_GLYPH_KEY[dot], preset)} ${meaning}`);
	const summaries = SEGMENT_REGISTRY.map(segment => `${segment.label} — ${segment.description}`);
	return [...dots, "", ...summaries];
}
