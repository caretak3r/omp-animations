import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import {
	ACCENT_SETTING_VALUES,
	accentColorKey,
	animationsEnvKey,
	OKABE_ITO_HEX,
	OKABE_ITO_PALETTE,
	PLACEMENT_VALUES,
	placementKey,
	resolveAnimationAppearance,
} from "../src/appearance";
import { AUDIT_TRAIL_BOX_COLORS, renderAuditMeterRow } from "../src/audit-trail-box/render";
import { AuditLedgerState } from "../src/audit-trail-box/state";
import { CACHE_METER_COLORS, renderCacheMeterRow } from "../src/cache-meter/render";
import { CacheMeterState } from "../src/cache-meter/state";
import { renderTidepoolRow, TIDEPOOL_COLORS } from "../src/rate-limit-tidepool/render";
import { ANIMATIONS, resolveAnimationsConfig } from "../src/registrar";

const taggedTheme: Pick<Theme, "fg" | "underline" | "bold"> = {
	fg: (color, text) => `${color}:${text}`,
	underline: text => `U(${text})`,
	bold: text => `B(${text})`,
};

describe("resolveAnimationAppearance", () => {
	it("uses the historical placement and built-in palette by default", () => {
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {})).toEqual({
			placement: "aboveEditor",
			accentColor: undefined,
			glyphPreset: "unicode",
		});
	});

	it("resolves stored placement before env, with null falling through", () => {
		expect(
			resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterPlacement: "belowEditor" }, {}).placement,
		).toBe("belowEditor");
		expect(
			resolveAnimationAppearance(
				"cacheMeter",
				"aboveEditor",
				{},
				{
					OMP_ANIMATIONS_CACHE_METER_PLACEMENT: "belowEditor",
				},
			).placement,
		).toBe("belowEditor");
		expect(
			resolveAnimationAppearance(
				"cacheMeter",
				"aboveEditor",
				{ cacheMeterPlacement: "aboveEditor" },
				{ OMP_ANIMATIONS_CACHE_METER_PLACEMENT: "belowEditor" },
			).placement,
		).toBe("aboveEditor");
		expect(
			resolveAnimationAppearance(
				"cacheMeter",
				"aboveEditor",
				{ cacheMeterPlacement: null },
				{ OMP_ANIMATIONS_CACHE_METER_PLACEMENT: "belowEditor" },
			).placement,
		).toBe("belowEditor");
	});

	it("silently falls back for malformed placement values", () => {
		expect(
			resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterPlacement: "sideways" }, {}).placement,
		).toBe("aboveEditor");
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterPlacement: 42 }, {}).placement).toBe(
			"aboveEditor",
		);
	});

	it("resolves curated accent values while default, absent, and junk preserve the built-in palette", () => {
		expect(
			resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterAccentColor: "success" }, {}).accentColor,
		).toBe("success");
		expect(
			resolveAnimationAppearance(
				"cacheMeter",
				"aboveEditor",
				{},
				{
					OMP_ANIMATIONS_CACHE_METER_ACCENT_COLOR: "warning",
				},
			).accentColor,
		).toBe("warning");
		for (const value of ["default", undefined, "hotpink"]) {
			expect(
				resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterAccentColor: value }, {}).accentColor,
			).toBeUndefined();
		}
	});

	it("resolves Okabe-Ito colorblind-safe palette values through the existing accentColor path", () => {
		// Test each Okabe-Ito color resolves correctly via pluginSettings
		for (const color of OKABE_ITO_PALETTE) {
			expect(
				resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterAccentColor: color }, {}).accentColor,
			).toBe(color);
		}

		// Test resolution via env
		expect(
			resolveAnimationAppearance(
				"rateLimitTidepool",
				"belowEditor",
				{},
				{ OMP_ANIMATIONS_RATE_LIMIT_TIDEPOOL_ACCENT_COLOR: "okabeOrange" },
			).accentColor,
		).toBe("okabeOrange");

		expect(
			resolveAnimationAppearance(
				"breathingBorder",
				"aboveEditor",
				{},
				{ OMP_ANIMATIONS_BREATHING_BORDER_ACCENT_COLOR: "okabeSkyBlue" },
			).accentColor,
		).toBe("okabeSkyBlue");

		// Verify hex values are correctly mapped
		expect(OKABE_ITO_HEX.okabeOrange).toBe("#E69F00");
		expect(OKABE_ITO_HEX.okabeSkyBlue).toBe("#56B4E9");
		expect(OKABE_ITO_HEX.okabeGreen).toBe("#009E73");
		expect(OKABE_ITO_HEX.okabeYellow).toBe("#F0E442");
		expect(OKABE_ITO_HEX.okabeBlue).toBe("#0072B2");
		expect(OKABE_ITO_HEX.okabeVermillion).toBe("#D55E00");
		expect(OKABE_ITO_HEX.okabePurple).toBe("#CC79A7");

		// Verify invalid/unset values still resolve to undefined (byte-identical to existing default)
		for (const value of ["default", undefined, "hotpink", "notAColor"]) {
			expect(
				resolveAnimationAppearance("cacheMeter", "aboveEditor", { cacheMeterAccentColor: value }, {}).accentColor,
			).toBeUndefined();
		}
	});

	it("derives manifest and env keys from camel-case ids", () => {
		expect(animationsEnvKey("rateLimitTidepool")).toBe("OMP_ANIMATIONS_RATE_LIMIT_TIDEPOOL");
		expect(animationsEnvKey("rateLimitTidepool", "PLACEMENT")).toBe("OMP_ANIMATIONS_RATE_LIMIT_TIDEPOOL_PLACEMENT");
		expect(placementKey("rateLimitTidepool")).toBe("rateLimitTidepoolPlacement");
		expect(accentColorKey("rateLimitTidepool")).toBe("rateLimitTidepoolAccentColor");
	});

	it("defaults glyphPreset to 'unicode' and passes an explicit value straight through, outside the settings/env precedence chain", () => {
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {}).glyphPreset).toBe("unicode");
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {}, "ascii").glyphPreset).toBe("ascii");
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {}, "nerd").glyphPreset).toBe("nerd");
	});
});

describe("resolveAnimationsConfig appearance", () => {
	it("keeps stored overrides isolated to their animation", () => {
		const config = resolveAnimationsConfig(
			{ auditTrailBoxPlacement: "aboveEditor", cacheMeterAccentColor: "warning" },
			{},
		);
		for (const entry of ANIMATIONS) {
			expect(config.appearance[entry.id]).toEqual({
				placement: entry.id === "auditTrailBox" ? "aboveEditor" : entry.defaultPlacement,
				accentColor: entry.id === "cacheMeter" ? "warning" : undefined,
				glyphPreset: "unicode",
			});
		}
	});

	it("threads an env-only override into the registrar config", () => {
		const config = resolveAnimationsConfig({}, { OMP_ANIMATIONS_RATE_LIMIT_TIDEPOOL_ACCENT_COLOR: "accent" });
		expect(config.appearance.rateLimitTidepool.accentColor).toBe("accent");
	});

	it("defaults glyphPreset to 'unicode' and threads an explicit value uniformly into every animation's appearance", () => {
		const defaulted = resolveAnimationsConfig({}, {});
		for (const entry of ANIMATIONS) expect(defaulted.appearance[entry.id].glyphPreset).toBe("unicode");

		const ascii = resolveAnimationsConfig({}, {}, "ascii");
		for (const entry of ANIMATIONS) expect(ascii.appearance[entry.id].glyphPreset).toBe("ascii");
	});
});

describe("manifest appearance settings", () => {
	it("keeps every placement/accent enum aligned with code-derived keys and defaults", async () => {
		const pkg = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json();
		const settings = pkg.omp.settings as Record<
			string,
			{ type?: string; values?: readonly string[]; default?: unknown; env?: string }
		>;

		for (const entry of ANIMATIONS) {
			const placement = settings[placementKey(entry.id)];
			expect(placement?.type).toBe("enum");
			expect(placement?.values).toEqual([...PLACEMENT_VALUES]);
			expect(placement?.env).toBe(animationsEnvKey(entry.id, "PLACEMENT"));
			expect(placement?.default).toBe(entry.defaultPlacement);
			const accent = settings[accentColorKey(entry.id)];
			expect(accent?.type).toBe("enum");
			expect(accent?.values).toEqual([...ACCENT_SETTING_VALUES]);
			expect(accent?.default).toBe("default");
			expect(accent?.env).toBe(animationsEnvKey(entry.id, "ACCENT_COLOR"));
		}
	});
});

describe("renderer accent override", () => {
	it("recolors only Audit Trail Box's badge", () => {
		const ledger = new AuditLedgerState();
		ledger.noteRead("a.ts", {});
		const snapshot = ledger.snapshot();
		const defaultRow = renderAuditMeterRow(snapshot, 40, 0, taggedTheme, "full");
		expect(defaultRow).toContain("accent:");
		const overriddenRow = renderAuditMeterRow(snapshot, 40, 0, taggedTheme, "full", {
			...AUDIT_TRAIL_BOX_COLORS,
			badge: "success",
		});
		expect(overriddenRow).toContain("success:");
		expect(overriddenRow).not.toContain("accent:");
	});

	it("recolors only Cache Meter's badge", () => {
		const state = new CacheMeterState();
		state.recordUsage(
			{
				provider: "anthropic",
				model: "claude",
				usage: { input: 0, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 100 },
			},
			0,
		);
		const snapshot = state.snapshot();
		const defaultRow = renderCacheMeterRow(snapshot, 40, 0, taggedTheme, "full");
		expect(defaultRow).toContain("accent:");
		const overriddenRow = renderCacheMeterRow(snapshot, 40, 0, taggedTheme, "full", snapshot.warmth, false, {
			...CACHE_METER_COLORS,
			badge: "success",
		});
		expect(overriddenRow).toContain("success:");
		expect(overriddenRow).not.toContain("accent:");
	});

	it("recolors only Rate-Limit Tidepool's water, never the fixed sand alarm", () => {
		const colors = {
			water: "syntaxString" as const,
			pebble: "dim" as const,
			sand: "warning" as const,
			label: "dim" as const,
		};
		const calm = renderTidepoolRow(1, "anthropic", 0, 69, taggedTheme, "subtle", colors);
		expect(calm).toContain("syntaxString:");
		const sand = renderTidepoolRow(0, "anthropic", 0, 69, taggedTheme, "subtle", colors);
		expect(sand).toContain("warning:");
		expect(sand).not.toContain("syntaxString:");
	});
});

describe("default byte-equality", () => {
	it("matches every explicit built-in palette", () => {
		const ledger = new AuditLedgerState();
		ledger.noteRead("a.ts", {});
		expect(renderAuditMeterRow(ledger.snapshot(), 40, 0, taggedTheme, "full")).toBe(
			renderAuditMeterRow(ledger.snapshot(), 40, 0, taggedTheme, "full", AUDIT_TRAIL_BOX_COLORS),
		);

		const cache = new CacheMeterState();
		cache.recordUsage(
			{
				provider: "anthropic",
				model: "claude",
				usage: { input: 0, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 100 },
			},
			0,
		);
		const cacheSnapshot = cache.snapshot();
		expect(renderCacheMeterRow(cacheSnapshot, 40, 0, taggedTheme, "full")).toBe(
			renderCacheMeterRow(
				cacheSnapshot,
				40,
				0,
				taggedTheme,
				"full",
				cacheSnapshot.warmth,
				false,
				CACHE_METER_COLORS,
			),
		);

		expect(renderTidepoolRow(0.5, "anthropic", 0, 69, taggedTheme, "full")).toBe(
			renderTidepoolRow(0.5, "anthropic", 0, 69, taggedTheme, "full", TIDEPOOL_COLORS),
		);
	});
});
