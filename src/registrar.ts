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
 * `env` fallbacks > defaults (every registered animation enabled, tier `full`).
 *
 * `readPluginSettings`/`env` stay on `MountContext` as a generic seam for any animation
 * that self-resolves richer settings beyond the shared enable+tier map — none of this
 * package's shipped animations currently use it.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionFactory, WidgetPlacement } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { CONFIG_DIR_NAME, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { type AnimationAppearance, animationsEnvKey, resolveAnimationAppearance } from "./appearance";
import { createAuditTrailBoxExtension } from "./audit-trail-box";
import { createBreathingBorderExtension } from "./breathing-border";
import { createCacheMeterExtension } from "./cache-meter";
import { createCadenceEqualizerExtension } from "./cadence-equalizer";
import type { MotionSetting } from "./kit";
import { createPalimpsestExtension } from "./palimpsest";
import { createRateLimitTidepoolExtension } from "./rate-limit-tidepool";
import { createReflectionRippleExtension } from "./reflection-ripple";
import { createToolConstellationExtension } from "./tool-constellation";

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
}

/** A single mountable animation: its settings id, label, and how to wire it. */
export interface AnimationEntry {
	/** Flat settings key that toggles this animation (e.g. `toolConstellation`). */
	id: string;
	/** Human-facing label. */
	title: string;
	/** Placement used when no `<id>Placement` setting/env is present — the animation's historical hardcoded side. */
	defaultPlacement: WidgetPlacement;
	/** Wire the animation onto `api`. Called only when the animation is enabled. */
	mount: (api: ExtensionAPI, ctx: MountContext) => void;
}

/**
 * The config-driven registry of this package's shipped animations: audit-trail-box,
 * breathing-border, cache-meter, cadence-equalizer, palimpsest, rate-limit-tidepool,
 * reflection-ripple, and tool-constellation — a curated keep-set chosen from the larger
 * oh-my-pi-animations suite. Every other animation's source was deliberately left out of
 * this package's copy rather than shipped here unregistered.
 *
 * Every shipped animation threads the resolved `<id>Placement`/`<id>AccentColor`
 * appearance record (see `appearance.ts`) straight through its factory.
 * `toolConstellation` is the one exception on the accent half: its star field is
 * colored by a seven-way per-category rainbow with no single overridable slot (see
 * its `index.ts`), so its factory only accepts `placement` — the resolved
 * `accentColor` still flows through the spread below for uniformity with every
 * other entry, but the factory itself ignores it.
 */
export const ANIMATIONS: readonly AnimationEntry[] = [
	{
		id: "auditTrailBox",
		title: "Audit Trail Box",
		defaultPlacement: "belowEditor",
		mount: (api, c) => createAuditTrailBoxExtension({ motionSetting: c.tier, ...c.appearance.auditTrailBox })(api),
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
	{
		id: "toolConstellation",
		title: "Tool Constellation",
		defaultPlacement: "belowEditor",
		mount: (api, c) =>
			createToolConstellationExtension({ motionSetting: c.tier, ...c.appearance.toolConstellation })(api),
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
 * Precedence per key: stored setting > env fallback > default (enabled / tier `full`).
 * A stored `false` disables (nullish coalescing only falls through on null/undefined).
 * Also resolves each animation's `<id>Placement`/`<id>AccentColor` appearance settings with the same precedence.
 */
export function resolveAnimationsConfig(
	pluginSettings: Record<string, unknown> = {},
	env: Record<string, string | undefined> = Bun.env,
): AnimationsConfig {
	const tier = resolveTier(pluginSettings.animations ?? env.OMP_ANIMATIONS, DEFAULT_TIER);
	const enabled: Record<string, boolean> = {};
	const appearance: Record<string, AnimationAppearance> = {};
	for (const animation of ANIMATIONS) {
		const stored = pluginSettings[animation.id];
		const fromEnv = env[animationsEnvKey(animation.id)];
		enabled[animation.id] = resolveBoolean(stored ?? fromEnv, true);
		appearance[animation.id] = resolveAnimationAppearance(
			animation.id,
			animation.defaultPlacement,
			pluginSettings,
			env,
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
}

/**
 * Build the single config-driven registrar extension. Synchronously mounts exactly the
 * enabled animations and nothing for the disabled ones.
 */
export function createAnimationsPlugin(options: AnimationsPluginOptions = {}): ExtensionFactory {
	const env = options.env ?? Bun.env;
	const settings = options.settings ?? readPluginSettingsSync(options.cwd, options.home);
	const config = resolveAnimationsConfig(settings, env);
	const readPluginSettings = options.readPluginSettings ?? ((cwd: string) => getPluginSettings(PLUGIN_NAME, cwd));

	return api => {
		const mountContext: MountContext = {
			tier: config.tier,
			appearance: config.appearance,
			readPluginSettings,
			env,
		};
		for (const animation of ANIMATIONS) {
			if (config.enabled[animation.id]) animation.mount(api, mountContext);
		}
		// Set last: `setLabel` is last-write-wins on the shared extension, so the
		// registrar's own label must win over any mounted animation's own setLabel call
		// (historically Context Weather did this internally; it is unregistered as of
		// Plan 007, but the ordering guard is kept in case a future animation does the
		// same).
		api.setLabel("oh-my-pi animations");
	};
}

export default createAnimationsPlugin();
