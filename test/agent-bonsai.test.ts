import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	type AgentBonsaiRef,
	type AgentBonsaiSnapshot,
	buildAgentBonsai,
	GIST_MAX_CHARS,
	MAX_BONSAI_ROWS,
	normalizeAgentLine,
} from "../src/agent-bonsai/state";
import { buildSkillDisclosureUri, renderAgentBonsaiRows } from "../src/agent-bonsai/widget";
import { FlashTracker } from "../src/animations-box/status-line";

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
		expect(snapshot.nodes[1]).toMatchObject({ status: "parked", model: undefined });
		expect(snapshot.nodes[2]?.gist?.length).toBe(GIST_MAX_CHARS);
		expect(normalizeAgentLine("\u001b]52;c;secret\u0007safe\u202e😀😀😀", 6)).toBe("safe😀…");
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
		expect(rows).toContain("skill:codebase-design");
		expect(rows).toContain("A1 worker");
		expect(rows).toContain("src/agent-bonsai/widget.ts");
		expect(rows).toContain("Implement the Bonsai row");
		expect(changes).toBeGreaterThan(0);

		const workerNode = snapshot.nodes[1];
		if (workerNode === undefined) throw new Error("expected worker node");
		const disclosureUri = buildSkillDisclosureUri(workerNode);
		expect(disclosureUri).toStartWith("data:text/plain;charset=utf-8,");
		const disclosure = decodeURIComponent(disclosureUri?.split(",", 2)[1] ?? "");
		expect(disclosure).toContain("Active skill: codebase-design");
		expect(disclosure).toContain("Loaded skills (2):");
		expect(disclosure).toContain("- tdd — /tmp/skills/tdd/SKILL.md");
		expect(disclosure).toContain("- codebase-design — /tmp/skills/codebase-design/SKILL.md");

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

	it("wraps the active-skill chip in an OSC 8 link to its disclosure when hyperlinks are on", () => {
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
		expect(linked).toContain(`;${uri}\u001b\\skill:tdd\u001b]8;;\u001b\\`);
		expect(linked).toMatch(/\u001b]8;id=[0-9a-f]{1,8};data:text\/plain/);

		// Same snapshot, gate off: chip text survives, escapes do not.
		const plain = render(snapshot, 200, false).join("\n");
		expect(plain).toContain("skill:tdd");
		expect(plain).not.toContain("\u001b]8;");
		controller.dispose();
	});

	it("omits the skill chip when no skill is active and keeps a settled agent until the next request", () => {
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined });
		controller.mount();
		controller.onAgentStart();
		controller.onToolExecutionUpdate(
			taskUpdate("call-1", [progressRow("plain", { resolvedModel: "openai/codex", lastIntent: "grep foo" })]),
		);
		const running = render(controller.snapshot()).join("\n");
		expect(running).toContain("openai/codex");
		expect(running).not.toContain("skill:");

		controller.onToolExecutionEnd({ toolName: "task", toolCallId: "call-1", result: { details: { progress: [] } } });
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "idle" });

		// The parent consumes the result in the very next provider turn, so a
		// settled row must outlive the whole request, not the turn that spawned it.
		expect(controller.snapshot().visible).toBe(true);
		controller.onAgentEnd();
		expect(controller.snapshot().visible).toBe(true);

		controller.onAgentStart();
		expect(controller.snapshot().visible).toBe(false);
	});

	it("leaves a backgrounded task's agents running past its tool result and settles them from later progress", () => {
		const controller = new AgentBonsaiController({ resolveSkillPath: () => undefined });
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
		expect(controller.snapshot().nodes[1]).toMatchObject({ status: "idle" });
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
				bonsaiRef("delivered", { status: "idle", createdAt: 2 }),
				bonsaiRef("parked", { status: "parked", createdAt: 3 }),
				bonsaiRef("aborted", { status: "aborted", createdAt: 4 }),
			],
			{
				seen: new Set(["parked", "aborted"]),
				cohort: new Map([
					["running", 1],
					["delivered", 2],
					["parked", 3],
					["aborted", 4],
				]),
			},
		);
		const rows = render(snapshot, 32);
		expect(rows.join("\n")).toContain("delivered");
		expect(rows.join("\n")).toContain("parked");
		expect(rows.join("\n")).toContain("aborted");
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(32);
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
