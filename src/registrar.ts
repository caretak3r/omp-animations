/**
 * @oh-my-pi/animations — the single config-driven plugin entry.
 *
 * The manifest declares this extension. It wires one headless Audit Trail
 * service, one shared controller, and one optional Agent Bonsai observer.
 * The controller registers one complete Animations Box on one host. No
 * standalone animation owns a scheduler or subscription.
 *
 * Settings resolve synchronously before an event occurs. The precedence is:
 * injected settings, stored plugin settings, manifest environment fallbacks,
 * and defaults. The settings have three groups: the shared motion tier, the
 * Animations Box settings, and the optional signal settings.
 *
 * The removed `display` setting (`rows` · `box` · `both`) is still read, for one purpose:
 * a stale `rows`/`both` logs a migration warning and gets the box anyway
 * (`removedDisplayNotice`). `ANIMATIONS` likewise survives as the per-animation
 * appearance table — id, label, and default placement behind
 * `<id>Placement`/`<id>AccentColor` resolution — not as a mount registry.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_DIR_NAME, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import {
	type ActivityProbe,
	type ActivitySessionResources,
	type ActivityTelemetryBus,
	globalActivityTelemetryBus,
} from "./activity-roster/bus";
import { type ActivityRosterSettings, resolveActivityRosterSettings } from "./activity-roster/settings";
import { AgentBonsaiController } from "./agent-bonsai";
import { type AnimationsBoxContext, AnimationsBoxController } from "./animations-box/controller";
import {
	type AnimationsBoxConfig,
	removedDisplayNotice,
	resolveAnimationsBoxConfigFromSources,
} from "./animations-box/settings";
import { type AccentColor, type AnimationAppearance, resolveAnimationAppearance } from "./appearance";
import { AuditLedgerState, createAuditTrailBoxExtension } from "./audit-trail-box";
import { cacheMeterColors, renderCacheMeterPanel } from "./cache-meter";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SessionEntry,
	SymbolPreset,
	WidgetPlacement,
} from "./host/types";
import type { MotionSetting } from "./kit";
import {
	estimateContentTokens,
	type PhylogenySignal,
	resolveSignalExtrasConfig,
	type SignalExtrasConfig,
} from "./signal-extras";

declare module "@oh-my-pi/pi-coding-agent/extensibility/extensions" {
	interface ExtensionContext {
		readonly sessionResources: ActivitySessionResources;
	}
}

/** npm package name — the key the runtime plugin settings store files settings under. */
export const PLUGIN_NAME = "@oh-my-pi/animations";

/** The slash command the registrar registers for the Audit Box's cache ledger detail panel. */
export const CACHE_METER_COMMAND = "cache";

const MOTION_VALUES: readonly MotionSetting[] = ["off", "subtle", "full"];
const EMPTY_SESSION_RESOURCES: ActivitySessionResources = Object.freeze({
	skills: Object.freeze([]),
	contextFiles: Object.freeze([]),
});
// The manifest (package.json#omp.settings.animations.default) ships "subtle" as the
// curated native default; this code fallback stays "full" deliberately — it is the
// value used only when a key is entirely absent from both stored settings and env
// (e.g. direct programmatic use of createAnimationsPlugin() outside the omp host).
const DEFAULT_TIER: MotionSetting = "full";

/** One animation's identity for appearance resolution: its settings id, label, and historical side. */
export interface AnimationEntry {
	/** Flat settings key this animation's appearance settings hang off (e.g. `cacheMeter`). */
	id: string;
	/** Human-facing label. */
	title: string;
	/** Placement used when no `<id>Placement` setting/env is present — the animation's historical hardcoded side. */
	defaultPlacement: WidgetPlacement;
}

/**
 * The appearance table for the curated Animations Box animations. Agent Bonsai
 * and Live Files have separate visibility settings. Tool Activity and the
 * signal extras do not expose legacy placement or accent settings.
 *
 * Each entry resolves an `<id>Placement` and `<id>AccentColor` pair. No entry
 * mounts a widget. The shared box controller owns one widget registration.
 */
export const ANIMATIONS: readonly AnimationEntry[] = [
	{ id: "auditTrailBox", title: "Audit Trail Box", defaultPlacement: "belowEditor" },
	{ id: "breathingBorder", title: "Breathing Border", defaultPlacement: "aboveEditor" },
	{ id: "cacheMeter", title: "Cache Meter", defaultPlacement: "aboveEditor" },
	{ id: "rateLimitTidepool", title: "Rate-Limit Tidepool", defaultPlacement: "belowEditor" },
];

/** Fully-resolved registrar configuration. */
export interface AnimationsConfig {
	tier: MotionSetting;
	/** id -> resolved placement/accent. */
	appearance: Record<string, AnimationAppearance>;
}

function resolveTier(raw: unknown, fallback: MotionSetting): MotionSetting {
	return typeof raw === "string" && (MOTION_VALUES as readonly string[]).includes(raw)
		? (raw as MotionSetting)
		: fallback;
}

/**
 * Resolve the shared motion tier plus every animation's appearance from a flat
 * plugin-settings record and env fallbacks. Precedence per key: stored setting > env
 * fallback > default (tier `full`). Resolves each `<id>Placement`/`<id>AccentColor`
 * pair with that same precedence, plus `glyphPreset` — one shared value (the host
 * exposes a single current `SymbolPreset` per session, not a per-animation setting)
 * threaded uniformly into every entry's `AnimationAppearance`. Defaults to `"unicode"`.
 *
 * There is no enable map: per-animation visibility is now a box concern, resolved by
 * `resolveAnimationsBoxConfigFromSources` off the same flat keys.
 */
export function resolveAnimationsConfig(
	pluginSettings: Record<string, unknown> = {},
	env: Record<string, string | undefined> = Bun.env,
	glyphPreset: SymbolPreset = "unicode",
): AnimationsConfig {
	const tier = resolveTier(pluginSettings.animations ?? env.OMP_ANIMATIONS, DEFAULT_TIER);
	const appearance: Record<string, AnimationAppearance> = {};
	for (const animation of ANIMATIONS) {
		appearance[animation.id] = resolveAnimationAppearance(
			animation.id,
			animation.defaultPlacement,
			pluginSettings,
			env,
			glyphPreset,
		);
	}
	return { tier, appearance };
}

/** Project-level override dirs, highest priority first — mirrors `PROJECT_CONFIG_BASES` in
 * oh-my-pi's `packages/coding-agent/src/config.ts` (`.omp` via `CONFIG_DIR_NAME`, then the
 * agent-compat dirs it also scans for `plugin-overrides.json`). */
const PROJECT_OVERRIDE_DIRS: readonly string[] = [CONFIG_DIR_NAME, ".claude", ".codex", ".gemini"];

/** Reads and JSON-parses `filePath`, or `undefined` on any error (missing file, bad JSON, ...). */
function readJsonFileSync(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Synchronous mirror of `getPluginSettings(PLUGIN_NAME, cwd)` from oh-my-pi's
 * `packages/coding-agent/src/extensibility/plugins/loader.ts` (the canonical source): the
 * global plugins lockfile (`getPluginsLockfile()`, resolved via the same `@oh-my-pi/pi-utils`
 * helper the runtime store uses) merged with the first existing project override file across
 * `PROJECT_OVERRIDE_DIRS`, project settings winning per-key. Unlike the async original, a
 * corrupt global lockfile never throws here — it degrades to `{}`, because this reader runs
 * synchronously at plugin wire time and must never crash the host over a malformed file.
 * If oh-my-pi ever adds a seam to pass resolved settings into an extension factory, delete
 * this mirror and use it (see plans/001-registrar-reads-stored-settings.md's maintenance note).
 *
 * `home` overrides the global-lockfile root (`getPluginsLockfile`'s own test-isolation seam) —
 * production callers never pass it; it exists so tests get a deterministic global lockfile
 * location instead of depending on the real machine's `~/.omp`.
 */
export function readPluginSettingsSync(cwd: string = process.cwd(), home?: string): Record<string, unknown> {
	const globalConfig = readJsonFileSync(getPluginsLockfile(home));
	const globalSettings = globalConfig?.settings as Record<string, Record<string, unknown>> | undefined;
	const global = globalSettings?.[PLUGIN_NAME] ?? {};

	let project: Record<string, unknown> = {};
	for (const dir of PROJECT_OVERRIDE_DIRS) {
		const overrides = readJsonFileSync(path.join(cwd, dir, "plugin-overrides.json"));
		if (overrides !== undefined) {
			const projectSettings = overrides.settings as Record<string, Record<string, unknown>> | undefined;
			project = projectSettings?.[PLUGIN_NAME] ?? {};
			break;
		}
	}

	return { ...global, ...project };
}

/** Injectable seams for the plugin; production callers use the defaults. */
export interface AnimationsPluginOptions {
	/** Pre-resolved unified plugin settings used for wire-time gating. Defaults to
	 * `readPluginSettingsSync(options.cwd)` — the stored settings for this plugin. */
	settings?: Record<string, unknown>;
	/** Env source for the manifest env-var fallbacks. Defaults to `Bun.env`. */
	env?: Record<string, string | undefined>;
	/** Working directory for resolving project-level stored settings. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Test-isolation override for the global-lockfile home dir; see `readPluginSettingsSync`. */
	home?: string;
	/**
	 * The host's current symbol preset, threaded into every animation's
	 * `AnimationAppearance.glyphPreset` (see `resolveAnimationsConfig`). Defaults to
	 * `"unicode"` — the host's own default and today's hardcoded glyphs — because
	 * `ExtensionContext.ui.theme.getSymbolPreset()` is only reachable inside event
	 * handlers, never at this synchronous wire-time call (`ExtensionFactory` receives
	 * only `ExtensionAPI`, no `ExtensionContext`). An injectable seam for tests and for
	 * whichever future call site re-resolves this from a live `ctx`, mirroring `env`'s
	 * existing convention on this same options type.
	 */
	glyphPreset?: SymbolPreset;
	/** Shared plugin-local telemetry bus. Injectable for integration tests; production uses the process-global bus. */
	activityBus?: ActivityTelemetryBus;
	/** Clock shared with an injected activity bus scheduler. Defaults to Date.now. */
	now?: () => number;
}

/**
 * Build the single config-driven registrar extension: one headless Audit Trail service
 * sharing its ledger with the one Audit Box, plus an optional Agent Bonsai observer.
 * A stale `display` value warns once here and changes nothing else.
 */
export function createAnimationsPlugin(options: AnimationsPluginOptions = {}): ExtensionFactory {
	const env = options.env ?? Bun.env;
	const settings = options.settings ?? readPluginSettingsSync(options.cwd, options.home);
	const glyphPreset = options.glyphPreset ?? "unicode";
	const config = resolveAnimationsConfig(settings, env, glyphPreset);
	const boxConfig = resolveAnimationsBoxConfigFromSources(settings, env);
	const extrasConfig = resolveSignalExtrasConfig(settings, env);
	const activitySettings = resolveActivityRosterSettings(settings, env);
	const displayNotice = removedDisplayNotice(settings, env);
	const activityBus = options.activityBus ?? globalActivityTelemetryBus();
	return api => {
		if (displayNotice !== undefined) api.logger.warn(displayNotice);
		const auditTrailState = new AuditLedgerState();
		let boxController: AnimationsBoxController | undefined;
		const requestBoxRender = (): void => boxController?.requestRender();
		createAuditTrailBoxExtension({
			accentColor: config.appearance.auditTrailBox.accentColor,
			state: auditTrailState,
			onChange: requestBoxRender,
		})(api);
		boxController = mountAnimationsBox(
			api,
			boxConfig,
			extrasConfig,
			config,
			auditTrailState,
			options.cwd,
			activityBus,
			activitySettings,
			options.now,
		);
		registerCacheCommand(api, boxController, config.appearance.cacheMeter.accentColor);
		api.setLabel("oh-my-pi animations");
	};
}

/**
 * `/cache` — the session prompt-cache breakdown, rendered from the Audit Box's own
 * ledger. The box row is a one-line summary; this is the grouped detail view that
 * used to hang off the deleted `createCacheMeterExtension`. Registered here, next to
 * the Audit Trail service's `/audit-trail`, because the registrar holds the
 * host API and live states behind the shared controller.
 */
function registerCacheCommand(
	api: ExtensionAPI,
	controller: AnimationsBoxController,
	accentColor: AccentColor | undefined,
): void {
	api.registerCommand(CACHE_METER_COMMAND, {
		description: "Session prompt-cache breakdown: per-provider/model reads, writes, misses, hit rate, invalidations",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;
			const panel = renderCacheMeterPanel(controller.cacheMeter.snapshot(), ctx.ui.theme, {
				colors: cacheMeterColors(accentColor),
				preset: ctx.ui.theme.getSymbolPreset(),
			});
			ctx.ui.notify(panel.join("\n"), "info");
		},
	});
}

/**
 * Plugin-side mirror of the host's `entryUsage` (session-manager.ts): the two
 * entry classes whose cost `getUsageStatistics()` sums. Both sides of the
 * off-path subtraction must move together if the host adds a third class.
 */
function entryCostUsd(entry: SessionEntry): number {
	if (entry.type !== "message") return 0;
	const message = entry.message;
	let cost: unknown;
	if (message.role === "assistant") cost = message.usage?.cost.total;
	else if (message.role === "toolResult" && message.toolName === "task") {
		const details: unknown = message.details;
		const usage: unknown =
			details !== null && typeof details === "object" ? Reflect.get(details, "usage") : undefined;
		const costs: unknown = usage !== null && typeof usage === "object" ? Reflect.get(usage, "cost") : undefined;
		cost = costs !== null && typeof costs === "object" ? Reflect.get(costs, "total") : undefined;
	}
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function readSessionTopology(ctx: ExtensionContext): PhylogenySignal {
	const roots = ctx.sessionManager.getTree();
	const leafId = ctx.sessionManager.getLeafId();
	const branch = ctx.sessionManager.getBranch();
	let siblings = 0;
	if (leafId !== undefined) {
		type TreeNode = (typeof roots)[number];
		const findLeaf = (nodes: readonly TreeNode[]): boolean => {
			for (const candidate of nodes) {
				if (candidate.entry.id === leafId) {
					siblings = Math.max(0, nodes.length - 1);
					return true;
				}
				if (findLeaf(candidate.children)) return true;
			}
			return false;
		};
		findLeaf(roots);
	}

	let offPathCostUsd: number | undefined;
	try {
		const treeCost = ctx.sessionManager.getUsageStatistics().cost;
		let branchCost = 0;
		for (const entry of branch) branchCost += entryCostUsd(entry);
		if (Number.isFinite(treeCost)) offPathCostUsd = Math.max(0, treeCost - branchCost);
	} catch {
		// The host may throw before the session index exists; the span simply stays absent.
	}
	return { depth: branch.length, siblings, ...(offPathCostUsd !== undefined ? { offPathCostUsd } : {}) };
}

/** Adapt the host's `ExtensionContext` to the box controller's own narrower context. */
function toAnimationsBoxContext(ctx: ExtensionContext): AnimationsBoxContext {
	const glyphPreset = ctx.hasUI ? ctx.ui.theme.getSymbolPreset() : "unicode";
	const setWidget: AnimationsBoxContext["setWidget"] = ctx.hasUI
		? (key, content, widgetOptions) => ctx.ui.setWidget(key, content, widgetOptions)
		: () => undefined;
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		cwd: ctx.cwd,
		glyphPreset,
		getContextUsage: () => {
			try {
				return ctx.getContextUsage();
			} catch {
				return undefined;
			}
		},
		getTranscriptTokens: () => {
			let tokens = 0;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message") tokens += estimateContentTokens(entry.message);
			}
			return tokens;
		},
		getSessionTopology: () => readSessionTopology(ctx),
		getMemoryStatus: async () => ctx.memory?.status(),
		getAsyncJobSnapshot: () => {
			try {
				return ctx.getAsyncJobSnapshot();
			} catch {
				return null;
			}
		},
		setWidget,
		...(ctx.hasUI && typeof ctx.ui.setTitle === "function"
			? { setTitle: (title: string) => ctx.ui.setTitle(title) }
			: {}),
	};
}

/**
 * Mount the Animations Box and subscribe its full event surface — the same union
 * `src/animations-box/controller.ts`'s own module doc enumerates. `mount()` runs once,
 * unconditionally, off `session_start`: every other event handler below narrows
 * `ExtensionContext` structurally to whichever `Pick<AnimationsBoxContext, ...>` that
 * controller method needs, with no per-event adapter (the two share field names).
 */
/** The order inside each handler is load-bearing: probe before bonsai before controller — the roster/bonsai state a frame reads must be written before the controller schedules that frame. Asserted by the fan-out characterization test. */
export interface FanoutSinks {
	ensureActivity(ctx: ExtensionContext): void;
	completeActivity(): void;
	probe(): ActivityProbe | undefined;
	bonsai(): AgentBonsaiController | undefined;
	controller: Pick<
		AnimationsBoxController,
		| "onToolExecutionStart"
		| "onToolExecutionUpdate"
		| "onToolExecutionEnd"
		| "onTurnStart"
		| "onTurnEnd"
		| "onAgentStart"
		| "onAgentEnd"
	>;
}

export function wireEventFanout(api: ExtensionAPI, sinks: FanoutSinks): void {
	api.on("tool_execution_start", (event, ctx) => {
		sinks.ensureActivity(ctx);
		sinks.probe()?.startTool({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
		sinks.controller.onToolExecutionStart(event, ctx);
	});
	api.on("tool_execution_update", (event, ctx) => {
		sinks.ensureActivity(ctx);
		sinks.probe()?.updateTool({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
		sinks.bonsai()?.onToolExecutionUpdate(event);
		sinks.controller.onToolExecutionUpdate(event, ctx);
	});
	api.on("tool_execution_end", (event, ctx) => {
		sinks.ensureActivity(ctx);
		sinks.probe()?.endTool({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
		sinks.bonsai()?.onToolExecutionEnd(event);
		sinks.controller.onToolExecutionEnd(event, ctx);
	});
	api.on("turn_start", (event, ctx) => {
		sinks.bonsai()?.noteMainModel(ctx.model?.id);
		sinks.controller.onTurnStart(event, ctx);
	});
	api.on("turn_end", (event, ctx) => sinks.controller.onTurnEnd(event, ctx));
	api.on("agent_start", (event, ctx) => {
		sinks.ensureActivity(ctx);
		sinks.bonsai()?.onAgentStart();
		if (ctx.hasUI) sinks.probe()?.beginRequest();
		sinks.controller.onAgentStart(event, ctx);
	});
	api.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI && event.willContinue !== true) sinks.completeActivity();
		sinks.bonsai()?.onAgentEnd(event.willContinue === true);
		sinks.controller.onAgentEnd(event, ctx);
	});
}

interface ActivitySessionManager {
	getSessionId?(): string;
	getArtifactsDir?(): string | null;
	getSessionFile?(): string | null;
}

function mountAnimationsBox(
	api: ExtensionAPI,
	boxConfig: AnimationsBoxConfig,
	extrasConfig: SignalExtrasConfig,
	config: AnimationsConfig,
	auditTrailState: AuditLedgerState,
	cwd: string | undefined,
	activityBus: ActivityTelemetryBus,
	activitySettings: ActivityRosterSettings,
	now: (() => number) | undefined,
): AnimationsBoxController {
	let activityProbe: ActivityProbe | undefined;
	const agentBonsai = boxConfig.optional.agentBonsai
		? new AgentBonsaiController({
				cwd,
				now,
				settleSeconds: activitySettings.retentionMs / 1_000,
				onChange: () => controller.requestRender(),
				onAgentOutcome: (id, outcome, completedAt) => activityProbe?.noteAgentOutcome(id, outcome, completedAt),
			})
		: undefined;
	const controller = new AnimationsBoxController({
		placement: boxConfig.placement,
		motionSetting: config.tier,
		initialConfig: boxConfig,
		initialExtrasConfig: extrasConfig,
		accentColor: config.appearance.breathingBorder.accentColor,
		auditTrailState,
		agentBonsai,
		onRenderError: error => {
			const detail =
				error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { error };
			api.logger.error("@oh-my-pi/animations: Audit Box render threw; widget disabled for this session", detail);
		},
		// glyphPreset is NOT threaded through `AnimationsBoxControllerOptions` here (unlike
		// accentColor) — it isn't resolvable at this synchronous wire-time call. Instead
		// `toAnimationsBoxContext` reads the live `ctx.ui.theme.getSymbolPreset()` fresh on
		// `session_start`, and `AnimationsBoxController.mount` captures it once from there.
	});
	let activityCompleted = false;
	const bindActivity = (ctx: ExtensionContext): void => {
		if (activityProbe !== undefined) {
			if (ctx.hasUI) activityProbe.dispose();
			else activityProbe.complete();
			activityProbe = undefined;
		}
		controller.attachActivityProbe(undefined);
		const sessionManager = ctx.sessionManager as ActivitySessionManager | undefined;
		if (sessionManager === undefined) return;
		const sessionId = sessionManager.getSessionId?.();
		if (sessionId === undefined) return;
		activityProbe = activityBus.registerSession({
			sessionId,
			hasUI: ctx.hasUI,
			cwd: ctx.cwd,
			sessionResources: ctx.sessionResources ?? EMPTY_SESSION_RESOURCES,
			artifactsDir: sessionManager.getArtifactsDir?.() ?? undefined,
			sessionFile: sessionManager.getSessionFile?.() ?? undefined,
			model: ctx.model?.id,
			retentionMs: ctx.hasUI ? activitySettings.retentionMs : undefined,
			detail: ctx.hasUI ? activitySettings.detail : undefined,
		});
		activityCompleted = false;
		controller.attachActivityProbe(ctx.hasUI ? activityProbe : undefined);
	};
	const ensureActivity = (ctx: ExtensionContext): void => {
		if (activityProbe === undefined) bindActivity(ctx);
	};
	const completeActivity = (): void => {
		if (activityCompleted) return;
		activityCompleted = true;
		activityProbe?.complete();
	};

	api.on("session_start", (_event, ctx) => {
		bindActivity(ctx);
		agentBonsai?.mount();
		agentBonsai?.noteMainModel(ctx.model?.id);
		controller.mount(toAnimationsBoxContext(ctx));
	});
	api.on("message_start", (event, ctx) => controller.onMessageStart(event, ctx));
	api.on("message_end", (event, ctx) => controller.onMessageEnd(event, ctx));
	api.on("after_provider_response", (event, ctx) => controller.onAfterProviderResponse(event, ctx));
	api.on("context", (event, ctx) => controller.onContext(event, toAnimationsBoxContext(ctx)));
	api.on("tool_call", (event, ctx) => controller.onToolCall(event, ctx));
	api.on("tool_result", (event, ctx) => controller.onToolResult(event, ctx));
	wireEventFanout(api, {
		ensureActivity,
		completeActivity,
		probe: () => activityProbe,
		bonsai: () => agentBonsai,
		controller,
	});
	api.on("session_before_compact", (event, ctx) =>
		controller.onSessionBeforeCompact(event, toAnimationsBoxContext(ctx)),
	);
	api.on("session_compact", (_event, ctx) => controller.onSessionCompact(ctx));
	api.on("auto_compaction_start", (event, ctx) => controller.onAutoCompactionStart(event, ctx));
	api.on("auto_compaction_end", (_event, ctx) => controller.onAutoCompactionEnd(ctx));
	api.on("tool_approval_requested", (event, ctx) => controller.onToolApprovalRequested(event, ctx));
	api.on("tool_approval_resolved", (event, ctx) => controller.onToolApprovalResolved(event, ctx));
	api.on("session_branch", (event, ctx) => controller.onSessionTopology(event, toAnimationsBoxContext(ctx)));
	api.on("session_tree", (event, ctx) => controller.onSessionTopology(event, toAnimationsBoxContext(ctx)));
	api.on("auto_retry_start", (event, ctx) => controller.onAutoRetryStart(event, ctx));
	api.on("auto_retry_end", (event, ctx) => controller.onAutoRetryEnd(event, ctx));
	api.on("retry_fallback_applied", (event, ctx) => controller.onRetryFallbackApplied(event, ctx));
	api.on("retry_fallback_succeeded", (event, ctx) => controller.onRetryFallbackSucceeded(event, ctx));
	api.on("credential_disabled", (event, ctx) => controller.onCredentialDisabled(event, ctx));
	api.on("goal_updated", (event, ctx) => controller.onGoalUpdated(event, ctx));
	api.on("session_switch", (event, ctx) => {
		bindActivity(ctx);
		agentBonsai?.mount();
		agentBonsai?.noteMainModel(ctx.model?.id);
		controller.onSessionSwitch(event, ctx);
	});
	api.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) activityProbe?.dispose();
		else completeActivity();
		activityProbe = undefined;
		agentBonsai?.dispose();
		controller.dispose(toAnimationsBoxContext(ctx));
	});
	return controller;
}

export default createAnimationsPlugin();
