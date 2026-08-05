// Gallery integration test: mounts this package's ambient-animation controllers together
// in one shared session (one shared `setWidget` spy), unlike the per-feature test files
// which each mount only their own controller in isolation. `motionSetting: "off"` forces
// every controller's `MotionPolicy` to the `off` tier, so every `setWidget` call carries a
// plain `string[]` instead of an animated-widget factory — no fake `TUI` needed.
import { describe, expect, test } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type {
	AfterProviderResponseEvent,
	EditToolResultEvent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	MessageEndEvent,
	MessageStartEvent,
	ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AuditTrailBoxContext, AuditTrailBoxController } from "../src/audit-trail-box/controller";
import { type BreathingBorderContext, BreathingBorderController } from "../src/breathing-border/controller";
import { type CacheMeterContext, CacheMeterController } from "../src/cache-meter/controller";
import { type CadenceEqualizerContext, CadenceEqualizerController } from "../src/cadence-equalizer/controller";
import { type PalimpsestContext, PalimpsestController } from "../src/palimpsest/controller";
import { RateLimitTidepoolController, type TidepoolContext } from "../src/rate-limit-tidepool/controller";
import { type ReflectionRippleContext, ReflectionRippleController } from "../src/reflection-ripple/controller";
import { type ToolConstellationContext, ToolConstellationController } from "../src/tool-constellation/controller";

// Identity theme so assertions see plain text instead of ANSI escapes. Palimpsest's theme
// additionally needs `underline`/`bold`; every other feature's theme type is a subset of
// this, so one shared object satisfies every controller's `theme` field.
const idTheme: Pick<Theme, "fg" | "underline" | "bold"> = {
	fg: (_color, text) => text,
	underline: text => text,
	bold: text => text,
};

/**
 * Every WIDGET_KEY -> documented placement, in the registrar's `ANIMATIONS` mount order
 * (`src/registrar.ts`) — the dispose-cascade test asserts against this same order.
 */
const EXPECTED_PLACEMENT: Record<string, "aboveEditor" | "belowEditor"> = {
	"audit-trail-box": "belowEditor",
	"breathing-border": "aboveEditor",
	"cache-meter": "aboveEditor",
	"cadence-equalizer": "belowEditor",
	palimpsest: "belowEditor",
	"rate-limit-tidepool": "belowEditor",
	"reflection-ripple": "aboveEditor",
	"tool-constellation": "belowEditor",
};

const REGISTRATION_ORDER = Object.keys(EXPECTED_PLACEMENT);
const ABOVE_COUNT = Object.values(EXPECTED_PLACEMENT).filter(p => p === "aboveEditor").length;
const BELOW_COUNT = Object.values(EXPECTED_PLACEMENT).filter(p => p === "belowEditor").length;

interface CapturedWidgetCall {
	feature: string;
	key: string;
	options: ExtensionWidgetOptions | undefined;
	content: ExtensionWidgetContent;
}

function rule(name: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: "",
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

function toolCallEvent(toolName: string, toolCallId = "1"): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input: {} } as ToolCallEvent;
}

function assistantMessage(output: number): MessageStartEvent["message"] {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: { output, input: 0, cacheRead: 0, cacheWrite: 0, totalTokens: output },
		stopReason: "stop",
		timestamp: 0,
	} as unknown as MessageStartEvent["message"];
}

function assistantMessageEnd(provider: string, model: string, cacheRead: number): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider,
			model,
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

interface MountedGallery {
	calls: CapturedWidgetCall[];
	disposers: Array<{ feature: string; dispose: () => void }>;
}

/**
 * Constructs one controller per shipped animation, each wired to its own feature-shaped
 * fake context, but all sharing ONE `setWidget` spy — then drives each through its
 * representative "active" event (mirroring the driving call each feature's own test file
 * already uses).
 */
function mountGallery(): MountedGallery {
	const calls: CapturedWidgetCall[] = [];
	const disposers: Array<{ feature: string; dispose: () => void }> = [];
	const base = {
		hasUI: true,
		isTTY: true,
		env: {} as Record<string, string | undefined>,
		motionSetting: "off" as const,
		theme: idTheme,
	};
	function widget(feature: string) {
		return (key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions) => {
			calls.push({ feature, key, options, content });
		};
	}

	{
		const ctx: AuditTrailBoxContext = {
			...base,
			setWidget: widget("audit-trail-box"),
			setStatus: () => {},
		};
		const controller = new AuditTrailBoxController();
		controller.noteRead("a.ts", {}, ctx);
		disposers.push({ feature: "audit-trail-box", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: BreathingBorderContext = { ...base, setWidget: widget("breathing-border") };
		const controller = new BreathingBorderController();
		controller.onAgentStart({ type: "agent_start" }, ctx);
		disposers.push({ feature: "breathing-border", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: CacheMeterContext = { ...base, setWidget: widget("cache-meter") };
		const controller = new CacheMeterController();
		controller.onMessageEnd(assistantMessageEnd("anthropic", "claude", 100), ctx);
		disposers.push({ feature: "cache-meter", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: CadenceEqualizerContext = { ...base, setWidget: widget("cadence-equalizer") };
		const controller = new CadenceEqualizerController();
		controller.onMessageStart({ type: "message_start", message: assistantMessage(0) }, ctx);
		disposers.push({ feature: "cadence-equalizer", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: PalimpsestContext = { ...base, setWidget: widget("palimpsest") };
		const controller = new PalimpsestController();
		// A single touch stays below the glow threshold — two touches to the same span
		// are what actually mount the widget (`GLOW_THRESHOLD`, see palimpsest/spans.ts).
		controller.onToolResult(editResult("a.ts"), ctx);
		controller.onToolResult(editResult("a.ts"), ctx);
		disposers.push({ feature: "palimpsest", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: TidepoolContext = { ...base, setWidget: widget("rate-limit-tidepool") };
		const controller = new RateLimitTidepoolController();
		controller.onAfterProviderResponse(afterProviderResponse(anthropicHeaders), ctx);
		controller.onMessageStart(assistantMessageStart("anthropic"), ctx);
		disposers.push({ feature: "rate-limit-tidepool", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: ReflectionRippleContext = { ...base, setWidget: widget("reflection-ripple") };
		const controller = new ReflectionRippleController();
		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("no-console-log")] }, ctx);
		disposers.push({ feature: "reflection-ripple", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: ToolConstellationContext = { ...base, setWidget: widget("tool-constellation") };
		const controller = new ToolConstellationController();
		controller.onToolCall(toolCallEvent("bash"), ctx);
		disposers.push({ feature: "tool-constellation", dispose: () => controller.dispose(ctx) });
	}

	return { calls, disposers };
}

/** Collapses repeated `setWidget` calls (mount, then a later repaint) to the last one per feature key. */
function lastCallPerKey(calls: readonly CapturedWidgetCall[]): CapturedWidgetCall[] {
	const byKey = new Map<string, CapturedWidgetCall>();
	for (const call of calls) byKey.set(call.key, call);
	return [...byKey.values()];
}

/** Formats the captured widgets into a labeled, human-readable "gallery" of the shipped suite. */
function renderGallery(calls: readonly CapturedWidgetCall[]): string {
	const section = (label: string, placement: "aboveEditor" | "belowEditor"): string[] => {
		const lines = [`${label}:`];
		for (const call of calls) {
			if (call.options?.placement !== placement) continue;
			lines.push(`  ${call.key}`);
			if (Array.isArray(call.content)) {
				for (const row of call.content) lines.push(`    ${row}`);
			}
		}
		return lines;
	};
	return [...section("Above editor", "aboveEditor"), ...section("Below editor", "belowEditor")].join("\n");
}

describe("wave2 gallery integration", () => {
	test("mounting every shipped controller together produces one non-idle setWidget call each, matching the documented aboveEditor/belowEditor split", () => {
		const { calls } = mountGallery();
		const withContent = lastCallPerKey(calls).filter(call => call.content !== undefined);

		expect(withContent).toHaveLength(Object.keys(EXPECTED_PLACEMENT).length);
		expect(new Set(withContent.map(call => call.key))).toEqual(new Set(Object.keys(EXPECTED_PLACEMENT)));

		const aboveCount = withContent.filter(call => call.options?.placement === "aboveEditor").length;
		const belowCount = withContent.filter(call => call.options?.placement === "belowEditor").length;
		expect(aboveCount).toBe(ABOVE_COUNT);
		expect(belowCount).toBe(BELOW_COUNT);

		for (const call of withContent) {
			expect(call.options?.placement).toBe(EXPECTED_PLACEMENT[call.key]);
			expect(Array.isArray(call.content)).toBe(true);
			const lines = call.content as string[];
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(line).not.toContain("undefined");
				expect(line).not.toContain("NaN");
			}
		}
	});

	test("renderGallery composes a labeled above/below gallery snapshot of every widget", () => {
		const { calls } = mountGallery();
		const withContent = lastCallPerKey(calls).filter(call => call.content !== undefined);
		const gallery = renderGallery(withContent);

		expect(gallery.startsWith("Above editor")).toBe(true);
		expect(gallery).toContain("Below editor");
		for (const key of Object.keys(EXPECTED_PLACEMENT)) {
			expect(gallery).toContain(key);
		}

		const [aboveSection, belowSection] = gallery.split("Below editor");
		const countBlocks = (section: string) => (section.match(/^ {2}\S/gm) ?? []).length;
		expect(countBlocks(aboveSection)).toBe(ABOVE_COUNT);
		expect(countBlocks(belowSection)).toBe(BELOW_COUNT);
	});

	test("disposing every controller in the registrar's mount order never throws (full session_shutdown cascade)", () => {
		const { disposers } = mountGallery();
		expect(disposers.map(d => d.feature)).toEqual(REGISTRATION_ORDER);
		for (const { dispose } of disposers) {
			expect(() => dispose()).not.toThrow();
		}
	});
});
