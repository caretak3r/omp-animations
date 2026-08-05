/**
 * Per-animation appearance settings: placement (which side of the editor the
 * widget mounts on) and an optional accent-color override for the animation's
 * primary accent slot.
 *
 * Flat prefixed manifest keys, per-key env fallbacks, validated enum resolvers,
 * stored > env > default precedence — with keys DERIVED from the animation id
 * instead of hand-enumerated, since the same two settings repeat across every
 * shipped animation. Resolution happens once, at registrar wire time (the same
 * restart-required posture as the enable/tier settings); there is no live re-read.
 */
import type { WidgetPlacement } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Curated accent palette: a deliberate subset of the host's `ThemeColor` union —
 * the vivid tokens the suite's built-in palettes already draw from (the sunrise
 * gradient, the gem tiers, the status trio) — not the full union, most of which
 * is markdown/status-line plumbing that would read as noise in a settings enum.
 */
export const ACCENT_COLOR_VALUES = [
	"accent",
	"success",
	"warning",
	"error",
	"muted",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxType",
	"syntaxString",
	"syntaxNumber",
] as const satisfies readonly ThemeColor[];

/** A user-selectable accent color — always a valid `ThemeColor`. */
export type AccentColor = (typeof ACCENT_COLOR_VALUES)[number];

/** Sentinel enum value meaning "keep the animation's built-in palette". */
export const ACCENT_DEFAULT = "default";

/** Manifest enum values for every `<id>AccentColor` setting: the sentinel first, then the palette. */
export const ACCENT_SETTING_VALUES: readonly string[] = [ACCENT_DEFAULT, ...ACCENT_COLOR_VALUES];

/** Manifest enum values for every `<id>Placement` setting — maps 1:1 to `WidgetPlacement`. */
export const PLACEMENT_VALUES: readonly WidgetPlacement[] = ["aboveEditor", "belowEditor"];

/** Fully-resolved, validated appearance for one animation. */
export interface AnimationAppearance {
	/** Which side of the editor the widget mounts on. */
	placement: WidgetPlacement;
	/** Accent override for the animation's primary accent slot; `undefined` keeps the built-in palette. */
	accentColor: AccentColor | undefined;
}

/** `diffBloom` -> `diffBloomPlacement` (flat manifest key — `PluginManifest.settings` does not nest). */
export function placementKey(id: string): string {
	return `${id}Placement`;
}

/** `diffBloom` -> `diffBloomAccentColor` (flat manifest key). */
export function accentColorKey(id: string): string {
	return `${id}AccentColor`;
}

/** `diffBloom` (+ optional suffix) -> `OMP_ANIMATIONS_DIFF_BLOOM[_<SUFFIX>]` — the manifest `env` derivation shared with the registrar's enable keys. */
export function animationsEnvKey(id: string, suffix?: string): string {
	const base = `OMP_ANIMATIONS_${id.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
	return suffix === undefined ? base : `${base}_${suffix}`;
}

function resolveEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
	return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** The `"default"` sentinel, an absent value, and any invalid string all resolve to `undefined` (built-in palette). */
function resolveAccentColor(raw: unknown): AccentColor | undefined {
	return typeof raw === "string" && (ACCENT_COLOR_VALUES as readonly string[]).includes(raw)
		? (raw as AccentColor)
		: undefined;
}

/**
 * Resolve one animation's appearance from a flat plugin-settings record and env
 * fallbacks. Precedence per key: stored setting > env fallback > default
 * (nullish coalescing — a stored `null`/`undefined` falls through to the env
 * var, matching the registrar's enable/tier machinery). Unknown or malformed
 * values fall back to the defaults rather than throwing.
 */
export function resolveAnimationAppearance(
	id: string,
	defaultPlacement: WidgetPlacement,
	pluginSettings: Record<string, unknown> = {},
	env: Record<string, string | undefined> = Bun.env,
): AnimationAppearance {
	const placementRaw = pluginSettings[placementKey(id)] ?? env[animationsEnvKey(id, "PLACEMENT")];
	const accentRaw = pluginSettings[accentColorKey(id)] ?? env[animationsEnvKey(id, "ACCENT_COLOR")];
	return {
		placement: resolveEnum(placementRaw, PLACEMENT_VALUES, defaultPlacement),
		accentColor: resolveAccentColor(accentRaw),
	};
}
