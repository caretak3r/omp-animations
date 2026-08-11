import { describe, expect, it } from "bun:test";
import type { ProgressBarTheme } from "../src/progress-bar";
import { PROGRESS_BAR_CELLS, progressBarFilledCells, renderProgressBar } from "../src/progress-bar";
import type { RenderTier } from "../src/terminal-capabilities";

const idTheme: ProgressBarTheme = {
	fg: (_color, text) => text,
	getColorHex: color => {
		if (color === "error") return "#ff0000";
		if (color === "warning") return "#ffff00";
		if (color === "success") return "#00ff00";
		return "#ffffff";
	},
};
const taggedTheme: ProgressBarTheme = {
	fg: (color, text) => `${color}:${text}`,
	getColorHex: color => {
		if (color === "error") return "#ff0000";
		if (color === "warning") return "#ffff00";
		if (color === "success") return "#00ff00";
		return "#ffffff";
	},
};

describe("progressBarFilledCells", () => {
	it("rounds to the nearest cell across the full range", () => {
		expect(progressBarFilledCells(0)).toBe(0);
		expect(progressBarFilledCells(1)).toBe(PROGRESS_BAR_CELLS);
		expect(progressBarFilledCells(0.5)).toBe(5);
		expect(progressBarFilledCells(0.79)).toBe(8);
	});

	it("clamps out-of-range and non-finite ratios", () => {
		expect(progressBarFilledCells(-1)).toBe(0);
		expect(progressBarFilledCells(1.5)).toBe(PROGRESS_BAR_CELLS);
		expect(progressBarFilledCells(Number.NaN)).toBe(0);
		expect(progressBarFilledCells(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("renderProgressBar", () => {
	it("draws an empty bracketed bar at ratio 0, unicode preset", () => {
		expect(renderProgressBar(0, idTheme, "accent")).toBe(`[${"░".repeat(10)}]`);
	});

	it("draws a full bracketed bar at ratio 1, unicode preset", () => {
		expect(renderProgressBar(1, idTheme, "accent")).toBe(`[${"█".repeat(10)}]`);
	});

	it("splits filled/empty cells proportionally at a mid ratio", () => {
		expect(renderProgressBar(0.7, idTheme, "accent")).toBe(`[${"█".repeat(7)}${"░".repeat(3)}]`);
	});

	it("colors filled cells with filledColor and empty cells with emptyColor (default dim)", () => {
		expect(renderProgressBar(0.3, taggedTheme, "accent")).toBe(`[${"accent:█".repeat(3)}${"dim:░".repeat(7)}]`);
	});

	it("honors an explicit emptyColor override", () => {
		expect(renderProgressBar(0.2, taggedTheme, "success", "warning")).toBe(
			`[${"success:█".repeat(2)}${"warning:░".repeat(8)}]`,
		);
	});

	it("renders every cell as a single 7-bit column under the ascii preset", () => {
		const bar = renderProgressBar(0.4, idTheme, "accent", "dim", "ascii");
		expect(bar).toBe(`[${"#".repeat(4)}${"-".repeat(6)}]`);
		for (const ch of bar) expect(ch.charCodeAt(0)).toBeLessThan(128);
	});

	it("nerd preset is identical to unicode", () => {
		expect(renderProgressBar(0.6, idTheme, "accent", "dim", "nerd")).toBe(
			renderProgressBar(0.6, idTheme, "accent", "dim", "unicode"),
		);
	});

	it("respects a custom cell count", () => {
		expect(renderProgressBar(0.5, idTheme, "accent", "dim", "unicode", 4)).toBe(`[${"█".repeat(2)}${"░".repeat(2)}]`);
	});
});

describe("renderProgressBar — eighth-block sub-cell resolution (unicode/nerd only)", () => {
	// Test all 8 sub-cell states at specific ratios
	const eighthsCases: Array<{ ratio: number; expected: string; desc: string }> = [
		{ ratio: 0.0125, expected: `[▏${"░".repeat(9)}]`, desc: "1/8 in first cell" },
		{ ratio: 0.025, expected: `[▎${"░".repeat(9)}]`, desc: "2/8 in first cell" },
		{ ratio: 0.0375, expected: `[▍${"░".repeat(9)}]`, desc: "3/8 in first cell" },
		{ ratio: 0.05, expected: `[▌${"░".repeat(9)}]`, desc: "4/8 in first cell" },
		{ ratio: 0.0625, expected: `[▋${"░".repeat(9)}]`, desc: "5/8 in first cell" },
		{ ratio: 0.075, expected: `[▊${"░".repeat(9)}]`, desc: "6/8 in first cell" },
		{ ratio: 0.0875, expected: `[▉${"░".repeat(9)}]`, desc: "7/8 in first cell" },
	];

	for (const { ratio, expected, desc } of eighthsCases) {
		it(`renders ${desc} at ratio ${ratio}`, () => {
			expect(renderProgressBar(ratio, idTheme, "accent")).toBe(expected);
		});
	}

	it("renders 7 full + 6/8 partial at ratio 0.78", () => {
		// 0.78 * 10 = 7.8 → floor=7, (0.8 * 8) = 6.4 → round=6 → ▊
		expect(renderProgressBar(0.78, idTheme, "accent")).toBe(`[${"█".repeat(7)}▊${"░".repeat(2)}]`);
	});

	it("renders 5 full + 4/8 partial at ratio 0.55", () => {
		// 0.55 * 10 = 5.5 → floor=5, (0.5 * 8) = 4.0 → round=4 → ▌
		expect(renderProgressBar(0.55, idTheme, "accent")).toBe(`[${"█".repeat(5)}▌${"░".repeat(4)}]`);
	});

	it("carries eighths=8 to next full cell", () => {
		// 0.09375 * 10 = 0.9375 → floor=0, (0.9375 * 8) = 7.5 → round=8 → carry → 1 full, 0 eighths
		expect(renderProgressBar(0.09375, idTheme, "accent")).toBe(`[█${"░".repeat(9)}]`);
	});

	it("exact whole-cell ratios render byte-identical to pre-eighths (all full or empty, no partial)", () => {
		expect(renderProgressBar(0, idTheme, "accent")).toBe(`[${"░".repeat(10)}]`);
		expect(renderProgressBar(0.1, idTheme, "accent")).toBe(`[█${"░".repeat(9)}]`);
		expect(renderProgressBar(0.2, idTheme, "accent")).toBe(`[${"█".repeat(2)}${"░".repeat(8)}]`);
		expect(renderProgressBar(0.5, idTheme, "accent")).toBe(`[${"█".repeat(5)}${"░".repeat(5)}]`);
		expect(renderProgressBar(0.7, idTheme, "accent")).toBe(`[${"█".repeat(7)}${"░".repeat(3)}]`);
		expect(renderProgressBar(1.0, idTheme, "accent")).toBe(`[${"█".repeat(10)}]`);
	});

	it("nerd preset uses eighths (identical to unicode)", () => {
		expect(renderProgressBar(0.78, idTheme, "accent", "dim", "nerd")).toBe(
			renderProgressBar(0.78, idTheme, "accent", "dim", "unicode"),
		);
	});
});

describe("renderProgressBar — ascii preset byte-identical (whole-cell round-nearest, no eighths)", () => {
	it("ascii at ratio 0.78 rounds to 8 full cells (pre-eighths behavior)", () => {
		// Round-nearest: 0.78 * 10 = 7.8 → round(7.8) = 8
		expect(renderProgressBar(0.78, idTheme, "accent", "dim", "ascii")).toBe(`[${"#".repeat(8)}${"-".repeat(2)}]`);
	});

	it("ascii at ratio 0.55 rounds to 6 full cells", () => {
		// Round-nearest: 0.55 * 10 = 5.5 → round(5.5) = 6
		expect(renderProgressBar(0.55, idTheme, "accent", "dim", "ascii")).toBe(`[${"#".repeat(6)}${"-".repeat(4)}]`);
	});

	it("ascii at exact whole-cell ratios matches unicode (pre-eighths)", () => {
		for (const ratio of [0, 0.1, 0.2, 0.5, 0.7, 1.0]) {
			const asciiBar = renderProgressBar(ratio, idTheme, "accent", "dim", "ascii");
			const unicodeBar = renderProgressBar(ratio, idTheme, "accent", "dim", "unicode");
			// Strip color tags and translate glyphs: █→#, ░→-
			const normalizedUnicode = unicodeBar.replace(/█/g, "#").replace(/░/g, "-");
			expect(asciiBar).toBe(normalizedUnicode);
		}
	});
});

describe("renderProgressBar — gradient threshold colors (truecolor-gated)", () => {
	const truecolorTier: RenderTier = { colorMode: "truecolor", graphics: false, syncOutput: false, program: "other" };
	const color256Tier: RenderTier = { colorMode: "256", graphics: false, syncOutput: false, program: "other" };
	const basicTier: RenderTier = { colorMode: "basic", graphics: false, syncOutput: false, program: "other" };

	// Helper to extract RGB values from ANSI truecolor sequence
	function extractRgb(ansiString: string): [number, number, number] | null {
		const match = ansiString.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
		if (!match) return null;
		return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
	}

	it("up-good: colors shift from red (0.1) → yellow (0.5) → green (1) at truecolor", () => {
		const r10 = renderProgressBar(
			0.1,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"up-good",
		);
		const r25 = renderProgressBar(
			0.25,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"up-good",
		);
		const r50 = renderProgressBar(
			0.5,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"up-good",
		);
		const r75 = renderProgressBar(
			0.75,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"up-good",
		);
		const r100 = renderProgressBar(
			1,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"up-good",
		);

		// Extract RGB from first filled cell
		const rgb10 = extractRgb(r10);
		const rgb25 = extractRgb(r25);
		const rgb50 = extractRgb(r50);
		const rgb75 = extractRgb(r75);
		const rgb100 = extractRgb(r100);

		// At 0.1: should be mostly red
		expect(rgb10).not.toBeNull();
		expect(rgb10![0]).toBeGreaterThan(200); // mostly red
		expect(rgb10![1]).toBeLessThan(100); // little green

		// At 0.5: should be yellow (mix of red and green)
		expect(rgb50).not.toBeNull();
		expect(rgb50![0]).toBe(255); // full red
		expect(rgb50![1]).toBe(255); // full green

		// At 1: should be pure green
		expect(rgb100).not.toBeNull();
		expect(rgb100![0]).toBe(0); // no red
		expect(rgb100![1]).toBe(255); // full green

		// Monotonic: green channel increases in first half, red channel decreases in second half
		expect(rgb25![1]).toBeGreaterThan(rgb10![1]); // green increases 0.1 → 0.25
		expect(rgb75![0]).toBeLessThan(rgb50![0]); // red decreases 0.5 → 0.75
	});
	it("down-good: colors shift from green (0.1) → yellow (0.5) → red (1) at truecolor", () => {
		const r10 = renderProgressBar(
			0.1,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"down-good",
		);
		const r50 = renderProgressBar(
			0.5,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"down-good",
		);
		const r100 = renderProgressBar(
			1,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"down-good",
		);

		const rgb10 = extractRgb(r10);
		const rgb50 = extractRgb(r50);
		const rgb100 = extractRgb(r100);

		// At 0.1: should be mostly green
		expect(rgb10).not.toBeNull();
		expect(rgb10![0]).toBeLessThan(100); // little red
		expect(rgb10![1]).toBeGreaterThan(200); // mostly green

		// At 0.5: should be yellow
		expect(rgb50).not.toBeNull();
		expect(rgb50![0]).toBe(255); // full red
		expect(rgb50![1]).toBe(255); // full green

		// At 1: should be pure red
		expect(rgb100).not.toBeNull();
		expect(rgb100![0]).toBe(255); // full red
		expect(rgb100![1]).toBe(0); // no green
	});

	it("same ratio, opposite directions → different colors", () => {
		const upGood = renderProgressBar(
			0.3,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"up-good",
		);
		const downGood = renderProgressBar(
			0.3,
			idTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
			"down-good",
		);

		const rgbUp = extractRgb(upGood);
		const rgbDown = extractRgb(downGood);

		// Colors should be different
		expect(rgbUp).not.toBeNull();
		expect(rgbDown).not.toBeNull();
		expect(rgbUp![0]).not.toBe(rgbDown![0]); // Different red component
		expect(rgbUp![1]).not.toBe(rgbDown![1]); // Different green component
	});

	it("truecolor gating: 256-color mode falls back to flat color (byte-identical to no-gradient)", () => {
		const withoutGradient = renderProgressBar(
			0.5,
			taggedTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			color256Tier,
		);
		const withGradient256 = renderProgressBar(
			0.5,
			taggedTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			color256Tier,
			"up-good",
		);

		// Should be byte-identical (no gradient applied)
		expect(withGradient256).toBe(withoutGradient);
	});

	it("truecolor gating: basic mode falls back to flat color (byte-identical to no-gradient)", () => {
		const withoutGradient = renderProgressBar(
			0.5,
			taggedTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			basicTier,
		);
		const withGradientBasic = renderProgressBar(
			0.5,
			taggedTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			basicTier,
			"up-good",
		);

		// Should be byte-identical (no gradient applied)
		expect(withGradientBasic).toBe(withoutGradient);
	});

	it("no renderTier provided: falls back to flat color", () => {
		const withoutTier = renderProgressBar(
			0.5,
			taggedTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			undefined,
			"up-good",
		);
		const withoutGradient = renderProgressBar(0.5, taggedTheme, "accent", "dim", "unicode", PROGRESS_BAR_CELLS);

		// Should be byte-identical (no gradient applied)
		expect(withoutTier).toBe(withoutGradient);
	});

	it("no gradient direction provided: falls back to flat color", () => {
		const withoutDirection = renderProgressBar(
			0.5,
			taggedTheme,
			"accent",
			"dim",
			"unicode",
			PROGRESS_BAR_CELLS,
			truecolorTier,
		);
		const withoutGradient = renderProgressBar(0.5, taggedTheme, "accent", "dim", "unicode", PROGRESS_BAR_CELLS);

		// Should be byte-identical (no gradient applied)
		expect(withoutDirection).toBe(withoutGradient);
	});
});
