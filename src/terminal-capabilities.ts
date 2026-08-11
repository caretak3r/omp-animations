/**
 * Terminal capability detection — pure, best-effort probes for color depth,
 * synchronized output, and graphics support. This module is read-only (no
 * mutation, no caching side effects), suitable for bundling into the
 * `@oh-my-pi/pi-animation` kit where downstream projects can call it once at
 * their initialization boundary.
 *
 * Detection heuristics prioritize correctness for the major terminals (Ghostty,
 * Kitty, iTerm2, WezTerm) while degrading gracefully for unknown environments.
 * Every ambiguous branch defaults to the safest/lowest tier — this module is
 * strictly additive; nothing else consumes it yet, so conservative fallbacks
 * cannot regress existing behavior.
 *
 * Env override: `OMP_ANIMATIONS_FORCE_TIER=<json>` where `<json>` is a JSON
 * object matching the `RenderTier` shape, e.g.:
 * ```
 * OMP_ANIMATIONS_FORCE_TIER='{"colorMode":"truecolor","graphics":true,"syncOutput":true,"program":"ghostty"}'
 * ```
 * Malformed JSON or missing fields fall through to probed detection (no throw).
 *
 * @module terminal-capabilities
 */

/** Fully-resolved terminal rendering tier — color depth, graphics, sync, and program identity. */
export interface RenderTier {
	/** Color depth: truecolor (24-bit RGB), 256-color indexed palette, or basic 16-color ANSI. */
	colorMode: "truecolor" | "256" | "basic";
	/**
	 * Kitty graphics protocol / iTerm2 inline images supported.
	 * - `true` for Ghostty, Kitty, WezTerm, iTerm2 (all support kitty-graphics or iTerm2 inline images).
	 * - `false` otherwise (Alacritty, gnome-terminal, xterm, etc. lack graphics).
	 */
	graphics: boolean;
	/**
	 * Synchronized output (DEC 2026 mode) supported — best-effort only.
	 * - `true` for Ghostty, Kitty, WezTerm, iTerm2 (iTerm2 >= 3.5 supports DEC 2026; treat as true).
	 * - `false` for other / unknown terminals.
	 */
	syncOutput: boolean;
	/** Terminal program identity, or `"other"` when unknown. */
	program: "ghostty" | "kitty" | "iterm" | "wezterm" | "other";
}

/**
 * Resolve terminal rendering capabilities from environment variables.
 *
 * **Detection logic:**
 * - `program`: `TERM_PROGRAM` exact match for `ghostty`/`kitty`/`WezTerm`/`iTerm.app`,
 *   or `TERM` containing `kitty` → `kitty`, else `"other"`.
 * - `colorMode`:
 *   1. `COLORTERM=truecolor` or `COLORTERM=24bit` → `"truecolor"`.
 *   2. `WT_SESSION` set (Windows Terminal) → `"truecolor"`.
 *   3. Known-truecolor programs (ghostty/kitty/iterm/wezterm) → `"truecolor"`.
 *   4. `TERM` containing `256color` → `"256"`.
 *   5. Fallback → `"basic"`.
 * - **tmux/screen caveat**: if `TERM` starts with `screen` or `tmux`, do NOT upgrade
 *   `colorMode` beyond what `COLORTERM` explicitly says (tmux wraps the real terminal;
 *   `TERM_PROGRAM` may still survive for program detection).
 * - `graphics`: `true` for ghostty/kitty/wezterm/iterm, `false` otherwise.
 * - `syncOutput`: `true` for ghostty/kitty/wezterm/iterm, `false` otherwise.
 *
 * **Override:** `OMP_ANIMATIONS_FORCE_TIER` env var with JSON matching `RenderTier`.
 * Malformed JSON or missing fields fall through to probed result.
 *
 * @param env - Environment variable record (defaults to `Bun.env`).
 * @returns The resolved rendering tier.
 */
export function resolveRenderTier(env: Record<string, string | undefined> = Bun.env): RenderTier {
	// Env override attempt (malformed values fall through silently).
	const forceRaw = env.OMP_ANIMATIONS_FORCE_TIER;
	if (forceRaw) {
		try {
			const parsed = JSON.parse(forceRaw);
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.colorMode === "string" &&
				["truecolor", "256", "basic"].includes(parsed.colorMode) &&
				typeof parsed.graphics === "boolean" &&
				typeof parsed.syncOutput === "boolean" &&
				typeof parsed.program === "string" &&
				["ghostty", "kitty", "iterm", "wezterm", "other"].includes(parsed.program)
			) {
				return parsed as RenderTier;
			}
		} catch {
			// Fall through to probed detection.
		}
	}

	// Program detection.
	const termProgram = env.TERM_PROGRAM;
	const term = env.TERM ?? "";
	let program: RenderTier["program"] = "other";
	if (termProgram === "ghostty") {
		program = "ghostty";
	} else if (termProgram === "kitty" || term.includes("kitty")) {
		program = "kitty";
	} else if (termProgram === "iTerm.app") {
		program = "iterm";
	} else if (termProgram === "WezTerm") {
		program = "wezterm";
	}

	// tmux/screen wrapping check (TERM starts with "screen" or "tmux").
	const wrapped = term.startsWith("screen") || term.startsWith("tmux");

	// Color mode detection.
	const colorterm = env.COLORTERM;
	const wtSession = env.WT_SESSION;
	let colorMode: RenderTier["colorMode"] = "basic";
	if (colorterm === "truecolor" || colorterm === "24bit") {
		colorMode = "truecolor";
	} else if (wtSession) {
		colorMode = "truecolor";
	} else if (
		!wrapped &&
		(program === "ghostty" || program === "kitty" || program === "iterm" || program === "wezterm")
	) {
		// Known-truecolor programs default to truecolor UNLESS wrapped by tmux/screen
		// (in which case we only trust COLORTERM/WT_SESSION).
		colorMode = "truecolor";
	} else if (term.includes("256color")) {
		colorMode = "256";
	}

	// Graphics support (kitty-graphics / iTerm2 inline images).
	const graphics = program === "ghostty" || program === "kitty" || program === "iterm" || program === "wezterm";

	// Synchronized output (DEC 2026 mode) — best-effort only.
	const syncOutput = program === "ghostty" || program === "kitty" || program === "iterm" || program === "wezterm";

	return { colorMode, graphics, syncOutput, program };
}
