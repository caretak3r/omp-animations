/**
 * @oh-my-pi/animations — the single config-driven plugin entry.
 *
 * This is the one extension the omp manifest declares (`package.json#omp.extensions`).
 * It reads the plugin's settings — a per-animation enable map plus the shared
 * `animations` motion tier (`off` · `subtle` · `full`) — and mounts ONLY the enabled
 * animations by conditionally invoking each one's `createXExtension()` factory against
 * the shared `ExtensionAPI`. A factory that is never invoked registers no `api.on(...)`
 * subscriptions, so a disabled animation leaves zero listeners behind. Each mounted
 * animation additionally self-gates through the kit's `MotionPolicy`.
 *
 * Enablement and tier are resolved SYNCHRONOUSLY at wire time (before any event fires)
 * so the zero-leak contract holds. Resolution precedence: an injected `settings` record
 * (the host's or a test's resolved plugin settings) > the stored plugin settings
 * (`readPluginSettingsSync`, a synchronous mirror of the runtime store) > the manifest
 * `env` fallbacks > per-animation defaults (tier `full`).
 *
 * `readPluginSettings`/`env` stay on `MountContext` as a generic seam for any animation
 * that self-resolves richer settings beyond the shared enable+tier map — none of this
 * package's shipped animations currently use it.
 *
 * A second setting, `display` (`rows` · `box` · `both`, default `box`), governs whether
 * each animation mounts a standalone row or the consolidated Audit Box owns it.
 * Whenever the Box is present, Audit Trail runs as a headless ledger/probe/remedy
 * service and shares its authoritative state with the Box's required `audit` row.
 * It never mounts a duplicate row or footer status.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CONFIG_DIR_NAME, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { AgentBonsaiController } from "./agent-bonsai";
import { type AnimationsBoxContext, AnimationsBoxController } from "./animations-box/controller";
import {
	type AnimationsBoxConfig,
	BOX_MIGRATED_ANIMATION_IDS,
	resolveAnimationsBoxConfigFromSources,
} from "./animations-box/settings";
import { type AnimationAppearance, animationsEnvKey, resolveAnimationAppearance } from "./appearance";
import { AuditLedgerState, createAuditTrailBoxExtension } from "./audit-trail-box";
import { createBreathingBorderExtension } from "./breathing-border";
import { createCacheMeterExtension } from "./cache-meter";
import { createCadenceEqualizerExtension } from "./cadence-equalizer";
import type { MotionSetting } from "./kit";
import { createPalimpsestExtension } from "./palimpsest";
import { createRateLimitTidepoolExtension } from "./rate-limit-tidepool";
import { createReflectionRippleExtension } from "./reflection-ripple";

/** npm package name — the key the runtime plugin settings store files settings under. */
export const PLUGIN_NAME = "@oh-my-pi/animations";

const MOTION_VALUES: readonly MotionSetting[] = ["off", "subtle", "full"];
// The manifest (package.json#omp.settings.animations.default) ships "subtle" as the
// curated native default; this code fallback stays "full" deliberately — it is the
// value used only when a key is entirely absent from both stored settings and env
// (e.g. direct programmatic use of createAnimationsPlugin() outside the omp host).
const DEFAULT_TIER: MotionSetting = "full";

/** Reads THIS plugin's stored settings (unified). Async, matching the runtime store. */
export type PluginSettingsReader = (cwd: string) => Promise<Record<string, unknown>>;

/** Everything a mounted animation may need beyond the raw `ExtensionAPI`. */
export interface MountContext {
	/** Shared motion tier resolved from settings. */
	tier: MotionSetting;
	/** id -> resolved placement/accent for that animation. */
	appearance: Record<string, AnimationAppearance>;
	/** Reader pointed at this plugin's unified settings (for self-resolving animations). */
	readPluginSettings: PluginSettingsReader;
	/** Env source for manifest env-var fallbacks. */
	env: Record<string, string | undefined>;
	/** Authoritative Audit Trail state shared by its service and the Audit Box. */
	auditTrailState: AuditLedgerState;
}

/** A single mountable animation: its settings id, label, and how to wire it. */
export interface AnimationEntry {
	/** Flat settings key that toggles this animation (e.g. `cacheMeter`). */
	id: string;
	/** Human-facing label. */
	title: string;
	/** Placement used when no `<id>Placement` setting/env is present — the animation's historical hardcoded side. */
	defaultPlacement: WidgetPlacement;
	/** Enablement used when neither a stored setting nor an env fallback exists. Defaults to `true`. */
	defaultEnabled?: boolean;
	/** Wire the animation onto `api`. Called only when the animation is enabled. */
	mount: (api: ExtensionAPI, ctx: MountContext) => void;
}

/**
 * The config-driven registry of this package's shipped animations:
 * audit-trail-box, breathing-border, cache-meter, cadence-equalizer,
 * palimpsest, rate-limit-tidepool, and reflection-ripple. Agent Bonsai is an
 * Audit Box group rather than an independent animation, and the Audit Box's
 * `tools` row is a box-owned tally with no standalone animation behind it
 * (Tool Constellation was deleted in `omp-animations-buv.4`).
 *
 * Every shipped animation threads the resolved `<id>Placement`/`<id>AccentColor`
 * appearance record (see `appearance.ts`) straight through its factory.
 */
export const ANIMATIONS: readonly AnimationEntry[] = [
	{
		id: "auditTrailBox",
		title: "Audit Trail Box",
		defaultPlacement: "belowEditor",
		mount: (api, c) =>
			createAuditTrailBoxExtension({
				motionSetting: c.tier,
				...c.appearance.auditTrailBox,
				state: c.auditTrailState,
			})(api),
	},
	{
		id: "breathingBorder",
		title: "Breathing Border",
		defaultPlacement: "aboveEditor",
		mount: (api, c) =>
			createBreathingBorderExtension({ motionSetting: c.tier, ...c.appearance.breathingBorder })(api),
	},
	{
		id: "cacheMeter",
		title: "Cache Meter",
		defaultPlacement: "aboveEditor",
		mount: (api, c) => createCacheMeterExtension({ motionSetting: c.tier, ...c.appearance.cacheMeter })(api),
	},
	{
		id: "cadenceEqualizer",
		title: "Cadence Equalizer",
		defaultPlacement: "belowEditor",
		mount: (api, c) =>
			createCadenceEqualizerExtension({ motionSetting: c.tier, ...c.appearance.cadenceEqualizer })(api),
	},
	{
		id: "palimpsest",
		title: "Palimpsest",
		defaultPlacement: "belowEditor",
		mount: (api, c) => createPalimpsestExtension({ motionSetting: c.tier, ...c.appearance.palimpsest })(api),
	},
	{
		id: "rateLimitTidepool",
		title: "Rate-Limit Tidepool",
		defaultPlacement: "belowEditor",
		mount: (api, c) =>
			createRateLimitTidepoolExtension({ motionSetting: c.tier, ...c.appearance.rateLimitTidepool })(api),
	},
	{
		id: "reflectionRipple",
		title: "Reflection Ripple",
		defaultPlacement: "aboveEditor",
		mount: (api, c) =>
			createReflectionRippleExtension({ motionSetting: c.tier, ...c.appearance.reflectionRipple })(api),
	},
];

/** Fully-resolved registrar configuration. */
export interface AnimationsConfig {
	tier: MotionSetting;
	/** id -> whether the animation mounts. */
	enabled: Record<string, boolean>;
	/** id -> resolved placement/accent. */
	appearance: Record<string, AnimationAppearance>;
}

function resolveTier(raw: unknown, fallback: MotionSetting): MotionSetting {
	return typeof raw === "string" && (MOTION_VALUES as readonly string[]).includes(raw)
		? (raw as MotionSetting)
		: fallback;
}

function resolveBoolean(raw: unknown, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return fallback;
}

/**
 * Resolve the enable map + tier from a flat plugin-settings record and env fallbacks.
 * Precedence per key: stored setting > env fallback > the entry's default / tier `full`.
 * A stored `false` disables (nullish coalescing only falls through on null/undefined).
 * Also resolves each animation's `<id>Placement`/`<id>AccentColor` appearance settings
 * with the same precedence, plus `glyphPreset` — one shared value (the host exposes a
 * single current `SymbolPreset` per session, not a per-animation setting) threaded
 * uniformly into every entry's `AnimationAppearance`. Defaults to `"unicode"`.
 */
export function resolveAnimationsConfig(
	pluginSettings: Record<string, unknown> = {},
	env: Record<string, string | undefined> = Bun.env,
	glyphPreset: SymbolPreset = "unicode",
): AnimationsConfig {
	const tier = resolveTier(pluginSettings.animations ?? env.OMP_ANIMATIONS, DEFAULT_TIER);
	const enabled: Record<string, boolean> = {};
	const appearance: Record<string, AnimationAppearance> = {};
	for (const animation of ANIMATIONS) {
		const stored = pluginSettings[animation.id];
		const fromEnv = env[animationsEnvKey(animation.id)];
		enabled[animation.id] = resolveBoolean(stored ?? fromEnv, animation.defaultEnabled ?? true);
		appearance[animation.id] = resolveAnimationAppearance(
			animation.id,
			animation.defaultPlacement,
			pluginSettings,
			env,
			glyphPreset,
		);
	}
	return { tier, enabled, appearance };
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
	/** Pre-resolved unified plugin settings used for wire-time enable/tier gating. Defaults to
	 * `readPluginSettingsSync(options.cwd)` — the stored settings for this plugin. */
	settings?: Record<string, unknown>;
	/** Env source for the manifest env-var fallbacks. Defaults to `Bun.env`. */
	env?: Record<string, string | undefined>;
	/** Async reader of this plugin's stored settings. Defaults to the runtime store. */
	readPluginSettings?: PluginSettingsReader;
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
}

/**
 * Build the single config-driven registrar extension. Synchronously mounts
 * standalone rows according to `display`, then mounts the consolidated Audit
 * Box with one shared Audit ledger and one Agent Bonsai observer.
 */
export function createAnimationsPlugin(options: AnimationsPluginOptions = {}): ExtensionFactory {
	const env = options.env ?? Bun.env;
	const settings = options.settings ?? readPluginSettingsSync(options.cwd, options.home);
	const glyphPreset = options.glyphPreset ?? "unicode";
	const config = resolveAnimationsConfig(settings, env, glyphPreset);
	const boxConfig = resolveAnimationsBoxConfigFromSources(settings, env);
	const readPluginSettings = options.readPluginSettings ?? ((cwd: string) => getPluginSettings(PLUGIN_NAME, cwd));
	return api => {
		const auditTrailState = new AuditLedgerState();
		const boxMounted = boxConfig.display === "box" || boxConfig.display === "both";
		let boxController: AnimationsBoxController | undefined;
		const requestBoxRender = (): void => boxController?.requestRender();
		const agentBonsai =
			boxMounted && boxConfig.optional.agentBonsai
				? new AgentBonsaiController({ onChange: requestBoxRender, cwd: options.cwd })
				: undefined;
		const mountContext: MountContext = {
			tier: config.tier,
			appearance: config.appearance,
			readPluginSettings,
			env,
			auditTrailState,
		};
		if (boxMounted) {
			createAuditTrailBoxExtension({
				motionSetting: config.tier,
				...config.appearance.auditTrailBox,
				state: auditTrailState,
				headless: true,
				onChange: requestBoxRender,
			})(api);
		}
		for (const animation of ANIMATIONS) {
			if (animation.id === "auditTrailBox" && boxMounted) continue;
			if (!config.enabled[animation.id]) continue;
			if (boxConfig.display === "box" && BOX_MIGRATED_ANIMATION_IDS.includes(animation.id)) continue;
			animation.mount(api, mountContext);
		}
		if (boxMounted) boxController = mountAnimationsBox(api, boxConfig, config, auditTrailState, agentBonsai);
		api.setLabel("oh-my-pi animations");
	};
}

/** Adapt the host's `ExtensionContext` to the box controller's own narrower context. */
function toAnimationsBoxContext(ctx: ExtensionContext): AnimationsBoxContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		cwd: ctx.cwd,
		glyphPreset: ctx.ui.theme.getSymbolPreset(),
		setWidget: (key, content, widgetOptions) => ctx.ui.setWidget(key, content, widgetOptions),
	};
}

/**
 * Mount the Animations Box and subscribe its full event surface — the same union
 * `src/animations-box/controller.ts`'s own module doc enumerates. `mount()` runs once,
 * unconditionally, off `session_start`: every other event handler below narrows
 * `ExtensionContext` structurally to whichever `Pick<AnimationsBoxContext, ...>` that
 * controller method needs, with no per-event adapter (the two share field names).
 */
function mountAnimationsBox(
	api: ExtensionAPI,
	boxConfig: AnimationsBoxConfig,
	config: AnimationsConfig,
	auditTrailState: AuditLedgerState,
	agentBonsai: AgentBonsaiController | undefined,
): AnimationsBoxController {
	const controller = new AnimationsBoxController({
		placement: boxConfig.placement,
		motionSetting: config.tier,
		initialConfig: boxConfig,
		accentColor: config.appearance.breathingBorder.accentColor,
		auditTrailState,
		agentBonsai,
		// glyphPreset is NOT threaded through `AnimationsBoxControllerOptions` here (unlike
		// accentColor) — it isn't resolvable at this synchronous wire-time call. Instead
		// `toAnimationsBoxContext` reads the live `ctx.ui.theme.getSymbolPreset()` fresh on
		// `session_start`, and `AnimationsBoxController.mount` captures it once from there.
	});

	api.on("session_start", (_event, ctx) => {
		agentBonsai?.mount();
		agentBonsai?.noteMainModel(ctx.model?.id);
		controller.mount(toAnimationsBoxContext(ctx));
	});
	api.on("message_start", (event, ctx) => controller.onMessageStart(event, ctx));
	api.on("message_update", (event, ctx) => controller.onMessageUpdate(event, ctx));
	api.on("message_end", (event, ctx) => controller.onMessageEnd(event, ctx));
	api.on("after_provider_response", (event, ctx) => controller.onAfterProviderResponse(event, ctx));
	api.on("tool_call", (event, ctx) => controller.onToolCall(event, ctx));
	api.on("tool_result", (event, ctx) => controller.onToolResult(event, ctx));
	api.on("turn_start", (event, ctx) => {
		agentBonsai?.noteMainModel(ctx.model?.id);
		controller.onTurnStart(event, ctx);
	});
	api.on("turn_end", (event, ctx) => controller.onTurnEnd(event, ctx));
	// The Bonsai prunes settled subagents per user request, not per provider turn:
	// a `task` result is consumed by the turn right after it lands, so pruning
	// there would erase the row the moment it became worth reading.
	api.on("agent_start", (event, ctx) => {
		agentBonsai?.onAgentStart();
		controller.onAgentStart(event, ctx);
	});
	api.on("agent_end", (event, ctx) => {
		agentBonsai?.onAgentEnd(event.willContinue === true);
		controller.onAgentEnd(event, ctx);
	});
	api.on("tool_execution_update", event => agentBonsai?.onToolExecutionUpdate(event));
	api.on("tool_execution_end", event => agentBonsai?.onToolExecutionEnd(event));
	api.on("session_compact", (_event, ctx) => controller.onSessionCompact(ctx));
	api.on("auto_compaction_start", (event, ctx) => controller.onAutoCompactionStart(event, ctx));
	api.on("auto_compaction_end", (_event, ctx) => controller.onAutoCompactionEnd(ctx));
	api.on("ttsr_triggered", (event, ctx) => controller.onTtsrTriggered(event, ctx));
	api.on("session_switch", (event, ctx) => {
		agentBonsai?.mount();
		agentBonsai?.noteMainModel(ctx.model?.id);
		controller.onSessionSwitch(event, ctx);
	});
	api.on("session_shutdown", (_event, ctx) => {
		agentBonsai?.dispose();
		controller.dispose(toAnimationsBoxContext(ctx));
	});
	return controller;
}

export default createAnimationsPlugin();
