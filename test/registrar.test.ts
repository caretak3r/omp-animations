import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type ActivityLifecycleScheduler, ActivityTelemetryBus } from "../src/activity-roster/bus";
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
import type { AgentBonsaiSnapshot } from "../src/agent-bonsai";
import { BOX_WIDGET_KEY, SIGNAL_WIDGET_KEY } from "../src/animations-box/controller";
import { BOX_DEFAULTS, BOX_SETTING_KEYS } from "../src/animations-box/settings";
import { animationsEnvKey } from "../src/appearance";
import { ANIMATIONS, createAnimationsPlugin, readPluginSettingsSync, resolveAnimationsConfig } from "../src/registrar";
import { SIGNAL_EXTRA_IDS } from "../src/signal-extras";

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
	titles?: string[];
}): ExtensionContext {
	const ui = {
		theme: { getSymbolPreset: () => "unicode" as const },
		setWidget: () => {},
		setTitle: (title: string) => options.titles?.push(title),
	};
	return {
		hasUI: options.hasUI,
		cwd: "/repo",
		model: { id: options.hasUI ? "root-model" : "child-model" },
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
		expect(
			mount({ agentBonsai: false, cadenceEqualizer: true, reflectionRipple: true }).events.slice().sort(),
		).toEqual(base);
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

	it("ANIMATIONS contains exactly the legacy appearance entries still in use", () => {
		expect(ALL_IDS.slice().sort()).toEqual([
			"auditTrailBox",
			"breathingBorder",
			"cacheMeter",
			"cadenceEqualizer",
			"rateLimitTidepool",
			"reflectionRipple",
		]);
		for (const id of ["agentFleet", "contextWeather", "diffBloom", "tokenTide", "toolConstellation"]) {
			expect(ALL_IDS).not.toContain(id);
		}
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
	it("mounts the Audit Box below the editor and signal sidecar above it", () => {
		const { api, fireSessionStart, widgetCalls } = makeDrivableApi();
		createAnimationsPlugin({ settings: {}, env: {} })(api);
		fireSessionStart();
		expect(widgetCalls).toEqual([
			{ key: BOX_WIDGET_KEY, mounted: true, placement: BOX_DEFAULTS.placement },
			{ key: SIGNAL_WIDGET_KEY, mounted: true, placement: "aboveEditor" },
		]);
	});

	it("enabling every animation and a stale `display: both` still mounts only the two named surfaces", () => {
		const { api, fireSessionStart, widgetCalls } = makeDrivableApi();
		createAnimationsPlugin({ settings: { display: "both", ...allSetTo(true) }, env: {} })(api);
		fireSessionStart();
		expect(widgetCalls.filter(call => call.mounted).map(call => call.key)).toEqual([
			BOX_WIDGET_KEY,
			SIGNAL_WIDGET_KEY,
		]);
	});
});

describe("plugin-local activity roster integration", () => {
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
			titles,
		});
		const childContext = activityContext({
			sessionId: "child-session",
			hasUI: false,
			artifactsDir: "/sessions/root-session/a1",
			sessionFile: "/sessions/root-session/a1.jsonl",
		});
		createAnimationsPlugin({ settings: {}, env: {}, activityBus: bus })(rootApi.api);
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
		});
		const roster = probe.snapshot();
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
					loadedSkills: [],
				},
				{
					id: "A1",
					cohortLabel: "A1",
					name: "child",
					depth: 1,
					isLast: true,
					ancestorsLast: [],
					status: "running",
					loadedSkills: [],
				},
			],
		};
		const files = buildActivityFilesSegment(roster, { entries: [] }, 1);
		const agents = projectActivityAgents(roster, inferred);
		expect(files.line.spans.map(span => span.text)).toEqual(["src/widget.ts"]);
		expect(agents.nodes.map(node => [node.id, node.gist])).toEqual([
			["main", undefined],
			["a1", "edit src/widget.ts"],
		]);
		expect(projectActivityAgents(undefined, inferred)).toBe(inferred);
		expect(projectActivityTitleFiles(roster, { entries: [] }).entries).toHaveLength(1);
		expect(titles.at(-1)).toBe("omp  1 writer");
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
		expect(widgetCalls).toEqual([
			{ key: BOX_WIDGET_KEY, mounted: true, placement: "aboveEditor" },
			{ key: SIGNAL_WIDGET_KEY, mounted: true, placement: "aboveEditor" },
		]);
	});
});

describe("activity roster lifecycle settings", () => {
	it("resolves stored values over env with compact and 300 seconds as defaults", () => {
		expect(resolveActivityRosterSettings({}, {})).toEqual(ACTIVITY_ROSTER_DEFAULTS);
		expect(
			resolveActivityRosterSettings(
				{ agentRosterDetail: "verbose", agentRosterRetentionSeconds: 12.5 },
				{
					OMP_ANIMATIONS_AGENT_ROSTER_DETAIL: "compact",
					OMP_ANIMATIONS_AGENT_ROSTER_RETENTION_SECONDS: "90",
				},
			),
		).toEqual({ detail: "verbose", retentionMs: 12_500 });
		expect(
			resolveActivityRosterSettings(
				{},
				{
					OMP_ANIMATIONS_AGENT_ROSTER_DETAIL: "verbose",
					OMP_ANIMATIONS_AGENT_ROSTER_RETENTION_SECONDS: "90",
				},
			),
		).toEqual({ detail: "verbose", retentionMs: 90_000 });
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
			artifactsDir: "/sessions/root",
			retentionMs: 300_000,
			detail: "verbose",
		});
		const child = bus.registerSession({
			sessionId: "child",
			hasUI: false,
			cwd: "/repo",
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
		expect(scheduled()?.delayMs).toBe(298_800);

		now = 300_001;
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

		// The removed display mode is gone from the advertised surface entirely.
		expect(settings.display).toBeUndefined();

		// Core summaries have no enable toggle. Palimpsest is fully removed.
		for (const id of ["auditTrailBox", "cacheMeter", "palimpsest", "rateLimitTidepool"]) {
			expect(settings[id]).toBeUndefined();
		}
		// Optional groups and the border chrome keep their original keys and env vars.
		expect(settings.agentBonsai).toMatchObject({ default: true, env: "OMP_ANIMATIONS_AGENT_BONSAI" });
		expect(settings.breathingBorder).toMatchObject({ default: true, env: "OMP_ANIMATIONS_BREATHING_BORDER" });
		expect(settings.cadenceEqualizer).toMatchObject({ default: false, env: "OMP_ANIMATIONS_CADENCE_EQUALIZER" });
		expect(settings.reflectionRipple).toMatchObject({ default: false, env: "OMP_ANIMATIONS_REFLECTION_RIPPLE" });
		expect(settings[ACTIVITY_ROSTER_SETTING_KEYS.detail]).toMatchObject({
			default: ACTIVITY_ROSTER_DEFAULTS.detail,
			env: ACTIVITY_ROSTER_SETTING_ENV.detail,
		});
		expect(settings[ACTIVITY_ROSTER_SETTING_KEYS.retentionSeconds]).toMatchObject({
			default: ACTIVITY_ROSTER_DEFAULTS.retentionMs / 1_000,
			env: ACTIVITY_ROSTER_SETTING_ENV.retentionSeconds,
		});

		for (const id of SIGNAL_EXTRA_IDS) {
			expect(settings[id]).toMatchObject({ default: true, env: animationsEnvKey(id) });
		}

		const appearanceKeys = [...ALL_IDS.map(id => `${id}Placement`), ...ALL_IDS.map(id => `${id}AccentColor`)];
		expect(Object.keys(settings).sort()).toEqual(
			[
				"animations",
				...Object.values(BOX_SETTING_KEYS),
				"agentBonsai",
				...Object.values(ACTIVITY_ROSTER_SETTING_KEYS),
				"breathingBorder",
				"cadenceEqualizer",
				"reflectionRipple",
				...SIGNAL_EXTRA_IDS,
				...appearanceKeys,
			].sort(),
		);
	});
});
