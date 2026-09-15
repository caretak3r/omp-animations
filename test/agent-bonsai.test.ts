import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityTelemetryBus } from "../src/activity-roster";
import { projectActivityAgents } from "../src/activity-roster/projection";
import { AgentBonsaiController } from "../src/agent-bonsai/controller";
import { resolveHyperlinkSupport } from "../src/agent-bonsai/hyperlinks";
import {
	extractTaskProgress,
	skillNameFromToolArgs,
	skillNamesFromProgress,
	type TaskAgentProgress,
} from "../src/agent-bonsai/progress";
import { createSkillPathResolver, skillRoots } from "../src/agent-bonsai/skill-paths";
import {
	type AgentActivityStep,
	type AgentBonsaiRef,
	type AgentBonsaiSnapshot,
	type AgentProvenanceEvent,
	buildAgentBonsai,
	GIST_MAX_CHARS,
	MAX_BONSAI_ROWS,
	normalizeAgentLine,
	summarizeAgentTask,
} from "../src/agent-bonsai/state";
import { buildSkillDisclosureUri, renderAgentBonsaiRows, sharedBonsaiModel } from "../src/agent-bonsai/widget";
import { type FlashTier, FlashTracker, FULL_FLASH_MS, SUBTLE_FLASH_MS } from "../src/animations-box/status-line";
import type { FrameScheduler } from "../src/kit";

function manualScheduler(): FrameScheduler & { advance(ms: number): void } {
	let current = 0;
	return {
		now: () => current,
		start: () => () => {},
		advance(ms) {
			current += ms;
		},
	};
}

function bonsaiRef(id: string, overrides: Partial<AgentBonsaiRef> = {}): AgentBonsaiRef {
	return {
		id,
		displayName: id,
		kind: id === "Main" ? "main" : "sub",
		parentId: id === "Main" ? undefined : "Main",
		status: "running",
		createdAt: id === "Main" ? 0 : 1,
		...overrides,
	};
}

function progressRow(id: string, overrides: Partial<TaskAgentProgress> = {}): TaskAgentProgress {
	return { index: 0, id, status: "running", ...overrides };
}

function taskUpdate(
	toolCallId: string,
	rows: readonly TaskAgentProgress[],
): {
	toolName: string;
	toolCallId: string;
	partialResult: unknown;
} {
	return { toolName: "task", toolCallId, partialResult: { details: { progress: rows } } };
}

function skillRead(name: string, endMs: number): { tool: string; args: string; endMs: number } {
	return { tool: "read", args: `skill://${name}`, endMs };
}

const RUNNING_JOB = { state: "running", jobId: "job-1", type: "task" } as const;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	symbol: (name: string) => {
		if (name === "tree.last") return "└─";
		if (name === "tree.branch") return "├─";
		return "│";
	},
};

const ANSI_COLORS: Readonly<Record<string, number>> = {
	dim: 90,
	accent: 36,
	syntaxFunction: 34,
	success: 32,
	warning: 33,
	error: 31,
};

const ansiTheme = {
	...plainTheme,
	fg: (color: string, text: string) => {
		const code = ANSI_COLORS[color] ?? 37;
		return `\x1b[${code}m${text}\x1b[39m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function stylesFor(row: string, text: string): readonly string[] {
	let color = 39;
	let bold = false;
	let plain = "";
	const styles: string[] = [];
	for (const token of row.match(/\x1b\[\d+m|[^\x1b]/gu) ?? []) {
		if (token.startsWith("\x1b[")) {
			const code = Number(token.slice(2, -1));
			if (code === 1 || code === 22) bold = code === 1;
			else color = code;
		} else {
			plain += token;
			styles.push(...Array.from({ length: token.length }, () => `${color}/${bold}`));
		}
	}
	const start = plain.indexOf(text);
	expect(start).toBeGreaterThanOrEqual(0);
	return [...new Set(styles.slice(start, start + text.length))];
}

/** `hyperlinks` is pinned so rows never vary with the terminal running the suite. */
function render(snapshot: AgentBonsaiSnapshot, width = 200, hyperlinks = false): readonly string[] {
	return renderAgentBonsaiRows(snapshot, width, {
		theme: plainTheme,
		glyphPreset: "unicode",
		now: 1_000,
		flashTier: "off",
		flash: new FlashTracker(),
		seenIds: new Set(),
		hyperlinks,
	});
}

function renderMotion(
	snapshot: AgentBonsaiSnapshot,
	now: number,
	width = 200,
	flashTier: FlashTier = "full",
	flash = new FlashTracker(),
	glyphPreset: "unicode" | "ascii" = "unicode",
): readonly string[] {
	return renderAgentBonsaiRows(snapshot, width, {
		theme: ansiTheme,
		glyphPreset,
		now,
		flashTier,
		flash,
		seenIds: new Set(snapshot.nodes.map(node => node.id)),
		hyperlinks: false,
	});
}

function renderAscii(snapshot: AgentBonsaiSnapshot, width = 200): readonly string[] {
	return renderAgentBonsaiRows(snapshot, width, {
		theme: plainTheme,
		glyphPreset: "ascii",
		now: 1_000,
		flashTier: "off",
		flash: new FlashTracker(),
		seenIds: new Set(),
		hyperlinks: false,
	});
}

describe("Agent Bonsai state", () => {
	it("suppresses Main-only snapshots and exposes stable cohort identities in depth-first order", () => {
		const mainOnly = buildAgentBonsai([bonsaiRef("Main")]);
		expect(mainOnly.visible).toBe(false);

		const snapshot = buildAgentBonsai(
			[
				bonsaiRef("Main"),
				bonsaiRef("alpha", { createdAt: 1 }),
				bonsaiRef("nested", { parentId: "alpha", createdAt: 2 }),
				bonsaiRef("beta", { createdAt: 3 }),
			],
			{
				cohort: new Map([
					["alpha", 1],
					["nested", 2],
					["beta", 3],
				]),
			},
		);
		expect(snapshot.nodes.map(node => [node.id, node.cohortLabel])).toEqual([
			["Main", "M"],
			["alpha", "A1"],
			["nested", "A2"],
			["beta", "A3"],
		]);
		expect(snapshot.nodes[1]?.createdAt).toBe(1);
	});

	it("keeps lifecycle tombstones, caps rows, sanitizes text, and bounds activity", () => {
		const refs = [
			bonsaiRef("Main", { displayName: "Main\tAgent" }),
			...Array.from({ length: 10 }, (_, index) =>
				bonsaiRef(`sub-${index}`, {
					createdAt: index + 1,
					status: index === 0 ? "parked" : "running",
					activity: index === 1 ? "x".repeat(GIST_MAX_CHARS + 50) : undefined,
				}),
			),
		];
		const snapshot = buildAgentBonsai(refs, {
			seen: new Set(["sub-0"]),
			cohort: new Map(refs.slice(1).map((ref, index) => [ref.id, index + 1])),
		});
		expect(snapshot.nodes).toHaveLength(MAX_BONSAI_ROWS);
		expect(snapshot.hiddenCount).toBe(3);
		expect(snapshot.nodes[0]?.name).toBe("Main Agent");
		expect(snapshot.nodes[1]).toMatchObject({ id: "sub-1", status: "running" });
		expect(snapshot.nodes[1]?.gist?.length).toBe(GIST_MAX_CHARS);
		expect(buildAgentBonsai(refs.slice(0, 2), { seen: new Set(["sub-0"]) }).nodes[1]?.status).toBe("parked");
		expect(normalizeAgentLine("\u001b]52;c;secret\u0007safe\u202e😀😀😀", 6)).toBe("safe😀…");
	});

	it("preserves whitespace boundaries while removing terminal controls", () => {
		expect(normalizeAgentLine("read\nsrc/a.ts\r\nthen\ttest\rresults")).toBe("read src/a.ts then test results");
		expect(normalizeAgentLine("\x1b[31mred\x1b[0m\nnext\u0000\u202e")).toBe("red next");
	});

	it("shortens absolute context-file provenance labels without changing relative labels", () => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker")], {
			cohort: new Map([["worker", 1]]),
			provenance: new Map([
				[
					"worker",
					[
						{
							id: "global-context",
							kind: "context-file",
							label: "/Users/private/.omp/agent/AGENTS.md",
							status: "complete",
							startedAt: 1,
						},
						{
							id: "project-context",
							kind: "context-file",
							label: "packages/widget/AGENTS.md",
							status: "complete",
							startedAt: 2,
						},
					] satisfies readonly AgentProvenanceEvent[],
				],
			]),
		});

		expect(snapshot.nodes[1]?.provenance?.map(event => event.label)).toEqual([
			"AGENTS.md",
			"packages/widget/AGENTS.md",
		]);
	});

	it("preserves authoritative order when provenance events share a timestamp", () => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker")], {
			cohort: new Map([["worker", 1]]),
			provenance: new Map([
				[
					"worker",
					[
						{ id: "later", kind: "memory", label: "recall", status: "complete", startedAt: 20 },
						{ id: "z-first", kind: "skill", label: "review", status: "complete", startedAt: 10 },
						{ id: "a-second", kind: "qmd", label: "QMD query", status: "active", startedAt: 10 },
					] satisfies readonly AgentProvenanceEvent[],
				],
			]),
		});

		expect(snapshot.nodes[1]?.provenance?.map(event => event.id)).toEqual(["z-first", "a-second", "later"]);
	});
});

describe("Agent Bonsai observer and renderer", () => {
	it("builds rows from task progress, shows model plus active skill hyperlink, and keeps rotated-out skills", () => {
		const resolveSkillPath = (name: string) => `/tmp/skills/${name}/SKILL.md`;
		let changes = 0;
		const controller = new AgentBonsaiController({ onChange: () => changes++, resolveSkillPath, now: () => 5 });
		controller.mount();
		controller.noteMainModel("openai/gpt-5.6");
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [
				progressRow("worker", {
					resolvedModel: "anthropic/sonnet",
					description: "Implement the Bonsai row",
					lastIntent: "read src/agent-bonsai/widget.ts 42",
					recentTools: [skillRead("codebase-design", 20), skillRead("tdd", 10)],
				}),
			]),
		);

		const snapshot = controller.snapshot();
		const rows = render(snapshot).join("\n");
		expect(rows).toContain("anthropic/sonnet");
		expect(rows).toContain("seen-skill:codebase-design");
		expect(rows).toContain("A1 worker");
		expect(rows).toContain("src/agent-bonsai/widget.ts");
		expect(rows).toContain("Implement the Bonsai row");
		expect(changes).toBeGreaterThan(0);

		const workerNode = snapshot.nodes[1];
		if (workerNode === undefined) throw new Error("expected worker node");
		const disclosureUri = buildSkillDisclosureUri(workerNode);
		expect(disclosureUri).toStartWith("data:text/plain;charset=utf-8,");
		const disclosure = decodeURIComponent(disclosureUri?.split(",", 2)[1] ?? "");
		expect(disclosure).toMatch(/Last observed skill reference.*inferred.*codebase-design/);
		expect(disclosure).toMatch(/Observed skill references.*2/);
		expect(disclosure).toMatch(/tdd.*\/tmp\/skills\/tdd\/SKILL.md/);
		expect(disclosure).toMatch(/codebase-design.*\/tmp\/skills\/codebase-design\/SKILL.md/);

		// The host caps `recentTools` at 5, so a later update drops the skill reads
		// entirely; the accumulated set must survive that rotation.
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [
				progressRow("worker", {
					resolvedModel: "anthropic/sonnet",
					lastIntent: "write tests 3",
					recentTools: [{ tool: "write", args: "test/a.test.ts", endMs: 40 }],
				}),
			]),
		);
		const later = controller.snapshot();
		expect(render(later).join("\n")).toContain("write tests 3");
		expect(later.nodes[1]?.loadedSkills.map(skill => skill.name)).toEqual(["tdd", "codebase-design"]);

		controller.onToolExecutionUpdate(taskUpdate("call-2", [progressRow("second-worker", { status: "pending" })]));
		expect(render(controller.snapshot()).join("\n")).toContain("A2 second-worker");
		controller.dispose();
		expect(controller.snapshot().visible).toBe(false);
	});

	it("summarizes sectioned assignments through pending, running and completed rows", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined, now: scheduler.now });
		const assignments = [
			{
				id: "Parser",
				description: [
					"Complete assignment thoroughly:",
					"# Target",
					"- Input: src/parser.ts",
					"# Change",
					"- Fix parser",
					"  line boundaries.",
					"- Keep the existing API.",
					"# Acceptance",
					"- No glued tokens.",
				].join("\n"),
				summary: "Fix parser line boundaries.",
			},
			{
				id: "Paths",
				description: [
					"Work on the assigned scope only.",
					"## Target",
					"src/cache.ts",
					"Keep ownership limited to src/cache.ts; do not alter the public exports, adapter contracts, provider configuration, terminal rendering, task lifecycle, or provenance collection while making this change.",
					"## Change",
					"1. Keep src/a#b.ts",
					"   and --flag: a*b.",
					"2. Do not rename paths.",
					"## Acceptance",
					"Literal punctuation survives.",
				].join("\r\n"),
				summary: "Keep src/a#b.ts and --flag: a*b.",
			},
		];
		controller.mount();
		controller.onAgentStart();
		try {
			for (const status of ["pending", "running", "completed"] as const) {
				controller.onToolExecutionUpdate(
					taskUpdate(
						"assignment",
						assignments.map(({ id, description }) =>
							progressRow(id, {
								status,
								...(id === "Parser" ? { description } : { task: description }),
								resolvedModel: "openai/codex",
								lastIntent: status === "running" ? "Reading src/a.ts" : undefined,
								recentTools: [skillRead("tdd", 10)],
							}),
						),
					),
				);
				const snapshot = controller.snapshot();
				for (const [index, assignment] of assignments.entries()) {
					expect(snapshot.nodes[index + 1]).toMatchObject({
						id: assignment.id,
						name: assignment.id,
						cohortLabel: `A${index + 1}`,
						task: assignment.summary,
						status,
						model: "openai/codex",
						gist: status === "running" ? "Reading src/a.ts" : undefined,
						loadedSkills: [{ name: "tdd", path: "skill://tdd" }],
					});
				}
				for (const width of [45, 69, 120]) {
					const rows = render(snapshot, width);
					for (const [index, assignment] of assignments.entries()) {
						const row = rows[index + 1] ?? "";
						expect(row).toContain(`A${index + 1} ${assignment.id}`);
						expect(row).not.toMatch(
							/# (?:Target|Change|Acceptance)|assignment thoroughly|scope only|lineboundaries/,
						);
						if (status === "running") expect(row).toContain("Reading src/a.ts");
						if (width === 120) expect(row).toContain(assignment.summary);
					}
					for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			controller.dispose();
		}
	});

	it("preserves literal heading text when an observed task joins the exact roster", () => {
		const bus = new ActivityTelemetryBus();
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		bus.registerSession({
			...session,
			sessionId: "worker",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
			artifactsDir: "/sessions/root/worker",
		});
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined });
		controller.mount();
		try {
			const description = "# Change\n- # TODO: preserve this shell comment";
			controller.onToolExecutionUpdate(taskUpdate("assignment", [progressRow("worker", { description })]));
			const fallback = controller.snapshot();
			expect(fallback.nodes[1]?.task).toBe("# TODO: preserve this shell comment");
			const projected = projectActivityAgents(root.snapshot(), fallback);
			expect(projected.nodes[1]?.task).toBe("# TODO: preserve this shell comment");
			expect(render(projected, 120).join("\n")).toContain("# TODO: preserve this shell comment");
		} finally {
			controller.dispose();
		}
	});

	it("preserves prose and literal content while summarizing task sections independently of provenance", () => {
		const provenance = [
			{ id: "context", kind: "context-file", label: "src/a#b.ts", status: "complete", startedAt: 1 },
			{ id: "query", kind: "qmd", label: "# Change - a*b", status: "active", startedAt: 2 },
		] satisfies readonly AgentProvenanceEvent[];
		for (const [description, summary] of [
			[
				"Read src/a#b.ts;\nkeep a*b, --flag and # Target literal.",
				"Read src/a#b.ts; keep a*b, --flag and # Target literal.",
			],
			[
				"# Target\n- Inspect src/a#b.ts\n  without changing a*b.\n# Acceptance\nReport findings.",
				"Inspect src/a#b.ts without changing a*b.",
			],
			["### Parser repair\nFix parser\nboundaries.\n\nMore instructions.", "Fix parser boundaries."],
			["- Keep a*b and src/a#b.ts\n  with --flag.\n- Other work.", "Keep a*b and src/a#b.ts with --flag."],
			[
				"# TODO: keep this shell comment\nand its continuation",
				"# TODO: keep this shell comment and its continuation",
			],
		] as const) {
			const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker")], {
				cohort: new Map([["worker", 1]]),
				task: new Map([["worker", summarizeAgentTask(description)]]),
				provenance: new Map([["worker", provenance]]),
			});
			expect(snapshot.nodes[1]?.task).toBe(summary);
			expect(snapshot.nodes[1]?.provenance).toEqual(provenance);
			for (const width of [45, 69, 120]) {
				const rows = render(snapshot, width);
				expect(rows[1]).toContain(summary.split(" ").slice(0, 2).join(" "));
				expect(rows[2]).toContain("# Change - a*b");
				for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			}
			expect(render(snapshot, 120)[1]).toContain(summary);
		}
	});

	it("shortens home paths only in display descriptions and keeps the first ingested summary", () => {
		const scheduler = manualScheduler();
		const skillPath = "/Users/another-user/.omp/skills/tdd/SKILL.md";
		const controller = new AgentBonsaiController({ now: scheduler.now, resolveSkillPath: () => skillPath });
		const description = [
			"Complete assignment thoroughly:",
			"# Target",
			"/Users/someone/work/parser.ts",
			"# Change",
			"- Read /Users/someone/work/a#b.ts",
			"  and /home/someone-else/work/cache.ts.",
			"# Acceptance",
			"No raw assignment prompt.",
		].join("\n");
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("paths", [progressRow("worker", { description, recentTools: [skillRead("tdd", 1)] })]),
		);
		controller.onToolExecutionUpdate(
			taskUpdate("paths", [
				progressRow("worker", {
					description: "# Change\nReplace the first assignment",
					lastIntent: "read /home/third-user/work/a#b.ts",
				}),
			]),
		);
		const snapshot = controller.snapshot();
		const worker = snapshot.nodes[1];
		if (worker === undefined) throw new Error("expected worker");
		expect(worker.task).toBe("Read ~/work/a#b.ts and ~/work/cache.ts.");
		expect(worker.gist).toBe("read ~/work/a#b.ts");
		expect(worker.activeSkill?.path).toBe(skillPath);
		const disclosure = decodeURIComponent(buildSkillDisclosureUri(worker)?.split(",", 2)[1] ?? "");
		expect(disclosure).toContain(skillPath);
		for (const width of [45, 69, 120]) {
			const rows = render(snapshot, width);
			expect(rows.join("\n")).not.toMatch(/\/(?:Users|home)\//u);
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
		const label = "/Users/someone/work/AGENTS.md";
		const provenance = [
			{ id: "context", kind: "context-file", label, status: "complete", startedAt: 0 },
		] satisfies readonly AgentProvenanceEvent[];
		const projected = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker")], {
			provenance: new Map([["worker", provenance]]),
			task: new Map([["worker", worker.task ?? ""]]),
		});
		expect(projected.nodes[1]?.provenance?.[0]?.label).toBe("AGENTS.md");
		expect(provenance[0]?.label).toBe(label);
		expect(summarizeAgentTask(`# Change\nRead /home/long-user/${"directory/".repeat(100)}`)).toHaveLength(
			GIST_MAX_CHARS,
		);
		controller.onToolExecutionUpdate(
			taskUpdate("paths", [progressRow("worker", { lastIntent: `read /Users/${"user".repeat(60)}/x.ts` })]),
		);
		expect(controller.snapshot().nodes[1]?.gist).toBe("read ~/x.ts");
		controller.dispose();
	});

	it("links the inferred skill reference to its disclosure when hyperlinks are on", () => {
		const controller = new AgentBonsaiController({
			resolveSkillPath: (name: string) => `/tmp/skills/${name}/SKILL.md`,
		});
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [
				progressRow("worker", { resolvedModel: "anthropic/sonnet", recentTools: [skillRead("tdd", 20)] }),
			]),
		);
		const snapshot = controller.snapshot();
		const workerNode = snapshot.nodes[1];
		if (workerNode === undefined) throw new Error("expected worker node");
		const uri = buildSkillDisclosureUri(workerNode);
		if (uri === undefined) throw new Error("expected a disclosure uri");

		const linked = render(snapshot, 200, true).join("\n");
		expect(linked).toContain(`;${uri}\u001b\\seen-skill:tdd\u001b]8;;\u001b\\`);
		expect(linked).toMatch(/\u001b]8;id=[0-9a-f]{1,8};data:text\/plain/);

		// Same snapshot, gate off: chip text survives, escapes do not.
		const plain = render(snapshot, 200, false).join("\n");
		expect(plain).toContain("seen-skill:tdd");
		expect(plain).not.toContain("\u001b]8;");
		controller.dispose();
	});

	it("omits the skill chip when no skill is active and keeps a settled agent until the next request", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined, now: scheduler.now });
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [progressRow("plain", { resolvedModel: "openai/codex", lastIntent: "grep foo" })]),
		);
		const running = render(controller.snapshot()).join("\n");
		expect(running).toContain("openai/codex");
		expect(running).not.toContain("seen-skill:");

		controller.onToolExecutionEnd({ toolName: "task", toolCallId: "call-1", result: { details: { progress: [] } } });
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "completed" });

		// The parent consumes the result in the very next provider turn, so a
		// settled row must outlive the whole request, not the turn that spawned it.
		expect(controller.snapshot().visible).toBe(true);
		controller.onAgentEnd();
		expect(controller.snapshot().visible).toBe(true);
		scheduler.advance(FULL_FLASH_MS);

		controller.onAgentStart();
		expect(controller.snapshot().visible).toBe(false);
	});

	it("leaves a backgrounded task's agents running past its tool result and settles them from later progress", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined, now: scheduler.now });
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(taskUpdate("call-1", [progressRow("bg", { resolvedModel: "openai/codex" })]));
		controller.onToolExecutionEnd({
			toolName: "task",
			toolCallId: "call-1",
			result: { details: { progress: [progressRow("bg", { status: "running" })], async: RUNNING_JOB } },
		});
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "running" });

		controller.onToolExecutionUpdate(taskUpdate("call-1", [progressRow("bg", { status: "completed" })]));
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "completed" });
		expect(render(controller.snapshot()).join("\n")).not.toMatch(/\bdelivered\b/iu);
		controller.dispose();
	});

	it("resolves an unresolvable skill name to its skill:// url", () => {
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [progressRow("worker", { currentTool: "read", currentToolArgs: "skill://ghost" })]),
		);
		const node = controller.snapshot().nodes[1];
		expect(node?.activeSkill).toEqual({ name: "ghost", path: "skill://ghost" });
	});

	it("uses semantic lifecycle labels and never exceeds the requested width", () => {
		const snapshot = buildAgentBonsai(
			[
				bonsaiRef("Main"),
				bonsaiRef("running", { status: "running", activity: "read src/a.ts 12" }),
				bonsaiRef("one", { status: "completed", createdAt: 2 }),
				bonsaiRef("two", { status: "parked", createdAt: 3 }),
				bonsaiRef("three", { status: "aborted", createdAt: 4 }),
			],
			{
				seen: new Set(["two", "three"]),
				cohort: new Map([
					["running", 1],
					["one", 2],
					["two", 3],
					["three", 4],
				]),
			},
		);
		const rows = render(snapshot, 32);
		expect(snapshot.nodes[2]?.status).toBe("completed");
		expect(rows[2]).not.toMatch(/\bdelivered\b/iu);
		expect(rows[3]).toContain("parked");
		expect(rows[4]).toContain("aborted");
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(32);
	});

	it("fits current work before skills and models without a sibling's model padding", () => {
		const longModel = `provider/${"long-model-".repeat(8)}`;
		const refs = [
			bonsaiRef("Main"),
			bonsaiRef("worker", { activity: "Inspecting renderer output for narrow terminals" }),
			bonsaiRef("peer", { activity: "Checking status", createdAt: 2 }),
			bonsaiRef("task", { createdAt: 3 }),
		];
		const snapshot = buildAgentBonsai(refs, {
			cohort: new Map([
				["worker", 1],
				["peer", 2],
				["task", 3],
			]),
			model: new Map([
				["worker", longModel],
				["peer", "small"],
				["task", longModel],
			]),
			activeSkill: new Map([
				["worker", { name: "tdd", path: "skill://tdd" }],
				["peer", { name: "tdd", path: "skill://tdd" }],
			]),
			task: new Map([["task", "Verify narrow-width rendering"]]),
		});
		for (const width of [45, 69, 120]) {
			const rows = render(snapshot, width);
			expect(rows[1]).toContain("A1 worker");
			expect(rows[1]).toContain("Inspecting renderer");
			expect(rows[2]).toContain("A2 peer");
			expect(rows[2]).toContain("Checking status");
			expect(rows[3]).toContain("A3 task");
			expect(rows[3]).toContain("Verify narrow-width");
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
		expect(render(snapshot, 69)[2]).toContain("seen-skill:tdd");
		expect(render(snapshot, 69)[2]).toContain("small");
		expect(render(snapshot, 120)[1]).toContain("seen-skill:tdd");
		expect(render(snapshot, 200)[1]).toContain(longModel);
	});

	it("collapses a model shared by every visible node instead of repeating it on each row (daw.4)", () => {
		const refs = [
			bonsaiRef("Main"),
			bonsaiRef("worker", { activity: "Verifying boundary contract" }),
			bonsaiRef("peer", { activity: "Checking status" }),
		];
		const snapshot = buildAgentBonsai(refs, {
			cohort: new Map([
				["worker", 1],
				["peer", 2],
			]),
			model: new Map([
				["Main", "openai-codex/gpt-5.6-sol:high"],
				["worker", "openai-codex/gpt-5.6-sol:high"],
				["peer", "openai-codex/gpt-5.6-sol:high"],
			]),
		});
		expect(sharedBonsaiModel(snapshot.nodes)).toBe("openai-codex/gpt-5.6-sol:high");
		const rows = render(snapshot).join("\n");
		expect(rows).not.toContain("openai-codex/gpt-5.6-sol:high");
		expect(rows).toContain("Verifying boundary contract");
		expect(rows).toContain("Checking status");
	});

	it("keeps the per-row model chip when visible nodes diverge (daw.4)", () => {
		const refs = [bonsaiRef("Main"), bonsaiRef("worker"), bonsaiRef("peer")];
		const snapshot = buildAgentBonsai(refs, {
			cohort: new Map([
				["worker", 1],
				["peer", 2],
			]),
			model: new Map([
				["worker", "anthropic/sonnet"],
				["peer", "openai/gpt-5"],
			]),
		});
		expect(sharedBonsaiModel(snapshot.nodes)).toBeUndefined();
		const rows = render(snapshot).join("\n");
		expect(rows).toContain("anthropic/sonnet");
		expect(rows).toContain("openai/gpt-5");
	});

	it("leads each row with the differentiator ahead of the skill and model chips (daw.4)", () => {
		const refs = [bonsaiRef("Main"), bonsaiRef("worker", { activity: "Verifying boundary contract" })];
		const snapshot = buildAgentBonsai(refs, {
			cohort: new Map([["worker", 1]]),
			model: new Map([["worker", "anthropic/sonnet"]]),
			activeSkill: new Map([["worker", { name: "beads-discipline", path: "skill://beads-discipline" }]]),
		});
		const row = render(snapshot)[1] ?? "";
		const gistIndex = row.indexOf("Verifying boundary contract");
		const skillIndex = row.indexOf("seen-skill:beads-discipline");
		const modelIndex = row.indexOf("anthropic/sonnet");
		expect(gistIndex).toBeGreaterThan(0);
		expect(skillIndex).toBeGreaterThan(gistIndex);
		expect(modelIndex).toBeGreaterThan(skillIndex);
	});

	it("sprouts fixed-width glyphs, then pulses only the live marker", () => {
		const snapshot = buildAgentBonsai(
			[bonsaiRef("Main"), bonsaiRef("worker", { createdAt: 100, status: "running" })],
			{ cohort: new Map([["worker", 1]]) },
		);

		expect(renderMotion(snapshot, 100).join("\n")).toContain("○");
		expect(renderMotion(snapshot, 280).join("\n")).toContain("◐");
		expect(renderMotion(snapshot, 460).join("\n")).toContain("●");
		const crest = renderMotion(snapshot, 1_200).join("\n");
		const rest = renderMotion(snapshot, 1_850).join("\n");
		expect(stylesFor(crest, "●")).toEqual(["34/true"]);
		expect(stylesFor(rest, "●")).toEqual(["90/false"]);
		expect(stylesFor(crest, "A1 worker")).toEqual(["34/false"]);
		expect(stylesFor(rest, "A1 worker")).toEqual(["34/false"]);
		expect(Bun.stringWidth(crest)).toBe(Bun.stringWidth(rest));
	});

	it.each([
		"unicode",
		"ascii",
	] as const)("keeps %s identity, skill and fitted evidence stable across motion phases and tiers", glyphPreset => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker")], {
			cohort: new Map([["worker", 1]]),
			activeSkill: new Map([["worker", { name: "tdd", path: "skill://tdd" }]]),
			activitySteps: new Map([
				[
					"worker",
					[
						{
							id: "file",
							kind: "file",
							label: "src/long-owned-resource-directory/changed-file.ts",
							status: "active",
							startedAt: 1,
						},
					],
				],
			]),
			provenance: new Map([
				[
					"worker",
					[{ id: "qmd", kind: "qmd", label: "long observed resource reference", status: "active", startedAt: 1 }],
				],
			]),
		});
		for (const width of [45, 69, 120]) {
			const semanticRows = glyphPreset === "ascii" ? renderAscii(snapshot, width) : render(snapshot, width);
			for (const tier of ["full", "subtle", "off"] as const) {
				const flash = new FlashTracker();
				const frames = [1_200, 1_600, 1_900, 2_400].map(now =>
					renderMotion(snapshot, now, width, tier, flash, glyphPreset),
				);
				for (const rows of frames) {
					expect(semanticRows).toEqual(rows.map(row => row.replaceAll(/\x1b\[\d+m/g, "")));
					for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
					expect(stylesFor(rows[1] ?? "", "A1 worker")).toEqual(["34/false"]);
					expect(stylesFor(rows[1] ?? "", "seen-skill:tdd")).toEqual(["36/false"]);
					expect(stylesFor(rows[2] ?? "", "src/")).toEqual(["36/false"]);
					expect(stylesFor(rows[3] ?? "", "long")).toEqual(["36/false"]);
				}
				if (tier !== "full") {
					for (const frame of frames) expect(frame).toEqual(frames[0]);
				}
			}
		}
	});

	it("expires genuine identity and skill flashes without restarting them on repaint", () => {
		const refs = [bonsaiRef("Main"), bonsaiRef("worker")];
		const before = buildAgentBonsai(refs, {
			cohort: new Map([["worker", 1]]),
			activeSkill: new Map([["worker", { name: "tdd", path: "skill://tdd" }]]),
		});
		const after = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker", { displayName: "renamed" })], {
			cohort: new Map([["worker", 1]]),
			activeSkill: new Map([["worker", { name: "review", path: "skill://review" }]]),
		});
		const flash = new FlashTracker();
		renderMotion(before, 1_200, 120, "full", flash);
		for (const now of [1_300, 1_699]) {
			const row = renderMotion(after, now, 120, "full", flash)[1] ?? "";
			expect(stylesFor(row, "A1 renamed")).toEqual(["34/true"]);
			expect(stylesFor(row, "seen-skill:review")).toEqual(["34/true"]);
		}
		const fading = renderMotion(after, 1_700, 120, "full", flash)[1] ?? "";
		expect(stylesFor(fading, "seen-skill:review")).toEqual(["34/false"]);
		for (const now of [2_100, 2_400, 3_700]) {
			const row = renderMotion(after, now, 120, "full", flash)[1] ?? "";
			expect(stylesFor(row, "A1 renamed")).toEqual(["34/false"]);
			expect(stylesFor(row, "seen-skill:review")).toEqual(["36/false"]);
		}
		const offFlash = new FlashTracker();
		renderMotion(before, 1_200, 120, "off", offFlash);
		const off = renderMotion(after, 1_300, 120, "off", offFlash)[1] ?? "";
		expect(stylesFor(off, "A1 renamed")).toEqual(["34/false"]);
		expect(stylesFor(off, "seen-skill:review")).toEqual(["36/false"]);
	});

	it("separates pending, arrival and completion, then settles without renewing the announcement", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ now: scheduler.now, resolveSkillPath: () => undefined });
		const flash = new FlashTracker();
		const seenIds = new Set<string>();
		const paint = () =>
			renderAgentBonsaiRows(controller.snapshot(), 120, {
				theme: ansiTheme,
				glyphPreset: "unicode",
				now: scheduler.now(),
				flashTier: "full",
				flash,
				seenIds,
				hyperlinks: false,
			})[1] ?? "";
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("lifecycle", [progressRow("worker", { status: "pending", recentTools: [skillRead("tdd", 0)] })]),
		);
		expect(controller.snapshot().nodes[1]?.status).toBe("pending");
		expect(stylesFor(paint(), "A1 worker")).toEqual(["90/true"]);
		scheduler.advance(100);
		controller.onToolExecutionUpdate(taskUpdate("lifecycle", [progressRow("worker")]));
		expect(controller.snapshot().nodes[1]?.status).toBe("running");
		paint();
		scheduler.advance(100);
		controller.onToolExecutionUpdate(taskUpdate("lifecycle", [progressRow("worker", { status: "completed" })]));
		const landed = paint();
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "completed", completedAt: 200 });
		expect(stylesFor(landed, "○")).toEqual(["32/true"]);
		expect(stylesFor(landed, "A1 worker")).toEqual(["32/false"]);
		expect(stylesFor(landed, "seen-skill:tdd")).toEqual(["36/false"]);
		scheduler.advance(FULL_FLASH_MS - 100);
		const fading = paint();
		expect(stylesFor(fading, "○")).toEqual(["32/false"]);
		expect(flash.phase("lifecycle:worker", "status", scheduler.now(), "full")).toBeUndefined();
		scheduler.advance(100);
		controller.onToolExecutionUpdate(taskUpdate("lifecycle", [progressRow("worker", { status: "completed" })]));
		const settled = paint();
		expect(controller.snapshot().nodes[1]?.completedAt).toBe(200);
		expect(stylesFor(settled, "○")).toEqual(["90/false"]);
		expect(stylesFor(settled, "A1 worker")).toEqual(["90/false"]);
		expect(stylesFor(settled, "seen-skill:tdd")).toEqual(["90/false"]);
		expect(stylesFor(paint(), "A1 worker")).toEqual(["90/false"]);
		controller.dispose();
	});

	it("ages snapshots with motion off, retains live work and never revives an expired completion", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("expiry", [progressRow("landed", { status: "completed" }), progressRow("live")]),
		);
		scheduler.advance(299_999);
		expect(renderMotion(controller.snapshot(), scheduler.now(), 120, "off").join("\n")).toContain("A1 landed");
		scheduler.advance(1);
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main", "live"]);
		expect(renderMotion(controller.snapshot(), scheduler.now(), 120, "off").join("\n")).not.toContain("landed");
		controller.onToolExecutionUpdate(taskUpdate("expiry", [progressRow("landed", { status: "completed" })]));
		controller.onToolExecutionUpdate(taskUpdate("expiry", [progressRow("landed")]));
		scheduler.advance(1_000_000);
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main", "live"]);
		controller.dispose();
	});

	it("keeps zero-retention completions until the bounded flash ends", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ now: scheduler.now, settleSeconds: 0 });
		controller.mount();
		controller.onToolExecutionUpdate(taskUpdate("immediate", [progressRow("worker", { status: "completed" })]));
		scheduler.advance(FULL_FLASH_MS - 1);
		expect(controller.snapshot().visible).toBe(true);
		scheduler.advance(1);
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main"]);
		controller.dispose();
	});

	it("does not announce old completions on first paint and respects the subtle flash window", () => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ now: scheduler.now });
		const flash = new FlashTracker();
		controller.mount();
		controller.onToolExecutionUpdate(taskUpdate("delayed", [progressRow("worker", { status: "completed" })]));
		const landed = renderMotion(controller.snapshot(), scheduler.now(), 120, "subtle", flash)[1] ?? "";
		expect(stylesFor(landed, "○")).toEqual(["32/true"]);
		scheduler.advance(SUBTLE_FLASH_MS);
		const settled = renderMotion(controller.snapshot(), scheduler.now(), 120, "subtle", flash)[1] ?? "";
		expect(stylesFor(settled, "○")).toEqual(["90/false"]);
		scheduler.advance(FULL_FLASH_MS);
		const firstPaint = renderMotion(controller.snapshot(), scheduler.now(), 120, "full")[1] ?? "";
		expect(stylesFor(firstPaint, "○")).toEqual(["90/false"]);
		controller.dispose();
	});

	it("keeps pending and running descendants visible before settled rows at the row cap", () => {
		const scheduler = manualScheduler();
		const refs = [bonsaiRef("Main")];
		for (let index = 0; index < MAX_BONSAI_ROWS; index++) {
			refs.push(bonsaiRef(`done-${index}`, { status: "completed", completedAt: scheduler.now() }));
		}
		scheduler.advance(FULL_FLASH_MS);
		refs.push(bonsaiRef("nested-live", { parentId: "done-7", createdAt: scheduler.now() }));
		refs.push(bonsaiRef("queued", { status: "pending", createdAt: scheduler.now() }));
		for (let index = 0; index < 5; index++) refs.push(bonsaiRef(`live-${index}`, { createdAt: scheduler.now() }));
		const snapshot = buildAgentBonsai(refs);
		expect(snapshot.nodes.map(node => node.id)).toEqual([
			"Main",
			"nested-live",
			"live-0",
			"live-1",
			"live-2",
			"live-3",
			"live-4",
			"queued",
		]);
		expect(snapshot.nodes[1]).toMatchObject({ depth: 1, ancestorsLast: [] });
		expect(snapshot.hiddenCount).toBe(MAX_BONSAI_ROWS);
		for (const row of render(snapshot, 45)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(45);
	});

	it("retains terminal status and its first timestamp when progress joins the exact roster", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const worker = bus.registerSession({
			...session,
			sessionId: "worker",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
			artifactsDir: "/sessions/root/worker",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		controller.onToolExecutionUpdate(taskUpdate("exact", [progressRow("worker", { status: "failed" })]));
		const beforeCompletion = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(beforeCompletion.nodes[1]).toMatchObject({ status: "aborted", completedAt: 0 });
		scheduler.advance(100);
		worker.complete();
		scheduler.advance(2_000);
		const recent = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(recent.nodes[1]).toMatchObject({ status: "aborted", completedAt: 0 });
		expect(stylesFor(renderMotion(recent, scheduler.now())[1] ?? "", "A1 worker")).toEqual(["31/false"]);
		controller.dispose();
		worker.dispose();
		root.dispose();
	});

	it("announces roster-only completion from its actual timestamp without inventing an agent failure", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now, retentionMs: 2_000 });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const child = bus.registerSession({
			...session,
			sessionId: "worker",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
		});
		child.startTool({ toolCallId: "read", toolName: "read", args: { path: "skill://tdd" } });
		child.endTool({ toolCallId: "read", toolName: "read", isError: true });
		scheduler.advance(100);
		child.complete();
		const flash = new FlashTracker();
		const landed = projectActivityAgents(root.snapshot(), undefined);
		expect(landed.nodes[1]).toMatchObject({ status: "completed", completedAt: 100 });
		expect(landed.nodes[1]?.activitySteps?.[0]?.status).toBe("error");
		expect(landed.nodes[1]?.provenance?.[0]?.status).toBe("error");
		expect(stylesFor(renderMotion(landed, scheduler.now(), 120, "full", flash)[1] ?? "", "○")).toEqual(["32/true"]);
		scheduler.advance(FULL_FLASH_MS);
		child.complete();
		const settled = projectActivityAgents(root.snapshot(), undefined);
		expect(settled.nodes[1]?.completedAt).toBe(100);
		expect(stylesFor(renderMotion(settled, scheduler.now(), 120, "full", flash)[1] ?? "", "○")).toEqual(["90/false"]);
		expect(stylesFor(renderMotion(settled, scheduler.now())[1] ?? "", "○")).toEqual(["90/false"]);
		root.dispose();
	});

	it("keeps fallback-only work and errors while retired exact rows cannot return across requests", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now, retentionMs: 0 });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const landed = bus.registerSession({
			...session,
			sessionId: "landed",
			hasUI: false,
			sessionFile: "/sessions/root/landed.jsonl",
		});
		bus.registerSession({
			...session,
			sessionId: "live",
			hasUI: false,
			sessionFile: "/sessions/root/live.jsonl",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now, settleSeconds: 2 });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("cohort", [
				progressRow("landed", { task: "Preserve first assignment" }),
				progressRow("live"),
				progressRow("fallback-only", { status: "failed" }),
				progressRow("pending", { status: "pending" }),
			]),
		);
		landed.complete();
		const completed = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(completed.nodes.find(node => node.id === "landed")).toMatchObject({
			status: "completed",
			completedAt: 0,
			task: "Preserve first assignment",
		});
		scheduler.advance(100);
		controller.onToolExecutionUpdate(
			taskUpdate("cohort", [progressRow("landed", { status: "failed", task: "Replacement assignment" })]),
		);
		const failure = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(failure.nodes.find(node => node.id === "landed")).toMatchObject({
			status: "aborted",
			completedAt: 0,
			task: "Preserve first assignment",
		});
		scheduler.advance(FULL_FLASH_MS - 101);
		expect(
			projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.some(node => node.id === "landed"),
		).toBe(true);
		scheduler.advance(1);
		const expired = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(new Set(expired.nodes.map(node => node.id))).toEqual(
			new Set(["main", "live", "fallback-only", "pending"]),
		);
		expect(expired.nodes.find(node => node.name === "fallback-only")?.status).toBe("aborted");
		controller.onAgentStart();
		root.beginRequest();
		expect(new Set(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id))).toEqual(
			new Set(["main", "live", "pending"]),
		);
		controller.onToolExecutionUpdate(taskUpdate("cohort", [progressRow("landed")]));
		controller.onAgentStart();
		root.beginRequest();
		expect(new Set(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id))).toEqual(
			new Set(["main", "live", "pending"]),
		);
		scheduler.advance(300_000);
		expect(new Set(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id))).toEqual(
			new Set(["main", "live", "pending"]),
		);
		controller.dispose();
		root.dispose();
	});

	it("pairs fallback request cleanup with exact terminal purge even when fallback still says running", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const child = bus.registerSession({
			...session,
			sessionId: "worker",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("request", [progressRow("worker"), progressRow("fallback", { status: "completed" })]),
		);
		child.complete();
		controller.onAgentStart();
		root.beginRequest();
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main", "worker"]);
		expect(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id)).toEqual([
			"main",
		]);
		controller.onAgentStart();
		root.beginRequest();
		expect(root.snapshot().retiredAgentIds).toEqual(["worker"]);
		expect(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id)).toEqual([
			"main",
		]);
		controller.dispose();
		root.dispose();
	});

	it("keeps synchronized errors after fallback metadata expires and never extends mismatched completion deadlines", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now, retentionMs: 2_000 });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const child = bus.registerSession({
			...session,
			sessionId: "worker",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now, settleSeconds: 0 });
		controller.mount();
		controller.onToolExecutionUpdate(taskUpdate("failure", [progressRow("worker", { status: "failed" })]));
		scheduler.advance(100);
		child.complete();
		root.noteAgentOutcome("worker", "aborted", 0);
		root.noteAgentOutcome("worker", "completed", 100);
		scheduler.advance(FULL_FLASH_MS - 100);
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main"]);
		const retained = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(retained.nodes[1]).toMatchObject({ status: "aborted", completedAt: 0 });
		expect(stylesFor(renderMotion(retained, scheduler.now())[1] ?? "", "A1 worker")).toEqual(["31/false"]);
		scheduler.advance(1_999 - FULL_FLASH_MS);
		expect(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes[1]).toMatchObject({
			status: "aborted",
			completedAt: 0,
		});
		scheduler.advance(1);
		expect(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id)).toEqual([
			"main",
		]);
		scheduler.advance(100);
		expect(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id)).toEqual([
			"main",
		]);
		controller.dispose();
		root.dispose();
	});

	it("preserves truncation evidence from fallback rows without adding overlapping hidden counts", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: { skills: [], contextFiles: [] },
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate(
				"many",
				Array.from({ length: MAX_BONSAI_ROWS + 3 }, (_, index) => progressRow(`worker-${index}`)),
			),
		);
		const projected = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(projected.hiddenCount).toBe(4);
		expect(projected.visible).toBe(true);
		controller.dispose();
		root.dispose();
	});

	it("preserves observed pending through empty exact registration until a tool actually starts", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		try {
			controller.onToolExecutionUpdate(taskUpdate("queue", [progressRow("queued", { status: "pending" })]));
			expect(controller.snapshot().nodes[1]?.status).toBe("pending");
			const child = bus.registerSession({
				...session,
				sessionId: "queued",
				hasUI: false,
				sessionFile: "/sessions/root/queued.jsonl",
			});
			const queued = projectActivityAgents(root.snapshot(), controller.snapshot());
			expect(queued.nodes.find(node => node.id === "queued")?.status).toBe("pending");
			child.beginRequest();
			root.beginRequest();
			expect(
				projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.find(node => node.id === "queued")
					?.status,
			).toBe("pending");
			child.startTool({ toolCallId: "read", toolName: "read", args: { path: "/repo/input.ts" } });
			const running = projectActivityAgents(root.snapshot(), controller.snapshot());
			expect(running.nodes.find(node => node.id === "queued")?.status).toBe("running");
			expect(
				running.nodes.find(node => node.id === "queued")?.activitySteps?.some(step => step.status === "active"),
			).toBe(true);
			expect(controller.snapshot().nodes[1]?.status).toBe("pending");
			child.endTool({ toolCallId: "read", toolName: "read", isError: false });
			scheduler.advance(8_001);
			const afterTrail = projectActivityAgents(root.snapshot(), controller.snapshot());
			expect(afterTrail.nodes.find(node => node.id === "queued")?.status).toBe("running");
		} finally {
			controller.dispose();
			root.dispose();
		}
	});

	it("projects case-distinct outcomes and retains the non-retired sibling", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		bus.registerSession({
			...session,
			sessionId: "upper",
			hasUI: false,
			sessionFile: "/sessions/root/Worker.jsonl",
		});
		bus.registerSession({
			...session,
			sessionId: "lower",
			hasUI: false,
			sessionFile: "/sessions/root/worker.jsonl",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		try {
			controller.onToolExecutionUpdate(taskUpdate("upper", [progressRow("Worker")]));
			controller.onToolExecutionUpdate(taskUpdate("lower", [progressRow("worker", { status: "failed" })]));
			const projected = projectActivityAgents(root.snapshot(), controller.snapshot());
			expect(projected.nodes.find(node => node.id === "Worker")).toMatchObject({
				name: "Worker",
				status: "running",
			});
			expect(projected.nodes.find(node => node.id === "worker")).toMatchObject({
				name: "worker",
				status: "aborted",
			});
			root.noteAgentOutcome("worker", "aborted", 0);
			root.beginRequest();
			const retired = root.snapshot();
			const surviving = projectActivityAgents(retired, controller.snapshot(retired.retiredAgentIds));
			expect(surviving.nodes.filter(node => node.depth > 0).map(node => node.name)).toEqual(["Worker"]);
		} finally {
			controller.dispose();
			root.dispose();
		}
	});

	it("removes retired hidden identities from an already-capped fallback snapshot", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const names = Array.from({ length: MAX_BONSAI_ROWS + 2 }, (_, index) => `Worker-${index}`);
		const children = names.map(name =>
			bus.registerSession({
				...session,
				sessionId: name,
				hasUI: false,
				sessionFile: `/sessions/root/${name}.jsonl`,
			}),
		);
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		try {
			controller.onToolExecutionUpdate(
				taskUpdate(
					"capped",
					names.map(name => progressRow(name)),
				),
			);
			const capped = controller.snapshot();
			expect(capped.hiddenCount).toBe(3);
			expect(capped.hiddenAgentIds).toEqual(names.slice(MAX_BONSAI_ROWS - 1));
			for (const child of children) child.complete();
			root.beginRequest();
			const projected = projectActivityAgents(root.snapshot(), capped);
			expect(projected.nodes.map(node => node.id)).toEqual(["main"]);
			expect(projected.hiddenCount).toBe(0);
			expect(projected.visible).toBe(false);
			expect(render(projected).join("\n")).not.toMatch(/\+\d+ more/u);
		} finally {
			controller.dispose();
			root.dispose();
		}
	});

	it("filters retired identities before capping so hidden live rows promote without mutating the default snapshot", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const retiredNames = Array.from({ length: MAX_BONSAI_ROWS - 1 }, (_, index) => `Worker-${index}`);
		const children = retiredNames.map(name =>
			bus.registerSession({
				...session,
				sessionId: name,
				hasUI: false,
				sessionFile: `/sessions/root/${name}.jsonl`,
			}),
		);
		const liveNames = ["worker-0", "hidden-live"];
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		try {
			controller.onToolExecutionUpdate(
				taskUpdate(
					"capped",
					[...retiredNames, ...liveNames].map(name => progressRow(name)),
				),
			);
			const capped = controller.snapshot();
			expect(new Set(capped.hiddenAgentIds)).toEqual(new Set(liveNames));
			for (const child of children) child.complete();
			root.beginRequest();
			const roster = root.snapshot();
			const promoted = controller.snapshot(roster.retiredAgentIds);
			expect(new Set(promoted.nodes.filter(node => node.depth > 0).map(node => node.name))).toEqual(
				new Set(liveNames),
			);
			expect(promoted.hiddenCount).toBe(0);
			const projected = projectActivityAgents(roster, promoted);
			expect(new Set(projected.nodes.filter(node => node.depth > 0).map(node => node.name))).toEqual(
				new Set(liveNames),
			);
			expect(projected.hiddenCount).toBe(0);
			expect(projected.visible).toBe(true);
			expect(controller.snapshot()).toEqual(capped);
		} finally {
			controller.dispose();
			root.dispose();
		}
	});

	it.each(["failed", "aborted"] as const)("announces %s once and retains error color until eviction", status => {
		const scheduler = manualScheduler();
		const controller = new AgentBonsaiController({ now: scheduler.now, settleSeconds: 2 });
		const flash = new FlashTracker();
		controller.mount();
		controller.onToolExecutionUpdate(taskUpdate("failure", [progressRow("worker")]));
		renderMotion(controller.snapshot(), scheduler.now(), 120, "full", flash);
		scheduler.advance(10);
		controller.onToolExecutionUpdate(taskUpdate("failure", [progressRow("worker", { status })]));
		const landed = renderMotion(controller.snapshot(), scheduler.now(), 120, "full", flash)[1] ?? "";
		expect(stylesFor(landed, "●")).toEqual(["31/true"]);
		expect(stylesFor(landed, "A1 worker")).toEqual(["31/false"]);
		scheduler.advance(FULL_FLASH_MS);
		controller.onToolExecutionUpdate(taskUpdate("failure", [progressRow("worker", { status: "completed" })]));
		const settled = renderMotion(controller.snapshot(), scheduler.now(), 120, "full", flash)[1] ?? "";
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "aborted", completedAt: 10 });
		expect(stylesFor(settled, "●")).toEqual(["31/false"]);
		expect(stylesFor(settled, "A1 worker")).toEqual(["31/false"]);
		scheduler.advance(2_000 - FULL_FLASH_MS);
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main"]);
		controller.dispose();
	});

	it("renders each agent's recent activity as a separate fixed-width status chain", () => {
		const steps = [
			{ id: "read:tool", kind: "tool", label: "read", status: "complete", startedAt: 1 },
			{ id: "read:skill", kind: "skill", label: "tdd", status: "complete", startedAt: 1 },
			{ id: "bash:tool", kind: "tool", label: "bash", status: "error", startedAt: 2 },
			{ id: "edit:tool", kind: "tool", label: "edit", status: "active", startedAt: 3 },
			{ id: "edit:file", kind: "file", label: "src/state.ts", status: "active", startedAt: 3 },
		] satisfies readonly AgentActivityStep[];
		const snapshot = buildAgentBonsai(
			[bonsaiRef("Main"), bonsaiRef("worker", { status: "running", activity: "implementing the renderer" })],
			{
				cohort: new Map([["worker", 1]]),
				activitySteps: new Map([["worker", steps]]),
			},
		);

		const rows = render(snapshot);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toContain("implementing the renderer");
		expect(rows[1]).not.toContain("[T ");
		expect(rows[2]).toContain("read ✓ → tdd skill ✓ → bash × → edit ● → src/state.ts ●");
		expect(rows[2]).not.toContain("implementing the renderer");

		const crest = renderMotion(snapshot, 1_200)[2] ?? "";
		const rest = renderMotion(snapshot, 1_850)[2] ?? "";
		for (const row of [crest, rest]) {
			expect(stylesFor(row, "read")).toEqual(["32/false"]);
			expect(stylesFor(row, "bash")).toEqual(["31/true"]);
			expect(stylesFor(row, "edit")).toEqual(["36/false"]);
			expect(stylesFor(row, "src/state.ts")).toEqual(["36/false"]);
		}
		expect(stylesFor(crest, "●")).toEqual(["36/true"]);
		expect(stylesFor(rest, "●")).toEqual(["36/false"]);
		expect(Bun.stringWidth(crest)).toBe(Bun.stringWidth(rest));

		const narrow = render(snapshot, 36);
		const narrowActivity = narrow[2] ?? "";
		expect(narrowActivity).toContain("… → edit ● → src/state.ts ●");
		expect(narrowActivity).not.toContain("read ✓");
		for (const row of narrow) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(36);
	});

	it("keeps exact provenance in chronological order under its agent owner after activity", () => {
		const provenance = [
			{ id: "skill", kind: "skill", label: "review", status: "complete", startedAt: 10 },
			{ id: "context", kind: "context-file", label: "AGENTS.md", status: "error", startedAt: 20 },
			{ id: "memory", kind: "memory", label: "recall", status: "complete", startedAt: 30 },
			{ id: "qmd", kind: "qmd", label: "QMD query", status: "active", startedAt: 40 },
		] satisfies readonly AgentProvenanceEvent[];
		const snapshot = buildAgentBonsai(
			[
				bonsaiRef("Main"),
				bonsaiRef("worker", { status: "running", activity: "checking provenance" }),
				bonsaiRef("peer", { createdAt: 2 }),
			],
			{
				cohort: new Map([
					["worker", 1],
					["peer", 2],
				]),
				activitySteps: new Map([
					["worker", [{ id: "read", kind: "tool", label: "read", status: "complete", startedAt: 5 }]],
				]),
				provenance: new Map<string, readonly AgentProvenanceEvent[]>([
					["worker", provenance],
					["peer", [{ id: "peer-qmd", kind: "qmd", label: "peer query", status: "error", startedAt: 15 }]],
				]),
			},
		);

		const rows = render(snapshot);
		expect(rows).toHaveLength(6);
		expect(rows[2]).toContain("read ✓");
		const provenanceRow = rows[3] ?? "";
		const cells = ["read review skill ✓", "read AGENTS.md ×", "recalled memory ✓", "qmd query ●"];
		let previous = -1;
		for (const cell of cells) {
			const position = provenanceRow.indexOf(cell);
			expect(position).toBeGreaterThan(previous);
			previous = position;
		}
		expect(rows[1]).not.toContain("read review skill");
		expect(rows[2]).not.toContain("read review skill");
		expect(rows[4]).toContain("A2 peer");
		expect(rows[5]).toContain("peer query ×");
		expect(rows[5]).not.toContain("qmd query");
		expect(provenanceRow).not.toContain("peer query");

		const ascii = renderAscii(snapshot)[3] ?? "";
		previous = -1;
		for (const cell of ["read review skill +", "read AGENTS.md !", "recalled memory +", "qmd query *"]) {
			const position = ascii.indexOf(cell);
			expect(position).toBeGreaterThan(previous);
			previous = position;
		}
		expect(ascii).not.toMatch(/[⇒✓×●↳·…]/u);
	});

	it("keeps provenance styles stable except active markers and sheds oldest nodes first", () => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker", { status: "running" })], {
			cohort: new Map([["worker", 1]]),
			provenance: new Map([
				[
					"worker",
					[
						{ id: "skill", kind: "skill", label: "review", status: "complete", startedAt: 10 },
						{ id: "context", kind: "context-file", label: "AGENTS.md", status: "error", startedAt: 20 },
						{ id: "memory", kind: "memory", label: "recall", status: "complete", startedAt: 30 },
						{ id: "qmd", kind: "qmd", label: "QMD query", status: "active", startedAt: 40 },
					] satisfies readonly AgentProvenanceEvent[],
				],
			]),
		});

		const crest = renderMotion(snapshot, 1_200)[2] ?? "";
		const rest = renderMotion(snapshot, 1_850)[2] ?? "";
		for (const row of [crest, rest]) {
			expect(stylesFor(row, "review")).toEqual(["32/false"]);
			expect(stylesFor(row, "AGENTS.md")).toEqual(["31/true"]);
			expect(stylesFor(row, "recall")).toEqual(["32/false"]);
			expect(stylesFor(row, "qmd query")).toEqual(["36/false"]);
		}
		expect(stylesFor(crest, "●")).toEqual(["36/true"]);
		expect(stylesFor(rest, "●")).toEqual(["36/false"]);
		expect(Bun.stringWidth(crest)).toBe(Bun.stringWidth(rest));

		for (const width of [120, 69, 45]) {
			const row = render(snapshot, width)[2] ?? "";
			expect(row).toContain("qmd query ●");
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
		const medium = render(snapshot, 69)[2] ?? "";
		expect(medium).toContain("recalled memory ✓");
		expect(medium).not.toContain("read review skill");
		expect(medium).toContain("read AGENTS.md ×");
		const narrow = render(snapshot, 45)[2] ?? "";
		expect(narrow).toMatch(/….*recalled memory ✓.*qmd query ●/u);
		expect(narrow).not.toContain("read AGENTS.md");
	});

	it("keeps narrow provenance truncation inside the ASCII glyph set", () => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker", { status: "running" })], {
			cohort: new Map([["worker", 1]]),
			provenance: new Map([
				[
					"worker",
					[
						{
							id: "qmd",
							kind: "qmd",
							label: "a deliberately long provenance resource label",
							status: "active",
							startedAt: 10,
						},
					] satisfies readonly AgentProvenanceEvent[],
				],
			]),
		});

		const row = renderAscii(snapshot, 45)[2] ?? "";
		expect(row).toContain("a deliberately long provenance");
		expect(row).toContain("...");
		expect(row).not.toContain("…");
		expect(row).toEndWith(" *");
		expect(Bun.stringWidth(row)).toBeLessThanOrEqual(45);
	});

	it("marks older provenance as omitted when the newest resource needs truncation", () => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker", { status: "running" })], {
			cohort: new Map([["worker", 1]]),
			provenance: new Map([
				[
					"worker",
					[
						{ id: "older", kind: "skill", label: "review", status: "complete", startedAt: 10 },
						{
							id: "latest",
							kind: "qmd",
							label: "a deliberately long provenance resource label",
							status: "active",
							startedAt: 20,
						},
					] satisfies readonly AgentProvenanceEvent[],
				],
			]),
		});

		const row = render(snapshot, 45)[2] ?? "";
		expect(row).toMatch(/….*a deliberately long provenance/u);
		expect(row).toEndWith(" ●");
		expect(row).not.toContain("read review skill");
		expect(Bun.stringWidth(row)).toBeLessThanOrEqual(45);
	});

	it.each([
		"active",
		"error",
	] as const)("preserves %s evidence and omitted history when labels need fitting", status => {
		const snapshot = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("worker")], {
			cohort: new Map([["worker", 1]]),
			activitySteps: new Map([
				[
					"worker",
					[
						{ id: "older", kind: "tool", label: "read", status: "complete", startedAt: 1 },
						{ id: "latest", kind: "file", label: `src/${"renderer/".repeat(20)}`, status, startedAt: 2 },
					],
				],
			]),
			provenance: new Map([
				[
					"worker",
					[
						{ id: "older", kind: "skill", label: "review", status: "complete", startedAt: 1 },
						{ id: "latest", kind: "qmd", label: "resource ".repeat(20), status, startedAt: 2 },
					],
				],
			]),
		});
		const outcome = status === "active" ? "●" : "×";
		for (const width of [20, 45, 69, 120]) {
			const rows = render(snapshot, width);
			expect(rows[2]).toMatch(/….*→/u);
			expect(rows[2]).toEndWith(outcome);
			expect(rows[3]).toMatch(/….*resour/u);
			expect(rows[3]).toEndWith(outcome);
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
		const ascii = renderAscii(snapshot, 22);
		expect(ascii).toHaveLength(4);
		const asciiActivity = ascii[2] ?? "";
		const asciiProvenance = ascii[3] ?? "";
		expect(asciiActivity).toMatch(/\.\.\..*->/u);
		expect(asciiProvenance).toMatch(/\.\.\..*reso/u);
		for (const row of [asciiActivity, asciiProvenance]) {
			expect(row).toEndWith(status === "active" ? "*" : "!");
			expect(row).not.toContain("…");
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(22);
		}
	});

	it("late registration: progress arrives before roster registration, metadata joins by exact id", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("task1", [progressRow("East", { status: "running", resolvedModel: "claude-sonnet-4" })]),
		);
		const beforeRegistration = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(beforeRegistration.nodes.map(node => node.id)).toEqual(["main", "East"]);
		expect(beforeRegistration.nodes[1]).toMatchObject({ name: "East", model: "claude-sonnet-4" });
		const eastAgent = bus.registerSession({
			...session,
			sessionId: "East",
			hasUI: false,
			sessionFile: "/sessions/root/East.jsonl",
			artifactsDir: "/sessions/root/East",
		});
		const afterRegistration = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(afterRegistration.nodes.map(node => node.id)).toEqual(["main", "East"]);
		expect(afterRegistration.nodes[1]).toMatchObject({ name: "East", model: "claude-sonnet-4" });
		controller.dispose();
		eastAgent.dispose();
		root.dispose();
	});

	it("name reuse within one retention window: new incarnation shows fresh cohort, no metadata leak", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now, settleSeconds: 10 });
		controller.mount();
		controller.onToolExecutionUpdate(
			taskUpdate("task1", [progressRow("East", { status: "running", resolvedModel: "gpt-4o", task: "first task" })]),
		);
		controller.onToolExecutionUpdate(taskUpdate("task1", [progressRow("East", { status: "completed" })]));
		controller.onToolExecutionEnd({ toolCallId: "task1", toolName: "task", result: { state: "completed" } });
		const firstIncarnation = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(firstIncarnation.nodes[1]).toMatchObject({
			id: "East",
			name: "East",
			status: "completed",
			model: "gpt-4o",
			task: "first task",
			cohortLabel: "A1",
		});
		scheduler.advance(1000);
		controller.onToolExecutionUpdate(
			taskUpdate("task2", [
				progressRow("East", { status: "running", resolvedModel: "claude-sonnet-4", task: "second task" }),
			]),
		);
		const secondIncarnation = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(secondIncarnation.nodes.filter(node => node.name === "East")).toHaveLength(1);
		expect(secondIncarnation.nodes[1]).toMatchObject({
			id: "East",
			name: "East",
			status: "running",
			model: "claude-sonnet-4",
			task: "second task",
			cohortLabel: "A2",
		});
		expect(secondIncarnation.nodes[1].completedAt).toBeUndefined();
		controller.dispose();
		root.dispose();
	});

	it("aborted-before-register: terminal streamed row renders as streamed-only, no fallback mis-attachment", () => {
		const scheduler = manualScheduler();
		const bus = new ActivityTelemetryBus({ now: scheduler.now });
		const session = { cwd: "/repo", sessionResources: { skills: [], contextFiles: [] } };
		const root = bus.registerSession({
			...session,
			sessionId: "root",
			hasUI: true,
			artifactsDir: "/sessions/root",
		});
		const eastAgent = bus.registerSession({
			...session,
			sessionId: "East",
			hasUI: false,
			sessionFile: "/sessions/root/East.jsonl",
			artifactsDir: "/sessions/root/East",
		});
		const controller = new AgentBonsaiController({ now: scheduler.now });
		controller.mount();
		controller.onToolExecutionUpdate(taskUpdate("task1", [progressRow("West", { status: "aborted" })]));
		controller.onToolExecutionEnd({
			toolCallId: "task1",
			toolName: "task",
			result: { state: "error" },
			isError: true,
		});
		const snapshot = projectActivityAgents(root.snapshot(), controller.snapshot());
		expect(snapshot.nodes.map(node => node.id)).toEqual(["main", "West", "East"]);
		expect(snapshot.nodes[1]).toMatchObject({ id: "West", name: "West", status: "aborted" });
		const eastNode = snapshot.nodes.find(node => node.id === "East");
		expect(eastNode).toBeDefined();
		expect(eastNode?.status).not.toBe("aborted");
		controller.dispose();
		eastAgent.dispose();
		root.dispose();
	});
});

describe("Agent Bonsai task progress adapter", () => {
	it("separates a non-task payload from an empty progress list and tolerates malformed rows", () => {
		expect(extractTaskProgress(undefined)).toBeUndefined();
		expect(extractTaskProgress({ details: {} })).toBeUndefined();
		expect(extractTaskProgress({ details: { progress: [] } })).toEqual([]);
		expect(
			extractTaskProgress({
				details: {
					progress: [
						{ id: "keep", status: "running" },
						{ id: "", status: "running" },
						{ id: "bad-status", status: "sleeping" },
						"nonsense",
					],
				},
			}),
		).toEqual([{ id: "keep", status: "running", index: 0 }]);
	});

	it("reads a skill name only from a skill:// read and orders accumulated names oldest first", () => {
		expect(skillNameFromToolArgs("read", "skill://tdd")).toBe("tdd");
		expect(skillNameFromToolArgs("read", "skill://macOS/seatbelt-sandboxer")).toBe("seatbelt-sandboxer");
		expect(skillNameFromToolArgs("read", "src/tdd.ts")).toBeUndefined();
		expect(skillNameFromToolArgs("write", "skill://tdd")).toBeUndefined();
		expect(skillNameFromToolArgs("read", undefined)).toBeUndefined();
		expect(
			skillNamesFromProgress(
				progressRow("worker", {
					recentTools: [skillRead("second", 20), { tool: "grep", args: "foo", endMs: 15 }, skillRead("first", 10)],
					currentTool: "read",
					currentToolArgs: "skill://third",
				}),
			),
		).toEqual(["first", "second", "third"]);
	});
});

describe("Agent Bonsai skill path resolver", () => {
	it("prefers project roots over user roots", () => {
		const roots = skillRoots("/work/repo", "/home/dev");
		expect(roots[0]).toBe(path.join("/work/repo", ".omp", "skills"));
		expect(roots).toContain(path.join("/home/dev", ".omp", "agent", "managed-skills"));
		expect(roots.indexOf(path.join("/work/repo", ".claude", "skills"))).toBeLessThan(
			roots.indexOf(path.join("/home/dev", ".agents", "skills")),
		);
	});

	it("finds direct and one-level-nested SKILL.md files and caches misses", async () => {
		const cwd = path.join(os.tmpdir(), `bonsai-skills-${Bun.randomUUIDv7()}`);
		const direct = path.join(cwd, ".omp", "skills", "tdd", "SKILL.md");
		const nested = path.join(cwd, ".omp", "skills", "macOS", "seatbelt-sandboxer", "SKILL.md");
		await Bun.write(direct, "# tdd\n");
		await Bun.write(nested, "# seatbelt\n");
		mkdirSync(path.join(cwd, ".agents", "skills"), { recursive: true });

		const resolve = createSkillPathResolver(cwd, path.join(cwd, "home"));
		expect(resolve("tdd")).toBe(direct);
		expect(resolve("seatbelt-sandboxer")).toBe(nested);
		expect(resolve("ghost")).toBeUndefined();
		// Second lookup must come from cache, so deleting the tree cannot change it.
		await Bun.$`rm -rf ${cwd}`.quiet().nothrow();
		expect(resolve("tdd")).toBe(direct);
		expect(resolve("ghost")).toBeUndefined();
	});
});

describe("Agent Bonsai hyperlink gate", () => {
	it("mirrors the host's auto policy: opt-out beats force-on, then NO_COLOR, TTY, capability", () => {
		const enabled = { env: {}, isTty: true, terminalHyperlinks: true };
		expect(resolveHyperlinkSupport(enabled)).toBe(true);
		expect(resolveHyperlinkSupport({ ...enabled, terminalHyperlinks: false })).toBe(false);
		expect(resolveHyperlinkSupport({ ...enabled, isTty: false })).toBe(false);
		expect(resolveHyperlinkSupport({ ...enabled, env: { NO_COLOR: "1" } })).toBe(false);

		// Overrides beat both the capability and the TTY requirement.
		expect(
			resolveHyperlinkSupport({ env: { PI_FORCE_HYPERLINKS: "1" }, isTty: false, terminalHyperlinks: false }),
		).toBe(true);
		expect(
			resolveHyperlinkSupport({
				env: { PI_FORCE_HYPERLINKS: "1", PI_NO_HYPERLINKS: "1" },
				isTty: true,
				terminalHyperlinks: true,
			}),
		).toBe(false);
	});
});

describe("Agent Bonsai sibling dedupe", () => {
	const resolveSkillPath = () => undefined;
	const render = (snapshot: AgentBonsaiSnapshot) =>
		renderAgentBonsaiRows(snapshot, 120, {
			theme: plainTheme,
			glyphPreset: "unicode",
			now: 5,
			flashTier: "off",
			hyperlinks: false,
		});

	it("renders identical task text once per sibling run", () => {
		const controller = new AgentBonsaiController({ onChange: () => {}, resolveSkillPath, now: () => 5 });
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [
				progressRow("A", { status: "completed", description: "Parse config file" }),
				progressRow("B", { status: "completed", description: "Parse config file" }),
			]),
		);
		const snapshot = controller.snapshot();
		const rows = render(snapshot);

		const a1Row = rows.find(r => r.includes("A1 A"));
		const a2Row = rows.find(r => r.includes("A2 B"));
		expect(a1Row).toContain("Parse config file");
		expect(a2Row).not.toContain("Parse config file");
	});

	it("renders different task text on both siblings", () => {
		const controller = new AgentBonsaiController({ onChange: () => {}, resolveSkillPath, now: () => 5 });
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [
				progressRow("A", { status: "completed", description: "Parse config file" }),
				progressRow("B", { status: "completed", description: "Validate schema" }),
			]),
		);
		const snapshot = controller.snapshot();
		const rows = render(snapshot);

		const a1Row = rows.find(r => r.includes("A1 A"));
		const a2Row = rows.find(r => r.includes("A2 B"));
		expect(a1Row).toContain("Parse config file");
		expect(a2Row).toContain("Validate schema");
	});

	it("does not dedupe identical tasks across different depths", () => {
		const refs = [
			bonsaiRef("Main"),
			bonsaiRef("A1", { parentId: "Main" }),
			bonsaiRef("B1", { parentId: "A1" }),
			bonsaiRef("B2", { parentId: "A1" }),
		];
		const snapshot = buildAgentBonsai(refs, {
			task: new Map([
				["A1", "Load data"],
				["B1", "Load data"],
				["B2", "Load data"],
			]),
		});
		const rows = render(snapshot);

		const a1Row = rows.find(r => r.includes("A1"));
		const b1Row = rows.find(r => r.includes("B1"));
		const b2Row = rows.find(r => r.includes("B2"));
		expect(a1Row).toContain("Load data");
		expect(b1Row).toContain("Load data");
		expect(b2Row).not.toContain("Load data");
	});

	it("dedupes model chips for sibling runs when Main differs", () => {
		const controller = new AgentBonsaiController({ onChange: () => {}, resolveSkillPath, now: () => 5 });
		controller.mount();
		controller.noteMainModel("openai/gpt-5");
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [
				progressRow("A", { resolvedModel: "anthropic/sonnet" }),
				progressRow("B", { resolvedModel: "anthropic/sonnet" }),
			]),
		);
		const snapshot = controller.snapshot();
		const rows = render(snapshot);

		const a1Row = rows.find(r => r.includes("A1 A"));
		const a2Row = rows.find(r => r.includes("A2 B"));
		expect(a1Row).toContain("anthropic/sonnet");
		expect(a2Row).not.toContain("anthropic/sonnet");
	});

	it("preserves task text for single siblings", () => {
		const controller = new AgentBonsaiController({ onChange: () => {}, resolveSkillPath, now: () => 5 });
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(taskUpdate("call-1", [progressRow("worker", { description: "Build index" })]));
		const snapshot = controller.snapshot();
		const rows = render(snapshot);

		const a1Row = rows.find(r => r.includes("A1 worker"));
		expect(a1Row).toContain("Build index");
	});
});

describe("Agent Bonsai collision chip", () => {
	const eastRow = (snapshot: AgentBonsaiSnapshot, width = 120) =>
		render(snapshot, width).find(row => row.includes("East")) ?? "";

	it("differs from the plain row by exactly the write-clash chip", () => {
		const plain = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("East")], {});
		const colliding = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("East")], { collisions: new Set(["East"]) });
		expect(eastRow(colliding)).toContain("write-clash");
		expect(eastRow(colliding).replace("  write-clash", "")).toBe(eastRow(plain));
		expect(eastRow(plain)).not.toContain("write-clash");
	});

	it("keeps the chip at the narrowest assembled candidate", () => {
		const colliding = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("East")], { collisions: new Set(["East"]) });
		expect(eastRow(colliding, 45)).toContain("write-clash");
	});

	it("returns to the plain row once the collision clears", () => {
		const colliding = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("East")], { collisions: new Set(["East"]) });
		const cleared = buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("East")], { collisions: new Set() });
		expect(eastRow(colliding)).toContain("write-clash");
		expect(eastRow(cleared)).toBe(eastRow(buildAgentBonsai([bonsaiRef("Main"), bonsaiRef("East")], {})));
	});

	it("never claims a collision from a streamed-only controller snapshot", () => {
		const controller = new AgentBonsaiController({ now: () => 10 });
		controller.onAgentStart();
		controller.onToolExecutionUpdate(taskUpdate("task-1", [progressRow("worker")]));
		expect(controller.snapshot().nodes.map(node => node.collision)).toEqual([undefined, undefined]);
		expect(render(controller.snapshot(), 120).join("\n")).not.toContain("write-clash");
		controller.dispose();
	});
});
