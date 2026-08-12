import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentRef, RegistryEvent } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AccentColor } from "../appearance";
import {
	AnimationHost,
	type BackpressureSignal,
	backpressureFromTui,
	DEFAULT_FRAME_SCHEDULER,
	type FrameScheduler,
	MotionPolicy,
	type MotionSetting,
} from "../kit";
import { type AgentTreeSnapshot, buildAgentTree, normalizeAgentLine } from "./state";
import { type AgentTreeTheme, AgentTreeWidget } from "./widget";

export const AGENT_TREE_WIDGET_KEY = "agentTree";
export const AGENT_TREE_POLL_MS = 500;
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";
const EMPTY_SNAPSHOT: AgentTreeSnapshot = { nodes: [], hiddenCount: 0, visible: false };

/** Registry seam. Tests inject a plain in-memory implementation. */
export interface AgentRegistryLike {
	list(): AgentRef[];
	onChange(listener: (event: RegistryEvent) => void): () => void;
}

/** Session-owned UI context captured at `session_start`. */
export interface AgentTreeContext {
	readonly hasUI: boolean;
	readonly isTTY: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly motionSetting: MotionSetting;
	readonly theme: AgentTreeTheme;
	readonly glyphPreset: SymbolPreset;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

interface AgentTreeMount {
	readonly host: AnimationHost;
	readonly pollHost?: AnimationHost;
}

function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: object): void } {
	let live: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return live?.underPressure ?? false;
			},
		},
		attach(tui) {
			live = backpressureFromTui(tui);
		},
	};
}

function modelTail(id: string): string {
	return normalizeAgentLine(id.slice(id.lastIndexOf("/") + 1));
}

function firstUserTask(ref: AgentRef): string | undefined {
	const messages = ref.session?.messages;
	if (messages === undefined) return undefined;
	for (const message of messages) {
		if (!("role" in message) || message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") {
			const task = normalizeAgentLine(content);
			return task.length > 0 ? task : undefined;
		}
		let taskText = "";
		for (const part of content) {
			if (part.type !== "text") continue;
			taskText += taskText.length === 0 ? part.text : ` ${part.text}`;
		}
		const task = normalizeAgentLine(taskText);
		return task.length > 0 ? task : undefined;
	}
	return undefined;
}

function arraysEqual(a: readonly boolean[], b: readonly boolean[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function snapshotsEqual(a: AgentTreeSnapshot, b: AgentTreeSnapshot): boolean {
	if (a.visible !== b.visible || a.hiddenCount !== b.hiddenCount || a.nodes.length !== b.nodes.length) return false;
	for (let i = 0; i < a.nodes.length; i++) {
		const left = a.nodes[i];
		const right = b.nodes[i];
		if (
			left === undefined ||
			right === undefined ||
			left.id !== right.id ||
			left.name !== right.name ||
			left.depth !== right.depth ||
			left.isLast !== right.isLast ||
			left.status !== right.status ||
			left.modelTail !== right.modelTail ||
			left.gist !== right.gist ||
			left.task !== right.task ||
			!arraysEqual(left.ancestorsLast, right.ancestorsLast)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Owns registry observation, session caches, visibility-driven mounting, and
 * throttled registry polling through the shared frame scheduler.
 */
export class AgentTreeController {
	#registry: AgentRegistryLike;
	#scheduler: FrameScheduler;
	#widgetOptions: ExtensionWidgetOptions;
	#accentColor: AccentColor | undefined;
	#snapshot: AgentTreeSnapshot = EMPTY_SNAPSHOT;
	#modelTail = new Map<string, string>();
	#task = new Map<string, string>();
	#seen = new Set<string>();
	#context: AgentTreeContext | undefined;
	#unsubscribeRegistry: (() => void) | undefined;
	#mount: AgentTreeMount | undefined;
	#widget: AgentTreeWidget | undefined;
	#lastPollElapsedMs = 0;

	constructor(
		registry: AgentRegistryLike,
		options: {
			scheduler?: FrameScheduler;
			placement?: WidgetPlacement;
			accentColor?: AccentColor;
		} = {},
	) {
		this.#registry = registry;
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
	}

	/** Current immutable render snapshot. */
	snapshot(): AgentTreeSnapshot {
		return this.#snapshot;
	}

	/** Capture the live UI context and begin observing the process-global registry. */
	mount(ctx: AgentTreeContext): void {
		this.dispose();
		if (!ctx.hasUI) return;
		this.#context = ctx;
		this.#unsubscribeRegistry = this.#registry.onChange(event => {
			if (event.type === "removed") this.#evict(event.ref.id);
			this.#pollRegistry();
		});
		this.#pollRegistry();
	}

	/** A switch owns a new transcript, so all previous caches and flash state reset. */
	onSessionSwitch(ctx: AgentTreeContext): void {
		this.mount(ctx);
	}

	/** Tear down the registry listener, frame host, widget, and session-owned caches. */
	dispose(): void {
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		this.#teardownWidget();
		this.#context = undefined;
		this.#snapshot = EMPTY_SNAPSHOT;
		this.#modelTail.clear();
		this.#task.clear();
		this.#seen.clear();
		this.#lastPollElapsedMs = 0;
	}

	#pollRegistry(): void {
		const refs = this.#registry.list();
		this.#updateCaches(refs);
		const next = buildAgentTree(refs, { modelTail: this.#modelTail, task: this.#task, seen: this.#seen });
		if (snapshotsEqual(this.#snapshot, next)) return;
		this.#snapshot = next;
		const ctx = this.#context;
		if (ctx === undefined) return;
		if (next.visible && this.#mount === undefined) {
			this.#mountWidget(ctx);
			return;
		}
		if (!next.visible && this.#mount !== undefined) {
			this.#teardownWidget();
			return;
		}
		if (next.visible) this.#widget?.refresh();
	}

	#updateCaches(refs: readonly AgentRef[]): void {
		for (const ref of refs) {
			const session = ref.session;
			if (session === null) continue;
			this.#seen.add(ref.id);
			if (session.model !== undefined) this.#modelTail.set(ref.id, modelTail(session.model.id));
			if (!this.#task.has(ref.id)) {
				const task = firstUserTask(ref);
				if (task !== undefined) this.#task.set(ref.id, task);
			}
		}
	}

	#evict(id: string): void {
		this.#modelTail.delete(id);
		this.#task.delete(id);
		this.#seen.delete(id);
	}

	#mountWidget(ctx: AgentTreeContext): void {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const pollHost =
			policy.tier === "off"
				? new AnimationHost({
						policy: new MotionPolicy({ hasUI: true, isTTY: true, env: {} }, "subtle"),
						backpressure: backpressure.signal,
						scheduler: this.#scheduler,
					})
				: host;
		this.#lastPollElapsedMs = 0;
		pollHost.subscribe((_frame, elapsedMs) => {
			if (elapsedMs - this.#lastPollElapsedMs < AGENT_TREE_POLL_MS) return;
			this.#lastPollElapsedMs = elapsedMs;
			this.#pollRegistry();
		});
		ctx.setWidget(
			AGENT_TREE_WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				const widget = new AgentTreeWidget({
					tui,
					host,
					policy,
					state: this,
					theme,
					accentColor: this.#accentColor,
					glyphPreset: ctx.glyphPreset,
				});
				this.#widget = widget;
				return widget;
			},
			this.#widgetOptions,
		);
		this.#mount = { host, pollHost: pollHost === host ? undefined : pollHost };
	}

	#teardownWidget(): void {
		if (this.#mount === undefined) return;
		this.#mount.host.dispose();
		this.#mount.pollHost?.dispose();
		this.#context?.setWidget(AGENT_TREE_WIDGET_KEY, undefined, this.#widgetOptions);
		this.#mount = undefined;
		this.#widget = undefined;
	}
}
