import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ANIMATIONS, createAnimationsPlugin, readPluginSettingsSync, resolveAnimationsConfig } from "../src/registrar";

/**
 * A recording ExtensionAPI double. The registrar and the animation factories touch
 * `on` (event subscription), `setLabel`, `registerCommand` (Audit Trail Box registers
 * `/audit-trail`), and — inside handlers, never at wire time — `logger`. Every
 * `on(event)` at wire time is captured so we can assert exactly which animations
 * subscribed, and likewise every registered command name.
 */
function makeApi(): { api: ExtensionAPI; events: string[]; labels: string[]; commands: string[] } {
	const events: string[] = [];
	const labels: string[] = [];
	const commands: string[] = [];
	const api = {
		on: (event: string) => {
			events.push(event);
		},
		setLabel: (label: string) => {
			labels.push(label);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		logger: { error() {}, warn() {}, debug() {}, info() {} },
	} as unknown as ExtensionAPI;
	return { api, events, labels, commands };
}

const ALL_IDS = ANIMATIONS.map(a => a.id);
const noopRead = async (): Promise<Record<string, unknown>> => ({});

/** Mount the registrar with an explicit per-animation enable record and capture subscriptions. */
function mount(enabled: Record<string, unknown>): { events: string[]; labels: string[]; commands: string[] } {
	const { api, events, labels, commands } = makeApi();
	createAnimationsPlugin({ settings: enabled, env: {}, readPluginSettings: noopRead })(api);
	return { events, labels, commands };
}

/** A flat enable record: only the ids in `on` are true, the rest false. */
function only(...on: string[]): Record<string, boolean> {
	const set = new Set(on);
	return Object.fromEntries(ALL_IDS.map(id => [id, set.has(id)]));
}

describe("animations registrar", () => {
	it("mounts every animation by default and labels the plugin once", () => {
		const { events, labels } = mount({});
		expect(events.length).toBeGreaterThan(0);
		expect(labels).toContain("oh-my-pi animations");
	});

	it("the registrar's own label is always the last one set, regardless of the enabled subset", () => {
		// setLabel is last-write-wins on the shared extension. Before Plan 007, Context
		// Weather's own mount called pi.setLabel("Context Weather") synchronously, which is
		// why the registrar sets its own label AFTER the mount loop — so /status shows the
		// whole suite, not just one animation. Context Weather is unregistered now, but the
		// ordering guard stays load-bearing for any future animation that calls setLabel.
		const { labels } = mount(only(...ALL_IDS));
		expect(labels.at(-1)).toBe("oh-my-pi animations");
	});

	it("leaves ZERO subscriptions when every animation is disabled", () => {
		const { events, labels, commands } = mount(only());
		// The core contract: a disabled animation's factory is never invoked, so it
		// registers no listeners. With all disabled there are no subscriptions at all.
		expect(events).toEqual([]);
		// Same contract for slash commands: Audit Trail Box's `/audit-trail` is
		// registered inside its factory, so disabling it leaves no command behind.
		expect(commands).toEqual([]);
		// The registrar itself still identifies the plugin.
		expect(labels).toContain("oh-my-pi animations");
	});

	it("registers each command-bearing animation's slash command only when that animation is enabled", () => {
		expect(mount(only("auditTrailBox")).commands).toEqual(["audit-trail"]);
		expect(mount(only("cacheMeter")).commands).toEqual(["cache"]);
		expect(mount(only("palimpsest", "reflectionRipple")).commands).toEqual([]);
		// Default (nothing specified) enables every animation, so both command-bearing
		// animations register, in ANIMATIONS mount order.
		expect(mount({}).commands).toEqual(["audit-trail", "cache"]);
	});

	it("mounts exactly the enabled subset — disabled animations contribute no subscriptions", () => {
		// Each animation's own subscription multiset, captured by mounting it alone.
		const own = new Map<string, string[]>();
		for (const a of ANIMATIONS) {
			own.set(a.id, mount(only(a.id)).events.slice().sort());
		}
		// A representative subset of the shipped set.
		const subset = ["breathingBorder", "cadenceEqualizer", "toolConstellation"];
		const got = mount(only(...subset))
			.events.slice()
			.sort();
		const expected = subset.flatMap(id => own.get(id) ?? []).sort();
		expect(got).toEqual(expected);

		// And a disabled animation's own events are genuinely absent from the subset mount.
		const disabledId = "reflectionRipple";
		expect(subset).not.toContain(disabledId);
		const disabledEvents = own.get(disabledId) ?? [];
		const gotSet = new Set(got);
		// reflectionRipple subscribes to at least one event no member of the subset does.
		expect(disabledEvents.some(e => !gotSet.has(e))).toBe(true);
	});

	it("composes the full set as the union of each animation's own subscriptions", () => {
		const all = mount(only(...ALL_IDS))
			.events.slice()
			.sort();
		const union = ALL_IDS.flatMap(id => mount(only(id)).events).sort();
		expect(all).toEqual(union);
	});

	it("the excluded animations are not in the registrar's mounted set and register no listeners", () => {
		// This package ships a curated 8-animation keep-set; the other 16 animation source
		// dirs from the broader oh-my-pi-animations suite were deliberately left out of the
		// copy entirely (see package.json's description and this file's own imports) — they
		// are not merely unregistered, their source does not exist in this repo at all.
		const excludedIds = [
			"agentFleet",
			"compactionVacuum",
			"contextConstellation",
			"contextWeather",
			"costCandle",
			"diffBloom",
			"driftBuoy",
			"fourHands",
			"goalHorizon",
			"memoryCrystals",
			"promptCharge",
			"sessionBonsai",
			"sessionStrata",
			"spinnerPacks",
			"todoMeteors",
			"tokenTide",
		];
		for (const id of excludedIds) expect(ALL_IDS).not.toContain(id);
		expect(ALL_IDS.slice().sort()).toEqual(
			[
				"auditTrailBox",
				"breathingBorder",
				"cacheMeter",
				"cadenceEqualizer",
				"palimpsest",
				"rateLimitTidepool",
				"reflectionRipple",
				"toolConstellation",
			].sort(),
		);

		// Trying to "enable" an excluded id (e.g. from a stale stored settings file) mounts
		// nothing for it — `only()` only recognizes ids that are still in ANIMATIONS, so a
		// stored `{ diffBloom: true }` is silently inert rather than resurrecting it.
		const { events, labels } = mount({ ...only(), diffBloom: true, contextWeather: true });
		expect(events).toEqual([]);
		expect(labels).toContain("oh-my-pi animations");
	});
});

describe("resolveAnimationsConfig", () => {
	it("defaults to tier 'full' with every animation enabled", () => {
		const cfg = resolveAnimationsConfig({}, {});
		expect(cfg.tier).toBe("full");
		expect(ALL_IDS.every(id => cfg.enabled[id])).toBe(true);
	});

	it("reads the tier and a stored disable from plugin settings", () => {
		const cfg = resolveAnimationsConfig({ animations: "subtle", cacheMeter: false }, {});
		expect(cfg.tier).toBe("subtle");
		expect(cfg.enabled.cacheMeter).toBe(false);
		expect(cfg.enabled.palimpsest).toBe(true);
	});

	it("falls back to env vars when a setting is unstored", () => {
		const cfg = resolveAnimationsConfig({}, { OMP_ANIMATIONS: "off", OMP_ANIMATIONS_CACHE_METER: "false" });
		expect(cfg.tier).toBe("off");
		expect(cfg.enabled.cacheMeter).toBe(false);
		expect(cfg.enabled.auditTrailBox).toBe(true);
	});

	it("prefers a stored setting over the env fallback", () => {
		const cfg = resolveAnimationsConfig({ cacheMeter: false }, { OMP_ANIMATIONS_CACHE_METER: "true" });
		expect(cfg.enabled.cacheMeter).toBe(false);
	});
});

describe("readPluginSettingsSync", () => {
	const tempDirs: string[] = [];

	/** A fresh, isolated `{ home, cwd }` pair — neither directory exists yet. */
	function isolatedRoots(): { home: string; cwd: string } {
		const base = mkdtempSync(path.join(tmpdir(), "oh-my-pi-animations-"));
		tempDirs.push(base);
		return { home: path.join(base, "home"), cwd: path.join(base, "project") };
	}

	function writeGlobalLockfile(home: string, settings: Record<string, unknown>): void {
		const dir = path.join(home, ".omp", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "omp-plugins.lock.json"),
			JSON.stringify({ plugins: {}, settings: { "@oh-my-pi/animations": settings } }),
		);
	}

	function writeProjectOverrides(cwd: string, settings: Record<string, unknown>): void {
		const dir = path.join(cwd, ".omp");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "plugin-overrides.json"),
			JSON.stringify({ settings: { "@oh-my-pi/animations": settings } }),
		);
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns {} for both stores absent — never throws over missing config", () => {
		const { home, cwd } = isolatedRoots();
		expect(readPluginSettingsSync(cwd, home)).toEqual({});
	});

	it("reads the global lockfile when no project override exists", () => {
		const { home, cwd } = isolatedRoots();
		writeGlobalLockfile(home, { animations: "subtle", toolConstellation: false });
		expect(readPluginSettingsSync(cwd, home)).toEqual({ animations: "subtle", toolConstellation: false });
	});

	it("project overrides win over the global lockfile, per key", () => {
		const { home, cwd } = isolatedRoots();
		writeGlobalLockfile(home, { animations: "full", toolConstellation: true, sessionBonsai: true });
		writeProjectOverrides(cwd, { animations: "subtle", toolConstellation: false });
		const settings = readPluginSettingsSync(cwd, home);
		// Project wins on contested keys...
		expect(settings.animations).toBe("subtle");
		expect(settings.toolConstellation).toBe(false);
		// ...and global still supplies keys the project override doesn't mention.
		expect(settings.sessionBonsai).toBe(true);
	});

	it("a malformed global lockfile degrades to {} instead of throwing", () => {
		const { home, cwd } = isolatedRoots();
		const dir = path.join(home, ".omp", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "omp-plugins.lock.json"), "{ not valid json");
		expect(() => readPluginSettingsSync(cwd, home)).not.toThrow();
		expect(readPluginSettingsSync(cwd, home)).toEqual({});
	});

	it("wires end to end through the production factory (not the settings-injection seam)", () => {
		// This exercises exactly the code path `export default createAnimationsPlugin()` uses —
		// only `cwd`/`home` are supplied, so `settings` resolves via the real readPluginSettingsSync.
		const { home, cwd } = isolatedRoots();
		writeProjectOverrides(cwd, { animations: "subtle", cacheMeter: false });
		const { api, events } = makeApi();
		createAnimationsPlugin({ cwd, home, env: {} })(api);

		const soloEvents = (id: string): string[] => {
			const solo = makeApi();
			createAnimationsPlugin({ settings: only(id), env: {}, readPluginSettings: noopRead })(solo.api);
			return solo.events;
		};

		// cacheMeter is disabled by the stored setting; every other animation is absent
		// from it and so defaults to enabled. Asserted as multiset equality against the
		// union of the enabled animations' own subscriptions rather than "none of
		// cacheMeter's event NAMES appear" — event names are shared (Cache Meter and Audit
		// Trail Box both subscribe to `session_switch`), so only the count proves that the
		// disabled factory contributed nothing.
		expect(soloEvents("cacheMeter").length).toBeGreaterThan(0);
		const expected = ALL_IDS.filter(id => id !== "cacheMeter")
			.flatMap(soloEvents)
			.sort();
		expect(events.slice().sort()).toEqual(expected);
	});
});

describe("package.json#omp.settings — this package's native default", () => {
	it("ships tier 'subtle' and exactly the shipped animations (ANIMATIONS), each defaulting true", async () => {
		const pkg = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json();
		const settings = pkg.omp.settings as Record<string, { default?: unknown }>;

		expect(settings.animations?.default).toBe("subtle");

		for (const id of ALL_IDS) expect(settings[id]?.default).toBe(true);

		const excludedIds = [
			"agentFleet",
			"contextConstellation",
			"contextWeather",
			"costCandle",
			"diffBloom",
			"driftBuoy",
			"fourHands",
			"goalHorizon",
			"memoryCrystals",
			"promptCharge",
			"sessionBonsai",
			"sessionStrata",
			"todoMeteors",
			"tokenTide",
		];
		for (const id of excludedIds) expect(settings[id]).toBeUndefined();

		// Exactly the tier setting + per shipped animation: the enable boolean, a Placement
		// appearance setting for every animation, and an AccentColor appearance setting for
		// every animation except toolConstellation — its per-category rainbow palette has
		// no single overridable slot (see `tool-constellation/index.ts`), so that key was
		// dropped rather than left inert. No leftover excluded keys.
		const accentCapableIds = ALL_IDS.filter(id => id !== "toolConstellation");
		const appearanceKeys = [
			...ALL_IDS.map(id => `${id}Placement`),
			...accentCapableIds.map(id => `${id}AccentColor`),
		];
		expect(Object.keys(settings).sort()).toEqual(["animations", ...ALL_IDS, ...appearanceKeys].sort());
	});
});
