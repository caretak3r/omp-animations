import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type {
	ExtensionContext,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AutoCompactionEndEvent,
	EditToolResultEvent,
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
import { AgentFleetState } from "../src/agent-fleet/state";
import { AGENT_FLEET_COLORS, AgentFleetWidget, renderAgentFleetRow } from "../src/agent-fleet/widget";
import {
	ACCENT_SETTING_VALUES,
	accentColorKey,
	animationsEnvKey,
	PLACEMENT_VALUES,
	placementKey,
	resolveAnimationAppearance,
} from "../src/appearance";
import { type DiffBloomContext, DiffBloomController } from "../src/diff-bloom/controller";
import { DiffBloomState } from "../src/diff-bloom/state";
import { DIFF_BLOOM_COLORS, DiffBloomWidget, renderDiffBloomRow } from "../src/diff-bloom/widget";
import { type GoalHorizonContext, GoalHorizonController } from "../src/goal-horizon/controller";
import { GoalHorizonState } from "../src/goal-horizon/state";
import {
	GOAL_HORIZON_FLARE_COLOR,
	GoalHorizonWidget,
	renderGoalHorizonRow,
	renderHorizonBar,
} from "../src/goal-horizon/widget";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";
import { type MemoryCrystalsContext, MemoryCrystalsController } from "../src/memory-crystals/controller";
import { SPARKLE_DURATION_MS } from "../src/memory-crystals/crystal";
import { MemoryCrystalsState } from "../src/memory-crystals/state";
import { MEMORY_CRYSTALS_COLORS, MemoryCrystalsWidget, renderMemoryCrystalsRow } from "../src/memory-crystals/widget";
import { CHARGE_BUCKET_COLOR } from "../src/prompt-charge/charge";
import { type PromptChargeContext, PromptChargeController } from "../src/prompt-charge/controller";
import { PromptChargeState } from "../src/prompt-charge/state";
import { PromptChargeWidget, renderPromptChargeRow } from "../src/prompt-charge/widget";
import { ANIMATIONS, createAnimationsPlugin, resolveAnimationsConfig } from "../src/registrar";
import {
	type BonsaiSessionSource,
	type BonsaiTreeSourceNode,
	type SessionBonsaiContext,
	SessionBonsaiController,
} from "../src/session-bonsai/controller";
import { BonsaiState } from "../src/session-bonsai/state";
import type { RawTreeNode } from "../src/session-bonsai/tree";
import { BONSAI_COLORS, renderBonsaiTree, SessionBonsaiWidget } from "../src/session-bonsai/widget";

const idTheme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
const taggedTheme: Pick<Theme, "fg"> = { fg: (color, text) => `${color}:${text}` };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };
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

function editResult(diff: string, pathName = "src/foo.ts"): EditToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path: pathName },
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: { diff, path: pathName },
	};
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

function inputEvent(text: string): InputEvent {
	return { type: "input", text, source: "interactive" };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "ship the thing",
		status: "active",
		tokenBudget: 1000,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function goalUpdated(goal: Goal | null): GoalUpdatedEvent {
	return { type: "goal_updated", goal };
}

function ref(id: string, overrides: Partial<AgentFleetRefSource> = {}): AgentFleetRefSource {
	return { id, displayName: id, kind: "sub", status: "running", ...overrides };
}

function registryEvent(
	type: AgentFleetRegistryEventSource["type"],
	id: string,
	overrides: Partial<AgentFleetRefSource> = {},
): AgentFleetRegistryEventSource {
	return { type, ref: ref(id, overrides) };
}

function fakeRegistry(): AgentFleetRegistrySource & { emit(event: AgentFleetRegistryEventSource): void } {
	const listeners = new Set<(event: AgentFleetRegistryEventSource) => void>();
	return {
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

function branchingRawTree(): RawTreeNode[] {
	return [
		{
			id: "root",
			children: [
				{ id: "active", children: [] },
				{ id: "dormant", children: [] },
			],
		},
	];
}

function oneNodeSource(): BonsaiTreeSourceNode[] {
	return [{ entry: { id: "leaf" }, children: [] }];
}

function fixedSessionSource(roots: BonsaiTreeSourceNode[], leafId: string | null): BonsaiSessionSource {
	return { getTree: () => roots, getLeafId: () => leafId };
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

function expectPlacement(calls: WidgetCall[], placement: "aboveEditor" | "belowEditor"): void {
	expect(calls[0]?.options?.placement).toBe(placement);
	const clearingCall = calls.at(-1);
	expect(clearingCall?.content).toBeUndefined();
	expect(clearingCall?.options?.placement).toBe(placement);
}

describe("resolveAnimationAppearance", () => {
	it("uses the historical placement and built-in palette by default", () => {
		expect(resolveAnimationAppearance("diffBloom", "aboveEditor", {}, {})).toEqual({
			placement: "aboveEditor",
			accentColor: undefined,
		});
	});

	it("resolves stored placement before env, with null falling through", () => {
		expect(
			resolveAnimationAppearance("diffBloom", "aboveEditor", { diffBloomPlacement: "belowEditor" }, {}).placement,
		).toBe("belowEditor");
		expect(
			resolveAnimationAppearance(
				"diffBloom",
				"aboveEditor",
				{},
				{
					OMP_ANIMATIONS_DIFF_BLOOM_PLACEMENT: "belowEditor",
				},
			).placement,
		).toBe("belowEditor");
		expect(
			resolveAnimationAppearance(
				"diffBloom",
				"aboveEditor",
				{ diffBloomPlacement: "aboveEditor" },
				{ OMP_ANIMATIONS_DIFF_BLOOM_PLACEMENT: "belowEditor" },
			).placement,
		).toBe("aboveEditor");
		expect(
			resolveAnimationAppearance(
				"diffBloom",
				"aboveEditor",
				{ diffBloomPlacement: null },
				{ OMP_ANIMATIONS_DIFF_BLOOM_PLACEMENT: "belowEditor" },
			).placement,
		).toBe("belowEditor");
	});

	it("silently falls back for malformed placement values", () => {
		expect(
			resolveAnimationAppearance("diffBloom", "aboveEditor", { diffBloomPlacement: "sideways" }, {}).placement,
		).toBe("aboveEditor");
		expect(resolveAnimationAppearance("diffBloom", "aboveEditor", { diffBloomPlacement: 42 }, {}).placement).toBe(
			"aboveEditor",
		);
	});

	it("resolves curated accent values while default, absent, and junk preserve the built-in palette", () => {
		expect(
			resolveAnimationAppearance("diffBloom", "aboveEditor", { diffBloomAccentColor: "success" }, {}).accentColor,
		).toBe("success");
		expect(
			resolveAnimationAppearance(
				"diffBloom",
				"aboveEditor",
				{},
				{
					OMP_ANIMATIONS_DIFF_BLOOM_ACCENT_COLOR: "warning",
				},
			).accentColor,
		).toBe("warning");
		for (const value of ["default", undefined, "hotpink"]) {
			expect(
				resolveAnimationAppearance("diffBloom", "aboveEditor", { diffBloomAccentColor: value }, {}).accentColor,
			).toBeUndefined();
		}
	});

	it("derives manifest and env keys from camel-case ids", () => {
		expect(animationsEnvKey("sessionBonsai")).toBe("OMP_ANIMATIONS_SESSION_BONSAI");
		expect(animationsEnvKey("sessionBonsai", "PLACEMENT")).toBe("OMP_ANIMATIONS_SESSION_BONSAI_PLACEMENT");
		expect(placementKey("goalHorizon")).toBe("goalHorizonPlacement");
		expect(accentColorKey("goalHorizon")).toBe("goalHorizonAccentColor");
	});
});

describe("resolveAnimationsConfig appearance", () => {
	it("resolves the exact 8-below/5-above split (the historical 3-below/3-above plus Audit Trail Box, Palimpsest, Session Strata, Rate-Limit Tidepool and Four Hands, all belowEditor, plus Cache Meter and Drift Buoy, aboveEditor)", () => {
		const config = resolveAnimationsConfig({}, {});
		for (const entry of ANIMATIONS) {
			expect(config.appearance[entry.id]).toEqual({
				placement: entry.defaultPlacement,
				accentColor: undefined,
			});
		}
		expect(ANIMATIONS.filter(entry => entry.defaultPlacement === "belowEditor").map(entry => entry.id)).toEqual([
			"sessionBonsai",
			"agentFleet",
			"memoryCrystals",
			"auditTrailBox",
			"palimpsest",
			"sessionStrata",
			"rateLimitTidepool",
			"fourHands",
		]);
		expect(ANIMATIONS.filter(entry => entry.defaultPlacement === "aboveEditor").map(entry => entry.id)).toEqual([
			"diffBloom",
			"goalHorizon",
			"promptCharge",
			"cacheMeter",
			"driftBuoy",
		]);
	});

	it("keeps stored overrides isolated to their animation", () => {
		const config = resolveAnimationsConfig(
			{ promptChargePlacement: "belowEditor", memoryCrystalsAccentColor: "warning" },
			{},
		);
		for (const entry of ANIMATIONS) {
			expect(config.appearance[entry.id]).toEqual({
				placement: entry.id === "promptCharge" ? "belowEditor" : entry.defaultPlacement,
				accentColor: entry.id === "memoryCrystals" ? "warning" : undefined,
			});
		}
	});

	it("threads an env-only override into the registrar config", () => {
		const config = resolveAnimationsConfig({}, { OMP_ANIMATIONS_GOAL_HORIZON_ACCENT_COLOR: "accent" });
		expect(config.appearance.goalHorizon.accentColor).toBe("accent");
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

describe("controller placement threading", () => {
	it("uses the override for mount and clear calls in every controller", () => {
		{
			const recorder = widgetRecorder();
			const ctx: DiffBloomContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new DiffBloomController({ scheduler: manualScheduler(), placement: "belowEditor" });
			controller.onToolResult(editResult("+1|added line"), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "belowEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: SessionBonsaiContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				sessionManager: fixedSessionSource(oneNodeSource(), "leaf"),
				setWidget: recorder.setWidget,
			};
			const controller = new SessionBonsaiController({
				scheduler: manualScheduler(),
				placement: "aboveEditor",
			});
			controller.onSessionTree({ type: "session_tree" } as SessionTreeEvent, ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: GoalHorizonContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new GoalHorizonController({ scheduler: manualScheduler(), placement: "belowEditor" });
			controller.onGoalUpdated(goalUpdated(makeGoal()), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "belowEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: MemoryCrystalsContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new MemoryCrystalsController({
				scheduler: manualScheduler(),
				placement: "aboveEditor",
			});
			controller.onAutoCompactionEnd(successfulCompactionEnd(50_000), ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}

		{
			const recorder = widgetRecorder();
			const ctx: PromptChargeContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				getEditorText: () => "",
				setWidget: recorder.setWidget,
			};
			const controller = new PromptChargeController({ scheduler: manualScheduler(), placement: "belowEditor" });
			controller.mount(ctx);
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "belowEditor");
		}

		{
			const recorder = widgetRecorder();
			const registry = fakeRegistry();
			const ctx: AgentFleetContext = {
				...fullEnv,
				motionSetting: "full",
				theme: idTheme,
				setWidget: recorder.setWidget,
			};
			const controller = new AgentFleetController({
				registry,
				scheduler: manualScheduler(),
				placement: "aboveEditor",
			});
			controller.watch(ctx);
			registry.emit(registryEvent("registered", "sub-1"));
			controller.dispose(ctx);
			expectPlacement(recorder.calls, "aboveEditor");
		}
	});

	it("uses the override for an off-tier static mount too", () => {
		const recorder = widgetRecorder();
		const ctx: PromptChargeContext = {
			...fullEnv,
			motionSetting: "off",
			theme: idTheme,
			getEditorText: () => "",
			setWidget: recorder.setWidget,
		};
		const controller = new PromptChargeController({ scheduler: manualScheduler(), placement: "belowEditor" });
		controller.mount(ctx);
		controller.onInput(inputEvent("charged prompt"), ctx);
		expect(Array.isArray(recorder.calls[0]?.content)).toBe(true);
		expect(recorder.calls.every(call => call.options?.placement === "belowEditor")).toBe(true);
		controller.dispose(ctx);
		expectPlacement(recorder.calls, "belowEditor");
	});
});

describe("renderer accent override", () => {
	it("recolors only Diff Bloom's added slot", () => {
		const colors = { ...DIFF_BLOOM_COLORS, added: "success" as const };
		const addedDominant = renderDiffBloomRow(400, 10, taggedTheme, 5, 1, "full", colors);
		expect(addedDominant).toContain("success:");
		expect(addedDominant).not.toContain("toolDiffAdded:");
		const removedDominant = renderDiffBloomRow(400, 10, taggedTheme, 1, 5, "full", colors);
		expect(removedDominant).toContain("toolDiffRemoved:");
	});

	it("recolors only Session Bonsai's active path", () => {
		const state = new BonsaiState();
		state.update(branchingRawTree(), "active", 0);
		const rows = renderBonsaiTree(state.snapshot(), 1000, taggedTheme, "subtle", {
			...BONSAI_COLORS,
			active: "warning",
		});
		expect(rows.some(row => row.includes("warning:"))).toBe(true);
		expect(rows.some(row => row.includes("dim:"))).toBe(true);
	});

	it("recolors only Goal Horizon's milestone flare", () => {
		const state = new GoalHorizonState();
		state.applyGoal(makeGoal({ tokensUsed: 0 }), 0);
		state.applyGoal(makeGoal({ tokensUsed: 300 }), 0);
		const snapshot = state.snapshot();
		const row = renderHorizonBar(snapshot.fraction as number, 0, snapshot, taggedTheme, "accent");
		expect(row).toContain("accent:");
		expect(row).toContain("syntaxType:");
	});

	it("recolors only Memory Crystals' landing sparkle", () => {
		const state = new MemoryCrystalsState();
		state.applyCompactionEnd(1000, "small", "context-full", 0);
		state.applyCompactionEnd(20_000, "medium", "context-full", 0);
		state.applyCompactionEnd(40_000, "large", "context-full", 0);
		const colors = { ...MEMORY_CRYSTALS_COLORS, sparkle: "warning" as const };
		expect(renderMemoryCrystalsRow(state.snapshot(), 0, taggedTheme, "full", colors)).toContain("warning:");
		const settled = renderMemoryCrystalsRow(state.snapshot(), SPARKLE_DURATION_MS, taggedTheme, "full", colors);
		expect(settled).toContain("dim:");
		expect(settled).toContain("syntaxType:");
		expect(settled).toContain("success:");
	});

	it("recolors only Prompt Charge's full bucket", () => {
		const colors = { ...CHARGE_BUCKET_COLOR, full: "success" as const };
		const full = new PromptChargeState();
		full.sampleEditorLength(1000);
		expect(renderPromptChargeRow(full.snapshot(), 0, taggedTheme, "subtle", colors)).toContain("success:");
		const building = new PromptChargeState();
		building.sampleEditorLength(10);
		expect(renderPromptChargeRow(building.snapshot(), 0, taggedTheme, "subtle", colors)).not.toContain("success:");
	});

	it("recolors only Agent Fleet's working fireflies", () => {
		const state = new AgentFleetState();
		state.applyRegistryEvent(registryEvent("registered", "sub-1"), 0);
		const row = renderAgentFleetRow(state.snapshot(), 0, taggedTheme, "subtle", {
			...AGENT_FLEET_COLORS,
			working: "accent",
		})[0];
		expect(row).toContain("accent:");
		expect(row).not.toContain("statusLineSubagents:");
	});
});

describe("default byte-equality", () => {
	it("matches every explicit built-in palette", () => {
		expect(renderDiffBloomRow(200, 20, taggedTheme, 5, 2, "full")).toBe(
			renderDiffBloomRow(200, 20, taggedTheme, 5, 2, "full", DIFF_BLOOM_COLORS),
		);

		const bonsai = new BonsaiState();
		bonsai.update(branchingRawTree(), "active", 0);
		expect(renderBonsaiTree(bonsai.snapshot(), 1000, taggedTheme, "subtle")).toEqual(
			renderBonsaiTree(bonsai.snapshot(), 1000, taggedTheme, "subtle", BONSAI_COLORS),
		);

		const goal = new GoalHorizonState();
		goal.applyGoal(makeGoal({ tokensUsed: 0 }), 0);
		goal.applyGoal(makeGoal({ tokensUsed: 300 }), 0);
		expect(renderGoalHorizonRow(goal.snapshot(), 0, taggedTheme, "full")).toBe(
			renderGoalHorizonRow(goal.snapshot(), 0, taggedTheme, "full", GOAL_HORIZON_FLARE_COLOR),
		);

		const crystals = new MemoryCrystalsState();
		crystals.applyCompactionEnd(10_000, "medium", "context-full", 0);
		expect(renderMemoryCrystalsRow(crystals.snapshot(), 0, taggedTheme, "full")).toBe(
			renderMemoryCrystalsRow(crystals.snapshot(), 0, taggedTheme, "full", MEMORY_CRYSTALS_COLORS),
		);

		const charge = new PromptChargeState();
		charge.sampleEditorLength(1000);
		expect(renderPromptChargeRow(charge.snapshot(), 0, taggedTheme, "subtle")).toBe(
			renderPromptChargeRow(charge.snapshot(), 0, taggedTheme, "subtle", CHARGE_BUCKET_COLOR),
		);

		const fleet = new AgentFleetState();
		fleet.applyRegistryEvent(registryEvent("registered", "sub-1"), 0);
		expect(renderAgentFleetRow(fleet.snapshot(), 0, taggedTheme, "subtle")).toEqual(
			renderAgentFleetRow(fleet.snapshot(), 0, taggedTheme, "subtle", AGENT_FLEET_COLORS),
		);
	});
});

describe("widget accent threading", () => {
	it("maps each widget accent option into its primary color slot", () => {
		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new DiffBloomState();
			state.applyBloom("a.ts", 10, 2, 0);
			const widget = new DiffBloomWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				onSettled: () => {},
				accentColor: "success",
			});
			scheduler.advance(200);
			expect(widget.renderFrame(20)[0]).toContain("success:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new BonsaiState();
			state.update(branchingRawTree(), "active", 0);
			const widget = new SessionBonsaiWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "warning",
			});
			expect(widget.renderFrame(80).some(row => row.includes("warning:"))).toBe(true);
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new GoalHorizonState();
			state.applyGoal(makeGoal({ tokensUsed: 0 }), 0);
			state.applyGoal(makeGoal({ tokensUsed: 300 }), 0);
			const widget = new GoalHorizonWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "accent",
			});
			expect(widget.renderFrame(80)[0]).toContain("accent:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new MemoryCrystalsState();
			state.applyCompactionEnd(20_000, "large", "context-full", 0);
			const widget = new MemoryCrystalsWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "warning",
			});
			expect(widget.renderFrame(80)[0]).toContain("warning:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new PromptChargeState();
			const widget = new PromptChargeWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				getEditorText: () => "a".repeat(1000),
				accentColor: "success",
			});
			widget.onFrame(0);
			expect(widget.renderFrame(80)[0]).toContain("success:");
			widget.dispose();
			host.dispose();
		}

		{
			const { scheduler, policy, host } = makeWidgetHarness();
			const state = new AgentFleetState();
			state.applyRegistryEvent(registryEvent("registered", "sub-1"), 0);
			const widget = new AgentFleetWidget({
				tui: noopTui,
				host,
				policy,
				state,
				theme: taggedTheme,
				clock: scheduler,
				accentColor: "accent",
			});
			expect(widget.renderFrame(80)[0]).toContain("accent:");
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
			settings: { ...only("promptCharge"), promptChargePlacement: "belowEditor" },
			env: {},
			readPluginSettings: async () => ({}),
		})(api);

		const calls: Array<{ key: string; options?: { placement?: string } }> = [];
		const fakeCtx = {
			hasUI: true,
			ui: {
				theme: idTheme,
				getEditorText: () => "",
				setWidget: (key: string, _content: unknown, options?: { placement?: string }) =>
					calls.push({ key, options }),
			},
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.({ type: "session_start" }, fakeCtx);
		expect(calls[0]?.key).toBe("prompt-charge");
		expect(calls[0]?.options?.placement).toBe("belowEditor");
	});
});
