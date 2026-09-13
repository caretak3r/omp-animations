import { describe, expect, it } from "bun:test";
import { renderLegend } from "../src/animations-box/legend";

describe("renderLegend", () => {
	it("opens with the dot vocabulary in escalation order for each preset", () => {
		expect(
			renderLegend("unicode")
				.slice(0, 4)
				.map(line => line.split(" ", 2).join(" ")),
		).toEqual(["○ idle", "● live", "◐ notable", "● alert"]);
		expect(
			renderLegend("ascii")
				.slice(0, 4)
				.map(line => line.split(" ", 2).join(" ")),
		).toEqual([". idle", "* live", "! notable", "! alert"]);
	});

	it("separates the dot table from the segment rows with one blank line", () => {
		expect(renderLegend("unicode")[4]).toBe("");
	});

	it("lists the Audit summaries in render order without a trailing optional separator", () => {
		expect(
			renderLegend("unicode")
				.slice(5)
				.map(line => line.split(" ")[0]),
		).toEqual(["context", "cache", "audit", "limits", "tools", "files"]);
	});

	it("segment rows are preset-independent — only the dot glyphs vary", () => {
		expect(renderLegend("unicode").slice(4)).toEqual(renderLegend("ascii").slice(4));
	});
});
