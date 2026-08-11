/**
 * Animations doctor — one-shot diagnostic that prints the resolved RenderTier
 * in plain language. Pure presentation layer over terminal-capabilities probes.
 *
 * @module animations-box/doctor
 */

import type { RenderTier } from "../terminal-capabilities";
import { resolveRenderTier } from "../terminal-capabilities";

/**
 * Format a terminal capabilities report from a resolved RenderTier.
 *
 * Pure function — no I/O, fully deterministic, unit-testable.
 *
 * @param tier - The resolved rendering tier.
 * @param overrideActive - Whether OMP_ANIMATIONS_FORCE_TIER override is in effect.
 * @returns Plain-language diagnostic string.
 */
export function formatDoctorReport(tier: RenderTier, overrideActive = false): string {
	const programNames: Record<RenderTier["program"], string> = {
		ghostty: "Ghostty",
		kitty: "Kitty",
		iterm: "iTerm2",
		wezterm: "WezTerm",
		other: "Unknown terminal",
	};

	const programName = programNames[tier.program];
	const colorModeText =
		tier.colorMode === "truecolor" ? "truecolor" : tier.colorMode === "256" ? "256-color" : "basic (16-color)";
	const syncText = tier.syncOutput ? "yes" : "no";
	const graphicsText = tier.graphics ? "yes" : "no";

	const lines: string[] = [];
	lines.push(`${programName} detected — ${colorModeText} — sync-output: ${syncText} — graphics: ${graphicsText}`);
	lines.push("detail-grammar: status-lines");

	if (overrideActive) {
		lines.push("(OMP_ANIMATIONS_FORCE_TIER override active)");
	}

	return lines.join("\n");
}

/**
 * One-shot diagnostic entry point: probe terminal capabilities and return
 * a plain-language report string.
 *
 * @param env - Environment variable record (defaults to `Bun.env`).
 * @returns Formatted diagnostic report.
 */
export function animationsDoctor(env: Record<string, string | undefined> = Bun.env): string {
	const tier = resolveRenderTier(env);
	const overrideActive = Boolean(env.OMP_ANIMATIONS_FORCE_TIER);
	return formatDoctorReport(tier, overrideActive);
}
