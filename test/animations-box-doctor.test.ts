import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { animationsDoctor, formatDoctorReport } from "../src/animations-box/doctor";
import type { RenderTier } from "../src/terminal-capabilities";

describe("formatDoctorReport", () => {
	test("Ghostty with full capabilities", () => {
		const tier: RenderTier = {
			program: "ghostty",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("Ghostty detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("Kitty with full capabilities", () => {
		const tier: RenderTier = {
			program: "kitty",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("Kitty detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("iTerm2 with full capabilities", () => {
		const tier: RenderTier = {
			program: "iterm",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("iTerm2 detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("WezTerm with full capabilities", () => {
		const tier: RenderTier = {
			program: "wezterm",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("WezTerm detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("Other/unknown terminal with degraded capabilities", () => {
		const tier: RenderTier = {
			program: "other",
			colorMode: "256",
			graphics: false,
			syncOutput: false,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("Unknown terminal detected — 256-color — sync-output: no — graphics: no");
	});

	test("Basic terminal with minimal capabilities", () => {
		const tier: RenderTier = {
			program: "other",
			colorMode: "basic",
			graphics: false,
			syncOutput: false,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("Unknown terminal detected — basic (16-color) — sync-output: no — graphics: no");
	});

	test("Override active notice appended", () => {
		const tier: RenderTier = {
			program: "ghostty",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: true,
		};
		const report = formatDoctorReport(tier, true);
		expect(report).toBe(
			"Ghostty detected — truecolor — sync-output: yes — graphics: yes\n(OMP_ANIMATIONS_FORCE_TIER override active)",
		);
	});

	test("256-color mode rendering", () => {
		const tier: RenderTier = {
			program: "kitty",
			colorMode: "256",
			graphics: true,
			syncOutput: true,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("Kitty detected — 256-color — sync-output: yes — graphics: yes");
	});

	test("Mixed capabilities (graphics but no sync)", () => {
		const tier: RenderTier = {
			program: "wezterm",
			colorMode: "truecolor",
			graphics: true,
			syncOutput: false,
		};
		const report = formatDoctorReport(tier, false);
		expect(report).toBe("WezTerm detected — truecolor — sync-output: no — graphics: yes");
	});
});

describe("animationsDoctor", () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		// Save original env
		originalEnv = { ...Bun.env };
	});

	afterEach(() => {
		// Restore original env
		for (const key of Object.keys(Bun.env)) {
			if (!(key in originalEnv)) {
				delete Bun.env[key];
			}
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			Bun.env[key] = value;
		}
	});

	test("Ghostty detection from TERM_PROGRAM", () => {
		const env = {
			TERM_PROGRAM: "ghostty",
			COLORTERM: "truecolor",
		};
		const report = animationsDoctor(env);
		expect(report).toBe("Ghostty detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("Kitty detection from TERM_PROGRAM", () => {
		const env = {
			TERM_PROGRAM: "kitty",
			COLORTERM: "truecolor",
		};
		const report = animationsDoctor(env);
		expect(report).toBe("Kitty detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("iTerm2 detection from TERM_PROGRAM", () => {
		const env = {
			TERM_PROGRAM: "iTerm.app",
			COLORTERM: "truecolor",
		};
		const report = animationsDoctor(env);
		expect(report).toBe("iTerm2 detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("WezTerm detection from TERM_PROGRAM", () => {
		const env = {
			TERM_PROGRAM: "WezTerm",
			COLORTERM: "truecolor",
		};
		const report = animationsDoctor(env);
		expect(report).toBe("WezTerm detected — truecolor — sync-output: yes — graphics: yes");
	});

	test("Override active when OMP_ANIMATIONS_FORCE_TIER is set", () => {
		const env = {
			TERM_PROGRAM: "ghostty",
			COLORTERM: "truecolor",
			OMP_ANIMATIONS_FORCE_TIER: JSON.stringify({
				program: "kitty",
				colorMode: "256",
				graphics: false,
				syncOutput: false,
			}),
		};
		const report = animationsDoctor(env);
		expect(report).toContain("(OMP_ANIMATIONS_FORCE_TIER override active)");
		expect(report).toContain("Kitty detected — 256-color — sync-output: no — graphics: no");
	});

	test("Fallback to other terminal when TERM_PROGRAM unknown", () => {
		const env = {
			TERM: "xterm-256color",
		};
		const report = animationsDoctor(env);
		expect(report).toBe("Unknown terminal detected — 256-color — sync-output: no — graphics: no");
	});

	test("Basic terminal fallback", () => {
		const env = {
			TERM: "xterm",
		};
		const report = animationsDoctor(env);
		expect(report).toBe("Unknown terminal detected — basic (16-color) — sync-output: no — graphics: no");
	});
});
