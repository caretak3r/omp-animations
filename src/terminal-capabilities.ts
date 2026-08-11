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

/**
 * RGB color value from OSC 11 background query response.
 * Values are normalized to 0-255 range regardless of terminal's hex precision.
 */
export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

/**
 * Background brightness classification based on relative luminance.
 */
export type BackgroundKind = "dark" | "light" | "unknown";

/**
 * Parse OSC 11 response into RGB color.
 * Terminals reply with hex values (1-4 digits per channel): rgb:RRRR/GGGG/BBBB
 * Response can be BEL or ST terminated.
 *
 * @returns RGB color with values normalized to 0-255, or null if unparseable
 */
export function parseOsc11Response(response: string): RgbColor | null {
	const pattern = /^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;
	const match = response.match(pattern);
	if (!match) return null;

	const [, rHex, gHex, bHex] = match;
	if (!rHex || !gHex || !bHex) return null;

	// Normalize hex values to 0-255 range. Terminals may send 2-digit (FF) or
	// 4-digit (FFFF) hex per channel. Scale to 8-bit by taking the high byte
	// for 4-digit values (FFFF → FF), treating 2-digit as-is.
	const parseChannel = (hex: string): number => {
		const val = parseInt(hex, 16);
		// 4-digit: scale from 16-bit (0-65535) to 8-bit (0-255)
		// 2-digit: already 8-bit
		return hex.length > 2 ? Math.round((val / 65535) * 255) : val;
	};

	return {
		r: parseChannel(rHex),
		g: parseChannel(gHex),
		b: parseChannel(bHex),
	};
}

/**
 * Calculate relative luminance using sRGB color space formula (ITU-R BT.709).
 *
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 *
 * where R, G, B are gamma-corrected linear values. For 8-bit sRGB:
 * - V = channel / 255
 * - Linear = V ≤ 0.03928 ? V/12.92 : ((V + 0.055)/1.055)^2.4
 *
 * @returns Relative luminance in range [0, 1]
 */
export function calculateLuminance(r: number, g: number, b: number): number {
	const toLinear = (val: number): number => {
		const v = val / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};

	const rLin = toLinear(r);
	const gLin = toLinear(g);
	const bLin = toLinear(b);

	return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Classify background as light or dark based on relative luminance threshold.
 * Uses standard 0.5 threshold (midpoint of [0,1] luminance range).
 * Luminance > 0.5 → light background, ≤ 0.5 → dark.
 *
 * @returns "light" or "dark" based on luminance threshold
 */
export function classifyBackground(r: number, g: number, b: number): "light" | "dark" {
	const luminance = calculateLuminance(r, g, b);
	return luminance > 0.5 ? "light" : "dark";
}

/**
 * Cached background kind result from the last successful OSC 11 query.
 * "unknown" means no query has succeeded yet (non-TTY, timeout, or unsupported terminal).
 * Theme layer can consult this to adapt color schemes.
 */
let backgroundKind: BackgroundKind = "unknown";

/**
 * Get the current background kind from the cached probe result.
 * Returns "unknown" if no successful OSC 11 query has completed.
 * Callers should assume dark when unknown (preserves today's behavior).
 */
export function getBackgroundKind(): BackgroundKind {
	return backgroundKind;
}

/**
 * Override the background kind. Used by tests and runtime OSC 11 integration
 * to update the cached state.
 */
export function setBackgroundKind(kind: BackgroundKind): void {
	backgroundKind = kind;
}

/**
 * Query terminal background color via OSC 11 escape sequence.
 * Returns RGB color on success, null on timeout/non-TTY/parse failure.
 *
 * This is a lightweight standalone probe for the animations kit.
 *
 * @param timeoutMs Maximum time to wait for response (default 500ms)
 * @returns RGB color from terminal, or null if unavailable
 */
export async function queryBackgroundColor(timeoutMs = 500): Promise<RgbColor | null> {
	// Only works on TTY
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		return null;
	}

	// Save stdin state
	const wasRaw = process.stdin.isRaw || false;
	const wasEncoding = process.stdin.readableEncoding;
	const { promise, resolve } = Promise.withResolvers<RgbColor | null>();

	let responseBuffer = "";
	let timeoutHandle: Timer | undefined;
	let resolved = false;

	// Single cleanup + resolution path: detach the listener, restore stdin
	// state, and settle the promise exactly once.
	const settle = (color: RgbColor | null) => {
		if (resolved) {
			return;
		}
		resolved = true;
		clearTimeout(timeoutHandle);
		process.stdin.removeListener("data", onData);
		process.stdin.pause();
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(wasRaw);
		}
		if (wasEncoding) {
			process.stdin.setEncoding(wasEncoding);
		}
		resolve(color);
	};

	const onData = (chunk: Buffer | string) => {
		responseBuffer += chunk.toString();
		const color = parseOsc11Response(responseBuffer);
		if (color) {
			settle(color);
		}
	};

	timeoutHandle = setTimeout(() => settle(null), timeoutMs);

	try {
		// Set up stdin to receive response
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		process.stdin.on("data", onData);

		// Send OSC 11 query (BEL terminated)
		// Note: Using BEL (\x07) terminator for maximum compatibility.
		// Terminals may reply with either BEL or ST (\x1b\\) - parser handles both.
		process.stdout.write("\x1b]11;?\x07");
	} catch {
		settle(null);
	}

	return promise;
}
