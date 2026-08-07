import type { SymbolPreset, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { resolveGlyph } from "../glyph-presets";

/**
 * Coarse grouping of tool names into the six star colors the constellation
 * palette calls for. `mcp` is detected by the `mcp__` bridge prefix (see
 * `mcp/tool-bridge.ts`); everything else falls through {@link normalizeToolName}
 * so legacy aliases (`search` -> `grep`, `find` -> `glob`) land in the right bucket.
 */
export type ToolCategory = "read" | "write" | "bash" | "search" | "agent" | "mcp" | "other";

/** Stable classification of a raw tool name into a {@link ToolCategory}. Pure. */
export function categorizeTool(toolName: string): ToolCategory {
	if (toolName.startsWith("mcp__")) return "mcp";
	switch (normalizeToolName(toolName)) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "write";
		case "bash":
			return "bash";
		case "grep":
		case "glob":
			return "search";
		case "task":
			return "agent";
		default:
			return "other";
	}
}

/**
 * Semantic theme tokens standing in for the bead's palette (Read=cyan,
 * Edit/Write=amber, Bash=green, Grep/Glob=violet, Agent=magenta, MCP=teal) —
 * chosen from the existing {@link ThemeColor} set rather than inventing new
 * raw ANSI colors.
 */
export const CATEGORY_THEME_COLOR: Readonly<Record<ToolCategory, ThemeColor>> = {
	read: "syntaxVariable",
	write: "syntaxFunction",
	bash: "toolDiffAdded",
	search: "syntaxKeyword",
	agent: "accent",
	mcp: "syntaxType",
	other: "muted",
};

/**
 * Narrow single-column glyph per category for the motion-`off` static tally line,
 * resolved for `preset` via `../glyph-presets.ts`. Defaults to `"unicode"` — the
 * original hardcoded values. Every unicode value here measures `visibleWidth` 1
 * (`@oh-my-pi/pi-tui`) — `bash` uses `↯` rather than `⚡` (U+26A1, East_Asian_Width
 * `W`, 2 cells) to keep that invariant true.
 */
export function categoryIcon(preset: SymbolPreset = "unicode"): Readonly<Record<ToolCategory, string>> {
	return {
		read: resolveGlyph("toolConstellation.category.read", preset),
		write: resolveGlyph("toolConstellation.category.write", preset),
		bash: resolveGlyph("toolConstellation.category.bash", preset),
		search: resolveGlyph("toolConstellation.category.search", preset),
		agent: resolveGlyph("toolConstellation.category.agent", preset),
		mcp: resolveGlyph("toolConstellation.category.mcp", preset),
		other: resolveGlyph("toolConstellation.category.other", preset),
	};
}

/** Display order used for the static tally and any category iteration that must be deterministic. */
export const CATEGORY_ORDER: readonly ToolCategory[] = ["read", "write", "bash", "search", "agent", "mcp", "other"];
