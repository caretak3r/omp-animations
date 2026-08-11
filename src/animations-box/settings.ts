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

/**
 * The 7 row segments the box composes, in priority order (lower survives
 * longest when width gets tight — see `../kit/segment.ts`'s `composeSegments`
 * doc). There is deliberately no `context` segment: its would-be source,
 * Context Weather, was cut from the registrar (Plan 007) before this box
 * existed, and it would only duplicate the host's own status line — see plan
 * 017 Decision 1.
 */
export const BOX_SEGMENT_IDS = [
	"cacheMeter",
	"cadenceEqualizer",
	"auditTrailBox",
	"rateLimitTidepool",
	"toolConstellation",
	"palimpsest",
	"reflectionRipple",
] as const;

export type BoxSegmentId = (typeof BOX_SEGMENT_IDS)[number];

/**
 * Box-scope default visibility (Plan 018 D7): cadence and reflect leave the
 * box by default. Both stay in {@link BOX_SEGMENT_IDS} — rows mode and the
 * per-animation enable booleans are untouched — but the box only composes
 * them when an explicit per-animation `true` opts the cut row back in. These
 * defaults are code, not settings keys (no box-only subset key).
 */
export const BOX_SEGMENT_DEFAULT_VISIBLE: Readonly<Record<BoxSegmentId, boolean>> = {
	cacheMeter: true,
	cadenceEqualizer: false,
	auditTrailBox: true,
	rateLimitTidepool: true,
	toolConstellation: true,
	palimpsest: true,
	reflectionRipple: false,
};

/** Breathing Border's own animation id. Not a {@link BoxSegmentId} — its row is replaced by the box's own border chrome (Decision 2), not a composed segment — but its existing per-animation enable boolean still gates whether that chrome breathes. */
const BREATHING_BORDER_ID = "breathingBorder";

/**
 * The 8 animations that stop mounting their own standalone row once the box
 * owns them (`display !== "rows"`): the 7 segments above, plus Breathing
 * Border, whose row is replaced by the box's own breathing chrome (Decision
 * 2) rather than a segment of its own.
 */
export const BOX_MIGRATED_ANIMATION_IDS: readonly string[] = [...BOX_SEGMENT_IDS, BREATHING_BORDER_ID];

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
	 * Per-segment participation, resolved from each keeper's OWN existing
	 * per-animation boolean key/env — the same setting that gates its
	 * standalone row in `rows` mode now also gates its box segment (Decision
	 * 3: "existing per-animation boolean keys now govern participation in the
	 * active display mode"). There is deliberately no separate box-only subset
	 * key.
	 */
	enabled: Readonly<Record<BoxSegmentId, boolean>>;
	/**
	 * Per-segment box composition (D7): an explicit per-animation boolean wins
	 * (`true` opts a cut row back in, `false` hides as always); with no
	 * explicit setting, {@link BOX_SEGMENT_DEFAULT_VISIBLE} decides. Rows mode
	 * never reads this — standalone rows gate on `enabled` alone.
	 */
	visible: Readonly<Record<BoxSegmentId, boolean>>;
	/**
	 * Whether the box's own border chrome breathes (Decision 2) — the SAME
	 * `breathingBorder` enable boolean that gates its standalone row in `rows`
	 * mode, resolved the same way as the 7 segment booleans above. Not a
	 * `BoxSegmentId`: it colors the frame itself, not a composed row.
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
	const visible = {} as Record<BoxSegmentId, boolean>;
	for (const id of BOX_SEGMENT_IDS) {
		enabled[id] = resolveBoolean(raw[id], true);
		visible[id] = raw[id] !== undefined ? enabled[id] : BOX_SEGMENT_DEFAULT_VISIBLE[id];
	}
	return {
		display: resolveEnum(raw[BOX_SETTING_KEYS.display], BOX_DISPLAY_VALUES, BOX_DEFAULTS.display),
		detail: resolveEnum(raw[BOX_SETTING_KEYS.detail], BOX_DETAIL_VALUES, BOX_DEFAULTS.detail),
		placement: resolveEnum(raw[BOX_SETTING_KEYS.placement], BOX_PLACEMENT_VALUES, BOX_DEFAULTS.placement),
		enabled,
		visible,
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
	const breathingBorderStored = pluginSettings[BREATHING_BORDER_ID] ?? env[animationsEnvKey(BREATHING_BORDER_ID)];
	if (breathingBorderStored !== undefined) raw[BREATHING_BORDER_ID] = breathingBorderStored;
	return resolveAnimationsBoxConfig(raw);
}

/**
 * Whether `id`'s segment composes into the box under `config` (D7): an
 * explicit per-animation boolean wins, otherwise the box-scope default
 * visibility cuts cadence and reflect. This only answers "would this segment
 * show if the box itself is showing"; callers additionally gate on
 * `config.display` (the box is entirely absent in `"rows"` mode).
 */
export function segmentVisible(config: AnimationsBoxConfig, id: BoxSegmentId): boolean {
	return config.visible[id];
}

export { PLUGIN_NAME };
