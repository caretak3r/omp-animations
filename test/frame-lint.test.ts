import { describe, expect, test } from "bun:test";
import { parseFrame, RULES } from "../scripts/frame-lint";

/**
 * The frame linter is the ratchet on the fix-and-reshoot loop: it turns the render
 * bugs we found by eye into checks the next run cannot regress past. A linter that
 * silently stops firing is worse than no linter, so both directions are pinned here.
 */

const firedRules = (text: string): string[] => {
	const frame = parseFrame("fixture.txt", text);
	return RULES.filter(rule => rule.check(frame).length > 0).map(rule => rule.id);
};

/** Wraps body lines in a box whose every line measures the same, so width rules stay quiet. */
const box = (bodies: string[]): string => {
	const inner = Math.max(...bodies.map(body => Bun.stringWidth(body)));
	const rule = "─".repeat(inner + 2);
	const rows = bodies.map(body => `│ ${body}${" ".repeat(inner - Bun.stringWidth(body))} │`);
	return [`╭${rule}╮`, ...rows, `╰${rule}╯`].join("\n");
};

/** The 2026-08-15 capture, trimmed to the rows that carry a defect. */
const BROKEN = box([
	"●  context  [███░░░░░░░] 30% quota · 66K/272K   ~290 turns left",
	"●  cache    97% hit · 61/63   259K uncached · 3.5M read",
	"◐  audit    5 reads · 2 writes",
	"●  tools    62 calls — other (15) · bash (12)",
	"○  files",
	"●  cadence  -- · peak 0",
	"agents",
	"├─ ● A1 North  openai-codex/gpt-5.6-sol:high  /Users/rohit/x.md",
	"└─ ● A2 East   openai-codex/gpt-5.6-sol:high  thoroughly:# Target",
]);

/** A row whose detail and wide-only tail are laid out on fixed columns, the way a fixed box should. */
const row = (dot: string, label: string, detail: string, tail: string): string => {
	const head = `${dot}  ${label.padEnd(7)}  ${detail}`;
	return `${head}${" ".repeat(Math.max(3, 52 - Bun.stringWidth(head)))}${tail}`;
};

/** The same box with every defect resolved the way the beads describe. */
const CLEAN = box([
	row("●", "context", "[███░░░░░░░] 30% quota · 66K/272K", ">99 turns left"),
	row("●", "cache", "97% hit · 61/63 · 3.5M cached", "259K uncached"),
	row("◐", "audit", "5 files read · 2 written", "SKILL.md"),
	row("●", "tools", "62 calls · other (15) · bash (12)", "~/omp"),
	row("○", "files", "—", "idle"),
	row("●", "cadence", "42 t/s · peak 61", "steady"),
	"agents",
	"├─ ● A1 North  awaiting adversary release · beads triage",
	"└─ ● A2 East   reading fabric tail · mutation sweep",
]);

describe("frame linter", () => {
	test("names every defect in the capture that opened the render-fidelity epic", () => {
		expect(firedRules(BROKEN).sort()).toEqual(
			[
				"absolute-path",
				"ascii-placeholder",
				"blank-value",
				"dead-rate",
				"glued-markdown",
				"junk-forecast",
				"mixed-separator",
				"ragged-tail",
				"read-write-collision",
				"repeated-chip",
			].sort(),
		);
	});

	test("stays silent on a box where those defects are fixed", () => {
		expect(firedRules(CLEAN)).toEqual([]);
	});

	test("a group heading is not graded as a data row missing its value", () => {
		const heading = parseFrame("f.txt", BROKEN).boxes[0]?.rows.find(row => row.label === "agents");
		expect(heading?.kind).toBe("header");
	});

	test("flags a fractional boundary glyph in the context bar but accepts whole cells", () => {
		expect(firedRules(box(["●  context  [█▊░░░░░░░░] 17% quota"]))).toContain("fractional-bar");
		expect(firedRules(box(["●  context  [██░░░░░░░░] 17% quota"]))).not.toContain("fractional-bar");
	});

	test("flags inferred fallback rows only when authoritative agent telemetry also renders", () => {
		const duplicateSources = box([
			"agents",
			"● M main             gpt-5.5  hub",
			"├─ ● A? SpecReview   gpt-5.5",
			"● M Main (inferred)  gpt-5.5",
			"└─ ● A1 SpecReview (inferred)  openai-codex/gpt-5.5:high",
		]);
		const authoritativeOnly = box(["agents", "● M main  gpt-5.5  hub", "└─ ● A? SpecReview  gpt-5.5"]);
		const inferredOnly = box([
			"agents",
			"● M Main (inferred)  gpt-5.5",
			"└─ ● A1 SpecReview (inferred)  openai-codex/gpt-5.5:high",
		]);

		expect(firedRules(duplicateSources)).toContain("duplicate-agent-source");
		expect(firedRules(authoritativeOnly)).not.toContain("duplicate-agent-source");
		expect(firedRules(inferredOnly)).not.toContain("duplicate-agent-source");
	});

	test("every rule cites the bead that pays for it", () => {
		const orphans = RULES.filter(rule => rule.bead !== "-" && !/^(?:daw|4qn|zko)\.\d$/.test(rule.bead));
		expect(orphans.map(rule => rule.id)).toEqual([]);
	});
});
