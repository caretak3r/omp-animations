import * as path from "node:path";
import { normalizeMutationTargets } from "../live-files/normalize";
import { ACTIVITY_ROSTER_DEFAULTS, type ActivityRosterDetail } from "./settings";

const DEFAULT_COMPLETION_FLASH_MS = 1_200;
const ACTIVITY_BUS = Symbol.for("@oh-my-pi/animations/activity-bus");

export type ActivityPhase = "active" | "completing" | "recent";

export interface ActivityLifecycleScheduler {
	now(): number;
	schedule(delayMs: number, tick: () => void): () => void;
}

const DEFAULT_LIFECYCLE_SCHEDULER: ActivityLifecycleScheduler = {
	now: Date.now,
	schedule(delayMs, tick) {
		const timer = setTimeout(tick, delayMs);
		return () => clearTimeout(timer);
	},
};

export interface ActivityOperationSnapshot {
	readonly id: string;
	readonly agentId: string;
	readonly tool: string;
	readonly path: string;
	readonly line?: number;
	readonly phase: "active" | "completing";
	readonly startedAt: number;
	readonly isError: boolean;
}

export interface ActivityAgentSnapshot {
	readonly id: string;
	readonly parentId?: string;
	readonly sessionId: string;
	readonly model?: string;
	readonly phase: ActivityPhase;
	readonly currentTool?: string;
	readonly currentTarget?: string;
}

export interface ActivityRosterSnapshot {
	readonly agents: readonly ActivityAgentSnapshot[];
	readonly operations: readonly ActivityOperationSnapshot[];
	readonly liveWriterCount: number;
	readonly pathCount: number;
	readonly runningCount: number;
	readonly idleCount: number;
	readonly detail: ActivityRosterDetail;
}

export interface ActivityTelemetryBusOptions {
	readonly scheduler?: ActivityLifecycleScheduler;
	/** Deterministic snapshot clock. When supplied without a scheduler, lifecycle timers stay disabled. */
	readonly now?: () => number;
	readonly completionFlashMs?: number;
	readonly retentionMs?: number;
}

export interface ActivitySessionRegistration {
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly cwd: string;
	readonly artifactsDir?: string;
	readonly sessionFile?: string;
	readonly model?: string;
	readonly retentionMs?: number;
	readonly detail?: ActivityRosterDetail;
}

export interface ActivityToolStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

export interface ActivityToolEnd {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
}

export interface ActivityProbe {
	startTool(event: ActivityToolStart): void;
	updateTool(event: ActivityToolStart): void;
	endTool(event: ActivityToolEnd): void;
	complete(): void;
	snapshot(): ActivityRosterSnapshot;
	subscribe(listener: () => void): () => void;
	dispose(): void;
}

interface ActiveTool {
	readonly toolCallId: string;
	toolName: string;
	args: unknown;
	readonly startedAt: number;
}

interface TrackedOperation {
	readonly id: string;
	readonly toolCallId: string;
	readonly ownerSessionId: string;
	readonly agentId: string;
	readonly tool: string;
	readonly path: string;
	readonly line?: number;
	readonly startedAt: number;
	endedAt?: number;
	isError: boolean;
}

interface TrackedAgent {
	readonly sessionId: string;
	readonly id: string;
	readonly parentId?: string;
	readonly depth: number;
	readonly cwd: string;
	readonly model?: string;
	readonly tools: Map<string, ActiveTool>;
	completedAt?: number;
}

interface RootScope {
	readonly rootSessionId: string;
	readonly artifactsDir?: string;
	readonly agents: Map<string, TrackedAgent>;
	readonly operations: Map<string, TrackedOperation>;
	readonly subscribers: Set<() => void>;
	readonly retentionMs: number;
	readonly detail: ActivityRosterDetail;
	lifecycleDeadline?: number;
	stopLifecycleTimer?: () => void;
}

interface SessionBinding {
	readonly scope: RootScope;
	readonly agent: TrackedAgent;
	readonly isRoot: boolean;
}

interface ProbeActions {
	readonly startTool: (event: ActivityToolStart) => void;
	readonly updateTool: (event: ActivityToolStart) => void;
	readonly endTool: (event: ActivityToolEnd) => void;
	readonly complete: () => void;
	readonly snapshot: () => ActivityRosterSnapshot;
	readonly subscribe: (listener: () => void) => () => void;
	readonly dispose: () => void;
}

class RegisteredActivityProbe implements ActivityProbe {
	#actions: ProbeActions;

	constructor(actions: ProbeActions) {
		this.#actions = actions;
	}

	startTool(event: ActivityToolStart): void {
		this.#actions.startTool(event);
	}

	updateTool(event: ActivityToolStart): void {
		this.#actions.updateTool(event);
	}

	endTool(event: ActivityToolEnd): void {
		this.#actions.endTool(event);
	}

	complete(): void {
		this.#actions.complete();
	}

	snapshot(): ActivityRosterSnapshot {
		return this.#actions.snapshot();
	}

	subscribe(listener: () => void): () => void {
		return this.#actions.subscribe(listener);
	}

	dispose(): void {
		this.#actions.dispose();
	}
}

function emptySnapshot(): ActivityRosterSnapshot {
	return {
		agents: [],
		operations: [],
		liveWriterCount: 0,
		pathCount: 0,
		runningCount: 0,
		idleCount: 0,
		detail: ACTIVITY_ROSTER_DEFAULTS.detail,
	};
}

function isPathWithin(parent: string, target: string): boolean {
	const relative = path.relative(parent, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function childIdentity(rootDir: string, sessionFile: string): { id: string; parentId: string; depth: number } {
	const relative = path.relative(rootDir, sessionFile);
	const parts = relative.split(path.sep).filter(Boolean);
	const id = path.basename(parts.at(-1) ?? sessionFile, path.extname(parts.at(-1) ?? sessionFile));
	const parentId = parts.length > 1 ? (parts.at(-2) ?? "main") : "main";
	return { id, parentId, depth: parts.length };
}

export class ActivityTelemetryBus {
	#roots = new Set<RootScope>();
	#sessions = new Map<string, SessionBinding>();
	#scheduler: ActivityLifecycleScheduler;
	#completionFlashMs: number;
	#retentionMs: number;

	constructor(options: ActivityTelemetryBusOptions = {}) {
		this.#scheduler =
			options.scheduler ??
			(options.now === undefined
				? DEFAULT_LIFECYCLE_SCHEDULER
				: { now: options.now, schedule: () => () => undefined });
		this.#completionFlashMs = options.completionFlashMs ?? DEFAULT_COMPLETION_FLASH_MS;
		this.#retentionMs = options.retentionMs ?? ACTIVITY_ROSTER_DEFAULTS.retentionMs;
	}

	registerSession(registration: ActivitySessionRegistration): ActivityProbe {
		const existing = this.#sessions.get(registration.sessionId);
		if (existing !== undefined) return this.#probe(existing);
		if (registration.hasUI) return this.#registerRoot(registration);
		return this.#registerChild(registration);
	}

	#registerRoot(registration: ActivitySessionRegistration): ActivityProbe {
		const agent: TrackedAgent = {
			sessionId: registration.sessionId,
			id: "main",
			depth: 0,
			cwd: registration.cwd,
			model: registration.model,
			tools: new Map(),
		};
		const scope: RootScope = {
			rootSessionId: registration.sessionId,
			artifactsDir: registration.artifactsDir,
			agents: new Map([[registration.sessionId, agent]]),
			operations: new Map(),
			subscribers: new Set(),
			retentionMs: registration.retentionMs ?? this.#retentionMs,
			detail: registration.detail ?? ACTIVITY_ROSTER_DEFAULTS.detail,
		};
		const binding = { scope, agent, isRoot: true };
		this.#roots.add(scope);
		this.#sessions.set(registration.sessionId, binding);
		return this.#probe(binding);
	}

	#registerChild(registration: ActivitySessionRegistration): ActivityProbe {
		const match = this.#matchingRoot(registration.sessionFile);
		if (match === undefined || match.artifactsDir === undefined || registration.sessionFile === undefined) {
			return new RegisteredActivityProbe({
				startTool: () => undefined,
				updateTool: () => undefined,
				endTool: () => undefined,
				complete: () => undefined,
				snapshot: emptySnapshot,
				subscribe: () => () => undefined,
				dispose: () => undefined,
			});
		}
		const identity = childIdentity(match.artifactsDir, registration.sessionFile);
		const agent: TrackedAgent = {
			sessionId: registration.sessionId,
			id: identity.id,
			parentId: identity.parentId,
			depth: identity.depth,
			cwd: registration.cwd,
			model: registration.model,
			tools: new Map(),
		};
		const binding = { scope: match, agent, isRoot: false };
		match.agents.set(registration.sessionId, agent);
		this.#sessions.set(registration.sessionId, binding);
		this.#changed(match);
		return this.#probe(binding);
	}

	#matchingRoot(sessionFile: string | undefined): RootScope | undefined {
		if (sessionFile === undefined) return undefined;
		let best: RootScope | undefined;
		for (const scope of this.#roots) {
			if (scope.artifactsDir === undefined || !isPathWithin(scope.artifactsDir, sessionFile)) continue;
			if (best === undefined || scope.artifactsDir.length > (best.artifactsDir?.length ?? 0)) best = scope;
		}
		return best;
	}

	#probe(binding: SessionBinding): ActivityProbe {
		let disposed = false;
		return new RegisteredActivityProbe({
			startTool: event => {
				if (!disposed) this.#startTool(binding, event);
			},
			updateTool: event => {
				if (!disposed) this.#updateTool(binding, event);
			},
			endTool: event => {
				if (!disposed) this.#endTool(binding, event);
			},
			complete: () => {
				if (!disposed) this.#complete(binding);
			},
			snapshot: () => {
				if (disposed) return emptySnapshot();
				const snapshot = this.#snapshot(binding.scope);
				this.#scheduleLifecycle(binding.scope);
				return snapshot;
			},
			subscribe: listener => {
				if (disposed) return () => undefined;
				binding.scope.subscribers.add(listener);
				this.#scheduleLifecycle(binding.scope);
				return () => binding.scope.subscribers.delete(listener);
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.#dispose(binding);
			},
		});
	}

	#startTool(binding: SessionBinding, event: ActivityToolStart): void {
		binding.agent.completedAt = undefined;
		binding.agent.tools.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			startedAt: this.#scheduler.now(),
		});
		this.#replaceOperations(binding, event);
		this.#changed(binding.scope);
	}

	#updateTool(binding: SessionBinding, event: ActivityToolStart): void {
		const tool = binding.agent.tools.get(event.toolCallId);
		if (tool === undefined) {
			this.#startTool(binding, event);
			return;
		}
		tool.toolName = event.toolName;
		tool.args = event.args;
		if (normalizeMutationTargets(event.toolName, event.args, binding.agent.cwd).length > 0) {
			this.#replaceOperations(binding, event);
		}
		this.#changed(binding.scope);
	}

	#replaceOperations(binding: SessionBinding, event: ActivityToolStart): void {
		const targets = normalizeMutationTargets(event.toolName, event.args, binding.agent.cwd);
		if (targets.length === 0) return;
		const prefix = `${binding.agent.sessionId}:${event.toolCallId}:`;
		const existing = new Map(
			[...binding.scope.operations.values()]
				.filter(operation => operation.id.startsWith(prefix))
				.map(operation => [operation.id, operation]),
		);
		for (const id of existing.keys()) binding.scope.operations.delete(id);
		for (const target of targets) {
			const suffix = `${target.path}${target.line === undefined ? "" : `:${target.line}`}`;
			const id = `${prefix}${suffix}`;
			const prior = existing.get(id);
			binding.scope.operations.set(id, {
				id,
				toolCallId: event.toolCallId,
				ownerSessionId: binding.agent.sessionId,
				agentId: binding.agent.id,
				tool: event.toolName,
				path: target.path,
				line: target.line,
				startedAt:
					prior?.startedAt ?? binding.agent.tools.get(event.toolCallId)?.startedAt ?? this.#scheduler.now(),
				isError: false,
			});
		}
	}

	#endTool(binding: SessionBinding, event: ActivityToolEnd): void {
		binding.agent.tools.delete(event.toolCallId);
		const now = this.#scheduler.now();
		for (const operation of binding.scope.operations.values()) {
			if (operation.toolCallId !== event.toolCallId || operation.ownerSessionId !== binding.agent.sessionId)
				continue;
			operation.endedAt = now;
			operation.isError = event.isError;
		}
		this.#changed(binding.scope);
	}

	#complete(binding: SessionBinding): void {
		if (binding.isRoot || binding.agent.completedAt !== undefined) return;
		binding.agent.completedAt = this.#scheduler.now();
		this.#changed(binding.scope);
	}

	#dispose(binding: SessionBinding): void {
		if (binding.isRoot) {
			binding.scope.stopLifecycleTimer?.();
			this.#roots.delete(binding.scope);
			for (const [sessionId, candidate] of this.#sessions) {
				if (candidate.scope === binding.scope) this.#sessions.delete(sessionId);
			}
			return;
		}
		this.#complete(binding);
	}

	#snapshot(scope: RootScope): ActivityRosterSnapshot {
		const now = this.#scheduler.now();
		for (const [id, operation] of scope.operations) {
			if (operation.endedAt !== undefined && now - operation.endedAt > this.#completionFlashMs) {
				scope.operations.delete(id);
			}
		}
		for (const [sessionId, agent] of scope.agents) {
			if (agent.id === "main" || agent.completedAt === undefined || now - agent.completedAt <= scope.retentionMs)
				continue;
			scope.agents.delete(sessionId);
			this.#sessions.delete(sessionId);
		}

		const trackedOperations = [...scope.operations.values()];
		const operations = trackedOperations
			.map(operation => ({
				id: operation.id,
				agentId: operation.agentId,
				tool: operation.tool,
				path: operation.path,
				line: operation.line,
				phase: operation.endedAt === undefined ? ("active" as const) : ("completing" as const),
				startedAt: operation.startedAt,
				isError: operation.isError,
			}))
			.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));

		const agents = [...scope.agents.values()]
			.map(agent => this.#agentSnapshot(agent, now, trackedOperations))
			.sort((a, b) => {
				const left = scope.agents.get(a.sessionId)?.depth ?? 0;
				const right = scope.agents.get(b.sessionId)?.depth ?? 0;
				return left - right || a.id.localeCompare(b.id);
			});
		const activeOperations = trackedOperations.filter(operation => operation.endedAt === undefined);
		return {
			agents,
			operations,
			liveWriterCount: new Set(activeOperations.map(operation => operation.ownerSessionId)).size,
			pathCount: new Set(activeOperations.map(operation => operation.path)).size,
			runningCount: agents.filter(agent => agent.phase === "active").length,
			idleCount: agents.filter(agent => agent.phase !== "active").length,
			detail: scope.detail,
		};
	}

	#agentSnapshot(agent: TrackedAgent, now: number, operations: readonly TrackedOperation[]): ActivityAgentSnapshot {
		const phase =
			agent.completedAt === undefined
				? "active"
				: now - agent.completedAt <= this.#completionFlashMs
					? "completing"
					: "recent";
		const current = [...agent.tools.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
		const target =
			current === undefined
				? undefined
				: operations.find(
						operation =>
							operation.ownerSessionId === agent.sessionId &&
							operation.toolCallId === current.toolCallId &&
							operation.endedAt === undefined,
					)?.path;
		return {
			id: agent.id,
			parentId: agent.parentId,
			sessionId: agent.sessionId,
			model: agent.model,
			phase,
			currentTool: current?.toolName,
			currentTarget: target,
		};
	}

	#changed(scope: RootScope): void {
		this.#notify(scope);
		this.#scheduleLifecycle(scope);
	}

	#scheduleLifecycle(scope: RootScope): void {
		const now = this.#scheduler.now();
		let deadline: number | undefined;
		const consider = (candidate: number): void => {
			if (candidate <= now) return;
			if (deadline === undefined || candidate < deadline) deadline = candidate;
		};
		for (const operation of scope.operations.values()) {
			if (operation.endedAt !== undefined) consider(operation.endedAt + this.#completionFlashMs + 1);
		}
		for (const agent of scope.agents.values()) {
			if (agent.completedAt === undefined) continue;
			consider(agent.completedAt + this.#completionFlashMs + 1);
			consider(agent.completedAt + scope.retentionMs + 1);
		}
		if (deadline === undefined) {
			scope.stopLifecycleTimer?.();
			scope.stopLifecycleTimer = undefined;
			scope.lifecycleDeadline = undefined;
			return;
		}
		if (scope.stopLifecycleTimer !== undefined && scope.lifecycleDeadline === deadline) return;
		scope.stopLifecycleTimer?.();
		scope.lifecycleDeadline = deadline;
		scope.stopLifecycleTimer = this.#scheduler.schedule(deadline - now, () => {
			scope.stopLifecycleTimer = undefined;
			scope.lifecycleDeadline = undefined;
			this.#snapshot(scope);
			this.#notify(scope);
			this.#scheduleLifecycle(scope);
		});
	}

	#notify(scope: RootScope): void {
		for (const subscriber of scope.subscribers) subscriber();
	}
}

interface GlobalActivityRegistry {
	readonly [key: symbol]: unknown;
}

function isActivityTelemetryBus(value: unknown): value is ActivityTelemetryBus {
	return typeof value === "object" && value !== null && "registerSession" in value;
}

export function globalActivityTelemetryBus(): ActivityTelemetryBus {
	const registry = globalThis as typeof globalThis & GlobalActivityRegistry;
	const existing = registry[ACTIVITY_BUS];
	if (isActivityTelemetryBus(existing)) return existing;
	const bus = new ActivityTelemetryBus();
	Object.defineProperty(registry, ACTIVITY_BUS, { value: bus, configurable: true });
	return bus;
}
