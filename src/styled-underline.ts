/**
 * Styled underline escape sequences — SGR 4:3 (curly) and 4:5 (dashed).
 *
 * Provides a colorblind-friendly SECOND semantic channel layered on top of
 * color for warning/error states. Curly underline = warning, dashed = error.
 * These never replace color; they augment it.
 *
 * Supported terminals: Kitty, Ghostty, iTerm2, WezTerm.
 * Unsupported terminals receive byte-identical output with no underline escapes.
 *
 * @module styled-underline
 */

import type { RenderTier } from "./terminal-capabilities";
import { supportsStyledUnderlines } from "./terminal-capabilities";

/** SGR sequence for curly underline (4:3). */
export const UNDERLINE_CURLY = "\x1b[4:3m";

/** SGR sequence for dashed underline (4:5). */
export const UNDERLINE_DASHED = "\x1b[4:5m";

/** SGR sequence to reset underline (4:0). Alternatively `\x1b[24m` works, but 4:0 is consistent with the styled forms. */
export const UNDERLINE_RESET = "\x1b[4:0m";

/**
 * Wrap text with a curly underline (warning semantic).
 * No-op when the terminal doesn't support styled underlines.
 *
 * @param text - Already-colored text (e.g., from `theme.fg("warning", "MISS 123")`).
 * @param program - Terminal program identifier (from {@link RenderTier}).
 * @returns The text wrapped with curly underline escapes, or unchanged if unsupported.
 */
export function curlyUnderline(text: string, program: RenderTier["program"]): string {
	return supportsStyledUnderlines(program) ? `${UNDERLINE_CURLY}${text}${UNDERLINE_RESET}` : text;
}

/**
 * Wrap text with a dashed underline (error semantic).
 * No-op when the terminal doesn't support styled underlines.
 *
 * @param text - Already-colored text (e.g., from `theme.fg("error", "invalidation")`).
 * @param program - Terminal program identifier (from {@link RenderTier}).
 * @returns The text wrapped with dashed underline escapes, or unchanged if unsupported.
 */
export function dashedUnderline(text: string, program: RenderTier["program"]): string {
	return supportsStyledUnderlines(program) ? `${UNDERLINE_DASHED}${text}${UNDERLINE_RESET}` : text;
}
