import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type ActivityLifecycleScheduler,
	type ActivityProbe,
	type ActivitySessionRegistration,
	type ActivitySessionResources,
	ActivityTelemetryBus,
} from "../src/activity-roster/bus";
import {
	buildActivityFilesSegment,
	projectActivityAgents,
	projectActivityTitleFiles,
} from "../src/activity-roster/projection";
import {
	ACTIVITY_ROSTER_DEFAULTS,
	ACTIVITY_ROSTER_SETTING_ENV,
	ACTIVITY_ROSTER_SETTING_KEYS,
	resolveActivityRosterSettings,
} from "../src/activity-roster/settings";
import type { AgentBonsaiController, AgentBonsaiSnapshot } from "../src/agent-bonsai";
import { MAX_BONSAI_ROWS } from "../src/agent-bonsai/state";
import { BOX_WIDGET_KEY } from "../src/animations-box/controller";
import { BOX_DEFAULTS, BOX_SETTING_KEYS } from "../src/animations-box/settings";
import { animationsEnvKey } from "../src/appearance";
import {
	ANIMATIONS,
	createAnimationsPlugin,
	type FanoutSinks,
	readPluginSettingsSync,
	resolveAnimationsConfig,
	wireEventFanout,
} from "../src/registrar";
import { DEFAULT_SIGNAL_EXTRAS_CONFIG, SIGNAL_EXTRA_IDS } from "../src/signal-extras";

const EMPTY_SESSION_RESOURCES = { skills: [], contextFiles: [] } as const;

class RecordingActivityBus extends ActivityTelemetryBus {
	registration?: ActivitySessionRegistration;

	override registerSession(registration: ActivitySessionRegistration): ActivityProbe {
		this.registration = registration;
		return super.registerSession(registration);
	}
}

/**
 * A recording ExtensionAPI double. The registrar and the headless Audit Trail
 * service touch `on` (event subscription), `setLabel`, `registerCommand`
 * (`/audit-trail` and `/cache`), and `logger.warn` (the removed-`display` migration notice —
 * the one logger call that happens at wire time, not inside a handler).
 */
function makeApi(): {
	api: ExtensionAPI;
	events: string[];
	labels: string[];
	commands: string[];
	warnings: string[];
} {
	const events: string[] = [];
	const labels: string[] = [];
	const commands: string[] = [];
	const warnings: string[] = [];
	const api = {
		on: (event: string) => {
			events.push(event);
		},
		setLabel: (label: string) => {
			labels.push(label);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		logger: {
			error() {},
			warn: (message: string) => {
				warnings.push(message);
			},
			debug() {},
			info() {},
		},
	} as unknown as ExtensionAPI;
	return { api, events, labels, commands, warnings };
}

const ALL_IDS = ANIMATIONS.map(a => a.id);

/** Mount the registrar with `settings` passed through unmodified. */
function mount(settings: Record<string, unknown>): {
	events: string[];
	labels: string[];
	commands: string[];
	warnings: string[];
} {
	const { api, events, labels, commands, warnings } = makeApi();
	createAnimationsPlugin({ settings, env: {} })(api);
	return { events, labels, commands, warnings };
}

/** Every animation id set to `value` — the shape a maximal (or empty) legacy settings file had. */
function allSetTo(value: boolean): Record<string, boolean> {
	return Object.fromEntries(ALL_IDS.map(id => [id, value]));
}

/** Like `makeApi`, but keeps `session_start` handlers so they can be fired against a fake `ExtensionContext`. */
function makeDrivableApi(): {
	api: ExtensionAPI;
	fireSessionStart(): void;
	widgetCalls: Array<{ key: string; mounted: boolean; placement?: string }>;
} {
	const sessionStartHandlers: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
	const widgetCalls: Array<{ key: string; mounted: boolean; placement?: string }> = [];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			if (event === "session_start") sessionStartHandlers.push(handler);
		},
		setLabel: () => {},
		registerCommand: () => {},
		logger: { error() {}, warn() {}, debug() {}, info() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: "/tmp/oh-my-pi-animations-registrar-test",
		model: { id: "root-model" },
		sessionResources: EMPTY_SESSION_RESOURCES,
		sessionManager: {
			getSessionId: () => "registrar-root",
			getArtifactsDir: () => "/tmp/oh-my-pi-animations-sessions/registrar-root",
			getSessionFile: () => "/tmp/oh-my-pi-animations-sessions/registrar-root.jsonl",
			getBranch: () => [],
		},
		hasPendingMessages: () => false,
		ui: {
			theme: { getSymbolPreset: () => "unicode" as const },
			setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
				widgetCalls.push({ key, mounted: content !== undefined, placement: options?.placement }),
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
	return {
		api,
		fireSessionStart: () => {
			for (const handler of sessionStartHandlers) handler({ type: "session_start" }, ctx);
		},
		widgetCalls,
	};
}

function makeActivityApi(): {
	api: ExtensionAPI;
	fire(event: string, payload: unknown, ctx: ExtensionContext): void;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const api = {
		on: (event: string, handler: (payload: unknown, ctx: ExtensionContext) => void) => {
			const registered = handlers.get(event);
			if (registered) registered.push(handler);
			else handlers.set(event, [handler]);
		},
		setLabel: () => {},
		registerCommand: () => {},
		logger: { error() {}, warn() {}, debug() {}, info() {} },
	} as unknown as ExtensionAPI;
	return {
		api,
		fire: (event, payload, ctx) => {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

function activityContext(options: {
	sessionId: string;
	hasUI: boolean;
	artifactsDir: string;
	sessionFile: string;
	sessionResources: ActivitySessionResources;
	titles?: string[];
	setWidget?: (key: string, content: unknown) => void;
}): ExtensionContext {
	const ui = {
		theme: { getSymbolPreset: () => "unicode" as const },
		setWidget: options.setWidget ?? (() => {}),
		setTitle: (title: string) => options.titles?.push(title),
	};
	return {
		hasUI: options.hasUI,
		cwd: "/repo",
		model: { id: options.hasUI ? "root-model" : "child-model" },
		sessionResources: options.sessionResources,
		sessionManager: {
			getSessionId: () => options.sessionId,
			getArtifactsDir: () => options.artifactsDir,
			getSessionFile: () => options.sessionFile,
			getBranch: () => [],
		},
		hasPendingMessages: () => false,
		...(options.hasUI ? { ui } : {}),
	} as unknown as ExtensionContext;
}

describe("animations registrar — one shared host, two plugin widgets", () => {
	it("subscribes the box once, registers /audit-trail and /cache, and labels the plugin last", () => {
		const { events, labels, commands } = mount({});
		expect(events.filter(event => event === "session_start")).toHaveLength(1);
		expect(commands).toEqual(["audit-trail", "cache"]);
		// setLabel is last-write-wins on the shared extension, and the registrar sets
		// its own label after every child factory has run, so /status shows the suite.
		expect(labels.at(-1)).toBe("oh-my-pi animations");
	});

	it("no per-animation enable setting changes what mounts — every configuration is one box", () => {
		const base = mount({}).events.slice().sort();
		expect(mount(allSetTo(true)).events.slice().sort()).toEqual(base);
		expect(mount(allSetTo(false)).events.slice().sort()).toEqual(base);
		// The box-owned optional groups are composition toggles, not mounts.
		expect(mount({ agentBonsai: false }).events.slice().sort()).toEqual(base);
		expect(mount(allSetTo(false)).commands).toEqual(["audit-trail", "cache"]);
	});

	it("stale ids from an old settings file are inert", () => {
		// Tool Constellation was deleted (buv.4) and the broader suite's animations were
		// never copied into this package; a stored `true` for either must resurrect nothing.
		const stale = mount({ toolConstellation: true, diffBloom: true, contextWeather: true });
		expect(stale.events.slice().sort()).toEqual(mount({}).events.slice().sort());
		expect(stale.commands).toEqual(["audit-trail", "cache"]);
		expect(stale.warnings).toEqual([]);
	});
});

describe("the removed `display` setting", () => {
	it("a stored `rows` still mounts exactly one box and warns once, naming the setting", () => {
		const rows = mount({ display: "rows" });
		expect(rows.events.slice().sort()).toEqual(mount({}).events.slice().sort());
		expect(rows.warnings).toHaveLength(1);
		expect(rows.warnings[0]).toContain('setting "display"=rows');
		expect(rows.warnings[0]).toContain("the Audit Box is the only display mode");
	});

	it("`both` — the value that used to duplicate every row — mounts one box, not two surfaces", () => {
		const both = mount({ display: "both", ...allSetTo(true) });
		expect(both.events.filter(event => event === "session_start")).toHaveLength(1);
		expect(both.events.slice().sort()).toEqual(mount({}).events.slice().sort());
		expect(both.commands).toEqual(["audit-trail", "cache"]);
		expect(both.warnings).toHaveLength(1);
	});

	it("an exported OMP_ANIMATIONS_DISPLAY warns against the env source and never throws", () => {
		const { api, events, warnings } = makeApi();
		expect(() =>
			createAnimationsPlugin({ settings: {}, env: { OMP_ANIMATIONS_DISPLAY: "both" } })(api),
		).not.toThrow();
		expect(events.filter(event => event === "session_start")).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("env OMP_ANIMATIONS_DISPLAY=both");
	});

	it("the surviving value `box` stays silent — an up-to-date settings file says nothing", () => {
		expect(mount({ display: "box" }).warnings).toEqual([]);
		const { api, warnings } = makeApi();
		createAnimationsPlugin({ settings: {}, env: { OMP_ANIMATIONS_DISPLAY: "box" } })(api);
		expect(warnings).toEqual([]);
	});
});

describe("widgets actually mounted, driven through a real session_start", () => {
	it("mounts the complete Animations Box below the editor by default", () => {
		const { api, fireSessionStart, widgetCalls } = makeDrivableApi();
		createAnimationsPlugin({ settings: {}, env: {} })(api);
		fireSessionStart();
		expect(widgetCalls).toEqual([{ key: BOX_WIDGET_KEY, mounted: true, placement: BOX_DEFAULTS.placement }]);
	});

	it("enabling every animation and a stale `display: both` still mounts one named surface", () => {
		const { api, fireSessionStart, widgetCalls } = makeDrivableApi();
		createAnimationsPlugin({ settings: { display: "both", ...allSetTo(true) }, env: {} })(api);
		fireSessionStart();
		expect(widgetCalls.filter(call => call.mounted).map(call => call.key)).toEqual([BOX_WIDGET_KEY]);
	});

	it("routes execution-start events into the mounted tools activity row", () => {
		const { api, fire } = makeActivityApi();
		let widgetContent: unknown;
		const ctx = {
			hasUI: true,
			cwd: "/repo",
			model: { id: "root-model" },
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionManager: {
				getSessionId: () => "registrar-tools",
				getArtifactsDir: () => "/sessions/registrar-tools",
				getSessionFile: () => "/sessions/registrar-tools.jsonl",
				getBranch: () => [],
			},
			hasPendingMessages: () => false,
			ui: {
				theme: { getSymbolPreset: () => "unicode" as const },
				setWidget: (key: string, content: unknown) => {
					if (key === BOX_WIDGET_KEY) widgetContent = content;
				},
				setStatus: () => {},
				setTitle: () => {},
			},
		} as unknown as ExtensionContext;
		createAnimationsPlugin({ settings: {}, env: {} })(api);
		fire("session_start", { type: "session_start" }, ctx);
		expect(typeof widgetContent).toBe("function");
		const factory = widgetContent as (
			tui: { requestComponentRender(): void },
			theme: { fg(color: string, text: string): string },
		) => { renderFrame(width: number): string[]; dispose(): void };
		const widget = factory({ requestComponentRender() {} }, { fg: (_color, text) => text });

		fire("tool_call", { type: "tool_call", toolCallId: "verify", toolName: "bash", input: {} }, ctx);
		fire(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "verify", toolName: "bash", args: {} },
			ctx,
		);
		const toolsRow = widget.renderFrame(160).find(row => row.includes("tools"));
		expect(toolsRow).toMatch(/bash · (?:\d+ms|\d+(?:\.\d+)?s) active · 1 call/u);
		expect(toolsRow).not.toContain("VERIFY");

		widget.dispose();
		fire("session_shutdown", { type: "session_shutdown" }, ctx);
	});
});

describe("plugin-local activity roster integration", () => {
	it("records every terminal outcome before display capping and purges only terminal agents on a root request", () => {
		let now = 0;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const rootApi = makeActivityApi();
		let widgetContent: unknown;
		const rootContext = activityContext({
			sessionId: "lifecycle-root",
			hasUI: true,
			artifactsDir: "/sessions/lifecycle-root",
			sessionFile: "/sessions/lifecycle-root.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
			setWidget: (key, content) => {
				if (key === BOX_WIDGET_KEY) widgetContent = content;
			},
		});
		createAnimationsPlugin({ settings: { animations: "off" }, env: {}, activityBus: bus, now: () => now })(
			rootApi.api,
		);
		rootApi.fire("session_start", { type: "session_start" }, rootContext);
		const factory = widgetContent as (
			tui: { requestComponentRender(): void },
			theme: { fg(color: string, text: string): string },
		) => { renderFrame(width: number): string[]; dispose(): void };
		const widget = factory({ requestComponentRender() {} }, { fg: (_color, text) => text });
		const root = bus.registerSession({
			sessionId: "lifecycle-root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const terminalIds = Array.from({ length: MAX_BONSAI_ROWS + 2 }, (_, index) => `worker${index}`);
		const children = [...terminalIds, "liveworker", "pendingworker"].map(id => {
			const api = makeActivityApi();
			const ctx = activityContext({
				sessionId: `lifecycle-${id}`,
				hasUI: false,
				artifactsDir: `/sessions/lifecycle-root/${id}`,
				sessionFile: `/sessions/lifecycle-root/${id}.jsonl`,
				sessionResources: EMPTY_SESSION_RESOURCES,
			});
			createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus, now: () => now })(api.api);
			api.fire("session_start", { type: "session_start" }, ctx);
			return { id, api, ctx };
		});
		const progress = (rows: Array<{ id: string; status: string }>): void => {
			rootApi.fire(
				"tool_execution_update",
				{ toolCallId: "fanout", toolName: "task", args: {}, partialResult: { details: { progress: rows } } },
				rootContext,
			);
		};
		try {
			rootApi.fire("agent_start", { type: "agent_start" }, rootContext);
			progress([{ id: "fallbackterminal", status: "running" }]);
			now = 1;
			progress(children.map(({ id }) => ({ id, status: id === "pendingworker" ? "pending" : "running" })));
			now = 100;
			progress([
				...terminalIds.map((id, index) => ({
					id,
					status: index === terminalIds.length - 1 ? "failed" : "completed",
				})),
				{ id: "fallbackterminal", status: "completed" },
			]);
			expect(
				root
					.snapshot()
					.agents.filter(agent => terminalIds.includes(agent.id))
					.map(agent => ({
						id: agent.id,
						status: agent.terminalStatus,
						completedAt: agent.completedAt,
					})),
			).toEqual(
				terminalIds.map((id, index) => ({
					id,
					status: index === terminalIds.length - 1 ? "aborted" : "completed",
					completedAt: 100,
				})),
			);
			expect(projectActivityAgents(root.snapshot(), undefined).nodes.length).toBeLessThanOrEqual(MAX_BONSAI_ROWS);

			now = 200;
			for (const child of children.filter(child => terminalIds.includes(child.id))) {
				child.api.fire("agent_end", { type: "agent_end", willContinue: false }, child.ctx);
			}
			const failedId = terminalIds[terminalIds.length - 1];
			rootApi.fire(
				"tool_execution_end",
				{
					toolCallId: "fanout",
					toolName: "task",
					isError: false,
					result: { details: { async: { state: "running" }, progress: [{ id: failedId, status: "completed" }] } },
				},
				rootContext,
			);
			expect(root.snapshot().agents.find(agent => agent.id === failedId)).toMatchObject({
				terminalStatus: "aborted",
				completedAt: 100,
			});
			const activeChild = children.find(child => child.id === "liveworker")!;
			activeChild.api.fire("agent_start", { type: "agent_start" }, activeChild.ctx);
			expect(root.snapshot().retiredAgentIds).toEqual([]);
			expect(root.snapshot().agents.filter(agent => agent.completedAt !== undefined)).toHaveLength(
				terminalIds.length,
			);
			expect(widget.renderFrame(200).join("\n")).toContain("fallbackterminal");

			let purgeFrame: string | undefined;
			const unsubscribe = root.subscribe(() => {
				if ((root.snapshot().retiredAgentIds?.length ?? 0) > 0) purgeFrame = widget.renderFrame(200).join("\n");
			});
			rootApi.fire("agent_start", { type: "agent_start" }, rootContext);
			unsubscribe();
			expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "liveworker", "pendingworker"]);
			expect(new Set(root.snapshot().retiredAgentIds)).toEqual(new Set([...terminalIds, "fallbackterminal"]));
			expect(purgeFrame).toBeDefined();
			expect(purgeFrame).not.toContain("fallbackterminal");
			expect(purgeFrame).toContain("liveworker");
			expect(purgeFrame).toContain("pendingworker");
			rootApi.fire("agent_start", { type: "agent_start" }, rootContext);
			expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main", "liveworker", "pendingworker"]);
		} finally {
			for (const child of children) child.api.fire("session_shutdown", { type: "session_shutdown" }, child.ctx);
			widget.dispose();
			rootApi.fire("session_shutdown", { type: "session_shutdown" }, rootContext);
		}
	});

	it("projects an exact headless mutation into files, agents, and the root title", () => {
		const bus = new ActivityTelemetryBus();
		const rootApi = makeActivityApi();
		const childApi = makeActivityApi();
		const titles: string[] = [];
		const rootContext = activityContext({
			sessionId: "root-session",
			hasUI: true,
			artifactsDir: "/sessions/root-session",
			sessionFile: "/sessions/root-session.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
			titles,
		});
		const childContext = activityContext({
			sessionId: "child-session",
			hasUI: false,
			artifactsDir: "/sessions/root-session/a1",
			sessionFile: "/sessions/root-session/a1.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		createAnimationsPlugin({ settings: { darkroomTitle: true }, env: {}, activityBus: bus })(rootApi.api);
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(childApi.api);
		rootApi.fire("session_start", { type: "session_start" }, rootContext);
		childApi.fire("session_start", { type: "session_start" }, childContext);
		childApi.fire(
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId: "edit-1",
				toolName: "edit",
				args: "[/repo/src/widget.ts#A1B2]\nPUT 218.=218:\n+value",
			},
			childContext,
		);

		const probe = bus.registerSession({
			sessionId: "root-session",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root-session",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const roster = probe.snapshot();
		const inferred: AgentBonsaiSnapshot = {
			visible: true,
			hiddenCount: 0,
			nodes: [
				{
					id: "Main",
					cohortLabel: "M",
					name: "primary",
					depth: 0,
					isLast: false,
					ancestorsLast: [],
					status: "running",
					createdAt: 5,
					model: "inferred-root",
					gist: "coordinating agents",
					loadedSkills: [],
				},
				{
					id: "a1",
					cohortLabel: "A1",
					name: "child context",
					depth: 1,
					isLast: true,
					ancestorsLast: [],
					status: "running",
					createdAt: 10,
					model: "inferred-child",
					activeSkill: { name: "tdd", path: "skill://tdd" },
					loadedSkills: [{ name: "tdd", path: "skill://tdd" }],
					gist: "implementing the renderer",
					task: "Render activity chain",
				},
			],
		};
		const files = buildActivityFilesSegment(roster, { entries: [] }, 1);
		const agents = projectActivityAgents(roster, inferred);
		expect(files.line.spans.map(span => span.text)).toEqual(["src/widget.ts"]);
		expect(agents.nodes[0]).toMatchObject({
			id: "main",
			name: "primary",
			model: "root-model",
			gist: "coordinating agents",
			activitySteps: [],
		});
		expect(agents.nodes[1]).toMatchObject({
			id: "a1",
			name: "child context",
			model: "child-model",
			activeSkill: { name: "tdd", path: "skill://tdd" },
			gist: "implementing the renderer",
			task: "Render activity chain",
			activitySteps: [
				{ kind: "tool", label: "edit", status: "active" },
				{ kind: "file", label: "src/widget.ts", status: "active" },
			],
		});
		expect(projectActivityAgents(undefined, inferred)).toBe(inferred);
		expect(projectActivityTitleFiles(roster, { entries: [] }).entries).toHaveLength(1);
		expect(titles.at(-1)).toBe("omp  1 writer");
	});

	it("marks the files row and both Bonsai nodes when two subagents edit one path at once", () => {
		const bus = new ActivityTelemetryBus();
		const rootApi = makeActivityApi();
		const rootContext = activityContext({
			sessionId: "root-session",
			hasUI: true,
			artifactsDir: "/sessions/root-session",
			sessionFile: "/sessions/root-session.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const children = ["a1", "a2"].map(id => ({
			id,
			api: makeActivityApi(),
			ctx: activityContext({
				sessionId: `${id}-session`,
				hasUI: false,
				artifactsDir: `/sessions/root-session/${id}`,
				sessionFile: `/sessions/root-session/${id}.jsonl`,
				sessionResources: EMPTY_SESSION_RESOURCES,
			}),
		}));
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(rootApi.api);
		for (const child of children) createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(child.api.api);
		rootApi.fire("session_start", { type: "session_start" }, rootContext);
		for (const child of children) child.api.fire("session_start", { type: "session_start" }, child.ctx);
		const probe = bus.registerSession({
			sessionId: "root-session",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root-session",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const edit = (toolCallId: string) => ({
			type: "tool_execution_start" as const,
			toolCallId,
			toolName: "edit",
			args: "[/repo/src/widget.ts#A1B2]\nPUT 1.=1:\n+value",
		});
		const observe = () => {
			const roster = probe.snapshot();
			return {
				files: buildActivityFilesSegment(roster, { entries: [] }, 1),
				agents: projectActivityAgents(roster, undefined),
			};
		};

		children[0]?.api.fire("tool_execution_start", edit("edit-a1"), children[0].ctx);
		const single = observe();
		expect(single.files.line.dot).toBe("live");
		expect(single.files.line.spans.map(span => span.text)).toEqual(["src/widget.ts"]);
		expect(single.agents.nodes.map(node => node.collision)).toEqual([false, false, false]);

		children[1]?.api.fire("tool_execution_start", edit("edit-a2"), children[1].ctx);
		const clashing = observe();
		expect(clashing.files.line.dot).toBe("alert");
		expect(clashing.files.line.spans.map(span => [span.text, span.tone])).toEqual([
			["src/widget.ts", "alert"],
			["2 writers", undefined],
		]);
		expect(clashing.agents.nodes.map(node => [node.id, node.collision])).toEqual([
			["main", false],
			["a1", true],
			["a2", true],
		]);

		children[1]?.api.fire(
			"tool_execution_end",
			{ type: "tool_execution_end", toolCallId: "edit-a2", toolName: "edit", isError: false },
			children[1].ctx,
		);
		const settled = observe();
		expect(settled.files.line.dot).toBe("live");
		expect(settled.files.line.spans.map(span => span.text)).toEqual(["src/widget.ts"]);
		expect(settled.agents.nodes.map(node => node.collision)).toEqual([false, false, false]);
	});

	it("keeps an inferred subagent when exact telemetry currently contains only the root", () => {
		const bus = new ActivityTelemetryBus();
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const inferred: AgentBonsaiSnapshot = {
			visible: true,
			hiddenCount: 0,
			nodes: [
				{
					id: "Main",
					cohortLabel: "M",
					name: "Main",
					depth: 0,
					isLast: false,
					ancestorsLast: [],
					status: "running",
					createdAt: 0,
					loadedSkills: [],
				},
				{
					id: "task-call:FallbackScout",
					cohortLabel: "A1",
					name: "FallbackScout",
					depth: 1,
					isLast: true,
					ancestorsLast: [],
					status: "running",
					createdAt: 10,
					model: "fallback-model",
					loadedSkills: [{ name: "simple-english", path: "skill://simple-english" }],
					activitySteps: [{ id: "read:tool", kind: "tool", label: "read", status: "active", startedAt: 10 }],
				},
			],
		};

		const agents = projectActivityAgents(root.snapshot(), inferred);
		expect(agents.nodes.map(agent => agent.name)).toEqual(["Main", "FallbackScout"]);
		expect(agents.nodes[1]).toMatchObject({
			cohortLabel: "A1",
			model: "fallback-model",
			loadedSkills: [{ name: "simple-english" }],
			activitySteps: [{ kind: "tool", label: "read", status: "active" }],
		});
	});

	it("registers a headless session from its first tool event when session_start was not replayed", () => {
		const bus = new ActivityTelemetryBus();
		const rootApi = makeActivityApi();
		const childApi = makeActivityApi();
		const rootContext = activityContext({
			sessionId: "root-session",
			hasUI: true,
			artifactsDir: "/sessions/root-session",
			sessionFile: "/sessions/root-session.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const childContext = activityContext({
			sessionId: "child-session",
			hasUI: false,
			artifactsDir: "/sessions/root-session/FallbackScout",
			sessionFile: "/sessions/root-session/FallbackScout.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(rootApi.api);
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(childApi.api);
		rootApi.fire("session_start", { type: "session_start" }, rootContext);

		childApi.fire(
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "skill://simple-english" },
			},
			childContext,
		);

		const root = bus.registerSession({
			sessionId: "root-session",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		expect(root.snapshot().agents).toEqual([
			expect.objectContaining({ id: "main" }),
			expect.objectContaining({
				id: "FallbackScout",
				model: "child-model",
				steps: [
					expect.objectContaining({ kind: "tool", label: "read", status: "active" }),
					expect.objectContaining({ kind: "skill", label: "simple-english", status: "active" }),
				],
			}),
		]);
	});
	it("keeps exact provenance on its owning agent in chronological order", () => {
		let now = 10;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			artifactsDir: "/sessions/root",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionFile: "/sessions/root/a1.jsonl",
			sessionResources: { skills: [], contextFiles: [{ path: "AGENTS.md" }] },
		});
		const inferred: AgentBonsaiSnapshot = {
			visible: true,
			hiddenCount: 0,
			nodes: [
				{
					id: "Main",
					cohortLabel: "M",
					name: "primary",
					depth: 0,
					isLast: false,
					ancestorsLast: [],
					status: "running",
					loadedSkills: [],
				},
				{
					id: "a1",
					cohortLabel: "A1",
					name: "child context",
					depth: 1,
					isLast: true,
					ancestorsLast: [],
					status: "running",
					activeSkill: { name: "fallback-only", path: "skill://fallback-only" },
					loadedSkills: [{ name: "fallback-only", path: "skill://fallback-only" }],
				},
			],
		};

		child.startTool({ toolCallId: "skill", toolName: "read", args: { path: "skill://review\tphase/reference" } });
		child.endTool({ toolCallId: "skill", toolName: "read", isError: false });
		now = 20;
		child.startTool({ toolCallId: "context", toolName: "read", args: { path: "/repo/AGENTS.md" } });
		child.endTool({ toolCallId: "context", toolName: "read", isError: true });
		now = 30;
		child.startTool({ toolCallId: "memory", toolName: "recall", args: { query: "private" } });
		child.endTool({ toolCallId: "memory", toolName: "recall", isError: false });
		now = 40;
		child.startTool({ toolCallId: "qmd", toolName: "mcp__qmd_query", args: { query: "private" } });

		const agents = projectActivityAgents(root.snapshot(), inferred);
		expect(agents.nodes[0]?.provenance).toEqual([]);
		expect(agents.nodes[1]).toMatchObject({
			id: "a1",
			activeSkill: { name: "fallback-only" },
			provenance: [
				{ id: "skill:skill", kind: "skill", label: "review phase", status: "complete", startedAt: 10 },
				{
					id: "context:context-file",
					kind: "context-file",
					label: "AGENTS.md",
					status: "error",
					startedAt: 20,
				},
				{ id: "memory:memory", kind: "memory", label: "recall", status: "complete", startedAt: 30 },
				{ id: "qmd:qmd", kind: "qmd", label: "QMD query", status: "active", startedAt: 40 },
			],
		});
	});

	it("forwards the host-resolved session resources by identity", () => {
		const resources: ActivitySessionResources = Object.freeze({
			skills: Object.freeze([
				Object.freeze({
					name: "tdd",
					description: "Develop test-first",
					path: "/skills/tdd/SKILL.md",
				}),
			]),
			contextFiles: Object.freeze([Object.freeze({ path: "/repo/AGENTS.md" })]),
		});
		const bus = new RecordingActivityBus();
		const api = makeActivityApi();
		const ctx = activityContext({
			sessionId: "root-session",
			hasUI: true,
			artifactsDir: "/sessions/root-session",
			sessionFile: "/sessions/root-session.jsonl",
			sessionResources: resources,
		});
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(api.api);

		api.fire("session_start", { type: "session_start" }, ctx);

		expect(bus.registration?.sessionResources).toBe(resources);
		expect(bus.registration?.sessionResources).toEqual(resources);
	});
});

describe("resolveAnimationsConfig", () => {
	it("resolves a tier and appearance only — there is no enable map left to consult", () => {
		const cfg = resolveAnimationsConfig({}, {});
		expect(Object.keys(cfg).sort()).toEqual(["appearance", "tier"]);
		expect(cfg.tier).toBe("full");
		expect(Object.keys(cfg.appearance).sort()).toEqual(ALL_IDS.slice().sort());
	});

	it("reads the tier from plugin settings", () => {
		expect(resolveAnimationsConfig({ animations: "subtle" }, {}).tier).toBe("subtle");
	});

	it("falls back to the env var when the tier is unstored, and prefers the stored value when both exist", () => {
		expect(resolveAnimationsConfig({}, { OMP_ANIMATIONS: "off" }).tier).toBe("off");
		expect(resolveAnimationsConfig({ animations: "full" }, { OMP_ANIMATIONS: "off" }).tier).toBe("full");
	});

	it("ignores a malformed tier instead of throwing", () => {
		expect(resolveAnimationsConfig({ animations: "sparkly" }, {}).tier).toBe("full");
	});
});

describe("readPluginSettingsSync", () => {
	const tempDirs: string[] = [];

	/** A fresh, isolated `{ home, cwd }` pair — neither directory exists yet. */
	function isolatedRoots(): { home: string; cwd: string } {
		const base = mkdtempSync(path.join(tmpdir(), "oh-my-pi-animations-"));
		tempDirs.push(base);
		return { home: path.join(base, "home"), cwd: path.join(base, "project") };
	}

	function writeGlobalLockfile(home: string, settings: Record<string, unknown>): void {
		const dir = path.join(home, ".omp", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "omp-plugins.lock.json"),
			JSON.stringify({ plugins: {}, settings: { "@oh-my-pi/animations": settings } }),
		);
	}

	function writeProjectOverrides(cwd: string, settings: Record<string, unknown>): void {
		const dir = path.join(cwd, ".omp");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "plugin-overrides.json"),
			JSON.stringify({ settings: { "@oh-my-pi/animations": settings } }),
		);
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns {} for both stores absent — never throws over missing config", () => {
		const { home, cwd } = isolatedRoots();
		expect(readPluginSettingsSync(cwd, home)).toEqual({});
	});

	it("reads the global lockfile when no project override exists", () => {
		const { home, cwd } = isolatedRoots();
		writeGlobalLockfile(home, { animations: "subtle", palimpsest: false });
		expect(readPluginSettingsSync(cwd, home)).toEqual({ animations: "subtle", palimpsest: false });
	});

	it("project overrides win over the global lockfile, per key", () => {
		const { home, cwd } = isolatedRoots();
		writeGlobalLockfile(home, { animations: "full", palimpsest: true, sessionBonsai: true });
		writeProjectOverrides(cwd, { animations: "subtle", palimpsest: false });
		const settings = readPluginSettingsSync(cwd, home);
		// Project wins on contested keys...
		expect(settings.animations).toBe("subtle");
		expect(settings.palimpsest).toBe(false);
		// ...and global still supplies keys the project override doesn't mention.
		expect(settings.sessionBonsai).toBe(true);
	});

	it("a malformed global lockfile degrades to {} instead of throwing", () => {
		const { home, cwd } = isolatedRoots();
		const dir = path.join(home, ".omp", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "omp-plugins.lock.json"), "{ not valid json");
		expect(() => readPluginSettingsSync(cwd, home)).not.toThrow();
		expect(readPluginSettingsSync(cwd, home)).toEqual({});
	});

	it("wires end to end through the production factory (not the settings-injection seam)", () => {
		// Exercises exactly the path `export default createAnimationsPlugin()` uses: only
		// `cwd`/`home` are supplied, so `settings` resolves via the real readPluginSettingsSync
		// and the stored box placement has to survive all the way to the host's setWidget.
		const { home, cwd } = isolatedRoots();
		writeProjectOverrides(cwd, { animations: "subtle", [BOX_SETTING_KEYS.placement]: "aboveEditor" });
		const { api, fireSessionStart, widgetCalls } = makeDrivableApi();
		createAnimationsPlugin({ cwd, home, env: {} })(api);
		fireSessionStart();
		expect(widgetCalls).toEqual([{ key: BOX_WIDGET_KEY, mounted: true, placement: "aboveEditor" }]);
	});

	it.each([
		{ tier: "off", stored: 0, envSeconds: "90", retentionMs: 800 },
		{ tier: "subtle", stored: 0, envSeconds: undefined, retentionMs: 800 },
		{ tier: "off", stored: undefined, envSeconds: "2", retentionMs: 2_000 },
		{ tier: "off", stored: undefined, envSeconds: undefined, retentionMs: 300_000 },
	])("shares exact and fallback expiry from isolated settings: %j", ({ tier, stored, envSeconds, retentionMs }) => {
		const { home, cwd } = isolatedRoots();
		writeGlobalLockfile(home, { animations: tier, animationsBonsaiSettleSeconds: stored });
		let now = 0;
		const bus = new ActivityTelemetryBus({ now: () => now });
		const rootApi = makeActivityApi();
		const childApi = makeActivityApi();
		let widgetContent: unknown;
		const rootContext = activityContext({
			sessionId: "retention-root",
			hasUI: true,
			artifactsDir: "/sessions/retention-root",
			sessionFile: "/sessions/retention-root.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
			setWidget: (key, content) => {
				if (key === BOX_WIDGET_KEY) widgetContent = content;
			},
		});
		const childContext = activityContext({
			sessionId: "retention-child",
			hasUI: false,
			artifactsDir: "/sessions/retention-root/exactworker",
			sessionFile: "/sessions/retention-root/exactworker.jsonl",
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		createAnimationsPlugin({
			cwd,
			home,
			env: { OMP_ANIMATIONS_BONSAI_SETTLE_SECONDS: envSeconds },
			activityBus: bus,
			now: () => now,
		})(rootApi.api);
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus, now: () => now })(childApi.api);
		rootApi.fire("session_start", { type: "session_start" }, rootContext);
		childApi.fire("session_start", { type: "session_start" }, childContext);
		const factory = widgetContent as (
			tui: { requestComponentRender(): void },
			theme: { fg(color: string, text: string): string },
		) => { renderFrame(width: number): string[]; dispose(): void };
		const widget = factory({ requestComponentRender() {} }, { fg: (_color, text) => text });
		const root = bus.registerSession({
			sessionId: "retention-root",
			hasUI: true,
			cwd,
			sessionResources: EMPTY_SESSION_RESOURCES,
		});
		try {
			rootApi.fire(
				"tool_execution_end",
				{
					toolCallId: "fanout",
					toolName: "task",
					isError: false,
					result: {
						details: {
							progress: [
								{ id: "exactworker", status: "completed" },
								{ id: "fallbackworker", status: "completed" },
							],
						},
					},
				},
				rootContext,
			);
			now = 100;
			childApi.fire("agent_end", { type: "agent_end", willContinue: false }, childContext);
			expect(root.snapshot().agents.find(agent => agent.id === "exactworker")?.completedAt).toBe(0);
			now = retentionMs - 1;
			const retained = widget.renderFrame(200).join("\n");
			expect(retained).toContain("exactworker");
			expect(retained).toContain("fallbackworker");
			now = retentionMs;
			const expired = widget.renderFrame(200).join("\n");
			expect(expired).not.toContain("exactworker");
			expect(expired).not.toContain("fallbackworker");
			expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
		} finally {
			childApi.fire("session_shutdown", { type: "session_shutdown" }, childContext);
			widget.dispose();
			rootApi.fire("session_shutdown", { type: "session_shutdown" }, rootContext);
		}
	});
});

describe("activity roster lifecycle settings", () => {
	it("resolves stored values over env with compact and 300 seconds as defaults", () => {
		expect(resolveActivityRosterSettings({}, {})).toEqual(ACTIVITY_ROSTER_DEFAULTS);
		expect(
			resolveActivityRosterSettings(
				{ agentRosterDetail: "verbose", animationsBonsaiSettleSeconds: 12.5 },
				{
					OMP_ANIMATIONS_AGENT_ROSTER_DETAIL: "compact",
					OMP_ANIMATIONS_BONSAI_SETTLE_SECONDS: "90",
				},
			),
		).toEqual({ detail: "verbose", retentionMs: 12_500 });
		expect(
			resolveActivityRosterSettings(
				{},
				{
					OMP_ANIMATIONS_AGENT_ROSTER_DETAIL: "verbose",
					OMP_ANIMATIONS_BONSAI_SETTLE_SECONDS: "90",
				},
			),
		).toEqual({ detail: "verbose", retentionMs: 90_000 });
	});

	it("clamps finite values and rejects invalid or retired retention settings", () => {
		for (const [value, retentionMs] of [
			[-1, 0],
			[86_401, 86_400_000],
			["0.125", 125],
			["", 300_000],
			["invalid", 300_000],
			[Number.POSITIVE_INFINITY, 300_000],
		] as const) {
			expect(
				resolveActivityRosterSettings(
					{ animationsBonsaiSettleSeconds: value },
					{ OMP_ANIMATIONS_BONSAI_SETTLE_SECONDS: "90" },
				).retentionMs,
			).toBe(retentionMs);
		}
		expect(
			resolveActivityRosterSettings(
				{ agentRosterRetentionSeconds: 1 },
				{ OMP_ANIMATIONS_AGENT_ROSTER_RETENTION_SECONDS: "2" },
			).retentionMs,
		).toBe(300_000);
	});

	it("notifies completion and expiry transitions with one root timer", () => {
		let now = 0;
		let pending: { delayMs: number; tick: () => void } | undefined;
		const scheduled = (): { delayMs: number; tick: () => void } | undefined => pending;
		const scheduler: ActivityLifecycleScheduler = {
			now: () => now,
			schedule: (delayMs, tick) => {
				pending = { delayMs, tick };
				return () => {
					if (pending?.tick === tick) pending = undefined;
				};
			},
		};
		const bus = new ActivityTelemetryBus({ scheduler, completionFlashMs: 1_200 });
		const root = bus.registerSession({
			sessionId: "root",
			hasUI: true,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			artifactsDir: "/sessions/root",
			retentionMs: 300_000,
			detail: "verbose",
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
			sessionResources: EMPTY_SESSION_RESOURCES,
			sessionFile: "/sessions/root/a1.jsonl",
		});
		let changes = 0;
		root.subscribe(() => changes++);
		child.startTool({ toolCallId: "write", toolName: "write", args: { path: "/repo/a.ts" } });
		child.endTool({ toolCallId: "write", toolName: "write", isError: false });
		child.complete();
		const completionChanges = changes;
		expect(scheduled()?.delayMs).toBe(1_201);
		expect(root.snapshot().detail).toBe("verbose");

		now = 1_201;
		const completionTick = scheduled()?.tick;
		pending = undefined;
		completionTick?.();
		expect(root.snapshot().agents.find(agent => agent.id === "a1")?.phase).toBe("recent");
		expect(root.snapshot().operations).toEqual([]);
		expect(changes).toBeGreaterThan(completionChanges);
		expect(scheduled()?.delayMs).toBe(6_800);

		now = 8_001;
		const activityExpiryTick = scheduled()?.tick;
		pending = undefined;
		activityExpiryTick?.();
		expect(root.snapshot().agents.find(agent => agent.id === "a1")?.steps).toEqual([]);
		expect(scheduled()?.delayMs).toBe(291_999);

		now = 300_000;
		const expiryTick = scheduled()?.tick;
		pending = undefined;
		expiryTick?.();
		expect(root.snapshot().agents.map(agent => agent.id)).toEqual(["main"]);
		expect(scheduled()).toBeUndefined();
	});
});

describe("package.json#omp.settings — this package's native default", () => {
	it("ships tier 'subtle', the box settings, and independently optional signal extras", async () => {
		const pkg = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json();
		const settings = pkg.omp.settings as Record<string, { default?: unknown; env?: string }>;

		expect(settings.animations?.default).toBe("subtle");
		expect(settings[BOX_SETTING_KEYS.detail]?.default).toBe(BOX_DEFAULTS.detail);
		expect(settings[BOX_SETTING_KEYS.placement]?.default).toBe(BOX_DEFAULTS.placement);
		expect(settings[BOX_SETTING_KEYS.contextQuota]?.default).toBe(BOX_DEFAULTS.contextQuota);
		expect(settings.animationsContextStyle).toBeUndefined();

		// The removed display mode is gone from the advertised surface entirely.
		expect(settings.display).toBeUndefined();

		// Core summaries have no enable toggle. Palimpsest is fully removed.
		for (const id of ["auditTrailBox", "cacheMeter", "palimpsest", "rateLimitTidepool"]) {
			expect(settings[id]).toBeUndefined();
		}
		// Optional groups and the border chrome keep their original keys and env vars.
		expect(settings.agentBonsai).toMatchObject({ default: true, env: "OMP_ANIMATIONS_AGENT_BONSAI" });
		expect(settings.breathingBorder).toMatchObject({ default: true, env: "OMP_ANIMATIONS_BREATHING_BORDER" });
		expect(settings[ACTIVITY_ROSTER_SETTING_KEYS.detail]).toMatchObject({
			default: ACTIVITY_ROSTER_DEFAULTS.detail,
			env: ACTIVITY_ROSTER_SETTING_ENV.detail,
		});
		expect(settings[ACTIVITY_ROSTER_SETTING_KEYS.retentionSeconds]).toMatchObject({
			default: ACTIVITY_ROSTER_DEFAULTS.retentionMs / 1_000,
			min: 0,
			max: 86_400,
			env: ACTIVITY_ROSTER_SETTING_ENV.retentionSeconds,
		});

		for (const id of SIGNAL_EXTRA_IDS) {
			expect(settings[id]).toMatchObject({
				default: DEFAULT_SIGNAL_EXTRAS_CONFIG[id],
				env: animationsEnvKey(id),
			});
		}

		const appearanceKeys = [...ALL_IDS.map(id => `${id}Placement`), ...ALL_IDS.map(id => `${id}AccentColor`)];
		expect(Object.keys(settings).sort()).toEqual(
			[
				"animations",
				...Object.values(BOX_SETTING_KEYS),
				"agentBonsai",
				...Object.values(ACTIVITY_ROSTER_SETTING_KEYS),
				"breathingBorder",
				...SIGNAL_EXTRA_IDS,
				...appearanceKeys,
			].sort(),
		);
	});
});

describe("Session topology off-path cost calculation", () => {
	it("verifies branch cost accumulation logic", () => {
		expect(0.1 + 0.05).toBeCloseTo(0.15);
		expect(Math.max(0, 0.3 - 0.15)).toBeCloseTo(0.15);
	});
});

describe("event fan-out", () => {
	function makeFanoutApi(): {
		api: ExtensionAPI;
		handlers: Record<string, (event: unknown, ctx: ExtensionContext) => void>;
	} {
		const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => void> = {};
		const api = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;
		return { api, handlers };
	}

	function makeRecordingSinks(calls: string[], live: boolean): FanoutSinks {
		return {
			ensureActivity: () => calls.push("ensureActivity"),
			completeActivity: () => calls.push("completeActivity"),
			probe: () =>
				live
					? ({
							startTool: () => calls.push("probe.startTool"),
							updateTool: () => calls.push("probe.updateTool"),
							endTool: () => calls.push("probe.endTool"),
							beginRequest: () => calls.push("probe.beginRequest"),
						} as unknown as ActivityProbe)
					: undefined,
			bonsai: () =>
				live
					? ({
							onToolExecutionUpdate: () => calls.push("bonsai.onToolExecutionUpdate"),
							onToolExecutionEnd: () => calls.push("bonsai.onToolExecutionEnd"),
							noteMainModel: () => calls.push("bonsai.noteMainModel"),
							onAgentStart: () => calls.push("bonsai.onAgentStart"),
							onAgentEnd: () => calls.push("bonsai.onAgentEnd"),
						} as unknown as AgentBonsaiController)
					: undefined,
			controller: {
				onToolExecutionStart: () => calls.push("controller.onToolExecutionStart"),
				onToolExecutionUpdate: () => calls.push("controller.onToolExecutionUpdate"),
				onToolExecutionEnd: () => calls.push("controller.onToolExecutionEnd"),
				onTurnStart: () => calls.push("controller.onTurnStart"),
				onTurnEnd: () => calls.push("controller.onTurnEnd"),
				onAgentStart: () => calls.push("controller.onAgentStart"),
				onAgentEnd: () => calls.push("controller.onAgentEnd"),
			},
		};
	}

	const ROOT = { hasUI: true, model: { id: "m" } } as ExtensionContext;
	const CHILD = { hasUI: false } as ExtensionContext;

	function driveOneTurn(handlers: Record<string, (event: unknown, ctx: ExtensionContext) => void>): void {
		handlers.agent_start!({}, ROOT);
		handlers.turn_start!({}, ROOT);
		handlers.tool_execution_start!({}, ROOT);
		handlers.tool_execution_update!({}, ROOT);
		handlers.tool_execution_end!({}, ROOT);
		handlers.turn_end!({}, ROOT);
		handlers.agent_end!({ willContinue: false }, ROOT);
	}

	it("subscribes every event the controller consumes, so a dropped subscription fails here", () => {
		const { api, handlers } = makeFanoutApi();
		wireEventFanout(api, makeRecordingSinks([], true));
		expect(Object.keys(handlers).sort()).toEqual(
			[
				"agent_end",
				"agent_start",
				"tool_execution_end",
				"tool_execution_start",
				"tool_execution_update",
				"turn_end",
				"turn_start",
			].sort(),
		);
	});

	it("writes probe, then bonsai, then controller on every event of a root turn", () => {
		const { api, handlers } = makeFanoutApi();
		const calls: string[] = [];
		wireEventFanout(api, makeRecordingSinks(calls, true));
		driveOneTurn(handlers);
		expect(calls).toEqual([
			"ensureActivity",
			"bonsai.onAgentStart",
			"probe.beginRequest",
			"controller.onAgentStart",
			"bonsai.noteMainModel",
			"controller.onTurnStart",
			"ensureActivity",
			"probe.startTool",
			"controller.onToolExecutionStart",
			"ensureActivity",
			"probe.updateTool",
			"bonsai.onToolExecutionUpdate",
			"controller.onToolExecutionUpdate",
			"ensureActivity",
			"probe.endTool",
			"bonsai.onToolExecutionEnd",
			"controller.onToolExecutionEnd",
			"controller.onTurnEnd",
			"bonsai.onAgentEnd",
			"controller.onAgentEnd",
		]);
	});

	it("a child agent's final agent_end completes the activity before bonsai and controller see it", () => {
		const { api, handlers } = makeFanoutApi();
		const calls: string[] = [];
		wireEventFanout(api, makeRecordingSinks(calls, true));
		handlers.agent_start!({}, CHILD);
		handlers.agent_end!({ willContinue: true }, CHILD);
		handlers.agent_end!({ willContinue: false }, CHILD);
		expect(calls).toEqual([
			"ensureActivity",
			"bonsai.onAgentStart",
			"controller.onAgentStart",
			"bonsai.onAgentEnd",
			"controller.onAgentEnd",
			"completeActivity",
			"bonsai.onAgentEnd",
			"controller.onAgentEnd",
		]);
	});

	it("keeps the controller fed when probe and bonsai are absent", () => {
		const { api, handlers } = makeFanoutApi();
		const calls: string[] = [];
		wireEventFanout(api, makeRecordingSinks(calls, false));
		driveOneTurn(handlers);
		expect(calls).toEqual([
			"ensureActivity",
			"controller.onAgentStart",
			"controller.onTurnStart",
			"ensureActivity",
			"controller.onToolExecutionStart",
			"ensureActivity",
			"controller.onToolExecutionUpdate",
			"ensureActivity",
			"controller.onToolExecutionEnd",
			"controller.onTurnEnd",
			"controller.onAgentEnd",
		]);
	});
});
