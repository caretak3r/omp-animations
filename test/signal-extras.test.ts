import { describe, expect, it } from "bun:test";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { type ActivityRosterSnapshot, ActivityTelemetryBus } from "../src/activity-roster";
import { renderStatusLine } from "../src/animations-box/status-line";
import { TemporalEvidenceStore } from "../src/animations-box/temporal-evidence";
import {
	buildDarkroomTitle,
	buildSignalExtraSegments,
	DEFAULT_SIGNAL_EXTRAS_CONFIG,
	resolveSignalExtrasConfig,
	SignalExtrasState,
} from "../src/signal-extras";

function renderSignals(state: SignalExtrasState, now = 0, roster?: ActivityRosterSnapshot) {
	const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(now);
	return buildSignalExtraSegments(
		state.snapshot(),
		DEFAULT_SIGNAL_EXTRAS_CONFIG,
		now,
		evidence,
		{
			unicode: true,
			reducedMotion: false,
		},
		roster,
	);
}

function skillRoster(rootSkills: readonly string[], childSkills: readonly string[] = []): ActivityRosterSnapshot {
	let now = 0;
	const bus = new ActivityTelemetryBus({ now: () => now });
	const root = bus.registerSession({
		sessionId: "root",
		hasUI: true,
		cwd: "/repo",
		artifactsDir: "/sessions/root",
		sessionResources: {
			skills: [{ name: "installed-only", description: "available but unused", path: "skills/installed-only" }],
			contextFiles: [],
		},
	});
	const actors = [{ actor: root, skills: rootSkills }];
	if (childSkills.length > 0) {
		actors.push({
			actor: bus.registerSession({
				sessionId: "child",
				hasUI: false,
				cwd: "/repo",
				sessionFile: "/sessions/root/child.jsonl",
				sessionResources: { skills: [], contextFiles: [] },
			}),
			skills: childSkills,
		});
	}
	for (const [actorIndex, { actor, skills }] of actors.entries()) {
		for (const [skillIndex, skill] of skills.entries()) {
			now++;
			const toolCallId = `skill-${actorIndex}-${skillIndex}`;
			actor.startTool({ toolCallId, toolName: "read", args: { path: `skill://${skill}` } });
			actor.endTool({ toolCallId, toolName: "read", isError: false });
		}
	}
	return root.snapshot();
}

function exactResourceRoster(): ActivityRosterSnapshot {
	let now = 0;
	const bus = new ActivityTelemetryBus({ now: () => now });
	const root = bus.registerSession({
		sessionId: "root",
		hasUI: true,
		cwd: "/repo",
		artifactsDir: "/sessions/root",
		sessionResources: { skills: [], contextFiles: [{ path: "/repo/AGENTS.md" }] },
	});
	const child = bus.registerSession({
		sessionId: "child",
		hasUI: false,
		cwd: "/repo",
		sessionFile: "/sessions/root/worker.jsonl",
		sessionResources: { skills: [], contextFiles: [{ path: "/repo/AGENTS.md" }] },
	});
	const uses = [
		{ actor: root, id: "recall-1", tool: "recall", args: {} },
		{ actor: root, id: "recall-2", tool: "recall", args: {} },
		{ actor: root, id: "reflect-1", tool: "reflect", args: {} },
		{ actor: root, id: "retain-1", tool: "retain", args: {} },
		{ actor: root, id: "context-1", tool: "read", args: { path: "/repo/AGENTS.md" } },
		{ actor: root, id: "context-2", tool: "read", args: { path: "/repo/AGENTS.md" } },
		{ actor: child, id: "context-3", tool: "read", args: { path: "/repo/AGENTS.md" } },
		{ actor: child, id: "qmd-1", tool: "mcp__qmd_query", args: { query: "PRIVATE_QUERY" } },
		{ actor: child, id: "qmd-2", tool: "mcp__qmd_query", args: { query: "PRIVATE_QUERY" } },
	];
	for (const use of uses) {
		now++;
		use.actor.startTool({ toolCallId: use.id, toolName: use.tool, args: use.args });
		use.actor.endTool({ toolCallId: use.id, toolName: use.tool, isError: false });
	}
	return root.snapshot();
}

function mixedContextRoster(): ActivityRosterSnapshot {
	let now = 0;
	const bus = new ActivityTelemetryBus({ now: () => now });
	const root = bus.registerSession({
		sessionId: "root",
		hasUI: true,
		cwd: "/repo",
		artifactsDir: "/sessions/root",
		sessionResources: {
			skills: [],
			contextFiles: [{ path: "/repo/AGENTS.md" }, { path: "/repo/PROJECT📚.md" }],
		},
	});
	for (const [index, path] of ["/repo/AGENTS.md", "/repo/PROJECT📚.md"].entries()) {
		now++;
		const toolCallId = `context-${index}`;
		root.startTool({ toolCallId, toolName: "read", args: { path } });
		root.endTool({ toolCallId, toolName: "read", isError: false });
	}
	return root.snapshot();
}

function externalContextRoster(): ActivityRosterSnapshot {
	const externalPaths = ["/Users/alice/private/AGENTS.md", "/Users/bob/secret/AGENTS.md"];
	const bus = new ActivityTelemetryBus({ now: () => 1 });
	const root = bus.registerSession({
		sessionId: "root",
		hasUI: true,
		cwd: "/repo",
		artifactsDir: "/sessions/root",
		sessionResources: { skills: [], contextFiles: externalPaths.map(path => ({ path })) },
	});
	for (const [index, path] of externalPaths.entries()) {
		const toolCallId = `context-external-${index}`;
		root.startTool({ toolCallId, toolName: "read", args: { path } });
		root.endTool({ toolCallId, toolName: "read", isError: false });
	}
	return root.snapshot();
}

function readyMemoryState(): SignalExtrasState {
	const state = new SignalExtrasState();
	state.noteMemoryPollSuccess(
		0,
		{
			backend: "mnemopi",
			active: true,
			writable: true,
			searchable: true,
			scope: "project",
		},
		100,
	);
	return state;
}

describe("signal extras settings", () => {
	it("uses curated defaults while plugin settings continue to override environment values", () => {
		const config = resolveSignalExtrasConfig(
			{ retryRadar: false },
			{
				OMP_ANIMATIONS_RETRY_RADAR: "true",
				OMP_ANIMATIONS_THINK_ACT_LISSAJOUS: "true",
			},
		);
		expect(config.retryRadar).toBeFalse();
		expect(config.liveFiles).toBeTrue();
		expect(config.thinkActLissajous).toBeTrue();
		expect(config.goalHeading).toBeFalse();
		expect(config.darkroomTitle).toBeFalse();

		const enabled = resolveSignalExtrasConfig({ goalHeading: true }, { OMP_ANIMATIONS_DARKROOM_TITLE: "true" });
		expect(enabled.thinkActLissajous).toBeFalse();
		expect(enabled.goalHeading).toBeTrue();
		expect(enabled.darkroomTitle).toBeTrue();
	});
});

describe("SignalExtrasState", () => {
	it("keeps the sidecar at zero rows until a signal is meaningful", () => {
		const state = new SignalExtrasState();
		expect(renderSignals(state)).toEqual([]);
	});

	it("shows plain repeat copy only when the latest tool sequence matches", () => {
		const state = new SignalExtrasState();
		state.onTurnStart();
		state.onToolCall("read");
		state.onToolCall("edit");
		state.onTurnEnd(1);
		expect(state.snapshot().recurrence).toBeUndefined();

		state.onTurnStart();
		state.onToolCall("read");
		state.onToolCall("edit");
		state.onTurnEnd(11);

		expect(state.snapshot().recurrence).toEqual({ turns: 2, observedAt: 11 });
		const row = renderSignals(state, 20)[0];
		expect(row?.id).toBe("recurrenceStrip");
		expect(row?.line.label).toBe("repeat");
		expect(row?.line.spans.map(span => span.text)).toEqual(["same tools as previous turn"]);
		expect(row?.line.activity).toBeTrue();
		expect(renderSignals(state, 2_000)[0]?.line.activity).toBeFalse();
		state.onTurnStart();
		expect(state.snapshot().recurrence).toBeUndefined();
	});

	it("summarizes recent successful skill reads across root and child agents", () => {
		const state = new SignalExtrasState();
		const roster = skillRoster(["tdd", "qmd-query", "tdd"], ["research", "tdd"]);

		const used = renderSignals(state, 40, roster).find(row => row.id === "skillChromatograph");
		expect(used?.line.label).toBe("skills");
		expect(used?.line.spans.map(span => span.text)).toEqual([
			expect.stringMatching(/recent read ×3 tdd/u),
			expect.stringMatching(/recent read ×1 qmd-query/u),
			expect.stringMatching(/recent read ×1 research/u),
			expect.stringMatching(/available ×1/u),
		]);
		expect(used?.variants.at(-1)).toMatch(/recent read ×5/u);
		expect(JSON.stringify(used)).not.toContain("installed-only");
	});

	it("does not turn catalog availability into an observed skill read", () => {
		const state = new SignalExtrasState();

		expect(renderSignals(state, 20, skillRoster([])).map(row => row.id)).not.toContain("skillChromatograph");
	});

	it("uses the ASCII count marker for exact skill reads", () => {
		const state = new SignalExtrasState();
		const roster = skillRoster(["diagnosing-bugs", "diagnosing-bugs"]);
		const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(20);
		const ascii = buildSignalExtraSegments(
			state.snapshot(),
			DEFAULT_SIGNAL_EXTRAS_CONFIG,
			20,
			evidence,
			{ unicode: false, reducedMotion: true },
			roster,
		).find(row => row.id === "skillChromatograph");

		expect(ascii?.line.spans.map(span => span.text)).toEqual([
			expect.stringMatching(/recent read x2 diagnosing-bugs/u),
			expect.stringMatching(/available x1/u),
		]);
	});

	it("truncates exact skill-read labels by terminal display width", () => {
		const state = new SignalExtrasState();
		const row = renderSignals(state, 20, skillRoster(["diagnosing-bugs📚"])).find(
			segment => segment.id === "skillChromatograph",
		);
		if (row === undefined) throw new Error("expected an exact skill-read row");
		for (const width of [12, 18, 30, 45, 69, 120]) {
			const rendered = renderStatusLine(row.line, width, {
				theme: { fg: (_color, text) => text },
				preset: "unicode",
				colorMode: "basic",
				program: "other",
				segmentId: row.id,
				now: 20,
				flashTier: "off",
			});
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
		}
	});

	it("hides exact skill-read provenance when the skill row is disabled", () => {
		const state = new SignalExtrasState();
		const roster = skillRoster(["tdd"]);
		const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(20);
		const disabled = buildSignalExtraSegments(
			state.snapshot(),
			{ ...DEFAULT_SIGNAL_EXTRAS_CONFIG, skillChromatograph: false },
			20,
			evidence,
			{ unicode: true, reducedMotion: false },
			roster,
		);
		expect(disabled.map(row => row.id)).not.toContain("skillChromatograph");
	});

	it("renders exact memory, context, and QMD usage as a human-readable summary", () => {
		const state = readyMemoryState();
		const roster = exactResourceRoster();

		const memory = renderSignals(state, 100, roster).find(row => row.id === "memoryBackendTide");
		expect(memory?.line.label).toBe("memory");
		expect(memory?.line.spans.map(span => span.text)).toEqual([
			"ready",
			expect.stringMatching(/recent recall complete ×3/u),
			expect.stringMatching(/recent writes complete ×1/u),
			expect.stringMatching(/recent context AGENTS.md read ×3/u),
			expect.stringMatching(/recent qmd query complete ×2/u),
		]);
		expect(JSON.stringify(memory)).not.toMatch(/mnemopi|A:[?YN]|W:[?YN]|S:[?YN]|PRIVATE_QUERY/);

		const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(100);
		const ascii = buildSignalExtraSegments(
			state.snapshot(),
			DEFAULT_SIGNAL_EXTRAS_CONFIG,
			100,
			evidence,
			{ unicode: false, reducedMotion: true },
			roster,
		).find(row => row.id === "memoryBackendTide");
		expect(ascii?.line.spans.map(span => span.text)).toContainEqual(
			expect.stringMatching(/recent recall complete x3/u),
		);
	});

	it("shows no invented usage, retains the settings gate, and keeps recent exact labels width-safe", () => {
		const state = readyMemoryState();
		const idle = renderSignals(state, 100, skillRoster([])).find(row => row.id === "memoryBackendTide");
		expect(idle?.line.spans.map(span => span.text)).toEqual(["ready"]);

		const roster = mixedContextRoster();
		const recent = renderSignals(state, 100, roster).find(row => row.id === "memoryBackendTide");
		expect(recent?.line.spans.map(span => span.text)).toEqual([
			"ready",
			expect.stringMatching(/recent context read ×2/u),
			expect.stringMatching(/last read PROJECT📚\.md/u),
		]);
		if (recent === undefined) throw new Error("expected an exact memory usage row");
		for (const width of [13, 18, 24, 36, 45, 69, 120]) {
			const rendered = renderStatusLine(recent.line, width, {
				theme: { fg: (_color, text) => text },
				preset: "unicode",
				colorMode: "basic",
				program: "other",
				segmentId: recent.id,
				now: 100,
				flashTier: "off",
			});
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
		}

		const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(100);
		const disabled = buildSignalExtraSegments(
			state.snapshot(),
			{ ...DEFAULT_SIGNAL_EXTRAS_CONFIG, memoryBackendTide: false },
			100,
			evidence,
			{ unicode: true, reducedMotion: false },
			roster,
		);
		expect(disabled.map(row => row.id)).not.toContain("memoryBackendTide");
	});

	it("keeps exact external context labels privacy-safe", () => {
		const memory = renderSignals(readyMemoryState(), 100, externalContextRoster()).find(
			row => row.id === "memoryBackendTide",
		);
		expect(memory?.line.spans.map(span => span.text)).toEqual([
			"ready",
			expect.stringMatching(/recent context read ×2/u),
			expect.stringMatching(/last read AGENTS\.md/u),
		]);
		expect(JSON.stringify(memory)).not.toContain("/Users/alice/private");
		expect(JSON.stringify(memory)).not.toContain("/Users/bob/secret");
	});

	it("keeps pending and failed reads distinct from successful skill reads", () => {
		const bus = new ActivityTelemetryBus({ now: () => 1 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: { skills: [], contextFiles: [] },
		});
		const state = new SignalExtrasState();
		root.startTool({ toolCallId: "first", toolName: "read", args: { path: "skill://tdd:raw" } });
		const pending = renderSignals(state, 1, root.snapshot()).find(row => row.id === "skillChromatograph");
		expect(pending?.variants[0]).toMatch(/recent active ×1 tdd/u);
		expect(pending?.variants.join(" ")).not.toMatch(/\bread\b|\bused\b/u);

		root.endTool({ toolCallId: "first", toolName: "read", isError: true });
		root.startTool({ toolCallId: "retry", toolName: "read", args: { path: "skill://tdd:raw" } });
		const retrying = renderSignals(state, 1, root.snapshot()).find(row => row.id === "skillChromatograph");
		expect(retrying?.variants[0]).toMatch(/failed ×1.*active ×1/u);
		expect(retrying?.variants.join(" ")).not.toMatch(/\bread\b|\bused\b/u);

		root.endTool({ toolCallId: "retry", toolName: "read", isError: false });
		const settled = renderSignals(state, 1, root.snapshot()).find(row => row.id === "skillChromatograph");
		expect(settled?.variants[0]).toMatch(/failed ×1.*read ×1/u);
		expect(settled?.variants.join(" ")).not.toMatch(/active|used|applied/u);
	});

	it("labels retained outcomes as recent after older reads are evicted", () => {
		let now = 0;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: { skills: [], contextFiles: [{ path: "AGENTS.md" }] },
		});
		const state = new SignalExtrasState();
		root.startTool({ toolCallId: "old-context", toolName: "read", args: { path: "AGENTS.md" } });
		root.endTool({ toolCallId: "old-context", toolName: "read", isError: true });
		for (let index = 0; index < 32; index++) {
			now++;
			const toolCallId = `skill-${index}`;
			root.startTool({ toolCallId, toolName: "read", args: { path: "skill://tdd" } });
			root.endTool({ toolCallId, toolName: "read", isError: false });
		}
		const before = renderSignals(state, now, root.snapshot()).find(row => row.id === "skillChromatograph");
		expect(before?.variants.at(-1)).toMatch(/recent read ×32/u);
		now++;
		root.startTool({ toolCallId: "new-context", toolName: "read", args: { path: "AGENTS.md:2-4" } });
		const after = renderSignals(state, now, root.snapshot());
		expect(after.find(row => row.id === "skillChromatograph")?.variants.at(-1)).toMatch(/recent read ×31/u);
		const context = after.find(row => row.id === "memoryBackendTide");
		expect(context?.variants[0]).toMatch(/recent context active ×1/u);
		expect(context?.variants.join(" ")).not.toMatch(/failed|\bread\b|\bused\b/u);
	});

	it("separates memory, context, and QMD successes from active and failed attempts", () => {
		const bus = new ActivityTelemetryBus({ now: () => 1 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: { skills: [], contextFiles: [{ path: "AGENTS.md" }] },
		});
		const operations = [
			{ toolName: "recall", args: {}, label: "recall complete" },
			{ toolName: "read", args: { path: "AGENTS.md:raw" }, label: "context AGENTS.md read" },
			{ toolName: "mcp__qmd_query", args: {}, label: "qmd query complete" },
		];
		for (const [index, operation] of operations.entries()) {
			for (const status of ["complete", "active", "error"]) {
				const toolCallId = `${index}-${status}`;
				root.startTool({ toolCallId, toolName: operation.toolName, args: operation.args });
				if (status !== "active") {
					root.endTool({ toolCallId, toolName: operation.toolName, isError: status === "error" });
				}
			}
		}
		const row = renderSignals(readyMemoryState(), 1, root.snapshot()).find(
			segment => segment.id === "memoryBackendTide",
		);
		const spans = row?.line.spans.map(span => span.text) ?? [];
		for (const kind of ["memory", "context", "qmd"]) {
			expect(spans).toContainEqual(expect.stringMatching(new RegExp(`recent ${kind} failed ×1.*active ×1`, "u")));
		}
		for (const operation of operations) {
			expect(spans).toContainEqual(expect.stringContaining(`recent ${operation.label} ×1`));
		}
		expect(row?.variants.join(" ")).not.toMatch(/\bused\b/u);
		expect(row?.variants.at(-1)).toMatch(/recent (?:memory|context|qmd) failed ×1/u);
	});

	it("keeps resource failures ahead of readiness, successful reads, and active attempts in detailed rows", () => {
		let now = 0;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: { skills: [], contextFiles: [] },
		});
		const operations = [
			{ id: "skill-success", toolName: "read", args: { path: "skill://tdd" }, status: "complete" },
			{
				id: "skill-failure",
				toolName: "read",
				args: { path: `skill://${"long-name-".repeat(8)}` },
				status: "error",
			},
			{ id: "skill-active", toolName: "read", args: { path: "skill://waiting" }, status: "active" },
			{ id: "recall-success", toolName: "recall", args: {}, status: "complete" },
			{ id: "recall-failure", toolName: "recall", args: {}, status: "error" },
		];
		for (const operation of operations) {
			now++;
			root.startTool({ toolCallId: operation.id, toolName: operation.toolName, args: operation.args });
			if (operation.status !== "active") {
				root.endTool({
					toolCallId: operation.id,
					toolName: operation.toolName,
					isError: operation.status === "error",
				});
			}
		}
		const rows = renderSignals(readyMemoryState(), now, root.snapshot());
		for (const id of ["skillChromatograph", "memoryBackendTide"]) {
			const row = rows.find(sample => sample.id === id);
			if (row === undefined) throw new Error(`expected ${id}`);
			for (const width of [45, 69, 120]) {
				const inner = width - 4; // Audit Box border and padding.
				const rendered = renderStatusLine(row.line, inner, {
					theme: { fg: (_color, text) => text },
					preset: "unicode",
					colorMode: "basic",
					program: "other",
					segmentId: row.id,
					now,
					flashTier: "off",
				});
				expect(rendered).toMatch(id === "skillChromatograph" ? /recent failed ×1/u : /recent memory failed ×1/u);
				expect(visibleWidth(rendered)).toBeLessThanOrEqual(inner);
			}
		}
	});

	it("retains a bounded compaction scar and counts ordinary reads since compaction", () => {
		const state = new SignalExtrasState();
		state.noteContext(8_000, 6_000);
		state.noteCompactionStart(9_000);
		state.noteCompactionEnd(3_000);
		state.onToolCall("read");
		state.onToolCall("read");
		state.onToolCall("read");

		expect(state.snapshot().rewrite).toEqual({ shown: 8_000, sent: 6_000, stripped: 2_000, sentIsActual: false });
		expect(state.snapshot().scar).toEqual({ cutTokens: 6_000, rereadCount: 3 });
		const scar = renderSignals(state).find(row => row.id === "compactionScar");
		if (scar === undefined) throw new Error("expected a compaction scar");
		const phrase = scar.line.spans.map(span => span.text).join(" ");
		expect(phrase).toContain("3 reads since compact");
		for (const text of [phrase, ...scar.variants]) expect(text).not.toMatch(/re-?read/iu);
		for (let turn = 0; turn < 4; turn++) state.onTurnEnd(turn);
		expect(state.snapshot().scar).toBeUndefined();
	});

	it("marks each rewrite token count as estimated in detailed and compact output", () => {
		const state = new SignalExtrasState();
		state.noteContext(8_000, 6_000);
		const rewrite = renderSignals(state).find(row => row.id === "contextRewriteShadow");
		if (rewrite === undefined) throw new Error("expected a context rewrite");
		const phrase = rewrite.line.spans.map(span => span.text).join(" ");
		for (const text of [phrase, ...rewrite.variants]) {
			expect(text).toMatch(/shown ~8(?:\.0)?k/u);
			expect(text).toMatch(/sent ~6(?:\.0)?k/u);
			expect(text).toMatch(/stripped ~2(?:\.0)?k/u);
		}
		for (const width of [32, 120]) {
			const rendered = renderStatusLine(rewrite.line, width, {
				theme: { fg: (_color, text) => text },
				preset: "unicode",
				colorMode: "basic",
				program: "other",
				segmentId: rewrite.id,
				now: 0,
				flashTier: "off",
			});
			if (width === 32) {
				expect(rendered).toContain("stripped ~2");
			} else {
				expect(rendered).toContain("shown ~8");
				expect(rendered).not.toMatch(/(?:shown|sent|stripped) \d/u);
			}
		}
	});

	it("suppresses the rewrite row when shown is 0 or undefined", () => {
		const state = new SignalExtrasState();
		state.noteContext(0, 1000);
		expect(state.snapshot().rewrite).toBeUndefined();
		state.noteContext(undefined, 1000);
		expect(state.snapshot().rewrite).toBeUndefined();
	});

	it("suppresses the rewrite row when stripped < 512 tokens", () => {
		const state = new SignalExtrasState();
		state.noteContext(1000, 600);
		expect(state.snapshot().rewrite).toBeUndefined();
		state.noteContext(1000, 489);
		expect(state.snapshot().rewrite).toBeUndefined();
	});

	it("renders the rewrite row when stripped ≥ 512 with stripped span first", () => {
		const state = new SignalExtrasState();
		state.noteContext(2000, 1000);
		const snapshot = state.snapshot().rewrite;
		expect(snapshot).toBeDefined();
		expect(snapshot?.stripped).toBe(1000);
		const segments = renderSignals(state);
		const rewrite = segments.find(row => row.id === "contextRewriteShadow");
		expect(rewrite).toBeDefined();
		expect(rewrite?.line.spans[0].key).toBe("stripped");
		expect(rewrite?.line.spans[0].tone).toBe("notable");
	});

	it("uses provider-reported usage for sent when noteUsageSent is called", () => {
		const state = new SignalExtrasState();
		state.noteUsageSent(1200);
		state.noteContext(2000, 999);
		const snapshot = state.snapshot().rewrite;
		expect(snapshot?.sent).toBe(1200);
		expect(snapshot?.stripped).toBe(800);
		expect(snapshot?.sentIsActual).toBe(true);
		const segments = renderSignals(state);
		const rewrite = segments.find(row => row.id === "contextRewriteShadow");
		const sentSpan = rewrite?.line.spans.find(span => span.key === "sent");
		expect(sentSpan?.text).toMatch(/^sent 1/);
		expect(sentSpan?.text).not.toContain("~");
	});

	it("clears usage baseline on resetSession", () => {
		const state = new SignalExtrasState();
		state.noteUsageSent(1200);
		state.noteContext(2000, 1000);
		expect(state.snapshot().rewrite?.sent).toBe(1200);
		state.resetSession();
		state.noteContext(2000, 1000);
		expect(state.snapshot().rewrite?.sent).toBe(1000);
		expect(state.snapshot().rewrite?.sentIsActual).toBe(false);
	});

	it("shows consent, retry, and only repeated content-free errors", () => {
		const state = new SignalExtrasState();
		state.noteApprovalRequested("call", "bash");
		state.noteError();
		expect(state.snapshot().error).toBeUndefined();
		state.noteError();
		state.noteRetrySchedule(2, 4, 2_000, 100);

		const snapshot = state.snapshot();
		expect(snapshot.consent).toEqual({ tool: "bash" });
		expect(snapshot.error).toEqual({ count: 2 });
		expect(snapshot.retry).toMatchObject({ attempt: 2, maxAttempts: 4, anchorAt: 100, deadline: 2_100 });
		state.noteApprovalResolved("call");
		state.noteRetryEnd(200);
		expect(state.snapshot().consent).toBeUndefined();
		expect(state.snapshot().retry).toBeUndefined();
	});

	it("keeps authoritative timing, goal, and memory deltas", () => {
		const state = new SignalExtrasState();
		state.onTurnStart();
		state.noteAssistant(8_000, 1_000);
		state.noteAssistantTiming(1_500, 2_400);
		const privateGoal = {
			objective: "PRIVATE_GOAL_SENTINEL",
			status: "active" as const,
			tokensUsed: 2_000,
			tokenBudget: 10_000,
		};
		state.noteGoal(privateGoal);
		const privateTopology = { depth: 2, siblings: 1, node: "PRIVATE_SESSION_SENTINEL" };
		state.notePhylogeny(privateTopology);
		state.noteMemoryPollSuccess(
			0,
			{
				backend: "mnemopi",
				active: true,
				writable: true,
				searchable: true,
				scope: "project",
				workingCount: 2,
				lastRecall: false,
			},
			200,
		);
		state.noteMemoryPollSuccess(
			1,
			{
				backend: "mnemopi",
				active: true,
				writable: true,
				searchable: true,
				scope: "project",
				workingCount: 3,
				lastRecall: true,
			},
			300,
		);

		const snapshot = state.snapshot();
		expect(snapshot.assistantTiming).toEqual({ ttftMs: 1_500, durationMs: 2_400 });
		expect(snapshot.thinkAct?.shape).toBe("thinking");
		expect(snapshot.goal).toEqual({ status: "active", tokensUsed: 2_000, tokenBudget: 10_000 });
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_GOAL_SENTINEL");
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SESSION_SENTINEL");
		expect(JSON.stringify(renderSignals(state, 300))).not.toContain("PRIVATE_GOAL_SENTINEL");
		expect(snapshot.memoryTide.lastGood?.working.change).toEqual({ kind: "observed delta", amount: 1 });
		expect(snapshot.memoryTide.lastGood?.recallReportedAt).toBe(300);
		const memoryStatus = snapshot.memoryTide.lastGood?.status as { backend?: string };
		expect(() => {
			memoryStatus.backend = "mutated";
		}).toThrow();
		expect(state.snapshot().memoryTide.lastGood?.status.backend).toBe("mnemopi");
	});

	it("surfaces truncation and dropped features at count 1, tool failures at count 2", () => {
		const state = new SignalExtrasState();
		state.noteAssistantIntegrity({
			stopReason: "length",
			provider: "anthropic",
		});
		let snapshot = state.snapshot();
		expect(snapshot.error).toEqual({ count: 0, truncated: 1 });

		state.noteAssistantIntegrity({
			stopReason: "end_turn",
			provider: "anthropic",
			disabledFeatures: ["priority"],
		});
		snapshot = state.snapshot();
		expect(snapshot.error).toEqual({
			count: 0,
			truncated: 1,
			droppedFeatures: ["priority"],
		});

		state.noteError();
		expect(state.snapshot().error).toEqual({
			count: 1,
			truncated: 1,
			droppedFeatures: ["priority"],
		});

		state.noteError();
		expect(state.snapshot().error).toEqual({
			count: 2,
			truncated: 1,
			droppedFeatures: ["priority"],
		});
	});

	it("dedupes dropped features and sorts them", () => {
		const state = new SignalExtrasState();
		state.noteAssistantIntegrity({
			stopReason: "end_turn",
			provider: "openai",
			disabledFeatures: ["priority", "thinking"],
		});
		state.noteAssistantIntegrity({
			stopReason: "end_turn",
			provider: "openai",
			disabledFeatures: ["priority", "extra"],
		});
		const snapshot = state.snapshot();
		expect(snapshot.error?.droppedFeatures).toEqual(["extra", "priority", "thinking"]);
	});

	it("tracks upstream route changes: first observation renders nothing, changed route renders", () => {
		const state = new SignalExtrasState();
		state.noteAssistantIntegrity({
			stopReason: "end_turn",
			provider: "openrouter",
			upstreamProvider: "OpenAI",
		});
		expect(state.snapshot().error).toBeUndefined();

		state.noteAssistantIntegrity({
			stopReason: "end_turn",
			provider: "openrouter",
			upstreamProvider: "Anthropic",
		});
		const snapshot = state.snapshot();
		expect(snapshot.error).toEqual({ count: 0, reroutedTo: "Anthropic" });
	});

	it("clears integrity state on resetSession", () => {
		const state = new SignalExtrasState();
		state.noteAssistantIntegrity({
			stopReason: "length",
			provider: "anthropic",
			upstreamProvider: "OpenAI",
			disabledFeatures: ["priority"],
		});
		state.noteAssistantIntegrity({
			stopReason: "end_turn",
			provider: "openrouter",
			upstreamProvider: "Anthropic",
		});
		expect(state.snapshot().error).toBeDefined();

		state.resetSession();
		expect(state.snapshot().error).toBeUndefined();
	});

	it("renders retry fallback transition in retryFallback snapshot", () => {
		const state = new SignalExtrasState();
		state.noteRetryFallback("claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022");
		const snapshot = state.snapshot();
		expect(snapshot.retryFallback).toEqual({
			from: "claude-3-5-sonnet-20241022",
			to: "claude-3-5-haiku-20241022",
			succeeded: false,
		});
	});

	it("flips fallback succeeded flag when retry succeeds on fallback model", () => {
		const state = new SignalExtrasState();
		state.noteRetryFallback("modelA", "modelB");
		expect(state.snapshot().retryFallback?.succeeded).toBe(false);

		state.noteRetryFallbackSucceeded();
		expect(state.snapshot().retryFallback?.succeeded).toBe(true);
	});

	it("clears fallback on resetSession", () => {
		const state = new SignalExtrasState();
		state.noteRetryFallback("modelA", "modelB");
		expect(state.snapshot().retryFallback).toBeDefined();

		state.resetSession();
		expect(state.snapshot().retryFallback).toBeUndefined();
	});

	it("authBeacon row absent by default, present after credential disabled", () => {
		const state = new SignalExtrasState();
		expect(state.snapshot().credentialAlerts).toEqual([]);

		state.noteCredentialDisabled("anthropic");
		expect(state.snapshot().credentialAlerts).toEqual(["anthropic"]);
	});

	it("credential alerts survive resetSession", () => {
		const state = new SignalExtrasState();
		state.noteCredentialDisabled("openai");
		expect(state.snapshot().credentialAlerts).toEqual(["openai"]);

		state.resetSession();
		expect(state.snapshot().credentialAlerts).toEqual(["openai"]);
	});

	it("multiple credential alerts render sorted", () => {
		const state = new SignalExtrasState();
		state.noteCredentialDisabled("openai");
		state.noteCredentialDisabled("anthropic");
		expect(state.snapshot().credentialAlerts).toEqual(["anthropic", "openai"]);
	});

	it("provider id clamped to 24 chars in credential alerts", () => {
		const state = new SignalExtrasState();
		const longProvider = "a".repeat(30);
		state.noteCredentialDisabled(longProvider);
		expect(state.snapshot().credentialAlerts[0]).toHaveLength(24);
	});
	it("filters disabled rows and projects critical state into the terminal title", () => {
		const state = new SignalExtrasState();
		state.noteApprovalRequested("call", "bash");
		state.noteContext(4_000, 3_000);
		const config = { ...DEFAULT_SIGNAL_EXTRAS_CONFIG, consentLock: false };
		const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(0);
		const rows = buildSignalExtraSegments(state.snapshot(), config, 0, evidence, {
			unicode: true,
			reducedMotion: false,
		});
		expect(rows.map(row => row.id)).toEqual(["contextRewriteShadow"]);
		expect(
			buildDarkroomTitle(state.snapshot(), 42, {
				entries: [{ owner: "main", path: "src/a.ts", tool: "edit", startedAt: 0 }],
			}),
		).toContain("omp  WAIT  bash  ctx  42  1 writer");
	});
});

describe("Async Job Harbor", () => {
	const enabledConfig = { ...DEFAULT_SIGNAL_EXTRAS_CONFIG, asyncJobHarbor: true };
	const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(0);
	const capabilities = { unicode: true, reducedMotion: false };

	function rowFor(snapshot: AsyncJobSnapshot | null, now = 0) {
		const rows = buildSignalExtraSegments(
			new SignalExtrasState().snapshot(),
			enabledConfig,
			now,
			evidence,
			capabilities,
			undefined,
			snapshot,
		);
		return rows.find(row => row.id === "asyncJobHarbor");
	}

	it("omits an unavailable snapshot", () => {
		expect(rowFor(null)).toBeUndefined();
	});

	it("omits an empty snapshot", () => {
		expect(
			rowFor({ running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
		).toBeUndefined();
	});

	it("omits a delivered-success-only snapshot", () => {
		const row = rowFor({
			running: [],
			recent: [{ id: "1", type: "bash", status: "completed", label: "ls", startTime: 0 }],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		expect(row).toBeUndefined();
	});

	it("shows a running count", () => {
		const row = rowFor({
			running: [{ id: "1", type: "bash", status: "running", label: "ls", startTime: 0 }],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		expect(row?.line.spans).toEqual([
			{ key: "running", text: "1 running", tone: "notable" },
			{ key: "oldest", text: "oldest <1s", tone: "dim", wideOnly: true },
		]);
		expect(row?.line.dot).toBe("notable");
	});

	it("shows completed-undelivered as ready, resolved by cross-referencing pendingJobIds against recent", () => {
		const row = rowFor({
			running: [],
			recent: [{ id: "1", type: "task", status: "completed", label: "sub", startTime: 0 }],
			delivery: { queued: 1, delivering: false, pendingJobIds: ["1"] },
		});
		expect(row?.line.spans).toEqual([{ key: "ready", text: "1 ready" }]);
	});

	it("shows recent failed and cancelled counts independent of delivery status, with an alert dot and the most relevant transition", () => {
		const row = rowFor({
			running: [],
			recent: [
				{ id: "1", type: "bash", status: "failed", label: "build", startTime: 10 },
				{ id: "2", type: "task", status: "cancelled", label: "sub", startTime: 0 },
			],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		expect(row?.line.dot).toBe("alert");
		expect(row?.line.spans).toEqual([
			{ key: "failed", text: "1 failed", tone: "alert" },
			{ key: "cancelled", text: "1 cancelled", tone: "notable" },
			{ key: "last", text: "last build failed", tone: "dim", wideOnly: true },
		]);
	});

	it("marks pending IDs absent from the retained outcome window as explicitly unknown, never as ready", () => {
		const row = rowFor({
			running: [],
			recent: [{ id: "1", type: "bash", status: "failed", label: "build", startTime: 0 }],
			delivery: { queued: 3, delivering: true, pendingJobIds: ["1", "2", "3"] },
		});
		expect(row?.line.spans).toEqual([
			{ key: "failed", text: "1 failed", tone: "alert" },
			{ key: "unknown", text: "2 unknown", tone: "dim", wideOnly: true },
			{ key: "last", text: "last build failed", tone: "dim", wideOnly: true },
		]);
	});

	it("never fabricates a progress percentage or a timeout/semaphore classification", () => {
		const row = rowFor({
			running: [{ id: "1", type: "task", status: "running", label: "sub", startTime: 0 }],
			recent: [{ id: "2", type: "bash", status: "failed", label: "build", startTime: 0 }],
			delivery: { queued: 1, delivering: false, pendingJobIds: ["2"] },
		});
		const text = row?.line.spans.map(span => span.text).join(" ") ?? "";
		expect(text).not.toMatch(/%|timeout|semaphore/i);
	});

	it("shows age for running jobs with finite startTime", () => {
		const now = 5 * 60 * 1000;
		const fiveMinutesAgo = 0;
		const row = rowFor(
			{
				running: [{ id: "1", type: "task", status: "running", label: "sub", startTime: fiveMinutesAgo }],
				recent: [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			},
			now,
		);
		expect(row?.line.spans.map(s => s.key)).toContain("oldest");
		const ageSpan = row?.line.spans.find(s => s.key === "oldest");
		expect(ageSpan?.text).toBe("oldest 5m");
		expect(ageSpan?.tone).toBe("dim");
		expect(ageSpan?.wideOnly).toBe(true);
	});
	it("omits age span when startTime is non-finite", () => {
		const row = rowFor({
			running: [{ id: "1", type: "task", status: "running", label: "sub", startTime: Number.NaN }],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		expect(row?.line.spans.map(s => s.key)).not.toContain("oldest");
	});

	it("omits age span when no jobs are running", () => {
		const row = rowFor({
			running: [],
			recent: [{ id: "1", type: "bash", status: "failed", label: "build", startTime: 0 }],
			delivery: { queued: 1, delivering: false, pendingJobIds: ["1"] },
		});
		expect(row?.line.spans.map(s => s.key)).not.toContain("oldest");
	});
});

describe("Session Phylogeny", () => {
	const enabledConfig = { ...DEFAULT_SIGNAL_EXTRAS_CONFIG, sessionPhylogeny: true };
	const evidence = new TemporalEvidenceStore({ scope: { root: 0, session: 0 } }).snapshot(0);
	const capabilities = { unicode: true, reducedMotion: false };

	function treeRow(state: SignalExtrasState) {
		const rows = buildSignalExtraSegments(state.snapshot(), enabledConfig, 0, evidence, capabilities);
		return rows.find(row => row.id === "sessionPhylogeny");
	}

	it("renders off-path spend when >= half a cent", () => {
		const state = new SignalExtrasState();
		state.notePhylogeny({ depth: 5, siblings: 2, offPathCostUsd: 0.42 });
		const row = treeRow(state);
		const offPathSpan = row?.line.spans.find(s => s.key === "off-path");
		expect(offPathSpan?.text).toBe("off-path $0.42");
	});

	it("omits off-path span when below half a cent", () => {
		const state = new SignalExtrasState();
		state.notePhylogeny({ depth: 5, siblings: 2, offPathCostUsd: 0.001 });
		const row = treeRow(state);
		expect(row?.line.spans.map(s => s.key)).not.toContain("off-path");
	});

	it("omits off-path span when not provided", () => {
		const state = new SignalExtrasState();
		state.notePhylogeny({ depth: 5, siblings: 2 });
		const row = treeRow(state);
		expect(row?.line.spans.map(s => s.key)).not.toContain("off-path");
	});

	it("clears off-path spend on resetSession", () => {
		const state = new SignalExtrasState();
		state.notePhylogeny({ depth: 5, siblings: 2, offPathCostUsd: 0.42 });
		state.resetSession();
		expect(state.snapshot().phylogeny).toBeUndefined();
	});
});

describe("Verify Row", () => {
	function verifyRow(state: SignalExtrasState) {
		return renderSignals(state).find(s => s.id === "verify");
	}

	it("renders nothing when no writes have settled", () => {
		const state = new SignalExtrasState();
		expect(state.snapshot().unverifiedWrites).toBe(0);
		expect(verifyRow(state)).toBeUndefined();
	});

	it("renders N write(s) since green bash when a write settles", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		const row = verifyRow(state);
		expect(row).toBeDefined();
		expect(row?.line.dot).toBe("notable");
		expect(row?.line.spans.some(s => s.text.includes("write") && s.text.includes("bash"))).toBe(true);
		expect(row?.line.spans.some(s => s.tone === "notable")).toBe(true);
	});

	it("counts multiple writes", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		state.noteToolSettled("edit", false);
		expect(state.snapshot().unverifiedWrites).toBe(2);
		const row = verifyRow(state);
		expect(row?.line.spans.some(s => s.text.includes("2 write"))).toBe(true);
	});

	it("clears the row when a green bash settles", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		state.noteToolSettled("bash", false);
		expect(state.snapshot().unverifiedWrites).toBe(0);
		expect(verifyRow(state)).toBeUndefined();
	});

	it("keeps write unverified when bash fails", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		state.noteToolSettled("bash", true);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		expect(verifyRow(state)).toBeDefined();
	});

	it("clears with a green bash after a failed bash", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		state.noteToolSettled("bash", true);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		state.noteToolSettled("bash", false);
		expect(state.snapshot().unverifiedWrites).toBe(0);
		expect(verifyRow(state)).toBeUndefined();
	});

	it("does not count failed writes", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", true);
		expect(state.snapshot().unverifiedWrites).toBe(0);
		expect(verifyRow(state)).toBeUndefined();
	});

	it("clears on resetSession", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		state.resetSession();
		expect(state.snapshot().unverifiedWrites).toBe(0);
		expect(verifyRow(state)).toBeUndefined();
	});

	it("survives turn boundaries (onTurnStart and onTurnEnd do not clear)", () => {
		const state = new SignalExtrasState();
		state.noteToolSettled("write", false);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		state.onTurnStart();
		expect(state.snapshot().unverifiedWrites).toBe(1);
		state.onTurnEnd(0);
		expect(state.snapshot().unverifiedWrites).toBe(1);
		expect(verifyRow(state)).toBeDefined();
	});
});
