/**
 * Terminal capability detection tests for styled underlines.
 * Verifies that supportsStyledUnderlines correctly identifies terminals.
 */
import { describe, expect, test } from "bun:test";
import type { RenderTier } from "../src/terminal-capabilities";
import { supportsStyledUnderlines } from "../src/terminal-capabilities";

describe("supportsStyledUnderlines", () => {
	const supportedPrograms: RenderTier["program"][] = ["ghostty", "kitty", "iterm", "wezterm"];
	const unsupportedPrograms: RenderTier["program"][] = ["other"];

	for (const program of supportedPrograms) {
		test(`returns true for ${program}`, () => {
			expect(supportsStyledUnderlines(program)).toBe(true);
		});
	}

	for (const program of unsupportedPrograms) {
		test(`returns false for ${program}`, () => {
			expect(supportsStyledUnderlines(program)).toBe(false);
		});
	}
});
