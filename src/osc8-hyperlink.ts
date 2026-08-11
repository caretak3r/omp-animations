/**
 * OSC-8 hyperlink escape sequences for clickable file paths and URIs.
 *
 * Wraps text with invisible OSC-8 sequences that make it clickable in
 * supporting terminals. The wrapped text remains visually identical —
 * zero width impact, zero color change — just gains click behavior.
 *
 * Supported terminals: Kitty, Ghostty, iTerm2, WezTerm, VS Code.
 * Unsupported terminals receive byte-identical output with no hyperlink escapes.
 *
 * @module osc8-hyperlink
 */

import { isAbsolute } from "node:path";
import type { RenderTier } from "./terminal-capabilities";

/**
 * Whether the terminal supports OSC-8 hyperlinks.
 * Same terminal set as styled underlines — the modern feature-complete terminals.
 *
 * @param program - Terminal program identifier (from {@link RenderTier}).
 * @returns true if OSC-8 hyperlinks are supported.
 */
export function supportsHyperlinks(program: RenderTier["program"]): boolean {
	return program === "ghostty" || program === "kitty" || program === "iterm" || program === "wezterm";
}

/**
 * Wrap text with an OSC-8 hyperlink to the given URI.
 * No-op when the terminal doesn't support hyperlinks or the URI is empty/relative.
 *
 * OSC-8 format: `\x1b]8;;URI\x1b\\TEXT\x1b]8;;\x1b\\`
 * Uses ST (`\x1b\\`) terminator, not BEL, matching the repo's OSC 11 precedent.
 *
 * Zero-width guarantee: The OSC-8 sequences contribute zero to visual width,
 * just like ANSI color codes. String.prototype.length counts the escape bytes,
 * but terminals don't render them — layout/column math stays correct.
 *
 * @param text - Already-colored text (e.g., from `theme.fg("accent", "/path/to/file")`).
 * @param uri - Target URI (e.g., `file:///absolute/path` or `https://example.com`).
 * @param program - Terminal program identifier (from {@link RenderTier}).
 * @returns The text wrapped with OSC-8 hyperlink escapes, or unchanged if unsupported/invalid.
 *
 * @example
 * ```ts
 * // File path hyperlink (only if absolute)
 * hyperlink("/src/main.ts", "file:///Users/dev/project/src/main.ts", tier.program)
 * // → "\x1b]8;;file:///Users/dev/project/src/main.ts\x1b\\/src/main.ts\x1b]8;;\x1b\\"
 *
 * // Web URL
 * hyperlink("docs", "https://example.com/docs", tier.program)
 * // → "\x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\"
 *
 * // Unsupported terminal or empty URI → passthrough
 * hyperlink("text", "", tier.program) // → "text"
 * ```
 */
export function hyperlink(text: string, uri: string, program: RenderTier["program"]): string {
	// Skip if terminal doesn't support hyperlinks or URI is empty
	if (!supportsHyperlinks(program) || uri.length === 0) {
		return text;
	}

	// OSC-8 format: OSC 8 ; params ; URI ST text OSC 8 ; ; ST
	// params are empty (no id/tooltip), just the URI
	return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Wrap a file path with an OSC-8 file:// hyperlink.
 * Only wraps absolute paths; relative paths return unchanged.
 *
 * @param text - Display text (typically the path itself, possibly elided).
 * @param fullPath - The full path to link to. Must be absolute or wrapping is skipped.
 * @param program - Terminal program identifier (from {@link RenderTier}).
 * @returns The text wrapped with a file:// hyperlink, or unchanged if path is relative/unsupported.
 *
 * @example
 * ```ts
 * // Absolute path → wrapped
 * hyperlinkPath("/src/main.ts", "/Users/dev/project/src/main.ts", tier.program)
 * // → "\x1b]8;;file:///Users/dev/project/src/main.ts\x1b\\/src/main.ts\x1b]8;;\x1b\\"
 *
 * // Relative path → passthrough
 * hyperlinkPath("src/main.ts", "src/main.ts", tier.program)
 * // → "src/main.ts"
 * ```
 */
export function hyperlinkPath(text: string, fullPath: string, program: RenderTier["program"]): string {
	// Only wrap absolute paths — relative paths have no stable file:// URI
	if (!isAbsolute(fullPath)) {
		return text;
	}

	return hyperlink(text, `file://${fullPath}`, program);
}
