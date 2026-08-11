import { describe, expect, it } from "bun:test";
import { type RenderTier, resolveRenderTier } from "../src/terminal-capabilities";

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
