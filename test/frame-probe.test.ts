import { describe, expect, it } from "bun:test";
import { lintFrame } from "../scripts/frame-lint";
import { parseCapture } from "../scripts/frame-probe";

const metadata = (sync: string, width = 30) => `@@omp-frame sync=${sync} x=18 y=0 width=${width} height=12`;
const truncatedBox = [
	`┌${"─".repeat(17)}`,
	...["context", "cache", "audit", "limits", "tools", "files"].map(label => `│ ${`● ${label}  —`.padEnd(27)}│`),
	`└${"─".repeat(28)}┘`,
].join("\n");
const capture = (before: string, after: string, pane = truncatedBox) => `${before}\n${pane}\n${after}\n`;

describe("frame capture transaction boundary", () => {
	it("distinguishes an unfinished synchronized paint without repairing its malformed rows", () => {
		const during = parseCapture(capture(metadata("1"), metadata("1")));
		const outside = parseCapture(capture(metadata("0"), metadata("0")));
		expect(during.status).toBe("in-flight");
		expect(outside.status).toBe("settled");
		for (const sample of [during, outside]) {
			expect(sample.pane).toBe(truncatedBox);
			expect(lintFrame("capture", sample.pane).some(violation => violation.rule === "ragged-width")).toBe(true);
		}
	});

	it("does not grade a capture that crosses either synchronization boundary", () => {
		for (const [before, after] of [
			["0", "1"],
			["1", "0"],
		]) {
			expect(parseCapture(capture(metadata(before), metadata(after))).status).toBe("in-flight");
		}
	});

	it("fails closed for unavailable metadata or a changed viewport", () => {
		for (const raw of [
			capture(metadata(""), metadata("")),
			capture(metadata("0"), ""),
			capture(metadata("0", 30), metadata("0", 45)),
			truncatedBox,
		]) {
			expect(parseCapture(raw).status).toBe("unknown");
		}
	});

	it("does not mistake metadata-looking pane content for capture boundaries", () => {
		const pane = `${truncatedBox}\n${metadata("1")}`;
		const result = parseCapture(capture(metadata("0"), metadata("0"), pane));
		expect(result.status).toBe("settled");
		expect(result.pane).toBe(pane);
	});
});
