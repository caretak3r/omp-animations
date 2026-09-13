/**
 * Animations Box — settings resolution.
 *
 * Follows the same flat-manifest-key, stored > env > default precedence every
 * other setting in this package uses (see `../appearance.ts`'s module doc).
 * `PLUGIN_NAME` is duplicated from `../registrar.ts` rather than imported —
 * the registrar constructs the box, so importing the name back would make the
 * two modules import each other, and the string is a stable, already-shipped
 * plugin identity, not something that drifts.
 */

import { animationsEnvKey } from "../appearance";
import type { WidgetPlacement } from "../host/types";
import { CONTEXT_QUOTA_DEFAULT_PERCENT, clampContextQuotaPercent } from "./context-gauge";

const PLUGIN_NAME = "@oh-my-pi/animations";

/** Audit Box summaries in render order. Live Files closes the block and remains independently optional. */
export const BOX_REQUIRED_SEGMENT_IDS = [
	"contextGauge",
	"cacheMeter",
	"auditTrailBox",
	"rateLimitTidepool",
	"toolActivity",
	"filesLive",
] as const;

export type BoxRequiredSegmentId = (typeof BOX_REQUIRED_SEGMENT_IDS)[number];

/** Optional Audit Box groups, in deterministic order. */
export const BOX_OPTIONAL_SEGMENT_IDS = ["agentBonsai"] as const;

export type BoxOptionalSegmentId = (typeof BOX_OPTIONAL_SEGMENT_IDS)[number];

/** Complete status-line segment priority order, shared with simple-mode width degradation. */
export const BOX_SEGMENT_IDS = BOX_REQUIRED_SEGMENT_IDS;
export type BoxSegmentId = (typeof BOX_SEGMENT_IDS)[number];

/** Breathing Border's own animation id. Not a {@link BoxSegmentId} — its row is replaced by the box's own border chrome (Decision 2), not a composed segment — but its existing per-animation enable boolean still gates whether that chrome breathes. */
const BREATHING_BORDER_ID = "breathingBorder";

/**
 * The removed `display` setting (`rows` · `box` · `both`) and its env fallback.
 * Surface selection no longer applies. Both values survive as read-only inputs
 * to {@link removedDisplayNotice}.
 */
export const REMOVED_DISPLAY_KEY = "display";
export const REMOVED_DISPLAY_ENV = "OMP_ANIMATIONS_DISPLAY";

/** How much each Audit Box segment shows. */
export type BoxDetail = "simple" | "detailed";
const BOX_DETAIL_VALUES: readonly BoxDetail[] = ["simple", "detailed"];

const BOX_PLACEMENT_VALUES: readonly WidgetPlacement[] = ["aboveEditor", "belowEditor"];

/** Fully-resolved, validated box configuration. */
export interface AnimationsBoxConfig {
	detail: BoxDetail;
	placement: WidgetPlacement;
	/** Optional Agent Bonsai group, enabled unless its flat setting is false. */
	optional: Readonly<Record<BoxOptionalSegmentId, boolean>>;
	/**
	 * Whether the box's border chrome breathes, resolved from the existing
	 * `breathingBorder` key. Not a `BoxSegmentId`: it colors the frame itself
	 * rather than composing a row.
	 */
	breathingBorder: boolean;
	/**
	 * Quota ceiling the context gauge fills against, as a percentage of the
	 * model's context window. Clamped to
	 * `[CONTEXT_QUOTA_MIN_PERCENT, CONTEXT_QUOTA_MAX_PERCENT]`.
	 */
	contextQuota: number;
}

/** Flat manifest setting keys (package.json#omp.settings — no nesting). */
export const BOX_SETTING_KEYS = {
	detail: "animationsBoxDetail",
	placement: "animationsBoxPlacement",
	contextQuota: "animationsContextQuota",
} as const;

/** Env-var fallbacks mirroring each manifest setting's `env` field. */
export const BOX_SETTING_ENV = {
	detail: "OMP_ANIMATIONS_BOX_DETAIL",
	placement: "OMP_ANIMATIONS_BOX_PLACEMENT",
	contextQuota: "OMP_ANIMATIONS_CONTEXT_QUOTA",
} as const;

export const BOX_DEFAULTS: Pick<AnimationsBoxConfig, "detail" | "placement" | "contextQuota"> = {
	detail: "detailed",
	placement: "belowEditor",
	contextQuota: CONTEXT_QUOTA_DEFAULT_PERCENT,
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

/** Numeric setting resolution: a stored number or its string form, anything else falling back. Non-finite values are garbage, not zero. */
function resolveNumber(raw: unknown, fallback: number): number {
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : fallback;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/**
 * Resolve the box config from a flat raw settings record (already merged
 * stored-settings-over-env, matching every other resolver in this package).
 * Missing or malformed values fall back instead of throwing. Required rows
 * remain structural; settings may change their presentation, not remove them.
 */
export function resolveAnimationsBoxConfig(raw: Record<string, unknown>): AnimationsBoxConfig {
	return {
		detail: resolveEnum(raw[BOX_SETTING_KEYS.detail], BOX_DETAIL_VALUES, BOX_DEFAULTS.detail),
		placement: resolveEnum(raw[BOX_SETTING_KEYS.placement], BOX_PLACEMENT_VALUES, BOX_DEFAULTS.placement),
		optional: { agentBonsai: resolveBoolean(raw.agentBonsai, true) },
		breathingBorder: resolveBoolean(raw[BREATHING_BORDER_ID], true),
		contextQuota: clampContextQuotaPercent(
			resolveNumber(raw[BOX_SETTING_KEYS.contextQuota], BOX_DEFAULTS.contextQuota),
		),
	};
}

/**
 * Resolve from a stored plugin-settings record plus env fallbacks, same
 * precedence as `resolveAnimationsConfig`/`resolveAnimationAppearance`: stored
 * setting > env var > default. Each optional group keeps the SAME key/env pair
 * its animation always used (`animationsEnvKey`, `../appearance.ts`), so folding
 * it into the box never invalidated anyone's settings file.
 */
export function resolveAnimationsBoxConfigFromSources(
	pluginSettings: Record<string, unknown>,
	env: Record<string, string | undefined> = Bun.env,
): AnimationsBoxConfig {
	const raw: Record<string, unknown> = {};
	const detail = pluginSettings[BOX_SETTING_KEYS.detail] ?? env[BOX_SETTING_ENV.detail];
	if (detail !== undefined) raw[BOX_SETTING_KEYS.detail] = detail;
	const placement = pluginSettings[BOX_SETTING_KEYS.placement] ?? env[BOX_SETTING_ENV.placement];
	if (placement !== undefined) raw[BOX_SETTING_KEYS.placement] = placement;
	const contextQuota = pluginSettings[BOX_SETTING_KEYS.contextQuota] ?? env[BOX_SETTING_ENV.contextQuota];
	if (contextQuota !== undefined) raw[BOX_SETTING_KEYS.contextQuota] = contextQuota;
	for (const id of BOX_OPTIONAL_SEGMENT_IDS) {
		const stored = pluginSettings[id] ?? env[animationsEnvKey(id)];
		if (stored !== undefined) raw[id] = stored;
	}
	const breathingBorderStored = pluginSettings[BREATHING_BORDER_ID] ?? env[animationsEnvKey(BREATHING_BORDER_ID)];
	if (breathingBorderStored !== undefined) raw[BREATHING_BORDER_ID] = breathingBorderStored;
	return resolveAnimationsBoxConfig(raw);
}

/**
 * One-line migration message for a stale `display` setting, or `undefined` when
 * there is nothing to say. A removed value normalizes to the Box rather than
 * throwing — an `OMP_ANIMATIONS_DISPLAY=rows` exported in a shell profile must
 * never crash the host at plugin wire time — and `box`, the one value that
 * survived, stays silent so an up-to-date settings file says nothing at all.
 */
export function removedDisplayNotice(
	pluginSettings: Record<string, unknown>,
	env: Record<string, string | undefined> = Bun.env,
): string | undefined {
	const stored = pluginSettings[REMOVED_DISPLAY_KEY];
	const value = stored ?? env[REMOVED_DISPLAY_ENV];
	if (value === undefined || value === "box") return undefined;
	const source = stored !== undefined ? `setting "${REMOVED_DISPLAY_KEY}"` : `env ${REMOVED_DISPLAY_ENV}`;
	return `${PLUGIN_NAME}: ${source}=${String(value)} is no longer supported — the Audit Box is the only display mode. Drop the setting; the box mounts either way.`;
}

export { PLUGIN_NAME };
