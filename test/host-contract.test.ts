import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { expandPath, resolveReadPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { getContextUsageLevel, getContextUsageThemeColor } from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import { splitInternalUrlSel, splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { installedHostVersion } from "./installed-host-harness";

describe("host contract", () => {
	test("installedHostVersion starts with 18.", () => {
		const version = installedHostVersion();
		expect(version.startsWith("18.")).toBe(true);
	});

	test("normalizeToolName on known builtin aliases", () => {
		const builtinNamesPath = path.join(
			process.cwd(),
			"node_modules/@oh-my-pi/pi-coding-agent/src/tools/builtin-names.ts",
		);
		const source = fs.readFileSync(builtinNamesPath, "utf-8");

		const aliasMatch = source.match(/LEGACY_BUILTIN_TOOL_NAME_ALIASES[^=]*=\s*new Map\s*\(\s*\[([\s\S]+?)\]\s*\)/);
		expect(aliasMatch).toBeTruthy();

		const entries =
			aliasMatch![1]
				.match(/\["([^"]+)",\s*"([^"]+)"\]/g)
				?.map(entry => {
					const match = entry.match(/\["([^"]+)",\s*"([^"]+)"\]/);
					return match ? ([match[1], match[2]] as [string, string]) : null;
				})
				.filter((pair): pair is [string, string] => pair !== null) ?? [];

		expect(entries.length).toBeGreaterThan(0);

		for (const [alias, canonical] of entries) {
			expect(normalizeToolName(alias)).toBe(canonical);
		}
	});

	test("getContextUsageLevel at threshold boundaries", () => {
		const thresholdsPath = path.join(process.cwd(), "node_modules/@oh-my-pi/pi-tui/src/chrome/context-thresholds.ts");
		const source = fs.readFileSync(thresholdsPath, "utf-8");

		const warningMatch = source.match(/CONTEXT_WARNING_PERCENT_THRESHOLD\s*=\s*(\d+)/);
		const purpleMatch = source.match(/CONTEXT_PURPLE_PERCENT_THRESHOLD\s*=\s*(\d+)/);

		expect(warningMatch).toBeTruthy();
		expect(purpleMatch).toBeTruthy();

		const warning = Number.parseInt(warningMatch![1], 10);
		const purple = Number.parseInt(purpleMatch![1], 10);

		const contextWindow = 200000;

		expect(getContextUsageLevel(warning - 1, contextWindow)).toBe("normal");
		expect(getContextUsageLevel(warning, contextWindow)).toBe("warning");
		expect(getContextUsageLevel(purple - 1, contextWindow)).toBe("warning");
		expect(getContextUsageLevel(purple, contextWindow)).toBe("purple");
	});

	test("getContextUsageThemeColor", () => {
		expect(typeof getContextUsageThemeColor("normal")).toBe("string");
		expect(typeof getContextUsageThemeColor("warning")).toBe("string");
		expect(typeof getContextUsageThemeColor("purple")).toBe("string");
		expect(typeof getContextUsageThemeColor("error")).toBe("string");
	});

	test("splitPathAndSel round-trips", () => {
		const withSel = splitPathAndSel("a/b.ts:5-10");
		expect(withSel.path).toBe("a/b.ts");
		expect(withSel.sel).toBe("5-10");

		const plainPath = splitPathAndSel("a/b.ts");
		expect(plainPath.path).toBe("a/b.ts");
		expect(plainPath.sel).toBeUndefined();
	});

	test("splitInternalUrlSel on internal URL", () => {
		const result = splitInternalUrlSel("memory://foo/bar:10-20");
		expect(result.path).toBe("memory://foo/bar");
		expect(result.sel).toBe("10-20");

		const noSel = splitInternalUrlSel("skill://test");
		expect(noSel.path).toBe("skill://test");
		expect(noSel.sel).toBeUndefined();
	});

	test("expandPath tilde expansion", () => {
		const home = os.homedir();
		expect(expandPath("~/test")).toBe(path.join(home, "test"));
		expect(expandPath("/abs/path")).toBe("/abs/path");
		expect(expandPath("rel/path")).toBe("rel/path");
	});

	test("resolveReadPath basic resolution", () => {
		const cwd = process.cwd();
		const result = resolveReadPath("test.txt", cwd);
		expect(result).toBe(path.join(cwd, "test.txt"));

		const absolute = resolveReadPath("/tmp/test.txt", cwd);
		expect(absolute).toBe("/tmp/test.txt");
	});
});
