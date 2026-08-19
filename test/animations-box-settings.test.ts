import { describe, expect, it } from "bun:test";
import {
	BOX_DEFAULTS,
	BOX_OPTIONAL_SEGMENT_IDS,
	BOX_OPTIONAL_STATUS_SEGMENT_IDS,
	BOX_REQUIRED_SEGMENT_IDS,
	BOX_SEGMENT_IDS,
	BOX_SETTING_ENV,
	BOX_SETTING_KEYS,
	REMOVED_DISPLAY_ENV,
	REMOVED_DISPLAY_KEY,
	resolveAnimationsBoxConfig,
	resolveAnimationsBoxConfigFromSources,
} from "../src/animations-box/settings";
import { animationsEnvKey } from "../src/appearance";

describe("Audit Box segment groups", () => {
	it("pins the Audit summary order and deterministic optional-animation order", () => {
		expect(BOX_REQUIRED_SEGMENT_IDS).toEqual([
			"contextGauge",
			"cacheMeter",
			"auditTrailBox",
			"rateLimitTidepool",
			"toolActivity",
			"filesLive",
		]);
		expect(BOX_OPTIONAL_SEGMENT_IDS).toEqual(["cadenceEqualizer", "reflectionRipple", "agentBonsai"]);
		expect(BOX_SEGMENT_IDS).toEqual([...BOX_REQUIRED_SEGMENT_IDS, ...BOX_OPTIONAL_STATUS_SEGMENT_IDS]);
		expect(new Set(BOX_SEGMENT_IDS).size).toBe(BOX_SEGMENT_IDS.length);
	});
});

describe("resolveAnimationsBoxConfig — defaults and validation", () => {
	it("defaults to detailed mode, no status animations, Agent Bonsai on, and a breathing border", () => {
		const config = resolveAnimationsBoxConfig({});
		expect(config).toEqual({
			detail: BOX_DEFAULTS.detail,
			placement: BOX_DEFAULTS.placement,
			optional: { cadenceEqualizer: false, reflectionRipple: false, agentBonsai: true },
			breathingBorder: true,
			contextQuota: BOX_DEFAULTS.contextQuota,
		});
	});

	it("accepts each valid detail/placement value", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.detail]: "simple" }).detail).toBe("simple");
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.detail]: "detailed" }).detail).toBe("detailed");
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.placement]: "aboveEditor" }).placement).toBe("aboveEditor");
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.placement]: "belowEditor" }).placement).toBe("belowEditor");
	});

	it("falls back to the default on an invalid or malformed value rather than throwing", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.detail]: "nonsense" }).detail).toBe(BOX_DEFAULTS.detail);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.placement]: 42 }).placement).toBe(BOX_DEFAULTS.placement);
	});

	it("there is no 'off' value on detail — it falls back to the default, same as any other invalid string", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.detail]: "off" }).detail).toBe(BOX_DEFAULTS.detail);
	});

	it("required summaries have no enable key: a stored false for one changes nothing", () => {
		const config = resolveAnimationsBoxConfig({
			cacheMeter: false,
			auditTrailBox: false,
			rateLimitTidepool: false,
			toolActivity: false,
			palimpsest: false,
		});
		expect(config).toEqual(resolveAnimationsBoxConfig({}));
	});

	it("ignores a stray animationsBoxOnly key entirely — the subset key was dropped, not just renamed", () => {
		expect(resolveAnimationsBoxConfig({ animationsBoxOnly: "cacheMeter" })).toEqual(resolveAnimationsBoxConfig({}));
	});

	it("ignores a stored toolConstellation key — the deleted animation's setting changes nothing", () => {
		// Tool Constellation was deleted in `omp-animations-buv.4`; the manifest key went
		// with it. A settings file left over from an older install must resolve identically
		// to one that never had the key.
		expect(resolveAnimationsBoxConfig({ toolConstellation: false })).toEqual(resolveAnimationsBoxConfig({}));
	});

	it("ignores the deleted OMP_ANIMATIONS_TOOL_CONSTELLATION env fallback", () => {
		expect(resolveAnimationsBoxConfigFromSources({}, { [animationsEnvKey("toolConstellation")]: "false" })).toEqual(
			resolveAnimationsBoxConfigFromSources({}, {}),
		);
	});

	it("ignores the removed display setting and its env fallback", () => {
		expect(resolveAnimationsBoxConfig({ [REMOVED_DISPLAY_KEY]: "rows" })).toEqual(resolveAnimationsBoxConfig({}));
		expect(resolveAnimationsBoxConfigFromSources({ [REMOVED_DISPLAY_KEY]: "both" }, {})).toEqual(
			resolveAnimationsBoxConfigFromSources({}, {}),
		);
		expect(resolveAnimationsBoxConfigFromSources({}, { [REMOVED_DISPLAY_ENV]: "rows" })).toEqual(
			resolveAnimationsBoxConfigFromSources({}, {}),
		);
	});

	it("breathingBorder defaults to enabled and resolves through the same raw key as the segment booleans (Decision 2)", () => {
		expect(resolveAnimationsBoxConfig({}).breathingBorder).toBe(true);
		expect(resolveAnimationsBoxConfig({ breathingBorder: false }).breathingBorder).toBe(false);
		expect(resolveAnimationsBoxConfig({ breathingBorder: "false" }).breathingBorder).toBe(false);
		expect(resolveAnimationsBoxConfig({ breathingBorder: "true" }).breathingBorder).toBe(true);
	});

	it("clamps contextQuota into the 5–100 band and falls back on garbage", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: 50 }).contextQuota).toBe(50);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: 1 }).contextQuota).toBe(5);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: 0 }).contextQuota).toBe(5);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: -20 }).contextQuota).toBe(5);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: 400 }).contextQuota).toBe(100);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: "nonsense" }).contextQuota).toBe(
			BOX_DEFAULTS.contextQuota,
		);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: null }).contextQuota).toBe(
			BOX_DEFAULTS.contextQuota,
		);
	});

	it("accepts a string quota, since env fallbacks arrive as strings", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.contextQuota]: "65" }).contextQuota).toBe(65);
	});
});

describe("resolveAnimationsBoxConfigFromSources — stored > env > default precedence", () => {
	it("prefers stored settings over env, and env over the default, per key", () => {
		const config = resolveAnimationsBoxConfigFromSources(
			{ [BOX_SETTING_KEYS.detail]: "detailed" },
			{ [BOX_SETTING_ENV.detail]: "simple", [BOX_SETTING_ENV.placement]: "aboveEditor" },
		);
		expect(config.detail).toBe("detailed"); // stored wins over env
		expect(config.placement).toBe("aboveEditor"); // env wins over default (nothing stored)
		expect(resolveAnimationsBoxConfigFromSources({}, {}).placement).toBe(BOX_DEFAULTS.placement);
	});

	it("uses the manifest's literal keys and env var names, and no longer carries a display key", () => {
		expect(BOX_SETTING_KEYS).toEqual({
			detail: "animationsBoxDetail",
			placement: "animationsBoxPlacement",
			contextQuota: "animationsContextQuota",
		});
		expect(BOX_SETTING_ENV).toEqual({
			detail: "OMP_ANIMATIONS_BOX_DETAIL",
			placement: "OMP_ANIMATIONS_BOX_PLACEMENT",
			contextQuota: "OMP_ANIMATIONS_CONTEXT_QUOTA",
		});
		expect(REMOVED_DISPLAY_KEY).toBe("display");
		expect(REMOVED_DISPLAY_ENV).toBe("OMP_ANIMATIONS_DISPLAY");
	});

	it("defaults env to Bun.env and never throws on an empty pluginSettings record", () => {
		expect(() => resolveAnimationsBoxConfigFromSources({})).not.toThrow();
	});

	it("resolves breathingBorder through the SAME key/env pair its standalone row already uses (Decision 2)", () => {
		const fromEnv = resolveAnimationsBoxConfigFromSources({}, { [animationsEnvKey("breathingBorder")]: "false" });
		expect(fromEnv.breathingBorder).toBe(false);

		const stored = resolveAnimationsBoxConfigFromSources(
			{ breathingBorder: false },
			{ [animationsEnvKey("breathingBorder")]: "true" },
		);
		expect(stored.breathingBorder).toBe(false); // stored wins over env
	});

	it("reads the quota from env when nothing is stored, and lets a stored value win", () => {
		expect(resolveAnimationsBoxConfigFromSources({}, { [BOX_SETTING_ENV.contextQuota]: "60" }).contextQuota).toBe(60);
		expect(
			resolveAnimationsBoxConfigFromSources(
				{ [BOX_SETTING_KEYS.contextQuota]: 90 },
				{ [BOX_SETTING_ENV.contextQuota]: "60" },
			).contextQuota,
		).toBe(90);
	});
});

describe("optional animation toggles", () => {
	it("contains only optional animation ids, so required summaries cannot become user-toggleable", () => {
		expect(Object.keys(resolveAnimationsBoxConfig({}).optional)).toEqual([...BOX_OPTIONAL_SEGMENT_IDS]);
	});

	it("round-trips cadence and reflection independently from booleans and string forms", () => {
		expect(resolveAnimationsBoxConfig({ cadenceEqualizer: true }).optional).toEqual({
			cadenceEqualizer: true,
			reflectionRipple: false,
			agentBonsai: true,
		});
		expect(resolveAnimationsBoxConfig({ reflectionRipple: "true" }).optional).toEqual({
			cadenceEqualizer: false,
			reflectionRipple: true,
			agentBonsai: true,
		});
		expect(resolveAnimationsBoxConfig({ cadenceEqualizer: "false", reflectionRipple: true }).optional).toEqual({
			cadenceEqualizer: false,
			reflectionRipple: true,
			agentBonsai: true,
		});
	});

	it("round-trips Agent Bonsai and lets a stored false beat the env fallback", () => {
		expect(resolveAnimationsBoxConfig({ agentBonsai: false }).optional.agentBonsai).toBe(false);
		expect(
			resolveAnimationsBoxConfigFromSources({}, { OMP_ANIMATIONS_AGENT_BONSAI: "false" }).optional.agentBonsai,
		).toBe(false);
		expect(
			resolveAnimationsBoxConfigFromSources({ agentBonsai: false }, { OMP_ANIMATIONS_AGENT_BONSAI: "true" }).optional
				.agentBonsai,
		).toBe(false);
	});

	it("uses each animation's existing stored-setting and env key with stored > env precedence", () => {
		const fromEnv = resolveAnimationsBoxConfigFromSources(
			{},
			{
				[animationsEnvKey("cadenceEqualizer")]: "true",
				[animationsEnvKey("reflectionRipple")]: "false",
			},
		);
		expect(fromEnv.optional).toEqual({ cadenceEqualizer: true, reflectionRipple: false, agentBonsai: true });

		const stored = resolveAnimationsBoxConfigFromSources(
			{ cadenceEqualizer: false, reflectionRipple: true },
			{
				[animationsEnvKey("cadenceEqualizer")]: "true",
				[animationsEnvKey("reflectionRipple")]: "false",
			},
		);
		expect(stored.optional).toEqual({ cadenceEqualizer: false, reflectionRipple: true, agentBonsai: true });
	});
});
