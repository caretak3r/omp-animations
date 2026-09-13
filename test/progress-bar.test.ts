import { describe, expect, it } from "bun:test";
import type { ProgressBarTheme } from "../src/progress-bar";
import { gradientColorAt, PROGRESS_BAR_CELLS, progressBarFilledCells, renderProgressBar } from "../src/progress-bar";

const idTheme: ProgressBarTheme = {
	fg: (_color, text) => text,
};
const taggedTheme: ProgressBarTheme = {
	fg: (color, text) => `${color}:${text}`,
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

	it("keeps the default unicode bar on the whole-cell glyph alphabet at every percentage", () => {
		for (let percentage = 0; percentage <= 100; percentage++) {
			const bar = renderProgressBar(percentage / 100, idTheme, "accent", "dim", "unicode");
			expect(bar).not.toMatch(/[\u2589-\u258f]/u);
			expect(bar.slice(1, -1)).toHaveLength(PROGRESS_BAR_CELLS);
		}
	});

	it("nerd preset matches unicode at exact whole-cell ratios", () => {
		expect(renderProgressBar(0.6, idTheme, "accent", "dim", "nerd")).toBe(
			renderProgressBar(0.6, idTheme, "accent", "dim", "unicode"),
		);
	});

	it("respects a custom cell count", () => {
		expect(renderProgressBar(0.5, idTheme, "accent", "dim", "unicode", 4)).toBe(`[${"█".repeat(2)}${"░".repeat(2)}]`);
	});
});

describe("renderProgressBar — eighth-block sub-cell resolution (nerd opt-in only)", () => {
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
			expect(renderProgressBar(ratio, idTheme, "accent", "dim", "nerd")).toBe(expected);
		});
	}

	it("renders 7 full + 6/8 partial at ratio 0.78", () => {
		// 0.78 * 10 = 7.8 → floor=7, (0.8 * 8) = 6.4 → round=6 → ▊
		expect(renderProgressBar(0.78, idTheme, "accent", "dim", "nerd")).toBe(`[${"█".repeat(7)}▊${"░".repeat(2)}]`);
	});

	it("renders 5 full + 4/8 partial at ratio 0.55", () => {
		// 0.55 * 10 = 5.5 → floor=5, (0.5 * 8) = 4.0 → round=4 → ▌
		expect(renderProgressBar(0.55, idTheme, "accent", "dim", "nerd")).toBe(`[${"█".repeat(5)}▌${"░".repeat(4)}]`);
	});

	it("carries eighths=8 to next full cell", () => {
		// 0.09375 * 10 = 0.9375 → floor=0, (0.9375 * 8) = 7.5 → round=8 → carry → 1 full, 0 eighths
		expect(renderProgressBar(0.09375, idTheme, "accent", "dim", "nerd")).toBe(`[█${"░".repeat(9)}]`);
	});

	it("exact whole-cell ratios render byte-identical to pre-eighths (all full or empty, no partial)", () => {
		expect(renderProgressBar(0, idTheme, "accent")).toBe(`[${"░".repeat(10)}]`);
		expect(renderProgressBar(0.1, idTheme, "accent")).toBe(`[█${"░".repeat(9)}]`);
		expect(renderProgressBar(0.2, idTheme, "accent")).toBe(`[${"█".repeat(2)}${"░".repeat(8)}]`);
		expect(renderProgressBar(0.5, idTheme, "accent")).toBe(`[${"█".repeat(5)}${"░".repeat(5)}]`);
		expect(renderProgressBar(0.7, idTheme, "accent")).toBe(`[${"█".repeat(7)}${"░".repeat(3)}]`);
		expect(renderProgressBar(1.0, idTheme, "accent")).toBe(`[${"█".repeat(10)}]`);
	});

	it("keeps eighths reachable through the nerd preset", () => {
		expect(renderProgressBar(0.78, idTheme, "accent", "dim", "nerd")).toBe(`[${"█".repeat(7)}▊${"░".repeat(2)}]`);
		expect(renderProgressBar(0.78, idTheme, "accent", "dim", "unicode")).toBe(`[${"█".repeat(8)}${"░".repeat(2)}]`);
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

it("maps threshold gradients through warning without reversing risk direction", () => {
	const theme: Required<ProgressBarTheme> = {
		fg: (_color, text) => text,
		getColorHex: color => {
			switch (color) {
				case "error":
					return "#ff0000";
				case "warning":
					return "#ffff00";
				case "success":
					return "#00ff00";
				default:
					throw new Error(`Unexpected gradient color: ${color}`);
			}
		},
	};
	expect(gradientColorAt(0, "up-good", theme)).toBe("#ff0000");
	expect(gradientColorAt(0.25, "up-good", theme)).toBe("#ff8000");
	expect(gradientColorAt(0.5, "up-good", theme)).toBe("#ffff00");
	expect(gradientColorAt(1, "up-good", theme)).toBe("#00ff00");
	expect(gradientColorAt(0, "down-good", theme)).toBe("#00ff00");
	expect(gradientColorAt(0.5, "down-good", theme)).toBe("#ffff00");
	expect(gradientColorAt(1, "down-good", theme)).toBe("#ff0000");
});
