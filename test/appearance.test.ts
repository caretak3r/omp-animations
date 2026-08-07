import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type {
	ExtensionContext,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AfterProviderResponseEvent,
	EditToolResultEvent,
	MessageEndEvent,
	MessageStartEvent,
	ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	ACCENT_SETTING_VALUES,
	accentColorKey,
	animationsEnvKey,
	PLACEMENT_VALUES,
	placementKey,
	resolveAnimationAppearance,
} from "../src/appearance";
import { type AuditTrailBoxContext, AuditTrailBoxController } from "../src/audit-trail-box/controller";
import { AuditLedgerState } from "../src/audit-trail-box/state";
import { AUDIT_TRAIL_BOX_COLORS, AuditTrailBoxWidget, renderAuditMeterRow } from "../src/audit-trail-box/widget";
import { BASE_BREATH_PERIOD_MS } from "../src/breathing-border/breath";
import { type BreathingBorderContext, BreathingBorderController } from "../src/breathing-border/controller";
import { BreathingBorderState } from "../src/breathing-border/state";
import {
	BREATHING_BORDER_COLORS,
	BreathingBorderWidget,
	renderBreathingBorderRow,
} from "../src/breathing-border/widget";
import { type CacheMeterContext, CacheMeterController } from "../src/cache-meter/controller";
import { CacheMeterState } from "../src/cache-meter/state";
import { CACHE_METER_COLORS, CacheMeterWidget, renderCacheMeterRow } from "../src/cache-meter/widget";
import { type CadenceEqualizerContext, CadenceEqualizerController } from "../src/cadence-equalizer/controller";
import { BUCKET_THEME_COLOR } from "../src/cadence-equalizer/scale";
import { CadenceEqualizerState } from "../src/cadence-equalizer/state";
import { CadenceEqualizerWidget, renderEqualizerRow } from "../src/cadence-equalizer/widget";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";
import { type PalimpsestContext, PalimpsestController } from "../src/palimpsest/controller";
import { PalimpsestState } from "../src/palimpsest/state";
import { PALIMPSEST_COLORS, PalimpsestWidget, renderPalimpsestRows } from "../src/palimpsest/widget";
import { RateLimitTidepoolController, type TidepoolContext } from "../src/rate-limit-tidepool/controller";
import { RateLimitTidepoolState } from "../src/rate-limit-tidepool/state";
import { renderTidepoolRow, TIDEPOOL_COLORS, TidepoolWidget } from "../src/rate-limit-tidepool/widget";
import { type ReflectionRippleContext, ReflectionRippleController } from "../src/reflection-ripple/controller";
import { ReflectionRippleState } from "../src/reflection-ripple/state";
import {
	REFLECTION_RIPPLE_COLORS,
	ReflectionRippleWidget,
	renderReflectionRippleRow,
} from "../src/reflection-ripple/widget";
import { ANIMATIONS, createAnimationsPlugin, resolveAnimationsConfig } from "../src/registrar";
import { type ToolConstellationContext, ToolConstellationController } from "../src/tool-constellation/controller";

const idTheme: Pick<Theme, "fg" | "underline" | "bold"> = {
	fg: (_color, text) => text,
	underline: text => text,
	bold: text => text,
};
const taggedTheme: Pick<Theme, "fg" | "underline" | "bold"> = {
	fg: (color, text) => `${color}:${text}`,
	underline: text => `U(${text})`,
	bold: text => `B(${text})`,
};
const fullEnv = {
	hasUI: true,
	isTTY: true,
	env: {} as Record<string, string | undefined>,
	glyphPreset: "unicode" as const,
};
const noopTui = { requestComponentRender() {} };

function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

interface WidgetCall {
	key: string;
	content: ExtensionWidgetContent;
	options: ExtensionWidgetOptions | undefined;
}

function widgetRecorder(): {
	calls: WidgetCall[];
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
} {
	const calls: WidgetCall[] = [];
	return {
		calls,
		setWidget(key, content, options) {
			calls.push({ key, content, options });
		},
	};
}

function expectPlacement(calls: WidgetCall[], placement: "aboveEditor" | "belowEditor"): void {
	expect(calls[0]?.options?.placement).toBe(placement);
	const clearingCall = calls.at(-1);
	expect(clearingCall?.content).toBeUndefined();
	expect(clearingCall?.options?.placement).toBe(placement);
}

function makeWidgetHarness(): {
	scheduler: ReturnType<typeof manualScheduler>;
	policy: MotionPolicy;
	host: AnimationHost;
} {
	const scheduler = manualScheduler();
	const policy = new MotionPolicy(fullEnv, "full");
	const host = new AnimationHost({ policy, backpressure: { underPressure: false }, scheduler });
	return { scheduler, policy, host };
}

const sampleDiff = ["@@ -10,3 +10,3 @@", "+line ten", "+line eleven", "+line twelve"].join("\n");

function editResult(path: string): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path },
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: { diff: sampleDiff, path },
	};
}

function assistantMessageEnd(cacheRead: number): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 10, cacheRead, cacheWrite: 0, totalTokens: 10 },
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as MessageEndEvent;
}

const anthropicHeaders = {
	"anthropic-ratelimit-requests-limit": "50",
	"anthropic-ratelimit-requests-remaining": "45",
	"anthropic-ratelimit-tokens-limit": "40000",
	"anthropic-ratelimit-tokens-remaining": "12000",
};

function afterProviderResponse(headers: Readonly<Record<string, string>>): AfterProviderResponseEvent {
	return { type: "after_provider_response", status: 200, headers: headers as Record<string, string> };
}

function assistantMessageStart(provider: string): MessageStartEvent {
	return {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider,
			model: "model-x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as MessageStartEvent;
}

function rule(name: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: "",
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

function toolCallEvent(toolName: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName, input: {} } as ToolCallEvent;
}

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

	it("derives manifest and env keys from camel-case ids", () => {
		expect(animationsEnvKey("toolConstellation")).toBe("OMP_ANIMATIONS_TOOL_CONSTELLATION");
		expect(animationsEnvKey("toolConstellation", "PLACEMENT")).toBe("OMP_ANIMATIONS_TOOL_CONSTELLATION_PLACEMENT");
		expect(placementKey("cadenceEqualizer")).toBe("cadenceEqualizerPlacement");
		expect(accentColorKey("cadenceEqualizer")).toBe("cadenceEqualizerAccentColor");
	});

	it("defaults glyphPreset to 'unicode' and passes an explicit value straight through, outside the settings/env precedence chain", () => {
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {}).glyphPreset).toBe("unicode");
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {}, "ascii").glyphPreset).toBe("ascii");
		expect(resolveAnimationAppearance("cacheMeter", "aboveEditor", {}, {}, "nerd").glyphPreset).toBe("nerd");
	});
});

describe("resolveAnimationsConfig appearance", () => {
	it("resolves the documented 5-below/3-above split (auditTrailBox, cadenceEqualizer, palimpsest, rateLimitTidepool, toolConstellation belowEditor; breathingBorder, cacheMeter, reflectionRipple aboveEditor)", () => {
		const config = resolveAnimationsConfig({}, {});
		for (const entry of ANIMATIONS) {
			expect(config.appearance[entry.id]).toEqual({
				placement: entry.defaultPlacement,
				accentColor: undefined,
				glyphPreset: "unicode",
			});
		}
		expect(ANIMATIONS.filter(entry => entry.defaultPlacement === "belowEditor").map(entry => entry.id)).toEqual([
			"auditTrailBox",
			"cadenceEqualizer",
			"palimpsest",
			"rateLimitTidepool",
			"toolConstellation",
		]);
		expect(ANIMATIONS.filter(entry => entry.defaultPlacement === "aboveEditor").map(entry => entry.id)).toEqual([
			"breathingBorder",
			"cacheMeter",
			"reflectionRipple",
		]);
	});

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

			// toolConstellation has no AccentColor manifest key: its per-category rainbow
			// palette has no single overridable slot (see tool-constellation/index.ts).
			if (entry.id === "toolConstellation") {
				expect(settings[accentColorKey(entry.id)]).toBeUndefined();
				continue;
			}

			const accent = settings[accentColorKey(entry.id)];
			expect(accent?.type).toBe("enum");
			expect(accent?.values).toEqual([...ACCENT_SETTING_VALUES]);
			expect(accent?.default).toBe("default");
			expect(accent?.env).toBe(animationsEnvKey(entry.id, "ACCENT_COLOR"));
		}
	});
});

describe("controller placement threading", () => {
	it("uses the override for mount and clear calls in every appearance-capable controller", () => {
		{
			const recorder = widgetRecorder();
			const ctx: AuditTrailBoxContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
				setStatus: () => {},
			};
			const controller = new AuditTrailBoxController({
				scheduler: manualScheduler(),
				placement: "aboveEditor",
				probeSource: { inspect: async () => undefined },
			});
			controller.noteWrite("a.ts", {}, ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: CacheMeterContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new CacheMeterController({ scheduler: manualScheduler(), placement: "belowEditor" });
			controller.onMessageEnd(assistantMessageEnd(100), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "belowEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: PalimpsestContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new PalimpsestController({ scheduler: manualScheduler(), placement: "aboveEditor" });
			// A single touch stays below the glow threshold; the second is what mounts.
			controller.onToolResult(editResult("a.ts"), ctx);
			controller.onToolResult(editResult("a.ts"), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: TidepoolContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new RateLimitTidepoolController({ scheduler: manualScheduler(), placement: "aboveEditor" });
			controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders), ctx);
			controller.onMessageStart(assistantMessageStart("anthropic"), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: BreathingBorderContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new BreathingBorderController({ scheduler: manualScheduler(), placement: "belowEditor" });
			controller.onAgentStart({ type: "agent_start" }, ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "belowEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: CadenceEqualizerContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new CadenceEqualizerController({ scheduler: manualScheduler(), placement: "aboveEditor" });
			controller.onMessageStart(assistantMessageStart("anthropic"), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: ReflectionRippleContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new ReflectionRippleController({ scheduler: manualScheduler(), placement: "belowEditor" });
			controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("no-console-log")] }, ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "belowEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: ToolConstellationContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new ToolConstellationController({ scheduler: manualScheduler(), placement: "aboveEditor" });
			controller.onToolCall(toolCallEvent("bash"), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}
	});

	it("uses the override for every off-tier repaint, not just the first", () => {
		const recorder = widgetRecorder();
		const ctx: AuditTrailBoxContext = {
			...fullEnv,
			motionSetting: "off",
			theme: idTheme,
			setWidget: recorder.setWidget,
			setStatus: () => {},
		};
		const controller = new AuditTrailBoxController({
			placement: "aboveEditor",
			probeSource: { inspect: async () => undefined },
		});
		controller.noteRead("a.ts", {}, ctx);
		controller.noteWrite("a.ts", {}, ctx);
		expect(Array.isArray(recorder.calls[0]?.content)).toBe(true);
		expect(recorder.calls.every(call => call.options?.placement === "aboveEditor")).toBe(true);
		controller.dispose(ctx);
		expectPlacement(recorder.calls, "aboveEditor");
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

	it("recolors only Palimpsest's ember tier, leaving underline/amber on their fixed tokens", () => {
		const colors = { ...PALIMPSEST_COLORS, ember: "accent" as const };
		const snapshot = { rows: [{ path: "a.ts", start: 1, end: 1, overlapCount: 4, lastTouchedTurn: 0 }] };
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "full", colors)).toEqual(["accent:B(a.ts:1)"]);
		expect(renderPalimpsestRows(snapshot, 0, taggedTheme, "full")).toEqual(["error:B(a.ts:1)"]);
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

	it("recolors only Breathing Border's peak brightness, leaving the muted/base tokens fixed", () => {
		const defaultRow = renderBreathingBorderRow(0.9, 10, taggedTheme, "full");
		expect(defaultRow).toContain("borderAccent:");
		const overriddenRow = renderBreathingBorderRow(0.9, 10, taggedTheme, "full", undefined, {
			...BREATHING_BORDER_COLORS,
			peak: "success",
		});
		expect(overriddenRow).toContain("success:");
		expect(overriddenRow).not.toContain("borderAccent:");
	});

	it("recolors only Cadence Equalizer's burst bucket, leaving the cooler buckets fixed", () => {
		const defaultRow = renderEqualizerRow([1], [1], taggedTheme);
		expect(defaultRow).toContain("warning:");
		const overriddenRow = renderEqualizerRow([1], [1], taggedTheme, { ...BUCKET_THEME_COLOR, burst: "success" });
		expect(overriddenRow).toContain("success:");
		expect(overriddenRow).not.toContain("warning:");
	});

	it("recolors only Reflection Ripple's ring, leaving the calm water on its fixed dim token", () => {
		const defaultRow = renderReflectionRippleRow(0, 11, taggedTheme, "full");
		expect(defaultRow).toContain("accent:");
		const overriddenRow = renderReflectionRippleRow(0, 11, taggedTheme, "full", {
			...REFLECTION_RIPPLE_COLORS,
			ring: "success",
		});
		expect(overriddenRow).toContain("success:");
		expect(overriddenRow).not.toContain("accent:");
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

		const palimpsestSnapshot = { rows: [{ path: "a.ts", start: 1, end: 1, overlapCount: 4, lastTouchedTurn: 0 }] };
		expect(renderPalimpsestRows(palimpsestSnapshot, 0, taggedTheme, "full")).toEqual(
			renderPalimpsestRows(palimpsestSnapshot, 0, taggedTheme, "full", PALIMPSEST_COLORS),
		);

		expect(renderTidepoolRow(0.5, "anthropic", 0, 69, taggedTheme, "full")).toBe(
			renderTidepoolRow(0.5, "anthropic", 0, 69, taggedTheme, "full", TIDEPOOL_COLORS),
		);

		expect(renderBreathingBorderRow(0.9, 10, taggedTheme, "full")).toBe(
			renderBreathingBorderRow(0.9, 10, taggedTheme, "full", undefined, BREATHING_BORDER_COLORS),
		);

		expect(renderEqualizerRow([1], [1], taggedTheme)).toBe(
			renderEqualizerRow([1], [1], taggedTheme, BUCKET_THEME_COLOR),
		);

		expect(renderReflectionRippleRow(0, 11, taggedTheme, "full")).toBe(
			renderReflectionRippleRow(0, 11, taggedTheme, "full", REFLECTION_RIPPLE_COLORS),
		);
	});
});

describe("widget accent threading", () => {
	it("maps each widget accent option into its primary color slot", () => {
		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new AuditLedgerState();
			state.noteRead("a.ts", {});
			const widget = new AuditTrailBoxWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "success",
			});
			expect(widget.renderFrame(40)[0]).toContain("success:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new CacheMeterState();
			state.recordUsage(
				{
					provider: "anthropic",
					model: "claude",
					usage: { input: 0, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 100 },
				},
				0,
			);
			const widget = new CacheMeterWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "warning",
			});
			expect(widget.renderFrame(40)[0]).toContain("warning:");
			widget.dispose();
			host.dispose();
		}

		{
			const { policy, host } = makeWidgetHarness();
			const state = new PalimpsestState();
			state.applyDegradedTouch("a.ts");
			state.applyDegradedTouch("a.ts");
			state.applyDegradedTouch("a.ts");
			state.applyDegradedTouch("a.ts"); // overlapCount 4 -> ember
			const widget = new PalimpsestWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				accentColor: "accent",
			});
			expect(widget.renderFrame(40)[0]).toContain("accent:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new RateLimitTidepoolState();
			state.applySample({
				provider: "anthropic",
				family: "anthropic",
				level: 0.5,
				resetAtMs: undefined,
				observedAtMs: 0,
			});
			const widget = new TidepoolWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "syntaxString",
			});
			expect(widget.renderFrame(69)[0]).toContain("syntaxString:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new BreathingBorderState();
			state.applyAgentStart(0);
			scheduler.advance(BASE_BREATH_PERIOD_MS / 2); // mid-cycle: the breath envelope peaks here
			const widget = new BreathingBorderWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				onSettled: () => {},
				accentColor: "success",
			});
			expect(widget.renderFrame(40)[0]).toContain("success:");
			widget.dispose();
			host.dispose();
		}

		{
			const { policy, host } = makeWidgetHarness();
			const state = new CadenceEqualizerState();
			for (let i = 0; i < 5; i++) state.pushSample(1); // saturates the fast band into the burst bucket
			const widget = new CadenceEqualizerWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				wallClock: { now: () => 0 },
				sampleRate: () => null,
				accentColor: "success",
			});
			expect(widget.renderFrame(80)[0]).toContain("success:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new ReflectionRippleState();
			state.applyTrigger(["r"], 0);
			const widget = new ReflectionRippleWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				onSettled: () => {},
				accentColor: "success",
			});
			expect(widget.renderFrame(11)[0]).toContain("success:");
			widget.dispose();
			host.dispose();
		}
	});
});

describe("registrar end-to-end placement", () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

	function makeRecordingApi(): { api: ExtensionAPI; handlers: Map<string, Handler> } {
		const handlers = new Map<string, Handler>();
		const api = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
			setLabel() {},
			registerCommand() {},
			logger: { error() {}, warn() {}, debug() {}, info() {} },
		} as unknown as ExtensionAPI;
		return { api, handlers };
	}

	const allIds = ANIMATIONS.map(animation => animation.id);
	function only(...on: string[]): Record<string, boolean> {
		const enabled = new Set(on);
		return Object.fromEntries(allIds.map(id => [id, enabled.has(id)]));
	}

	it("passes a stored placement override through registrar, factory, and controller", async () => {
		const { api, handlers } = makeRecordingApi();
		createAnimationsPlugin({
			// `display: "rows"` — Animations Box mode (the default) would suppress Audit
			// Trail Box's own row and mount it headless instead (Plan 017 Decision 6),
			// which is exactly what this test's row-widget assertion below must not hit.
			settings: { display: "rows", ...only("auditTrailBox"), auditTrailBoxPlacement: "aboveEditor" },
			env: {},
			readPluginSettings: async () => ({}),
		})(api);

		const calls: Array<{ key: string; options?: { placement?: string } }> = [];
		const fakeCtx = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				theme: { ...idTheme, getSymbolPreset: () => "unicode" as const },
				setWidget: (key: string, _content: unknown, options?: { placement?: string }) =>
					calls.push({ key, options }),
				setStatus: () => {},
			},
		} as unknown as ExtensionContext;

		await handlers.get("tool_result")?.(
			{
				type: "tool_result",
				toolName: "write",
				toolCallId: "call-1",
				input: { path: "/tmp/appearance-test-audit-trail-box.ts", content: "x" },
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			fakeCtx,
		);
		expect(calls[0]?.key).toBe("audit-trail-box");
		expect(calls[0]?.options?.placement).toBe("aboveEditor");
	});
});
