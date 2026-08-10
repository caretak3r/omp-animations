import { describe, expect, it } from "bun:test";
import type { ProgressBarTheme } from "../src/progress-bar";
import { PROGRESS_BAR_CELLS, progressBarFilledCells, renderProgressBar } from "../src/progress-bar";

const idTheme: ProgressBarTheme = { fg: (_color, text) => text };
const taggedTheme: ProgressBarTheme = { fg: (color, text) => `${color}:${text}` };

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
