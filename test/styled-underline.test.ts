/**
 * Styled underline escape sequences and capability detection tests.
 * Verifies exact SGR bytes and terminal-gated behavior.
 */
import { describe, expect, test } from "bun:test";
import {
	curlyUnderline,
	dashedUnderline,
	UNDERLINE_CURLY,
	UNDERLINE_DASHED,
	UNDERLINE_RESET,
} from "../src/styled-underline";
import type { RenderTier } from "../src/terminal-capabilities";

describe("styled-underline constants", () => {
	test("UNDERLINE_CURLY is SGR 4:3", () => {
		expect(UNDERLINE_CURLY).toBe("\x1b[4:3m");
	});

	test("UNDERLINE_DASHED is SGR 4:5", () => {
		expect(UNDERLINE_DASHED).toBe("\x1b[4:5m");
	});

	test("UNDERLINE_RESET is SGR 4:0", () => {
		expect(UNDERLINE_RESET).toBe("\x1b[4:0m");
	});
});

describe("curlyUnderline", () => {
	const supportedTerminals: RenderTier["program"][] = ["ghostty", "kitty", "iterm", "wezterm"];
	const unsupportedTerminals: RenderTier["program"][] = ["other"];

	for (const program of supportedTerminals) {
		test(`wraps text with curly underline on ${program}`, () => {
			const input = "warning text";
			const result = curlyUnderline(input, program);
			expect(result).toBe("\x1b[4:3mwarning text\x1b[4:0m");
		});
	}

	for (const program of unsupportedTerminals) {
		test(`returns text unchanged on ${program}`, () => {
			const input = "warning text";
			const result = curlyUnderline(input, program);
			expect(result).toBe(input);
		});
	}

	test("wraps already-colored text preserving ANSI escapes", () => {
		const coloredText = "\x1b[33mwarning\x1b[0m";
		const result = curlyUnderline(coloredText, "kitty");
		expect(result).toBe("\x1b[4:3m\x1b[33mwarning\x1b[0m\x1b[4:0m");
	});
});

describe("dashedUnderline", () => {
	const supportedTerminals: RenderTier["program"][] = ["ghostty", "kitty", "iterm", "wezterm"];
	const unsupportedTerminals: RenderTier["program"][] = ["other"];

	for (const program of supportedTerminals) {
		test(`wraps text with dashed underline on ${program}`, () => {
			const input = "error text";
			const result = dashedUnderline(input, program);
			expect(result).toBe("\x1b[4:5merror text\x1b[4:0m");
		});
	}

	for (const program of unsupportedTerminals) {
		test(`returns text unchanged on ${program}`, () => {
			const input = "error text";
			const result = dashedUnderline(input, program);
			expect(result).toBe(input);
		});
	}

	test("wraps already-colored text preserving ANSI escapes", () => {
		const coloredText = "\x1b[31merror\x1b[0m";
		const result = dashedUnderline(coloredText, "ghostty");
		expect(result).toBe("\x1b[4:5m\x1b[31merror\x1b[0m\x1b[4:0m");
	});
});

describe("styled underline gating", () => {
	test("unsupported terminal produces byte-identical output", () => {
		const plainText = "text";
		const coloredText = "\x1b[33mtext\x1b[0m";

		expect(curlyUnderline(plainText, "other")).toBe(plainText);
		expect(dashedUnderline(plainText, "other")).toBe(plainText);
		expect(curlyUnderline(coloredText, "other")).toBe(coloredText);
		expect(dashedUnderline(coloredText, "other")).toBe(coloredText);
	});

	test("supported terminal adds exactly underline escapes, no other changes", () => {
		const text = "test";
		const curly = curlyUnderline(text, "kitty");
		const dashed = dashedUnderline(text, "kitty");

		// Should only add prefix and suffix, no content modification
		expect(curly).toBe(`${UNDERLINE_CURLY}${text}${UNDERLINE_RESET}`);
		expect(dashed).toBe(`${UNDERLINE_DASHED}${text}${UNDERLINE_RESET}`);
	});
});
