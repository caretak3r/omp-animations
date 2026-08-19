/**
 * The breathing border's palette layer: the three named color slots the Audit
 * Box paints its border chrome with, and the accent override applied to the
 * brightest of them. Coloring itself lives in `../animations-box/widget.ts`,
 * which buckets the live envelope through `./breath`'s `brightnessToken` and
 * resolves the resulting token against this palette.
 */
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AccentColor, accentToThemeColor } from "../appearance";

/**
 * Named color map. `peak` — the border's brightest moment, the crest of an
 * inhale or of the wind-down exhale — is the primary accent slot and the only
 * token an accent override replaces; `muted`/`base` stay on their fixed border
 * tokens, mirroring Palimpsest's underline/amber-stay-fixed, only-the-hottest-tier
 * convention.
 */
export interface BreathingBorderColors {
	muted: ThemeColor;
	base: ThemeColor;
	peak: ThemeColor;
}

/** Built-in palette — the exact border tokens the border carried before colors were configurable. */
export const BREATHING_BORDER_COLORS: BreathingBorderColors = {
	muted: "borderMuted",
	base: "border",
	peak: "borderAccent",
};

/** The palette with the accent slot applied, or the built-in palette when none is given. */
export function breathingBorderColors(accentColor: AccentColor | undefined): BreathingBorderColors {
	return accentColor === undefined
		? BREATHING_BORDER_COLORS
		: { ...BREATHING_BORDER_COLORS, peak: accentToThemeColor(accentColor) };
}
