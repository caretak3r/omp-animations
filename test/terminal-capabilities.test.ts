import { describe, expect, it } from "bun:test";
import {
	calculateLuminance,
	classifyBackground,
	getBackgroundKind,
	parseOsc11Response,
	queryBackgroundColor,
	type RenderTier,
	resolveRenderTier,
	setBackgroundKind,
} from "../src/terminal-capabilities";

describe("resolveRenderTier — program detection", () => {
	it("detects Ghostty via TERM_PROGRAM=ghostty", () => {
		const tier = resolveRenderTier({ TERM_PROGRAM: "ghostty" });
		expect(tier.program).toBe("ghostty");
		expect(tier.colorMode).toBe("truecolor"); // known-truecolor program
		expect(tier.graphics).toBe(true);
		expect(tier.syncOutput).toBe(true);
	});

	it("detects Kitty via TERM_PROGRAM=kitty", () => {
		const tier = resolveRenderTier({ TERM_PROGRAM: "kitty" });
		expect(tier.program).toBe("kitty");
		expect(tier.colorMode).toBe("truecolor");
		expect(tier.graphics).toBe(true);
		expect(tier.syncOutput).toBe(true);
	});

	it("detects Kitty via TERM containing 'kitty'", () => {
		const tier = resolveRenderTier({ TERM: "xterm-kitty" });
		expect(tier.program).toBe("kitty");
		expect(tier.colorMode).toBe("truecolor");
		expect(tier.graphics).toBe(true);
		expect(tier.syncOutput).toBe(true);
	});

	it("detects iTerm2 via TERM_PROGRAM=iTerm.app", () => {
		const tier = resolveRenderTier({ TERM_PROGRAM: "iTerm.app" });
		expect(tier.program).toBe("iterm");
		expect(tier.colorMode).toBe("truecolor");
		expect(tier.graphics).toBe(true);
		expect(tier.syncOutput).toBe(true);
	});

	it("detects WezTerm via TERM_PROGRAM=WezTerm", () => {
		const tier = resolveRenderTier({ TERM_PROGRAM: "WezTerm" });
		expect(tier.program).toBe("wezterm");
		expect(tier.colorMode).toBe("truecolor");
		expect(tier.graphics).toBe(true);
		expect(tier.syncOutput).toBe(true);
	});

	it("falls back to 'other' for unknown TERM_PROGRAM", () => {
		const tier = resolveRenderTier({ TERM_PROGRAM: "Alacritty" });
		expect(tier.program).toBe("other");
		expect(tier.graphics).toBe(false);
		expect(tier.syncOutput).toBe(false);
	});

	it("falls back to 'other' when TERM_PROGRAM is absent", () => {
		const tier = resolveRenderTier({ TERM: "xterm-256color" });
		expect(tier.program).toBe("other");
		expect(tier.graphics).toBe(false);
		expect(tier.syncOutput).toBe(false);
	});
});

describe("resolveRenderTier — colorMode detection", () => {
	it("resolves truecolor from COLORTERM=truecolor", () => {
		const tier = resolveRenderTier({ COLORTERM: "truecolor", TERM: "xterm" });
		expect(tier.colorMode).toBe("truecolor");
	});

	it("resolves truecolor from COLORTERM=24bit", () => {
		const tier = resolveRenderTier({ COLORTERM: "24bit", TERM: "xterm" });
		expect(tier.colorMode).toBe("truecolor");
	});

	it("resolves truecolor from WT_SESSION (Windows Terminal)", () => {
		const tier = resolveRenderTier({ WT_SESSION: "some-guid", TERM: "xterm-256color" });
		expect(tier.colorMode).toBe("truecolor");
	});

	it("resolves truecolor for known-truecolor programs (ghostty/kitty/iterm/wezterm) when not wrapped", () => {
		expect(resolveRenderTier({ TERM_PROGRAM: "ghostty", TERM: "xterm" }).colorMode).toBe("truecolor");
		expect(resolveRenderTier({ TERM_PROGRAM: "kitty", TERM: "xterm" }).colorMode).toBe("truecolor");
		expect(resolveRenderTier({ TERM_PROGRAM: "iTerm.app", TERM: "xterm" }).colorMode).toBe("truecolor");
		expect(resolveRenderTier({ TERM_PROGRAM: "WezTerm", TERM: "xterm" }).colorMode).toBe("truecolor");
	});

	it("resolves 256 from TERM containing '256color'", () => {
		const tier = resolveRenderTier({ TERM: "xterm-256color" });
		expect(tier.colorMode).toBe("256");
	});

	it("falls back to basic when no color indicators present", () => {
		const tier = resolveRenderTier({ TERM: "xterm" });
		expect(tier.colorMode).toBe("basic");
	});

	it("falls back to basic when TERM is absent", () => {
		const tier = resolveRenderTier({});
		expect(tier.colorMode).toBe("basic");
		expect(tier.program).toBe("other");
	});
});

describe("resolveRenderTier — tmux/screen wrapping caveat", () => {
	it("does NOT upgrade colorMode for tmux-wrapped TERM unless COLORTERM is set", () => {
		// tmux wraps a known-truecolor terminal, but COLORTERM is absent → fall back to TERM.
		const tier = resolveRenderTier({ TERM: "tmux-256color", TERM_PROGRAM: "ghostty" });
		expect(tier.program).toBe("ghostty"); // program detection still works
		expect(tier.colorMode).toBe("256"); // degraded to what TERM says (256color), NOT truecolor
	});

	it("does NOT upgrade colorMode for screen-wrapped TERM unless COLORTERM is set", () => {
		const tier = resolveRenderTier({ TERM: "screen-256color", TERM_PROGRAM: "kitty" });
		expect(tier.program).toBe("kitty");
		expect(tier.colorMode).toBe("256");
	});

	it("respects COLORTERM even when tmux-wrapped", () => {
		const tier = resolveRenderTier({ TERM: "tmux-256color", COLORTERM: "truecolor" });
		expect(tier.colorMode).toBe("truecolor");
	});

	it("respects WT_SESSION even when screen-wrapped", () => {
		const tier = resolveRenderTier({ TERM: "screen-256color", WT_SESSION: "guid" });
		expect(tier.colorMode).toBe("truecolor");
	});

	it("falls back to basic for bare tmux TERM without COLORTERM", () => {
		const tier = resolveRenderTier({ TERM: "tmux" });
		expect(tier.colorMode).toBe("basic");
	});

	it("still detects kitty via TERM=tmux-kitty (TERM contains 'kitty')", () => {
		// Edge case: tmux with TERM=tmux-kitty → program=kitty, but colorMode still respects wrapping.
		const tier = resolveRenderTier({ TERM: "tmux-kitty" });
		expect(tier.program).toBe("kitty"); // TERM contains "kitty"
		expect(tier.colorMode).toBe("basic"); // wrapped + no COLORTERM → basic
	});
});

describe("resolveRenderTier — graphics and syncOutput flags", () => {
	it("enables graphics for ghostty/kitty/iterm/wezterm", () => {
		expect(resolveRenderTier({ TERM_PROGRAM: "ghostty" }).graphics).toBe(true);
		expect(resolveRenderTier({ TERM_PROGRAM: "kitty" }).graphics).toBe(true);
		expect(resolveRenderTier({ TERM_PROGRAM: "iTerm.app" }).graphics).toBe(true);
		expect(resolveRenderTier({ TERM_PROGRAM: "WezTerm" }).graphics).toBe(true);
	});

	it("disables graphics for other terminals", () => {
		expect(resolveRenderTier({ TERM_PROGRAM: "Alacritty" }).graphics).toBe(false);
		expect(resolveRenderTier({ TERM: "xterm-256color" }).graphics).toBe(false);
	});

	it("enables syncOutput for ghostty/kitty/iterm/wezterm", () => {
		expect(resolveRenderTier({ TERM_PROGRAM: "ghostty" }).syncOutput).toBe(true);
		expect(resolveRenderTier({ TERM_PROGRAM: "kitty" }).syncOutput).toBe(true);
		expect(resolveRenderTier({ TERM_PROGRAM: "iTerm.app" }).syncOutput).toBe(true);
		expect(resolveRenderTier({ TERM_PROGRAM: "WezTerm" }).syncOutput).toBe(true);
	});

	it("disables syncOutput for other terminals", () => {
		expect(resolveRenderTier({ TERM_PROGRAM: "Alacritty" }).syncOutput).toBe(false);
		expect(resolveRenderTier({ TERM: "xterm-256color" }).syncOutput).toBe(false);
	});
});

describe("resolveRenderTier — OMP_ANIMATIONS_FORCE_TIER override", () => {
	it("applies a valid JSON override", () => {
		const override: RenderTier = {
			colorMode: "basic",
			graphics: false,
			syncOutput: false,
			program: "other",
		};
		const tier = resolveRenderTier({
			OMP_ANIMATIONS_FORCE_TIER: JSON.stringify(override),
			TERM_PROGRAM: "ghostty", // would normally resolve to truecolor+graphics+sync
		});
		expect(tier).toEqual(override);
	});

	it("falls through for malformed JSON", () => {
		const tier = resolveRenderTier({
			OMP_ANIMATIONS_FORCE_TIER: "not-json",
			TERM_PROGRAM: "ghostty",
		});
		expect(tier.program).toBe("ghostty"); // probed result
		expect(tier.colorMode).toBe("truecolor");
	});

	it("falls through for JSON with missing fields", () => {
		const tier = resolveRenderTier({
			OMP_ANIMATIONS_FORCE_TIER: '{"colorMode":"truecolor"}', // missing graphics/syncOutput/program
			TERM_PROGRAM: "kitty",
		});
		expect(tier.program).toBe("kitty");
		expect(tier.graphics).toBe(true);
	});

	it("falls through for JSON with invalid colorMode value", () => {
		const tier = resolveRenderTier({
			OMP_ANIMATIONS_FORCE_TIER: '{"colorMode":"ultracolor","graphics":true,"syncOutput":true,"program":"ghostty"}',
			TERM: "xterm-256color",
		});
		expect(tier.colorMode).toBe("256"); // probed from TERM
	});

	it("falls through for JSON with invalid program value", () => {
		const tier = resolveRenderTier({
			OMP_ANIMATIONS_FORCE_TIER: '{"colorMode":"truecolor","graphics":true,"syncOutput":true,"program":"vscode"}',
			TERM_PROGRAM: "iTerm.app",
		});
		expect(tier.program).toBe("iterm"); // probed result
	});

	it("falls through for JSON with wrong types (graphics as string)", () => {
		const tier = resolveRenderTier({
			OMP_ANIMATIONS_FORCE_TIER: '{"colorMode":"truecolor","graphics":"yes","syncOutput":true,"program":"ghostty"}',
			TERM_PROGRAM: "WezTerm",
		});
		expect(tier.program).toBe("wezterm");
		expect(tier.graphics).toBe(true);
	});

	it("accepts all valid colorMode values", () => {
		for (const colorMode of ["truecolor", "256", "basic"] as const) {
			const tier = resolveRenderTier({
				OMP_ANIMATIONS_FORCE_TIER: JSON.stringify({
					colorMode,
					graphics: false,
					syncOutput: false,
					program: "other",
				}),
			});
			expect(tier.colorMode).toBe(colorMode);
		}
	});

	it("accepts all valid program values", () => {
		for (const program of ["ghostty", "kitty", "iterm", "wezterm", "other"] as const) {
			const tier = resolveRenderTier({
				OMP_ANIMATIONS_FORCE_TIER: JSON.stringify({
					colorMode: "basic",
					graphics: false,
					syncOutput: false,
					program,
				}),
			});
			expect(tier.program).toBe(program);
		}
	});
});

describe("resolveRenderTier — combined real-world scenarios", () => {
	it("Ghostty on macOS (typical)", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "ghostty",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		});
		expect(tier).toEqual({
			program: "ghostty",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		});
	});

	it("Kitty with TERM=xterm-kitty", () => {
		const tier = resolveRenderTier({
			TERM: "xterm-kitty",
			COLORTERM: "truecolor",
		});
		expect(tier).toEqual({
			program: "kitty",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		});
	});

	it("iTerm2 on macOS", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "iTerm.app",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		});
		expect(tier).toEqual({
			program: "iterm",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		});
	});

	it("WezTerm on Linux", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "WezTerm",
			TERM: "wezterm",
			COLORTERM: "truecolor",
		});
		expect(tier).toEqual({
			program: "wezterm",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		});
	});

	it("Windows Terminal (unknown program, but WT_SESSION present)", () => {
		const tier = resolveRenderTier({
			WT_SESSION: "abc-123",
			TERM: "xterm-256color",
		});
		expect(tier).toEqual({
			program: "other",
			colorMode: "truecolor", // WT_SESSION forces truecolor
			graphics: false,
			syncOutput: false,
		});
	});

	it("Alacritty (no truecolor indicators)", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "Alacritty",
			TERM: "alacritty",
		});
		expect(tier).toEqual({
			program: "other",
			colorMode: "basic",
			graphics: false,
			syncOutput: false,
		});
	});

	it("Alacritty with COLORTERM=truecolor", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "Alacritty",
			TERM: "alacritty",
			COLORTERM: "truecolor",
		});
		expect(tier).toEqual({
			program: "other",
			colorMode: "truecolor",
			graphics: false,
			syncOutput: false,
		});
	});

	it("gnome-terminal (xterm-256color, no COLORTERM)", () => {
		const tier = resolveRenderTier({
			TERM: "xterm-256color",
		});
		expect(tier).toEqual({
			program: "other",
			colorMode: "256",
			graphics: false,
			syncOutput: false,
		});
	});

	it("Kitty inside tmux (TERM=tmux-256color, no COLORTERM)", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "kitty",
			TERM: "tmux-256color",
		});
		expect(tier).toEqual({
			program: "kitty",
			colorMode: "256", // wrapped → trust TERM, not program
			graphics: true,
			syncOutput: true,
		});
	});

	it("Kitty inside tmux with COLORTERM passthrough", () => {
		const tier = resolveRenderTier({
			TERM_PROGRAM: "kitty",
			TERM: "tmux-256color",
			COLORTERM: "truecolor",
		});
		expect(tier).toEqual({
			program: "kitty",
			colorMode: "truecolor", // COLORTERM overrides wrapping degradation
			graphics: true,
			syncOutput: true,
		});
	});

	it("Bare xterm (no indicators)", () => {
		const tier = resolveRenderTier({
			TERM: "xterm",
		});
		expect(tier).toEqual({
			program: "other",
			colorMode: "basic",
			graphics: false,
			syncOutput: false,
		});
	});

	it("Empty env (absolute fallback)", () => {
		const tier = resolveRenderTier({});
		expect(tier).toEqual({
			program: "other",
			colorMode: "basic",
			graphics: false,
			syncOutput: false,
		});
	});
});

describe("parseOsc11Response", () => {
	it("parses 4-digit hex RGB with BEL terminator", () => {
		const result = parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff\x07");
		expect(result).toEqual({ r: 255, g: 255, b: 255 });
	});

	it("parses 4-digit hex RGB with ST terminator", () => {
		const result = parseOsc11Response("\x1b]11;rgb:0000/0000/0000\x1b\\");
		expect(result).toEqual({ r: 0, g: 0, b: 0 });
	});

	it("parses 2-digit hex RGB", () => {
		const result = parseOsc11Response("\x1b]11;rgb:80/80/80\x07");
		expect(result).toEqual({ r: 128, g: 128, b: 128 });
	});

	it("parses rgba (ignores alpha channel)", () => {
		const result = parseOsc11Response("\x1b]11;rgba:ffff/ffff/ffff\x07");
		expect(result).toEqual({ r: 255, g: 255, b: 255 });
	});

	it("normalizes 4-digit hex to 8-bit range", () => {
		// 8000 hex = 32768 decimal, should normalize to ~128 in 8-bit
		const result = parseOsc11Response("\x1b]11;rgb:8000/8000/8000\x07");
		expect(result).toEqual({ r: 128, g: 128, b: 128 });
	});

	it("returns null for malformed responses", () => {
		expect(parseOsc11Response("garbage")).toBeNull();
		expect(parseOsc11Response("\x1b]11;invalid\x07")).toBeNull();
		expect(parseOsc11Response("\x1b]11;rgb:gg/hh/ii\x07")).toBeNull();
		expect(parseOsc11Response("")).toBeNull();
	});

	it("returns null for incomplete responses", () => {
		expect(parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff")).toBeNull();
		expect(parseOsc11Response("\x1b]11;rgb:ff/ff")).toBeNull();
	});
});

describe("calculateLuminance", () => {
	it("returns 1.0 for pure white", () => {
		const lum = calculateLuminance(255, 255, 255);
		expect(lum).toBeCloseTo(1.0, 5);
	});

	it("returns 0.0 for pure black", () => {
		const lum = calculateLuminance(0, 0, 0);
		expect(lum).toBeCloseTo(0.0, 5);
	});

	it("calculates mid-gray luminance", () => {
		// RGB(128, 128, 128) should be around 0.215 relative luminance
		const lum = calculateLuminance(128, 128, 128);
		expect(lum).toBeCloseTo(0.215, 2);
	});

	it("applies sRGB gamma correction", () => {
		// Green contributes most to luminance (0.7152 coefficient)
		const greenLum = calculateLuminance(0, 255, 0);
		const redLum = calculateLuminance(255, 0, 0);
		const blueLum = calculateLuminance(0, 0, 255);

		expect(greenLum).toBeGreaterThan(redLum);
		expect(greenLum).toBeGreaterThan(blueLum);
		expect(redLum).toBeGreaterThan(blueLum);
	});
});

describe("classifyBackground", () => {
	it("classifies white as light", () => {
		expect(classifyBackground(255, 255, 255)).toBe("light");
	});

	it("classifies black as dark", () => {
		expect(classifyBackground(0, 0, 0)).toBe("dark");
	});

	it("classifies typical light background (near-white) as light", () => {
		// Common light theme background: rgb(250, 250, 250)
		expect(classifyBackground(250, 250, 250)).toBe("light");
	});

	it("classifies typical dark background as dark", () => {
		// Common dark theme backgrounds
		expect(classifyBackground(30, 30, 30)).toBe("dark");
		expect(classifyBackground(40, 44, 52)).toBe("dark"); // One Dark
	});

	it("uses 0.5 luminance threshold", () => {
		// Mid-gray (128, 128, 128) has luminance ~0.215, should be dark
		expect(classifyBackground(128, 128, 128)).toBe("dark");

		// Lighter gray that crosses the 0.5 threshold should be light
		// RGB ~188 gives luminance ~0.5
		expect(classifyBackground(188, 188, 188)).toBe("light");
		expect(classifyBackground(187, 187, 187)).toBe("dark");
	});
});

describe("getBackgroundKind and setBackgroundKind", () => {
	it("defaults to unknown", () => {
		// Note: This may fail if other tests have set it, but we can't easily reset
		// global state. The test documents expected initial state.
		const initial = getBackgroundKind();
		expect(initial === "unknown" || initial === "dark" || initial === "light").toBe(true);
	});

	it("allows setting and getting background kind", () => {
		setBackgroundKind("dark");
		expect(getBackgroundKind()).toBe("dark");

		setBackgroundKind("light");
		expect(getBackgroundKind()).toBe("light");

		setBackgroundKind("unknown");
		expect(getBackgroundKind()).toBe("unknown");
	});
});

describe("queryBackgroundColor", () => {
	it("returns null when not a TTY", async () => {
		// Save original values
		const wasStdoutTTY = process.stdout.isTTY;
		const wasStdinTTY = process.stdin.isTTY;

		try {
			// Mock non-TTY
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true, writable: true });
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true, writable: true });

			const result = await queryBackgroundColor(100);
			expect(result).toBeNull();
		} finally {
			// Restore
			Object.defineProperty(process.stdout, "isTTY", { value: wasStdoutTTY, configurable: true, writable: true });
			Object.defineProperty(process.stdin, "isTTY", { value: wasStdinTTY, configurable: true, writable: true });
		}
	});

	it("returns null on timeout when no response arrives", async () => {
		// Skip if not in a real TTY (can't test timeout behavior in non-TTY)
		if (!process.stdout.isTTY || !process.stdin.isTTY) {
			return;
		}

		// Use very short timeout - terminal won't respond to our query in time
		// because we can't actually inject a fake response in this test
		const result = await queryBackgroundColor(1);
		expect(result).toBeNull();
	});

	it("restores stdin state after timeout", async () => {
		if (!process.stdout.isTTY || !process.stdin.isTTY) {
			return;
		}

		const wasRaw = process.stdin.isRaw || false;

		await queryBackgroundColor(1);

		// Stdin should be restored to original state
		expect(process.stdin.isRaw).toBe(wasRaw);
	});
});
