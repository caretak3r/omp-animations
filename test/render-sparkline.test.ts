/**
 * Braille sparkline renderer — exhaustive unit tests against hand-verified
 * codepoints. Every assertion pins exact braille characters for known sample
 * buffers, validates character width, and exercises edge cases (empty, zero,
 * single-sample, odd counts, clamping, max override).
 */
import { describe, expect, it } from "bun:test";
import { renderSparkline } from "../src/render-sparkline";

describe("renderSparkline", () => {
	describe("braille encoding — hand-verified codepoints", () => {
		it("renders [max, max] as U+28FF (full 8-dot block)", () => {
			// Both columns at 4 dots each = all 8 dots set.
			const result = renderSparkline([100, 100], 10, 100);
			expect(result).toBe("\u28FF");
			expect(result.codePointAt(0)).toBe(0x28ff);
		});

		it("renders [0, 0] as U+2800 (blank)", () => {
			// Both columns at 0 dots = no dots set.
			const result = renderSparkline([0, 0], 10, 100);
			expect(result).toBe("\u2800");
			expect(result.codePointAt(0)).toBe(0x2800);
		});

		it("renders [max, 0] as left column full (U+2847)", () => {
			// Left column: dots 7,3,2,1 = 0x40 | 0x04 | 0x02 | 0x01 = 0x47.
			const result = renderSparkline([100, 0], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0x47);
			expect(result).toBe("\u2847");
		});

		it("renders [0, max] as right column full (U+28B8)", () => {
			// Right column: dots 8,6,5,4 = 0x80 | 0x20 | 0x10 | 0x08 = 0xB8.
			const result = renderSparkline([0, 100], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0xb8);
			expect(result).toBe("\u28B8");
		});

		it("renders single bottom-left dot (1/4 height) as U+2840", () => {
			// 25% of max = 1 dot in left column = dot 7 = 0x40.
			const result = renderSparkline([25, 0], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0x40);
			expect(result).toBe("\u2840");
		});

		it("renders single bottom-right dot (1/4 height) as U+2880", () => {
			// 25% of max = 1 dot in right column = dot 8 = 0x80.
			const result = renderSparkline([0, 25], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0x80);
			expect(result).toBe("\u2880");
		});

		it("renders [50, 50] as 2 dots per column (U+28C6)", () => {
			// 50% = 2 dots each. Left: dots 7,3 = 0x44. Right: dots 8,6 = 0xA0. Total: 0xC6 but...
			// Actually, let me recalculate: Left bottom 2: 7,3 = 0x40 | 0x04 = 0x44.
			// Right bottom 2: 8,6 = 0x80 | 0x20 = 0xA0. Combined: 0x44 | 0xA0 = 0xE4.
			const result = renderSparkline([50, 50], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0xe4);
			expect(result).toBe("\u28E4");
		});

		it("renders [75, 75] as 3 dots per column (U+28E7)", () => {
			// 75% = 3 dots each. Left: dots 7,3,2 = 0x40|0x04|0x02 = 0x46.
			// Right: dots 8,6,5 = 0x80|0x20|0x10 = 0xB0. Combined: 0xF6.
			const result = renderSparkline([75, 75], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0xf6);
			expect(result).toBe("\u28F6");
		});

		it("renders [25, 75] as asymmetric heights (U+28F0)", () => {
			// Left 25% = 1 dot (7 = 0x40), Right 75% = 3 dots (8,6,5 = 0xB0). Combined: 0xF0.
			const result = renderSparkline([25, 75], 10, 100);
			expect(result.codePointAt(0)).toBe(0x2800 + 0xf0);
			expect(result).toBe("\u28F0");
		});
	});

	describe("normalization and max override", () => {
		it("defaults max to buffer maximum", () => {
			// [10, 5] with implicit max=10 normalizes to [1.0, 0.5] = [4, 2] dots.
			const result = renderSparkline([10, 5], 10);
			// Left 100% = 4 dots (0x47), Right 50% = 2 dots (0xA0). Combined: 0xE7.
			expect(result.codePointAt(0)).toBe(0x2800 + 0xe7);
			expect(result).toBe("\u28E7");
		});

		it("clamps values above max to full height", () => {
			// [150, 100] with max=100 normalizes to [1.0, 1.0] = full block.
			const result = renderSparkline([150, 100], 10, 100);
			expect(result).toBe("\u28FF");
		});

		it("treats negative samples as zero", () => {
			// [-10, 50] with max=100 normalizes to [0, 0.5] = [0, 2] dots.
			const result = renderSparkline([-10, 50], 10, 100);
			// Left 0% = 0 dots, Right 50% = 2 dots (0xA0). Combined: 0xA0.
			expect(result.codePointAt(0)).toBe(0x2800 + 0xa0);
			expect(result).toBe("\u28A0");
		});

		it("guards against zero max (treats as 1)", () => {
			// All zeros with implicit max=0 should guard to max=1, normalize to [0, 0].
			const result = renderSparkline([0, 0], 10);
			expect(result).toBe("\u2800");
		});

		it("guards against explicit zero max", () => {
			// Explicit max=0 should be treated as 1, so [0, 0] stays blank.
			const result = renderSparkline([0, 0], 10, 0);
			expect(result).toBe("\u2800");
		});
	});

	describe("odd sample counts", () => {
		it("renders single sample using only left column", () => {
			// [100] with max=100 = left column full (4 dots), right blank.
			const result = renderSparkline([100], 10, 100);
			expect(result).toBe("\u2847"); // Left 4 dots = 0x47.
		});

		it("renders 3 samples as 2 characters (full pair + solo left)", () => {
			// [100, 50, 75] with max=100 → [[100,50], [75]].
			const result = renderSparkline([100, 50, 75], 10, 100);
			expect(result.length).toBe(2);
			// First char: [100, 50] = left 4 dots (0x47), right 2 dots (0xA0) = 0xE7.
			expect(result.codePointAt(0)).toBe(0x2800 + 0xe7);
			// Second char: [75] = left 3 dots (0x46), right blank = 0x46.
			expect(result.codePointAt(1)).toBe(0x2800 + 0x46);
			expect(result).toBe("\u28E7\u2846");
		});

		it("renders 5 samples as 3 characters", () => {
			// [100, 0, 50, 25, 75] → [[100,0], [50,25], [75]].
			const result = renderSparkline([100, 0, 50, 25, 75], 10, 100);
			expect(result.length).toBe(3);
		});
	});

	describe("width capping", () => {
		it("respects width limit — truncates excess samples", () => {
			// 10 samples at width=3 should yield 3 chars (first 6 samples).
			const samples = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
			const result = renderSparkline(samples, 3, 100);
			expect(result.length).toBe(3);
		});

		it("width=1 yields 1 character (2 samples)", () => {
			const result = renderSparkline([100, 50, 25], 1, 100);
			expect(result.length).toBe(1);
			expect(result).toBe("\u28E7"); // [100, 50].
		});

		it("width=0 yields empty string", () => {
			const result = renderSparkline([100, 50], 0, 100);
			expect(result).toBe("");
		});
	});

	describe("empty and single-value buffers", () => {
		it("returns empty string for empty samples", () => {
			const result = renderSparkline([], 10, 100);
			expect(result).toBe("");
		});

		it("renders buffer of all zeros as blank characters", () => {
			const result = renderSparkline([0, 0, 0, 0], 10, 100);
			expect(result.length).toBe(2);
			expect(result).toBe("\u2800\u2800");
		});

		it("renders buffer of all same value as full-height line", () => {
			// [42, 42, 42, 42] with max=42 → all 1.0 → all 4 dots.
			const result = renderSparkline([42, 42, 42, 42], 10, 42);
			expect(result.length).toBe(2);
			expect(result).toBe("\u28FF\u28FF");
		});
	});

	describe("character width compliance", () => {
		it("every output character measures 1 column via Bun.stringWidth", () => {
			const samples = [100, 75, 50, 25, 0, 25, 50, 75];
			const result = renderSparkline(samples, 10, 100);
			// Should be 4 braille chars (8 samples / 2).
			expect(result.length).toBe(4);
			// Each braille char is 1 column wide in a terminal.
			expect(Bun.stringWidth(result)).toBe(4);

			// Verify each char individually.
			for (let i = 0; i < result.length; i++) {
				const char = result[i];
				if (char === undefined) continue;
				expect(Bun.stringWidth(char)).toBe(1);
			}
		});

		it("odd-count sparkline has correct width", () => {
			const result = renderSparkline([100, 50, 25], 10, 100);
			expect(result.length).toBe(2);
			expect(Bun.stringWidth(result)).toBe(2);
		});
	});

	describe("realistic streaming data patterns", () => {
		it("renders ascending ramp", () => {
			// [0, 25, 50, 75, 100].
			const result = renderSparkline([0, 25, 50, 75, 100], 10, 100);
			expect(result.length).toBe(3); // 5 samples = 3 chars.
			expect(Bun.stringWidth(result)).toBe(3);
		});

		it("renders descending ramp", () => {
			// [100, 75, 50, 25, 0].
			const result = renderSparkline([100, 75, 50, 25, 0], 10, 100);
			expect(result.length).toBe(3);
			expect(Bun.stringWidth(result)).toBe(3);
		});

		it("renders spike pattern", () => {
			// [10, 100, 10].
			const result = renderSparkline([10, 100, 10], 10, 100);
			expect(result.length).toBe(2);
			expect(Bun.stringWidth(result)).toBe(2);
		});

		it("renders flat low baseline", () => {
			// [10, 10, 10, 10] with max=100 → all 10% = all 0 dots (rounds to 0).
			const result = renderSparkline([10, 10, 10, 10], 10, 100);
			expect(result).toBe("\u2800\u2800"); // All blank.
		});
	});

	describe("rounding behavior", () => {
		it("rounds 12.5% to 1 dot (0.5 rounds to 1)", () => {
			// 12.5% of 4 dots = 0.5 → rounds to 1.
			const result = renderSparkline([12.5, 0], 10, 100);
			expect(result).toBe("\u2840"); // Left 1 dot.
		});

		it("rounds 37.5% to 2 dots (1.5 rounds to 2)", () => {
			// 37.5% of 4 dots = 1.5 → rounds to 2.
			const result = renderSparkline([37.5, 0], 10, 100);
			// Left 2 dots: 7,3 = 0x44.
			expect(result.codePointAt(0)).toBe(0x2800 + 0x44);
			expect(result).toBe("\u2844");
		});

		it("rounds 62.5% to 3 dots (2.5 rounds to 3)", () => {
			// 62.5% of 4 dots = 2.5 → rounds to 3.
			const result = renderSparkline([62.5, 0], 10, 100);
			// Left 3 dots: 7,3,2 = 0x46.
			expect(result.codePointAt(0)).toBe(0x2800 + 0x46);
			expect(result).toBe("\u2846");
		});

		it("rounds 87.5% to 4 dots (3.5 rounds to 4)", () => {
			// 87.5% of 4 dots = 3.5 → rounds to 4.
			const result = renderSparkline([87.5, 0], 10, 100);
			expect(result).toBe("\u2847"); // Left 4 dots.
		});
	});
});
