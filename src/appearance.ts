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
import type { SymbolPreset, Theme, ThemeColor, WidgetPlacement } from "./host/types";
import type { RenderTier } from "./terminal-capabilities";

/**
 * Curated accent palette: a deliberate subset of the host's `ThemeColor` union —
 * the vivid tokens the suite's built-in palettes already draw from (the sunrise
 * gradient, the gem tiers, the status trio) — not the full union, most of which
 * makes for poor accent choices (invisibles, structural monochromes).
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

/**
 * Okabe-Ito colorblind-safe palette — deuteranopia/protanopia-distinguishable.
 * Published reference values from Okabe & Ito (2008), formatted as direct hex strings.
 */
export const OKABE_ITO_PALETTE = [
	"okabeOrange", // #E69F00
	"okabeSkyBlue", // #56B4E9
	"okabeGreen", // #009E73
	"okabeYellow", // #F0E442
	"okabeBlue", // #0072B2
	"okabeVermillion", // #D55E00
	"okabePurple", // #CC79A7
] as const;

/** Hex color mapping for Okabe-Ito palette values. */
export const OKABE_ITO_HEX: Record<(typeof OKABE_ITO_PALETTE)[number], string> = {
	okabeOrange: "#E69F00",
	okabeSkyBlue: "#56B4E9",
	okabeGreen: "#009E73",
	okabeYellow: "#F0E442",
	okabeBlue: "#0072B2",
	okabeVermillion: "#D55E00",
	okabePurple: "#CC79A7",
};

/** Union of theme colors and Okabe-Ito palette names. */
export type OkabeItoColor = (typeof OKABE_ITO_PALETTE)[number];

/** A user-selectable accent color — theme colors or Okabe-Ito palette. */
export type AccentColor = (typeof ACCENT_COLOR_VALUES)[number] | OkabeItoColor;

/** Sentinel enum value meaning "keep the animation's built-in palette". */
export const ACCENT_DEFAULT = "default";

/** Manifest enum values for every `<id>AccentColor` setting: the sentinel first, then both palettes. */
export const ACCENT_SETTING_VALUES: readonly string[] = [ACCENT_DEFAULT, ...ACCENT_COLOR_VALUES, ...OKABE_ITO_PALETTE];

/** Type guard: is this AccentColor an Okabe-Ito color? */
export function isOkabeIto(c: AccentColor): c is OkabeItoColor {
	return (c as string) in OKABE_ITO_HEX;
}

/**
 * Render text in an AccentColor: Okabe-Ito colors resolve to truecolor SGR when
 * the render tier supports it (otherwise fallback to a sensible theme color);
 * ThemeColor values go straight to theme.fg().
 */
export function colorText(color: AccentColor, text: string, theme: Pick<Theme, "fg">, renderTier?: RenderTier): string {
	if (isOkabeIto(color)) {
		const hex = OKABE_ITO_HEX[color];
		// Use truecolor SGR if supported, otherwise fallback to theme color
		if (renderTier?.colorMode === "truecolor") {
			// Parse hex to RGB
			const r = Number.parseInt(hex.slice(1, 3), 16);
			const g = Number.parseInt(hex.slice(3, 5), 16);
			const b = Number.parseInt(hex.slice(5, 7), 16);
			return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
		}
		// Fallback mapping: pick closest semantic theme color
		const fallback: Record<OkabeItoColor, ThemeColor> = {
			okabeOrange: "warning",
			okabeSkyBlue: "accent",
			okabeGreen: "success",
			okabeYellow: "warning",
			okabeBlue: "accent",
			okabeVermillion: "error",
			okabePurple: "syntaxKeyword",
		};
		return theme.fg(fallback[color], text);
	}
	return theme.fg(color as ThemeColor, text);
}

/**
 * Convert AccentColor to ThemeColor for widgets that use theme.fg().
 * Okabe-Ito colors map to semantically similar theme colors.
 */
export function accentToThemeColor(color: AccentColor): ThemeColor {
	if (isOkabeIto(color)) {
		const fallback: Record<OkabeItoColor, ThemeColor> = {
			okabeOrange: "warning",
			okabeSkyBlue: "accent",
			okabeGreen: "success",
			okabeYellow: "warning",
			okabeBlue: "accent",
			okabeVermillion: "error",
			okabePurple: "syntaxKeyword",
		};
		return fallback[color];
	}
	return color as ThemeColor;
}

/** Manifest enum values for every `<id>Placement` setting — maps 1:1 to `WidgetPlacement`. */
export const PLACEMENT_VALUES: readonly WidgetPlacement[] = ["aboveEditor", "belowEditor"];

/** Fully-resolved, validated appearance for one animation. */
export interface AnimationAppearance {
	/** Which side of the editor the widget mounts on. */
	placement: WidgetPlacement;
	/** Accent override for the animation's primary accent slot; `undefined` keeps the built-in palette. */
	accentColor: AccentColor | undefined;
	/**
	 * Glyph preset for this animation's Unicode literals (see `../glyph-presets.ts`).
	 * Unlike `placement`/`accentColor`, this is not resolved from `pluginSettings`/`env`
	 * — it's not a user-facing setting, it mirrors the host's own global symbol preset
	 * (`ExtensionContext.ui.theme.getSymbolPreset()`), which only exists inside event
	 * handlers. `resolveAnimationAppearance` takes it as a plain pass-through parameter
	 * instead of deriving it itself, defaulting to `"unicode"` — the host's own default
	 * and today's hardcoded glyphs — for every caller that doesn't thread a live value.
	 */
	glyphPreset: SymbolPreset;
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
	if (typeof raw !== "string") return undefined;
	if ((ACCENT_COLOR_VALUES as readonly string[]).includes(raw)) return raw as AccentColor;
	if ((OKABE_ITO_PALETTE as readonly string[]).includes(raw)) return raw as OkabeItoColor;
	return undefined;
}

/**
 * Resolve one animation's appearance from a flat plugin-settings record and env
 * fallbacks, plus the host's live glyph preset. Precedence per key: stored setting >
 * env fallback > default (nullish coalescing — a stored `null`/`undefined` falls
 * through to the env var, matching the registrar's enable/tier machinery). Unknown or
 * malformed values fall back to the defaults rather than throwing. `glyphPreset` sits
 * outside that settings/env precedence chain entirely — see `AnimationAppearance`'s doc.
 */
export function resolveAnimationAppearance(
	id: string,
	defaultPlacement: WidgetPlacement,
	pluginSettings: Record<string, unknown> = {},
	env: Record<string, string | undefined> = Bun.env,
	glyphPreset: SymbolPreset = "unicode",
): AnimationAppearance {
	const placementRaw = pluginSettings[placementKey(id)] ?? env[animationsEnvKey(id, "PLACEMENT")];
	const accentRaw = pluginSettings[accentColorKey(id)] ?? env[animationsEnvKey(id, "ACCENT_COLOR")];
	return {
		placement: resolveEnum(placementRaw, PLACEMENT_VALUES, defaultPlacement),
		accentColor: resolveAccentColor(accentRaw),
		glyphPreset,
	};
}
