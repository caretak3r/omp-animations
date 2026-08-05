// Gallery integration test: mounts the 6 shipped ambient-animation controllers together
// in one shared session (one shared `setWidget` spy), unlike the per-feature test files
// which each mount only their own controller in isolation. The dropped animations
// (Plan 007's 6 status-line duplicators plus tool-constellation, todo-meteors,
// breathing-border, reflection-ripple) keep their source and per-feature test on disk,
// just unregistered — so they are not exercised here.
import { describe, expect, test } from "bun:test";
import type {
	AutoCompactionEndEvent,
	EditToolResultEvent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	InputEvent,
	SessionTreeEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { GoalUpdatedEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type AgentFleetContext,
	AgentFleetController,
	type AgentFleetRegistrySource,
} from "../src/agent-fleet/controller";
import type { AgentFleetRefSource, AgentFleetRegistryEventSource } from "../src/agent-fleet/state";
import { type DiffBloomContext, DiffBloomController } from "../src/diff-bloom/controller";
import { type GoalHorizonContext, GoalHorizonController } from "../src/goal-horizon/controller";
import type { MotionSetting } from "../src/kit";
import { type MemoryCrystalsContext, MemoryCrystalsController } from "../src/memory-crystals/controller";
import { type PromptChargeContext, PromptChargeController } from "../src/prompt-charge/controller";
import {
	type BonsaiSessionSource,
	type BonsaiTreeSourceNode,
	type SessionBonsaiContext,
	SessionBonsaiController,
} from "../src/session-bonsai/controller";

// Identity theme so assertions see plain text instead of ANSI escapes. All 6
// feature theme aliases are structurally `Pick<Theme, "fg">`, so one shared
// object satisfies every controller's `theme` field.
const idTheme: Pick<Theme, "fg"> = { fg: (_color, text) => text };

/**
 * Every WIDGET_KEY -> documented placement for the 6 shipped animations
 * (3 aboveEditor, 3 belowEditor). Key order mirrors the registrar's `ANIMATIONS`
 * mount order, which the dispose-cascade test asserts against.
 */
const EXPECTED_PLACEMENT: Record<string, "aboveEditor" | "belowEditor"> = {
	"session-bonsai": "belowEditor",
	"agent-fleet": "belowEditor",
	"memory-crystals": "belowEditor",
	"diff-bloom": "aboveEditor",
	"goal-horizon": "aboveEditor",
	"prompt-charge": "aboveEditor",
};

/** sdk.ts's `createAgentSession` inline-extension registration order (see `sdk.ts` around line 1844-1858). */
const REGISTRATION_ORDER = Object.keys(EXPECTED_PLACEMENT).sort(
	(a, b) => Object.keys(EXPECTED_PLACEMENT).indexOf(a) - Object.keys(EXPECTED_PLACEMENT).indexOf(b),
);

interface CapturedWidgetCall {
	feature: string;
	key: string;
	options: ExtensionWidgetOptions | undefined;
	content: ExtensionWidgetContent;
}

/** root -A- B(branch) -> C(leaf), -> D -E- (leaf), in the real `{ entry: { id }, children }` shape. */
function branchingSourceTree(): BonsaiTreeSourceNode[] {
	return [
		{
			entry: { id: "A" },
			children: [
				{
					entry: { id: "B" },
					children: [
						{ entry: { id: "C" }, children: [] },
						{ entry: { id: "D" }, children: [{ entry: { id: "E" }, children: [] }] },
					],
				},
			],
		},
	];
}

function fixedSessionSource(roots: BonsaiTreeSourceNode[], leafId: string | null): BonsaiSessionSource {
	return { getTree: () => roots, getLeafId: () => leafId };
}

function fakeRegistry(): AgentFleetRegistrySource & { emit(evt: AgentFleetRegistryEventSource): void } {
	const listeners = new Set<(evt: AgentFleetRegistryEventSource) => void>();
	return {
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(evt) {
			for (const listener of [...listeners]) listener(evt);
		},
	};
}

function ref(id: string, overrides: Partial<AgentFleetRefSource> = {}): AgentFleetRefSource {
	return { id, displayName: id, kind: "sub", status: "running", ...overrides };
}

function successfulCompactionEnd(tokensBefore: number): AutoCompactionEndEvent {
	return {
		type: "auto_compaction_end",
		action: "context-full",
		aborted: false,
		willRetry: false,
		result: { summary: "compacted the session", tokensBefore, firstKeptEntryId: "entry-1" },
	} as AutoCompactionEndEvent;
}

const sampleDiff = ["+1|line one", "+2|line two", "-1|old line"].join("\n");

function editResult(diff: string, path = "src/foo.ts"): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path },
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: { diff, path },
	};
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "ship the thing",
		status: "active",
		tokenBudget: 1000,
		tokensUsed: 400,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function inputEvent(text: string): InputEvent {
	return { type: "input", text, source: "interactive" };
}

interface MountedGallery {
	calls: CapturedWidgetCall[];
	disposers: Array<{ feature: string; dispose: () => void }>;
}

/**
 * Constructs the 6 shipped controllers, each wired to its own feature-shaped fake
 * context, but all sharing ONE `setWidget` spy — then drives each through its
 * representative "active" event (mirroring the driving call each feature's own test
 * file already uses). `motionSetting: "off"` forces every controller's `MotionPolicy`
 * to the `off` tier (see `resolveMotionTier`), so every `setWidget` call carries a plain
 * `string[]` instead of an animated-widget factory — no fake `TUI` needed.
 */
function mountGallery(): MountedGallery {
	const calls: CapturedWidgetCall[] = [];
	const disposers: Array<{ feature: string; dispose: () => void }> = [];
	const base = {
		hasUI: true,
		isTTY: true,
		env: {} as Record<string, string | undefined>,
		motionSetting: "off" as MotionSetting,
		theme: idTheme,
	};
	function widget(feature: string) {
		return (key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions) => {
			calls.push({ feature, key, options, content });
		};
	}

	{
		const ctx: SessionBonsaiContext = {
			...base,
			sessionManager: fixedSessionSource(branchingSourceTree(), "C"),
			setWidget: widget("session-bonsai"),
		};
		const controller = new SessionBonsaiController();
		controller.onSessionTree({ type: "session_tree", newLeafId: "C", oldLeafId: null } as SessionTreeEvent, ctx);
		disposers.push({ feature: "session-bonsai", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: AgentFleetContext = { ...base, setWidget: widget("agent-fleet") };
		const registry = fakeRegistry();
		const controller = new AgentFleetController({ registry });
		controller.watch(ctx);
		registry.emit({ type: "registered", ref: ref("sub-1") });
		disposers.push({ feature: "agent-fleet", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: MemoryCrystalsContext = { ...base, setWidget: widget("memory-crystals") };
		const controller = new MemoryCrystalsController();
		controller.onAutoCompactionEnd(successfulCompactionEnd(20_000), ctx);
		disposers.push({ feature: "memory-crystals", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: DiffBloomContext = { ...base, setWidget: widget("diff-bloom") };
		const controller = new DiffBloomController();
		controller.onToolResult(editResult(sampleDiff), ctx);
		disposers.push({ feature: "diff-bloom", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: GoalHorizonContext = { ...base, setWidget: widget("goal-horizon") };
		const controller = new GoalHorizonController();
		controller.onGoalUpdated({ type: "goal_updated", goal: makeGoal() } as GoalUpdatedEvent, ctx);
		disposers.push({ feature: "goal-horizon", dispose: () => controller.dispose(ctx) });
	}

	{
		const ctx: PromptChargeContext = { ...base, getEditorText: () => "", setWidget: widget("prompt-charge") };
		const controller = new PromptChargeController();
		controller.mount(ctx);
		controller.onInput(inputEvent("x".repeat(80)), ctx);
		disposers.push({ feature: "prompt-charge", dispose: () => controller.dispose(ctx) });
	}

	return { calls, disposers };
}

/** Collapses repeated `setWidget` calls (mount, then a later repaint) to the last one per feature key. */
function lastCallPerKey(calls: readonly CapturedWidgetCall[]): CapturedWidgetCall[] {
	const byKey = new Map<string, CapturedWidgetCall>();
	for (const call of calls) byKey.set(call.key, call);
	return [...byKey.values()];
}

/** Formats the 6 captured widgets into a labeled, human-readable "gallery" of the shipped suite. */
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
	test("mounting all 6 shipped controllers together produces one non-idle setWidget call each, matching the documented 3/3 placement split", () => {
		const { calls } = mountGallery();
		const withContent = lastCallPerKey(calls).filter(call => call.content !== undefined);

		expect(withContent).toHaveLength(6);
		expect(new Set(withContent.map(call => call.key))).toEqual(new Set(Object.keys(EXPECTED_PLACEMENT)));

		const aboveCount = withContent.filter(call => call.options?.placement === "aboveEditor").length;
		const belowCount = withContent.filter(call => call.options?.placement === "belowEditor").length;
		expect(aboveCount).toBe(3);
		expect(belowCount).toBe(3);

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

	test("renderGallery composes a labeled above/below gallery snapshot of all 6 widgets", () => {
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
		expect(countBlocks(aboveSection)).toBe(3);
		expect(countBlocks(belowSection)).toBe(3);
	});

	test("disposing all 6 controllers in the registrar's mount order never throws (full session_shutdown cascade)", () => {
		const { disposers } = mountGallery();
		expect(disposers.map(d => d.feature)).toEqual(REGISTRATION_ORDER);
		for (const { dispose } of disposers) {
			expect(() => dispose()).not.toThrow();
		}
	});
});
