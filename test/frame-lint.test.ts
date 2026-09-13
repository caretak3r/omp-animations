import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FrameLintMetadata, lintFrame, parseFrame, RULES } from "../scripts/frame-lint";

/**
 * The frame linter is the ratchet on the fix-and-reshoot loop: it turns the render
 * bugs we found by eye into checks the next run cannot regress past. A linter that
 * silently stops firing is worse than no linter, so both directions are pinned here.
 */

const firedRules = (text: string): string[] => {
	const frame = parseFrame("fixture.txt", text);
	return RULES.filter(rule => rule.check(frame).length > 0).map(rule => rule.id);
};

const firedMetadataRules = (metadata: Readonly<FrameLintMetadata>, text = CLEAN): string[] =>
	lintFrame("fixture.txt", text, metadata).map(violation => violation.rule);

/** Wraps body lines in a box whose every line measures the same, so width rules stay quiet. */
const box = (bodies: string[]): string => {
	const inner = Math.max(...bodies.map(body => Bun.stringWidth(body)));
	const rule = "─".repeat(inner + 2);
	const rows = bodies.map(body => `│ ${body}${" ".repeat(inner - Bun.stringWidth(body))} │`);
	return [`╭${rule}╮`, ...rows, `╰${rule}╯`].join("\n");
};

const auditBox = (bodies: string[]): string => box(["○  context  —", ...bodies]);

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
				// Per-agent model labels are not duplicate summary chips.
			].sort(),
		);
	});

	test("stays silent on a box where those defects are fixed", () => {
		expect(firedRules(CLEAN)).toEqual([]);
	});

	test("rejects truncated, bracketless, and wrong-width context bars", () => {
		for (const visual of [
			"[██████…",
			"[████…",
			"[██…",
			"[…",
			"██████░░░░]",
			"██████░░░░",
			"[██████░░░]",
			"[██████░░░░░]",
			"[██████░░░░]…",
			"[####...",
			"[####------",
			"####------]",
			"----------]",
			"[]",
			"[",
			"]",
		]) {
			expect(firedRules(box([`●  context  ${visual} 60% budget`]))).toContain("broken-bar");
			expect(firedRules(box([`${visual} 60% budget · reuse 71%`]))).toContain("broken-bar");
		}
	});

	test("accepts intact context graphics and percentage-only fallback", () => {
		for (const value of ["[███████▌░░] 75% budget", "[####------] 40% budget", "40% budget", "40%…"]) {
			expect(firedRules(box([`●  context  ${value}`]))).not.toContain("broken-bar");
		}
		expect(firedRules(box(["[██████░░░░] 60% budget · reuse 71%"]))).not.toContain("broken-bar");
	});

	test("does not grade agent activity cells as context bars", () => {
		expect(
			firedRules(
				auditBox([
					"agents",
					"● M Main  openai-codex/gpt-6-astra  inspect src/frame-lint.ts · 40% budget",
					"├─ ● A1 Worker  parsing # headings",
					"  ↳ [T bash ●] → [F file.ts ●]",
				]),
			),
		).not.toContain("broken-bar");
	});

	test("ignores unrelated bordered tool output when a plugin box is present", () => {
		const plugin = box([
			"●  context  10% quota",
			"○  cache    —",
			"○  audit    —",
			"○  limits   —",
			"○  tools    —",
			"○  files    —",
		]);
		const toolOutput = box(["⟨Resolved path: /Users/rohit/private/SKILL.md⟩", "~241 turns"]);
		const rules = lintFrame("capture.txt", `${toolOutput}\n${plugin}`).map(violation => violation.rule);
		expect(rules).not.toContain("absolute-path");
		expect(rules).not.toContain("junk-forecast");
	});

	test("does not assign rounded tool-only output to the plugin", () => {
		const toolOutput = box([
			"Resolved path: /Users/rohit/private/SKILL.md",
			"~241 turns",
			"259K read · 2 writes",
			"openai-codex/gpt-6-astra:high openai-codex/gpt-6-astra:high",
		]);
		expect(parseFrame("tool.txt", toolOutput).boxes).toEqual([]);
		expect(lintFrame("tool.txt", toolOutput)).toEqual([]);
		expect(firedMetadataRules({ requiredRowCount: 6 }, toolOutput)).toContain("required-row-displacement");
		expect(firedMetadataRules({ requiredRowCount: 6, renderedRequiredRowCount: 6 }, toolOutput)).toContain(
			"required-row-displacement",
		);
	});

	test("CLI exits inconclusively when no plugin frame can be graded", async () => {
		const directory = await mkdtemp(join(tmpdir(), "FramePolicy-frame-lint-"));
		try {
			const frame = join(directory, "capture.txt");
			const script = join(import.meta.dir, "../scripts/frame-lint.ts");
			await writeFile(frame, box(["Resolved path: /Users/rohit/tool/file.ts"]));
			const unowned = Bun.spawnSync([process.execPath, script, "--json", frame]);
			expect(unowned.exitCode).toBe(2);
			expect(JSON.parse(unowned.stdout.toString()).gradedFrames).toBe(0);

			await writeFile(frame, auditBox(["○  files  —"]));
			const owned = Bun.spawnSync([process.execPath, script, "--json", frame]);
			expect(owned.exitCode).toBe(0);
			expect(JSON.parse(owned.stdout.toString()).gradedFrames).toBe(1);

			await writeFile(frame, auditBox(["○  files  —"]).slice(0, -1));
			const malformed = Bun.spawnSync([process.execPath, script, "--json", frame]);
			expect(malformed.exitCode).toBe(1);
			expect(JSON.parse(malformed.stdout.toString()).violations).toEqual(
				expect.arrayContaining([expect.objectContaining({ rule: "incomplete-border" })]),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("owns simple summaries without treating their measurements as missing labels or glyphs", () => {
		for (const summary of [
			"17% budget · reuse 71% · 2✎",
			"[██░░░░░░░░] 17% budget · 71% recent token reuse · 4 calls",
		]) {
			const plugin = box([summary]);
			const toolOutput = box(["Resolved path: /Users/rohit/private/SKILL.md", "259K read · 2 writes"]);
			expect(parseFrame("simple.txt", plugin).boxes).toHaveLength(1);
			expect(lintFrame("simple.txt", `${toolOutput}\n${plugin}`)).toEqual([]);
			expect(firedMetadataRules({ requiredRowCount: 6, renderedRequiredRowCount: 6 }, plugin)).toEqual([]);
			expect(firedRules(box([`${summary} · /Users/rohit/private/status.db`]))).toContain("absolute-path");
		}
	});

	test("keeps plugin path failures separate from unrelated tool paths in mixed captures", () => {
		const plugin = auditBox(["●  files  /Users/rohit/plugin/file.ts"]);
		const toolOutput = box(["Resolved path: /Users/rohit/tool/file.ts"]);
		const failures = lintFrame("mixed.txt", `${toolOutput}\n${plugin}`).filter(
			violation => violation.rule === "absolute-path",
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.evidence).toContain("/Users/rohit/plugin/file.ts");
	});

	test("still owns truncated chrome and reports border and width failures", () => {
		const intact = auditBox(["●  files  /Users/rohit/plugin/file.ts"]).split("\n");
		const truncated = [...intact];
		truncated[0] = (truncated[0] ?? "").slice(0, -8);
		expect(firedRules(truncated.join("\n"))).toContain("ragged-width");
		expect(firedRules(truncated.join("\n"))).toContain("incomplete-border");
		expect(firedRules(truncated.join("\n"))).toContain("absolute-path");

		for (const damaged of [
			intact.slice(1),
			intact.slice(0, -1),
			intact.map((line, index) => (index === 0 ? ` ${line.slice(1)}` : line)),
			intact.map((line, index) => (index === 1 ? line.slice(0, -1) : line)),
			intact.map((line, index) => (index === 1 ? ` ${line.slice(1)}` : line)),
		]) {
			expect(firedRules(damaged.join("\n"))).toContain("incomplete-border");
			expect(firedRules(damaged.join("\n"))).toContain("absolute-path");
		}
	});

	test("detects ragged body widths even when both caps are intact", () => {
		const lines = auditBox(["○  files  —"]).split("\n");
		lines[1] = lines[1]?.replace(" │", "  │") ?? "";
		expect(firedRules(lines.join("\n"))).toContain("ragged-width");
	});

	test("allows two agents to identify the same model in detailed and simple layouts", () => {
		const agents = [
			"agents",
			"● M Main  openai-codex/gpt-6-astra:high",
			"├─ ● A1 WidthProbeA  openai-codex/gpt-6-astra:high  Reading writing skill",
			"└─ ● A2 WidthProbeB  openai-codex/gpt-6-astra:high  Reading English skill",
		];
		expect(firedRules(auditBox(agents))).not.toContain("repeated-chip");
		expect(firedRules(box(["17% budget · reuse 71%", "", ...agents]))).not.toContain("repeated-chip");
	});

	test("allows independent agents to share assignment paths and slash-delimited prose", () => {
		const assignment = "Read /tmp/omp-anim-sandbox/project/README.md; no edits/shell/beads/other resources";
		for (const model of ["", "openai-codex/gpt-6-astra:high  "]) {
			const agents = ["agents", `├─ ● A1 North  ${model}${assignment}`, `└─ ● A2 East  ${model}${assignment}`];
			expect(firedRules(auditBox(agents))).not.toContain("repeated-chip");
			expect(firedRules(box(["17% budget · reuse 71%", "", ...agents]))).not.toContain("repeated-chip");
		}
	});

	test("rejects duplicate summary chips outside model cells, including inside the agents group", () => {
		const chip = "openai-codex/gpt-6-astra:high";
		expect(firedRules(auditBox([`●  tools  ${chip}`, `●  timing  ${chip}`]))).toContain("repeated-chip");
		expect(firedRules(box([`17% budget · ${chip} · ${chip}`]))).toContain("repeated-chip");
		expect(firedRules(auditBox(["agents", `├─ ● A1 North  ${chip}  ${chip}`, `└─ ● A2 East  ${chip}`]))).toContain(
			"repeated-chip",
		);
		expect(firedRules(auditBox(["agents", `●  tools  ${chip}`, `●  timing  ${chip}`]))).toContain("repeated-chip");
	});

	test("a group heading is not graded as a data row missing its value", () => {
		const heading = parseFrame("f.txt", BROKEN).boxes[0]?.rows.find(row => row.label === "agents");
		expect(heading?.kind).toBe("header");
	});

	test("flags a fractional boundary glyph in the context bar but accepts whole cells", () => {
		expect(firedRules(box(["●  context  [█▊░░░░░░░░] 17% quota"]))).toContain("fractional-bar");
		expect(firedRules(box(["●  context  [██░░░░░░░░] 17% quota"]))).not.toContain("fractional-bar");
	});

	test("rejects internal orbit terminology in repeat rows", () => {
		expect(firedRules(auditBox(["◐  repeat   orbit"]))).toContain("opaque-repeat-copy");
		expect(firedRules(auditBox(["◐  repeat   same tools as previous turn"]))).not.toContain("opaque-repeat-copy");
	});

	test("flags inferred fallback rows only when authoritative agent telemetry also renders", () => {
		const duplicateSources = auditBox([
			"agents",
			"● M main             gpt-5.5  hub",
			"├─ ● A? SpecReview   gpt-5.5",
			"● M Main (inferred)  gpt-5.5",
			"└─ ● A1 SpecReview (inferred)  openai-codex/gpt-5.5:high",
		]);
		const authoritativeOnly = auditBox(["agents", "● M main  gpt-5.5  hub", "└─ ● A? SpecReview  gpt-5.5"]);
		const inferredOnly = auditBox([
			"agents",
			"● M Main (inferred)  gpt-5.5",
			"└─ ● A1 SpecReview (inferred)  openai-codex/gpt-5.5:high",
		]);

		expect(firedRules(duplicateSources)).toContain("duplicate-agent-source");
		expect(firedRules(authoritativeOnly)).not.toContain("duplicate-agent-source");
		expect(firedRules(inferredOnly)).not.toContain("duplicate-agent-source");
	});

	test("fails each minimal broken temporal-evidence metadata fixture", () => {
		const fixtures: readonly [rule: string, metadata: Readonly<FrameLintMetadata>][] = [
			["motion-after-ttl", { semanticStage: "expired", motionFrameCount: 1 }],
			["unproven-directional-connector", { directionalConnectorCount: 1, explicitRelationCount: 0 }],
			["observed-delta-labeled-write", { observedDeltaCount: 1, writeLabelCount: 1 }],
			["stale-observation-erased", { staleObservationCount: 1, retainedObservationCount: 0 }],
			["color-only-lifecycle", { lifecycleStateCount: 1, textualLifecycleMarkerCount: 0 }],
			["pending-completed-collapse", { pendingCount: 1, completedCount: 1, distinctLifecycleProjectionCount: 1 }],
			["private-content", { privateContentFieldCount: 1 }],
			["duplicate-source-projection", { sourceProjectionCount: 2 }],
			["unsupported-placeholder", { capability: "unsupported", placeholderRowCount: 1 }],
			["idle-row-leak", { idleOptionalRowCount: 1 }],
			["retry-cancel-inference", { inferredRetryCount: 1, inferredCancellationCount: 1 }],
			["width-overflow", { contentWidth: 46, availableWidth: 45 }],
			["required-row-displacement", { requiredRowCount: 6, renderedRequiredRowCount: 5 }],
		];

		for (const [rule, metadata] of fixtures) {
			expect(firedMetadataRules(metadata), rule).toContain(rule);
		}
	});

	test("keeps private metadata and raw absolute paths as separate failures", () => {
		expect(firedMetadataRules({ privateContentFieldCount: 1 })).toContain("private-content");
		expect(firedRules(auditBox(["●  memory  /Users/private/status.db"]))).toContain("absolute-path");
	});

	test("stays silent when temporal metadata proves the clean contract", () => {
		const metadata: FrameLintMetadata = {
			semanticStage: "residual",
			motionFrameCount: 0,
			directionalConnectorCount: 1,
			explicitRelationCount: 1,
			observedDeltaCount: 1,
			writeLabelCount: 0,
			staleObservationCount: 1,
			retainedObservationCount: 1,
			lifecycleStateCount: 2,
			textualLifecycleMarkerCount: 2,
			pendingCount: 1,
			completedCount: 1,
			distinctLifecycleProjectionCount: 2,
			privateContentFieldCount: 0,
			sourceProjectionCount: 1,
			capability: "unsupported",
			placeholderRowCount: 0,
			idleOptionalRowCount: 0,
			inferredRetryCount: 0,
			inferredCancellationCount: 0,
			contentWidth: 45,
			availableWidth: 45,
			requiredRowCount: 6,
			renderedRequiredRowCount: 6,
		};

		expect(firedMetadataRules(metadata)).toEqual([]);
	});

	test("every rule cites the bead that pays for it", () => {
		const orphans = RULES.filter(
			rule => rule.bead !== "-" && !/^(?:(?:daw|4qn|zko)\.\d|zko\.5\.\d+|omp-animations-[a-z0-9]+)$/.test(rule.bead),
		);
		expect(orphans.map(rule => rule.id)).toEqual([]);
	});
});
