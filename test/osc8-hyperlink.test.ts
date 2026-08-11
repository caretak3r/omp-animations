/**
 * OSC-8 hyperlink escape sequences and capability detection tests.
 * Verifies exact OSC-8 bytes, zero-width behavior, and terminal-gated wrapping.
 */
import { describe, expect, test } from "bun:test";
import { hyperlink, hyperlinkPath, supportsHyperlinks } from "../src/osc8-hyperlink";
import type { RenderTier } from "../src/terminal-capabilities";

describe("supportsHyperlinks", () => {
	const supportedTerminals: RenderTier["program"][] = ["ghostty", "kitty", "iterm", "wezterm"];
	const unsupportedTerminals: RenderTier["program"][] = ["other"];

	for (const program of supportedTerminals) {
		test(`returns true for ${program}`, () => {
			expect(supportsHyperlinks(program)).toBe(true);
		});
	}

	for (const program of unsupportedTerminals) {
		test(`returns false for ${program}`, () => {
			expect(supportsHyperlinks(program)).toBe(false);
		});
	}
});

describe("hyperlink", () => {
	const supportedProgram: RenderTier["program"] = "kitty";
	const unsupportedProgram: RenderTier["program"] = "other";

	test("wraps text with OSC-8 sequences using ST terminator", () => {
		const result = hyperlink("example", "https://example.com", supportedProgram);
		expect(result).toBe("\x1b]8;;https://example.com\x1b\\example\x1b]8;;\x1b\\");
	});

	test("uses correct OSC-8 format with empty params field", () => {
		const result = hyperlink("text", "file:///path", supportedProgram);
		// Format: OSC 8 ; params ; URI ST text OSC 8 ; ; ST
		// params should be empty (no id/tooltip)
		expect(result).toMatch(/^\x1b]8;;file:\/\/\/path\x1b\\text\x1b]8;;\x1b\\$/);
	});

	test("returns text unchanged for unsupported terminal", () => {
		const result = hyperlink("example", "https://example.com", unsupportedProgram);
		expect(result).toBe("example");
	});

	test("returns text unchanged when URI is empty", () => {
		const result = hyperlink("example", "", supportedProgram);
		expect(result).toBe("example");
	});

	test("wraps already-colored text preserving ANSI escapes", () => {
		const coloredText = "\x1b[38;2;255;100;50mexample\x1b[0m";
		const result = hyperlink(coloredText, "https://example.com", supportedProgram);
		expect(result).toBe(`\x1b]8;;https://example.com\x1b\\${coloredText}\x1b]8;;\x1b\\`);
	});

	test("handles file:// URIs", () => {
		const result = hyperlink("main.ts", "file:///Users/dev/project/src/main.ts", supportedProgram);
		expect(result).toBe("\x1b]8;;file:///Users/dev/project/src/main.ts\x1b\\main.ts\x1b]8;;\x1b\\");
	});

	test("handles web URLs", () => {
		const result = hyperlink("docs", "https://docs.example.com/guide", supportedProgram);
		expect(result).toBe("\x1b]8;;https://docs.example.com/guide\x1b\\docs\x1b]8;;\x1b\\");
	});

	test("zero-width guarantee: String.prototype.length includes escapes but terminals ignore them", () => {
		const plain = "example";
		const wrapped = hyperlink(plain, "https://example.com", supportedProgram);

		// String.prototype.length counts the escape bytes
		expect(wrapped.length).toBeGreaterThan(plain.length);

		// But the visible width is unchanged (terminals don't render OSC sequences)
		// This is the same behavior as ANSI color codes - they count in .length
		// but contribute zero to visual width
		const escapePrefix = "\x1b]8;;https://example.com\x1b\\";
		const escapeSuffix = "\x1b]8;;\x1b\\";
		expect(wrapped).toBe(`${escapePrefix}${plain}${escapeSuffix}`);
		expect(wrapped.length).toBe(escapePrefix.length + plain.length + escapeSuffix.length);
	});
});

describe("hyperlinkPath", () => {
	const supportedProgram: RenderTier["program"] = "kitty";
	const unsupportedProgram: RenderTier["program"] = "other";

	test("wraps absolute path with file:// URI", () => {
		const result = hyperlinkPath("main.ts", "/Users/dev/project/src/main.ts", supportedProgram);
		expect(result).toBe("\x1b]8;;file:///Users/dev/project/src/main.ts\x1b\\main.ts\x1b]8;;\x1b\\");
	});

	test("returns text unchanged for relative path", () => {
		const result = hyperlinkPath("src/main.ts", "src/main.ts", supportedProgram);
		expect(result).toBe("src/main.ts");
	});

	test("returns text unchanged for empty path", () => {
		const result = hyperlinkPath("text", "", supportedProgram);
		expect(result).toBe("text");
	});

	test("returns text unchanged for unsupported terminal even with absolute path", () => {
		const result = hyperlinkPath("main.ts", "/Users/dev/project/src/main.ts", unsupportedProgram);
		expect(result).toBe("main.ts");
	});

	test("handles display text different from full path (elided paths)", () => {
		const displayText = "…ct/src/main.ts";
		const fullPath = "/Users/dev/project/src/main.ts";
		const result = hyperlinkPath(displayText, fullPath, supportedProgram);
		expect(result).toBe(`\x1b]8;;file://${fullPath}\x1b\\${displayText}\x1b]8;;\x1b\\`);
	});

	test("handles already-colored path text", () => {
		const coloredPath = "\x1b[38;2;255;100;50m/src/main.ts\x1b[0m";
		const fullPath = "/Users/dev/project/src/main.ts";
		const result = hyperlinkPath(coloredPath, fullPath, supportedProgram);
		expect(result).toBe(`\x1b]8;;file://${fullPath}\x1b\\${coloredPath}\x1b]8;;\x1b\\`);
	});

	test("works with padded path text", () => {
		// Simulating padRight behavior from audit-trail-box
		const paddedPath = "/src/main.ts            ";
		const fullPath = "/Users/dev/project/src/main.ts";
		const result = hyperlinkPath(paddedPath, fullPath, supportedProgram);
		expect(result).toBe(`\x1b]8;;file://${fullPath}\x1b\\${paddedPath}\x1b]8;;\x1b\\`);
	});

	test("relative path detection works correctly", () => {
		// Various relative path forms should NOT be wrapped
		expect(hyperlinkPath("text", "./relative", supportedProgram)).toBe("text");
		expect(hyperlinkPath("text", "../parent", supportedProgram)).toBe("text");
		expect(hyperlinkPath("text", "relative/path", supportedProgram)).toBe("text");
	});

	test("absolute path detection works correctly", () => {
		// Unix absolute paths
		const unixResult = hyperlinkPath("text", "/absolute/path", supportedProgram);
		expect(unixResult).toContain("file:///absolute/path");

		// The result should be wrapped
		expect(unixResult).toMatch(/^\x1b]8;;file:\/\//);
		expect(unixResult).toMatch(/\x1b]8;;\x1b\\$/);
	});
});

describe("OSC-8 hyperlink gating", () => {
	test("supported terminal + absolute path = wrapped", () => {
		const result = hyperlinkPath("text", "/path/to/file", "kitty");
		expect(result).toContain("\x1b]8;;");
	});

	test("supported terminal + relative path = unwrapped", () => {
		const result = hyperlinkPath("text", "relative/path", "kitty");
		expect(result).toBe("text");
	});

	test("unsupported terminal + absolute path = unwrapped", () => {
		const result = hyperlinkPath("text", "/path/to/file", "other");
		expect(result).toBe("text");
	});

	test("unsupported terminal + relative path = unwrapped", () => {
		const result = hyperlinkPath("text", "relative/path", "other");
		expect(result).toBe("text");
	});

	test("supported terminal + empty URI = unwrapped", () => {
		const result = hyperlink("text", "", "kitty");
		expect(result).toBe("text");
	});
});
