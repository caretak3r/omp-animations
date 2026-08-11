import { describe, expect, it } from "bun:test";
import {
	BOX_DEFAULTS,
	BOX_MIGRATED_ANIMATION_IDS,
	BOX_SEGMENT_DEFAULT_VISIBLE,
	BOX_SEGMENT_IDS,
	BOX_SETTING_ENV,
	BOX_SETTING_KEYS,
	resolveAnimationsBoxConfig,
	resolveAnimationsBoxConfigFromSources,
	segmentVisible,
} from "../src/animations-box/settings";
import { animationsEnvKey } from "../src/appearance";
import { ANIMATIONS } from "../src/registrar";

const ALL_ANIMATION_IDS = ANIMATIONS.map(a => a.id);

describe("BOX_SEGMENT_IDS / BOX_MIGRATED_ANIMATION_IDS — derived from the registrar, never hardcoded counts", () => {
	it("every segment id names a real registrar animation, with no duplicates", () => {
		for (const id of BOX_SEGMENT_IDS) expect(ALL_ANIMATION_IDS).toContain(id);
		expect(new Set(BOX_SEGMENT_IDS).size).toBe(BOX_SEGMENT_IDS.length);
	});

	it("excludes breathingBorder — its row becomes the box's own border chrome, not a segment", () => {
		expect(BOX_SEGMENT_IDS).not.toContain("breathingBorder");
	});

	it("is exactly the registrar's animations minus breathingBorder (there is no context segment — see Decision 1)", () => {
		expect(ALL_ANIMATION_IDS.length - 1).toBe(BOX_SEGMENT_IDS.length);
	});

	it("BOX_MIGRATED_ANIMATION_IDS is exactly the segment ids plus breathingBorder — the whole registrar set", () => {
		expect(new Set(BOX_MIGRATED_ANIMATION_IDS)).toEqual(new Set(ALL_ANIMATION_IDS));
		expect(BOX_MIGRATED_ANIMATION_IDS.length).toBe(ALL_ANIMATION_IDS.length);
	});
});

describe("resolveAnimationsBoxConfig — defaults and validation", () => {
	it("falls back to display=box, detail=detailed, placement=belowEditor, every segment enabled, on an empty record", () => {
		const config = resolveAnimationsBoxConfig({});
		expect(config.display).toBe(BOX_DEFAULTS.display);
		expect(config.detail).toBe(BOX_DEFAULTS.detail);
		expect(config.placement).toBe(BOX_DEFAULTS.placement);
		for (const id of BOX_SEGMENT_IDS) expect(config.enabled[id]).toBe(true);
		for (const id of BOX_SEGMENT_IDS) expect(config.visible[id]).toBe(BOX_SEGMENT_DEFAULT_VISIBLE[id]);
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

	it("resolves each segment's own boolean key independently, accepting real booleans and string forms", () => {
		const config = resolveAnimationsBoxConfig({ cacheMeter: false, palimpsest: "false", toolConstellation: "true" });
		expect(config.enabled.cacheMeter).toBe(false);
		expect(config.enabled.palimpsest).toBe(false);
		expect(config.enabled.toolConstellation).toBe(true);
		expect(config.enabled.reflectionRipple).toBe(true); // untouched key stays at the default
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

describe("segment visibility — D7's box-scope default cut", () => {
	it("BOX_SEGMENT_DEFAULT_VISIBLE cuts exactly cadenceEqualizer and reflectionRipple", () => {
		const cut = BOX_SEGMENT_IDS.filter(id => !BOX_SEGMENT_DEFAULT_VISIBLE[id]);
		expect(cut).toEqual(["cadenceEqualizer", "reflectionRipple"]);
	});

	it("a cut segment stays enabled by default — rows mode and the per-animation boolean are untouched", () => {
		const config = resolveAnimationsBoxConfig({});
		expect(config.enabled.cadenceEqualizer).toBe(true);
		expect(segmentVisible(config, "cadenceEqualizer")).toBe(false);
		expect(config.enabled.reflectionRipple).toBe(true);
		expect(segmentVisible(config, "reflectionRipple")).toBe(false);
	});

	it("an explicit per-animation true opts a cut row back in, boolean or string form", () => {
		expect(segmentVisible(resolveAnimationsBoxConfig({ cadenceEqualizer: true }), "cadenceEqualizer")).toBe(true);
		expect(segmentVisible(resolveAnimationsBoxConfig({ reflectionRipple: "true" }), "reflectionRipple")).toBe(true);
	});

	it("an explicit false still hides a default-visible segment", () => {
		const config = resolveAnimationsBoxConfig({ cacheMeter: false });
		expect(segmentVisible(config, "cacheMeter")).toBe(false);
		expect(config.enabled.cacheMeter).toBe(false);
	});

	it("the opt-back-in reads the SAME key/env pair as the enable boolean, stored > env", () => {
		const fromEnv = resolveAnimationsBoxConfigFromSources({}, { [animationsEnvKey("cadenceEqualizer")]: "true" });
		expect(segmentVisible(fromEnv, "cadenceEqualizer")).toBe(true);

		const stored = resolveAnimationsBoxConfigFromSources(
			{ reflectionRipple: false },
			{ [animationsEnvKey("reflectionRipple")]: "true" },
		);
		expect(segmentVisible(stored, "reflectionRipple")).toBe(false); // stored false wins over env true
	});

	it("is independent of display — callers gate box presence on display separately", () => {
		const config = resolveAnimationsBoxConfig({ [BOX_SETTING_KEYS.display]: "rows", cacheMeter: true });
		expect(segmentVisible(config, "cacheMeter")).toBe(true);
	});
});
