/**
 * Verify that styled underlines gate correctly and don't leak ANSI escapes
 * into plain-text output when terminal is unsupported or disabled.
 */
import { describe, expect, test } from "bun:test";

// We can't easily test the module-level TERMINAL_PROGRAM constant without
// dependency injection, but we CAN verify that dashedUnderline respects
// the program parameter and returns plain text for "other".

import { dashedUnderline } from "../src/styled-underline";

// Identity theme strips color codes - same as goldens test
const idTheme = { fg: (_color: string, text: string) => text };

describe("styled underline escapes don't leak into plain output", () => {
	test("dashedUnderline on 'other' terminal returns text unchanged", () => {
		const plainText = "error text";
		const coloredText = idTheme.fg("error", plainText);
		const result = dashedUnderline(coloredText, "other");

		// Should be byte-identical to input
		expect(result).toBe(coloredText);
		expect(result).toBe(plainText); // Since idTheme strips color
		expect(result).not.toContain("\x1b"); // No ANSI escapes
	});

	test("dashedUnderline on supported terminal adds escapes", () => {
		const plainText = "error text";
		const result = dashedUnderline(plainText, "kitty");

		// Should have underline escapes
		expect(result).toContain("\x1b[4:5m"); // Dashed underline
		expect(result).toContain("\x1b[4:0m"); // Reset
		expect(result).toContain(plainText); // Original text preserved
	});

	test("gated output is byte-identical to ungated when unsupported", () => {
		const text = "test";

		// Ungated (no underline wrapper)
		const ungated = text;

		// Gated with unsupported terminal
		const gated = dashedUnderline(text, "other");

		// Must be byte-identical
		expect(gated).toBe(ungated);
	});
});
