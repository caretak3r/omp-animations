import { describe, expect, it } from "bun:test";
import {
	BOX_DEFAULTS,
	BOX_MIGRATED_ANIMATION_IDS,
	BOX_OPTIONAL_SEGMENT_IDS,
	BOX_OPTIONAL_STATUS_SEGMENT_IDS,
	BOX_REQUIRED_SEGMENT_IDS,
	BOX_SEGMENT_IDS,
	BOX_SETTING_ENV,
	BOX_SETTING_KEYS,
	resolveAnimationsBoxConfig,
	resolveAnimationsBoxConfigFromSources,
} from "../src/animations-box/settings";
import { animationsEnvKey } from "../src/appearance";
import { ANIMATIONS } from "../src/registrar";

const ALL_ANIMATION_IDS = ANIMATIONS.map(a => a.id);

describe("Audit Box segment groups", () => {
	it("pins the immutable required-summary order and deterministic optional-animation order", () => {
		expect(BOX_REQUIRED_SEGMENT_IDS).toEqual([
			"cacheMeter",
			"auditTrailBox",
			"rateLimitTidepool",
			"toolConstellation",
			"palimpsest",
		]);
		expect(BOX_OPTIONAL_SEGMENT_IDS).toEqual(["cadenceEqualizer", "reflectionRipple", "agentBonsai"]);
		expect(BOX_SEGMENT_IDS).toEqual([...BOX_REQUIRED_SEGMENT_IDS, ...BOX_OPTIONAL_STATUS_SEGMENT_IDS]);
	});

	it("covers every registrar status animation except border chrome exactly once", () => {
		const expected = ALL_ANIMATION_IDS.filter(id => id !== "breathingBorder");
		expect(expected.sort()).toEqual([...BOX_SEGMENT_IDS].sort());
		expect(new Set(BOX_SEGMENT_IDS).size).toBe(BOX_SEGMENT_IDS.length);
	});

	it("migrates the complete standalone registrar set", () => {
		expect([...BOX_MIGRATED_ANIMATION_IDS].sort()).toEqual(ALL_ANIMATION_IDS.sort());
		expect(BOX_MIGRATED_ANIMATION_IDS).toHaveLength(ALL_ANIMATION_IDS.length);
	});
});

describe("resolveAnimationsBoxConfig — defaults and validation", () => {
	it("defaults to the box, detailed mode, no status animations, and Agent Bonsai enabled", () => {
		const config = resolveAnimationsBoxConfig({});
		expect(config.display).toBe(BOX_DEFAULTS.display);
		expect(config.detail).toBe(BOX_DEFAULTS.detail);
		expect(config.placement).toBe(BOX_DEFAULTS.placement);
		for (const id of BOX_SEGMENT_IDS) expect(config.enabled[id]).toBe(true);
		expect(config.optional).toEqual({
			cadenceEqualizer: false,
			reflectionRipple: false,
			agentBonsai: true,
		});
	});

	it("accepts each valid display/detail/placement value", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.display]: "rows" }).display).toBe("rows");
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.display]: "both" }).display).toBe("both");
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.detail]: "simple" }).detail).toBe("simple");
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.placement]: "aboveEditor" }).placement).toBe("aboveEditor");
	});

	it("falls back to the default on an invalid or malformed value rather than throwing", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.display]: "nonsense" }).display).toBe(BOX_DEFAULTS.display);
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.placement]: 42 }).placement).toBe(BOX_DEFAULTS.placement);
	});

	it("there is no 'off' value on detail — it falls back to the default, same as any other invalid string", () => {
		expect(resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.detail]: "off" }).detail).toBe(BOX_DEFAULTS.detail);
	});

	it("resolves standalone enable booleans and optional box toggles independently", () => {
		const config = resolveAnimationsBoxConfig({
			cacheMeter: false,
			cadenceEqualizer: "true",
			reflectionRipple: false,
		});
		expect(config.enabled.cacheMeter).toBe(false);
		expect(config.enabled.cadenceEqualizer).toBe(true);
		expect(config.enabled.reflectionRipple).toBe(false);
		expect(config.optional).toEqual({ cadenceEqualizer: true, reflectionRipple: false, agentBonsai: true });
	});

	it("ignores a stray animationsBoxOnly key entirely — the subset key was dropped, not just renamed", () => {
		const config = resolveAnimationsBoxConfig({ animationsBoxOnly: "cacheMeter" });
		for (const id of BOX_SEGMENT_IDS) expect(config.enabled[id]).toBe(true);
	});

	it("breathingBorder defaults to enabled and resolves through the same raw key as the segment booleans (Decision 2)", () => {
		expect(resolveAnimationsBoxConfig({}).breathingBorder).toBe(true);
		expect(resolveAnimationsBoxConfig({ breathingBorder: false }).breathingBorder).toBe(false);
		expect(resolveAnimationsBoxConfig({ breathingBorder: "false" }).breathingBorder).toBe(false);
		expect(resolveAnimationsBoxConfig({ breathingBorder: "true" }).breathingBorder).toBe(true);
	});
});

describe("resolveAnimationsBoxConfigFromSources — stored > env > default precedence", () => {
	it("prefers stored settings over env, and env over the default, per key", () => {
		const config = resolveAnimationsBoxConfigFromSources(
			{ [BOX_SETTING_KEYS.display]: "rows" },
			{ [BOX_SETTING_ENV.display]: "both", [BOX_SETTING_ENV.detail]: "simple" },
		);
		expect(config.display).toBe("rows"); // stored wins over env
		expect(config.detail).toBe("simple"); // env wins over default (nothing stored)
		expect(config.placement).toBe(BOX_DEFAULTS.placement); // neither set — default
	});

	it("uses the manifest's literal env var names for display/detail/placement", () => {
		expect(BOX_SETTING_ENV.display).toBe("OMP_ANIMATIONS_DISPLAY");
		expect(BOX_SETTING_ENV.detail).toBe("OMP_ANIMATIONS_BOX_DETAIL");
		expect(BOX_SETTING_ENV.placement).toBe("OMP_ANIMATIONS_BOX_PLACEMENT");
		expect(BOX_SETTING_KEYS.display).toBe("display");
	});

	it("resolves each segment's enable boolean through the SAME key/env pair its standalone row already uses", () => {
		const config = resolveAnimationsBoxConfigFromSources(
			{ cacheMeter: false },
			{ [animationsEnvKey("cadenceEqualizer")]: "false" },
		);
		expect(config.enabled.cacheMeter).toBe(false); // stored
		expect(config.enabled.cadenceEqualizer).toBe(false); // env
		expect(config.enabled.palimpsest).toBe(true); // neither — default
	});

	it("a stored false beats an env true for the same segment", () => {
		const config = resolveAnimationsBoxConfigFromSources(
			{ cacheMeter: false },
			{ [animationsEnvKey("cacheMeter")]: "true" },
		);
		expect(config.enabled.cacheMeter).toBe(false);
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
});

describe("optional animation toggles", () => {
	it("contains only optional animation ids, so required summaries cannot become user-toggleable", () => {
		const config = resolveAnimationsBoxConfig({
			cacheMeter: false,
			auditTrailBox: false,
			rateLimitTidepool: false,
			toolConstellation: false,
			palimpsest: false,
		});
		expect(Object.keys(config.optional)).toEqual([...BOX_OPTIONAL_SEGMENT_IDS]);
		for (const id of BOX_REQUIRED_SEGMENT_IDS) expect(config.enabled[id]).toBe(false);
		expect(config.optional).toEqual({
			cadenceEqualizer: false,
			reflectionRipple: false,
			agentBonsai: true,
		});
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

	it("is independent of display; callers still gate whether the box itself mounts", () => {
		const config = resolveAnimationsBoxConfig({
			[BOX_SETTING_KEYS.display]: "rows",
			cadenceEqualizer: true,
			reflectionRipple: false,
		});
		expect(config.optional).toEqual({ cadenceEqualizer: true, reflectionRipple: false, agentBonsai: true });
	});
});
