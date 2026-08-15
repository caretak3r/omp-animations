/**
 * Animations Box — settings resolution.
 *
 * Follows the same flat-manifest-key, stored > env > default precedence every
 * other setting in this package uses (see `../appearance.ts`'s module doc).
 * `PLUGIN_NAME` is duplicated from `../registrar.ts` rather than imported —
 * importing it back would make `registrar.ts` and this module import each
 * other once the box is wired into the registrar (`oh-my-pi-dxi.7`), and the
 * string is a stable, already-shipped plugin identity, not something that
 * drifts.
 */
import type { WidgetPlacement } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { animationsEnvKey } from "../appearance";

const PLUGIN_NAME = "@oh-my-pi/animations";

/** Required summaries always render in this order and have no box-level visibility setting. */
export const BOX_REQUIRED_SEGMENT_IDS = [
	"cacheMeter",
	"auditTrailBox",
	"rateLimitTidepool",
	"toolActivity",
	"palimpsest",
] as const;

export type BoxRequiredSegmentId = (typeof BOX_REQUIRED_SEGMENT_IDS)[number];

/** Optional Audit Box groups, in deterministic order. */
export const BOX_OPTIONAL_SEGMENT_IDS = ["cadenceEqualizer", "reflectionRipple", "agentBonsai"] as const;

/** Optional status-line animations consumed by simple-mode composition. */
export const BOX_OPTIONAL_STATUS_SEGMENT_IDS = ["cadenceEqualizer", "reflectionRipple"] as const;

export type BoxOptionalSegmentId = (typeof BOX_OPTIONAL_SEGMENT_IDS)[number];
export type BoxOptionalStatusSegmentId = (typeof BOX_OPTIONAL_STATUS_SEGMENT_IDS)[number];

/** Complete status-line segment priority order, shared with simple-mode width degradation. */
export const BOX_SEGMENT_IDS = [...BOX_REQUIRED_SEGMENT_IDS, ...BOX_OPTIONAL_STATUS_SEGMENT_IDS] as const;
export type BoxSegmentId = (typeof BOX_SEGMENT_IDS)[number];

/** Breathing Border's own animation id. Not a {@link BoxSegmentId} — its row is replaced by the box's own border chrome (Decision 2), not a composed segment — but its existing per-animation enable boolean still gates whether that chrome breathes. */
const BREATHING_BORDER_ID = "breathingBorder";

/**
 * The animations that stop mounting standalone rows when the box owns them
 * (`display !== "rows"`): every segment that still has a standalone widget,
 * plus Breathing Border, which the box renders as chrome rather than as a
 * segment. `toolActivity` is excluded — Tool Constellation was deleted
 * outright (`omp-animations-buv.4`) and its row is box-only, so there is no
 * standalone animation of that id left to migrate.
 */
export const BOX_MIGRATED_ANIMATION_IDS: readonly string[] = [
	...BOX_SEGMENT_IDS.filter(id => id !== "toolActivity"),
	BREATHING_BORDER_ID,
];

/** `rows` is today's behavior unchanged; `box` mounts the one consolidated widget; `both` is a debug/compare mode. */
export type BoxDisplay = "rows" | "box" | "both";
const BOX_DISPLAY_VALUES: readonly BoxDisplay[] = ["rows", "box", "both"];

/** No `"off"` value: `display: "rows"` already expresses "no box" (Decision 3). */
export type BoxDetail = "simple" | "detailed";
const BOX_DETAIL_VALUES: readonly BoxDetail[] = ["simple", "detailed"];

const BOX_PLACEMENT_VALUES: readonly WidgetPlacement[] = ["aboveEditor", "belowEditor"];

/** Fully-resolved, validated box configuration. */
export interface AnimationsBoxConfig {
	display: BoxDisplay;
	detail: BoxDetail;
	placement: WidgetPlacement;
	/**
	 * Standalone-row enable decisions. These preserve the existing `rows` and
	 * `both` display behavior until the later Box-only registrar cutover.
	 * Required Audit Box summaries do not consult this map.
	 */
	enabled: Readonly<Record<BoxSegmentId, boolean>>;
	/**
	 * Box participation for optional animations only. Cadence and Reflection
	 * default to false; Agent Bonsai defaults to true. Explicit settings use
	 * each optional group's existing flat key.
	 */
	optional: Readonly<Record<BoxOptionalSegmentId, boolean>>;
	/**
	 * Whether the box's border chrome breathes. The existing
	 * `breathingBorder` setting also gates its standalone row in `rows` mode.
	 * This is not a `BoxSegmentId` because it colors the frame itself.
	 */
	breathingBorder: boolean;
}

/** Flat manifest setting keys (package.json#omp.settings — no nesting). */
export const BOX_SETTING_KEYS = {
	display: "display",
	detail: "animationsBoxDetail",
	placement: "animationsBoxPlacement",
} as const;

/** Env-var fallbacks mirroring each manifest setting's `env` field. */
export const BOX_SETTING_ENV = {
	display: "OMP_ANIMATIONS_DISPLAY",
	detail: "OMP_ANIMATIONS_BOX_DETAIL",
	placement: "OMP_ANIMATIONS_BOX_PLACEMENT",
} as const;

export const BOX_DEFAULTS: Pick<AnimationsBoxConfig, "display" | "detail" | "placement"> = {
	display: "box",
	detail: "detailed",
	placement: "belowEditor",
};

function resolveEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
	return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Mirrors `registrar.ts`'s own private `resolveBoolean` — kept as a local copy for the same reason `PLUGIN_NAME` is above (no import back into `registrar.ts`). */
function resolveBoolean(raw: unknown, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return fallback;
}

/**
 * Resolve the box config from a flat raw settings record (already merged
 * stored-settings-over-env, matching every other resolver in this package).
 * Missing/malformed values fall back to defaults rather than throwing. Each
 * segment's enable boolean reads `raw[id]` directly — the same flat key its
 * standalone row's registrar entry already reads.
 */
export function resolveAnimationsBoxConfig(raw: Record<string, unknown>): AnimationsBoxConfig {
	const enabled = {} as Record<BoxSegmentId, boolean>;
	for (const id of BOX_SEGMENT_IDS) enabled[id] = resolveBoolean(raw[id], true);
	const optional = {} as Record<BoxOptionalSegmentId, boolean>;
	for (const id of BOX_OPTIONAL_SEGMENT_IDS) {
		const defaultEnabled = id === "agentBonsai";
		optional[id] = resolveBoolean(raw[id], defaultEnabled);
	}
	return {
		display: resolveEnum(raw[BOX_SETTING_KEYS.display], BOX_DISPLAY_VALUES, BOX_DEFAULTS.display),
		detail: resolveEnum(raw[BOX_SETTING_KEYS.detail], BOX_DETAIL_VALUES, BOX_DEFAULTS.detail),
		placement: resolveEnum(raw[BOX_SETTING_KEYS.placement], BOX_PLACEMENT_VALUES, BOX_DEFAULTS.placement),
		enabled,
		optional,
		breathingBorder: resolveBoolean(raw[BREATHING_BORDER_ID], true),
	};
}

/**
 * Resolve from a stored plugin-settings record plus env fallbacks, same
 * precedence as `resolveAnimationsConfig`/`resolveAnimationAppearance`: stored
 * setting > env var > default. Each segment's own enable boolean uses the
 * SAME key/env pair its standalone row already resolves against
 * (`animationsEnvKey`, `../appearance.ts`) — one enable decision, two
 * consumers (the row registrar, this box).
 */
export function resolveAnimationsBoxConfigFromSources(
	pluginSettings: Record<string, unknown>,
	env: Record<string, string | undefined> = Bun.env,
): AnimationsBoxConfig {
	const raw: Record<string, unknown> = {};
	const display = pluginSettings[BOX_SETTING_KEYS.display] ?? env[BOX_SETTING_ENV.display];
	if (display !== undefined) raw[BOX_SETTING_KEYS.display] = display;
	const detail = pluginSettings[BOX_SETTING_KEYS.detail] ?? env[BOX_SETTING_ENV.detail];
	if (detail !== undefined) raw[BOX_SETTING_KEYS.detail] = detail;
	const placement = pluginSettings[BOX_SETTING_KEYS.placement] ?? env[BOX_SETTING_ENV.placement];
	if (placement !== undefined) raw[BOX_SETTING_KEYS.placement] = placement;
	for (const id of BOX_SEGMENT_IDS) {
		const stored = pluginSettings[id] ?? env[animationsEnvKey(id)];
		if (stored !== undefined) raw[id] = stored;
	}
	const agentBonsaiStored = pluginSettings.agentBonsai ?? env.OMP_ANIMATIONS_AGENT_BONSAI;
	if (agentBonsaiStored !== undefined) raw.agentBonsai = agentBonsaiStored;
	const breathingBorderStored = pluginSettings[BREATHING_BORDER_ID] ?? env[animationsEnvKey(BREATHING_BORDER_ID)];
	if (breathingBorderStored !== undefined) raw[BREATHING_BORDER_ID] = breathingBorderStored;
	return resolveAnimationsBoxConfig(raw);
}

export { PLUGIN_NAME };
