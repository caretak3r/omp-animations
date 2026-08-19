import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Named color map for Palimpsest's three glow tiers, keyed by how hard a
 * region is being thrashed: a faint, still-cool `underline` at two touches, a
 * warming `amber` at three, `ember` at four or more. `ember` is the primary
 * accent slot — the only token an accent override replaces; `underline` and
 * `amber` keep their fixed semantic tokens.
 */
export interface PalimpsestColors {
	underline: ThemeColor;
	amber: ThemeColor;
	ember: ThemeColor;
}

/** Built-in palette retained with the legacy pure state API. */
export const PALIMPSEST_COLORS: PalimpsestColors = { underline: "dim", amber: "warning", ember: "error" };
