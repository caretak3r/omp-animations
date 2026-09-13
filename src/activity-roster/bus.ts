import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
import { expandPath, resolveReadPath, splitInternalUrlSel, splitPathAndSel } from "../host/runtime";
import { normalizeMutationTargets } from "../live-files/normalize";
import { ACTIVITY_ROSTER_DEFAULTS, type ActivityRosterDetail } from "./settings";

const MIN_COMPLETION_RETENTION_MS = 800;
const DEFAULT_COMPLETION_FLASH_MS = 1_200;
const DEFAULT_ACTIVITY_TRAIL_MS = 8_000;
const MAX_ACTIVITY_TOOLS = 6;
const MAX_PROVENANCE_EVENTS = 32;
const INTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
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

export type ActivityStepKind = "tool" | "skill" | "file";
export type ActivityStepStatus = "active" | "complete" | "error";

export interface ActivityStepSnapshot {
	readonly id: string;
	readonly kind: ActivityStepKind;
	readonly label: string;
	readonly status: ActivityStepStatus;
	readonly startedAt: number;
}

export type ActivityProvenanceKind = "skill" | "context-file" | "memory" | "qmd";

export interface ActivityProvenanceSnapshot {
	readonly id: string;
	readonly kind: ActivityProvenanceKind;
	readonly label: string;
	readonly status: ActivityStepStatus;
	readonly startedAt: number;
}

export interface ActivityAgentSnapshot {
	readonly id: string;
	readonly parentId?: string;
	readonly sessionId: string;
	readonly model?: string;
	readonly phase: ActivityPhase;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly terminalStatus?: "completed" | "aborted";
	readonly currentTool?: string;
	readonly currentTarget?: string;
	readonly steps: readonly ActivityStepSnapshot[];
	readonly provenance: readonly ActivityProvenanceSnapshot[];
}

export interface ActivitySessionResources {
	readonly skills: readonly {
		readonly name: string;
		readonly description: string;
		readonly path: string;
	}[];
	readonly contextFiles: readonly {
		readonly path: string;
	}[];
}

export interface ActivityAvailableSkillSnapshot {
	readonly name: string;
	readonly description: string;
	readonly path: string;
}

export interface ActivityContextFileSnapshot {
	readonly path: string;
	readonly label: string;
}

export interface ActivityResourceCatalogSnapshot {
	readonly availableSkills: readonly ActivityAvailableSkillSnapshot[];
	readonly contextFiles: readonly ActivityContextFileSnapshot[];
}

export interface ActivityResourceUsageSnapshot {
	readonly skillInvocationCount: number;
	readonly contextFileReadCount: number;
	readonly memoryOperationCount: number;
	readonly qmdOperationCount: number;
	readonly totalCount: number;
}

export interface ActivityRosterSnapshot {
	readonly agents: readonly ActivityAgentSnapshot[];
	readonly retiredAgentIds?: readonly string[];
	readonly operations: readonly ActivityOperationSnapshot[];
	readonly resourceCatalog: ActivityResourceCatalogSnapshot;
	readonly resourceUsage: ActivityResourceUsageSnapshot;
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
	readonly activityTrailMs?: number;
}

export interface ActivitySessionRegistration {
	readonly sessionId: string;
	readonly hasUI: boolean;
	readonly cwd: string;
	readonly sessionResources: ActivitySessionResources;
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
	/** Root only. Call after the fallback observer has purged terminal rows. */
	beginRequest(): void;
	noteAgentOutcome(id: string, outcome: "completed" | "aborted", completedAt: number): void;
	complete(): void;
	snapshot(): ActivityRosterSnapshot;
	subscribe(listener: () => void): () => void;
	dispose(): void;
}

interface ActivityTarget {
	readonly kind: "skill" | "file";
	readonly label: string;
}

interface ActivityProvenanceTarget {
	readonly kind: ActivityProvenanceKind;
	readonly label: string;
}

interface TrackedTool {
	readonly toolCallId: string;
	toolName: string;
	args: unknown;
	targets: readonly ActivityTarget[];
	readonly observedProvenance: Set<string>;
	readonly startedAt: number;
	endedAt?: number;
	isError: boolean;
}

interface TrackedProvenance {
	readonly id: string;
	readonly toolCallId: string;
	readonly kind: ActivityProvenanceKind;
	label: string;
	readonly startedAt: number;
	endedAt?: number;
	isError: boolean;
}

interface TrackedResourceUsage {
	skillInvocationCount: number;
	contextFileReadCount: number;
	memoryOperationCount: number;
	qmdOperationCount: number;
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
	readonly resourceCatalog: ActivityResourceCatalogSnapshot;
	readonly model?: string;
	readonly tools: Map<string, TrackedTool>;
	readonly provenance: Map<string, TrackedProvenance>;
	readonly resourceUsage: TrackedResourceUsage;
	startedAt?: number;
	completedAt?: number;
	terminalStatus?: "completed" | "aborted";
}

interface PendingAgentOutcome {
	readonly terminalStatus: "completed" | "aborted";
	readonly completedAt: number;
}

interface RootScope {
	readonly rootSessionId: string;
	readonly artifactsDir?: string;
	readonly agents: Map<string, TrackedAgent>;
	/** Identity tombstones live until root disposal, including across request boundaries. */
	readonly retiredAgentIds: Set<string>;
	readonly pendingAgentOutcomes: Map<string, PendingAgentOutcome>;
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
	readonly beginRequest: () => void;
	readonly noteAgentOutcome: (id: string, outcome: "completed" | "aborted", completedAt: number) => void;
	readonly complete: () => void;
	readonly snapshot: () => ActivityRosterSnapshot;
	readonly subscribe: (listener: () => void) => () => void;
	readonly dispose: () => void;
}

const EMPTY_RESOURCE_CATALOG: ActivityResourceCatalogSnapshot = Object.freeze({
	availableSkills: Object.freeze([]),
	contextFiles: Object.freeze([]),
});

const EMPTY_RESOURCE_USAGE: ActivityResourceUsageSnapshot = Object.freeze({
	skillInvocationCount: 0,
	contextFileReadCount: 0,
	memoryOperationCount: 0,
	qmdOperationCount: 0,
	totalCount: 0,
});

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

	beginRequest(): void {
		this.#actions.beginRequest();
	}

	noteAgentOutcome(id: string, outcome: "completed" | "aborted", completedAt: number): void {
		this.#actions.noteAgentOutcome(id, outcome, completedAt);
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
		retiredAgentIds: [],
		operations: [],
		resourceCatalog: EMPTY_RESOURCE_CATALOG,
		resourceUsage: EMPTY_RESOURCE_USAGE,
		liveWriterCount: 0,
		pathCount: 0,
		runningCount: 0,
		idleCount: 0,
		detail: ACTIVITY_ROSTER_DEFAULTS.detail,
	};
}

function emptyTrackedResourceUsage(): TrackedResourceUsage {
	return {
		skillInvocationCount: 0,
		contextFileReadCount: 0,
		memoryOperationCount: 0,
		qmdOperationCount: 0,
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function displayTarget(raw: string, cwd: string): string {
	if (!path.isAbsolute(raw)) return raw;
	const relative = path.relative(cwd, path.normalize(raw));
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." ? relative : raw;
}

function sanitizeSessionResources(resources: ActivitySessionResources, cwd: string): ActivityResourceCatalogSnapshot {
	const availableSkills = resources.skills.map(skill =>
		Object.freeze({
			name: skill.name,
			description: skill.description,
			path: path.resolve(cwd, skill.path),
		}),
	);
	const contextFiles = resources.contextFiles.map(file => {
		const normalizedPath = path.resolve(cwd, file.path);
		return Object.freeze({ path: normalizedPath, label: displayTarget(normalizedPath, cwd) });
	});
	if (availableSkills.length === 0 && contextFiles.length === 0) return EMPTY_RESOURCE_CATALOG;
	return Object.freeze({
		availableSkills: Object.freeze(availableSkills),
		contextFiles: Object.freeze(contextFiles),
	});
}

function aggregateResourceCatalog(agents: Iterable<TrackedAgent>): ActivityResourceCatalogSnapshot {
	const skillsByName = new Map<string, ActivityAvailableSkillSnapshot>();
	const contextFilesByPath = new Map<string, ActivityContextFileSnapshot>();
	for (const agent of agents) {
		for (const skill of agent.resourceCatalog.availableSkills) {
			if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
		}
		for (const file of agent.resourceCatalog.contextFiles) {
			if (!contextFilesByPath.has(file.path)) contextFilesByPath.set(file.path, file);
		}
	}
	if (skillsByName.size === 0 && contextFilesByPath.size === 0) return EMPTY_RESOURCE_CATALOG;
	return Object.freeze({
		availableSkills: Object.freeze(
			[...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
		),
		contextFiles: Object.freeze(
			[...contextFilesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
		),
	});
}

function activityTargets(toolName: string, args: unknown, cwd: string): readonly ActivityTarget[] {
	const mutations = normalizeMutationTargets(toolName, args, cwd);
	if (mutations.length > 0) return mutations.map(target => ({ kind: "file", label: target.path }));

	const input = asRecord(args);
	const raw =
		typeof input?.path === "string"
			? input.path
			: typeof args === "string" && (toolName === "read" || toolName === "grep" || toolName === "glob")
				? args.trim()
				: undefined;
	if (raw === undefined || raw.length === 0) return [];
	if (raw.startsWith("skill://")) {
		const name = splitInternalUrlSel(raw).path.slice("skill://".length).split(/[/?#]/u, 1)[0] ?? "";
		return name.length === 0 ? [] : [{ kind: "skill", label: name }];
	}
	if (INTERNAL_SCHEME.test(raw)) return [];
	return [{ kind: "file", label: displayTarget(raw, cwd) }];
}

function readTarget(toolName: string, args: unknown): string | undefined {
	if (toolName !== "read") return undefined;
	const input = asRecord(args);
	const raw = typeof input?.path === "string" ? input.path : typeof args === "string" ? args.trim() : undefined;
	return raw === undefined || raw.length === 0 ? undefined : raw;
}

function readResourcePath(raw: string, cwd: string): string | undefined {
	const filePath = raw.startsWith("file://") ? expandPath(raw) : raw;
	if (INTERNAL_SCHEME.test(filePath)) return undefined;
	const strict = splitPathAndSel(filePath);
	let target = strict.path;
	if (strict.sel !== undefined) {
		const resolved = resolveReadPath(filePath, cwd);
		try {
			fs.lstatSync(resolved);
			target = filePath;
		} catch (error) {
			// Match the host's literal-first read: only a definitely missing literal permits selector peeling.
			if (!isEnoent(error) && !isEnotdir(error) && !hasFsCode(error, "ENAMETOOLONG")) target = filePath;
		}
	}
	return resolveReadPath(target, cwd);
}

function skillProvenanceTarget(toolName: string, args: unknown): ActivityProvenanceTarget | undefined {
	const raw = readTarget(toolName, args);
	if (raw === undefined || !raw.startsWith("skill://")) return undefined;
	const name = splitInternalUrlSel(raw).path.slice("skill://".length).split(/[/?#]/u, 1)[0] ?? "";
	return name.length === 0 ? undefined : { kind: "skill", label: name };
}

function fileProvenanceTarget(
	toolName: string,
	args: unknown,
	cwd: string,
	resourceCatalog: ActivityResourceCatalogSnapshot,
): ActivityProvenanceTarget | undefined {
	const raw = readTarget(toolName, args);
	if (raw === undefined) return undefined;
	const normalizedPath = readResourcePath(raw, cwd);
	if (normalizedPath === undefined) return undefined;
	const skill = resourceCatalog.availableSkills.find(entry => entry.path === normalizedPath);
	if (skill !== undefined) return { kind: "skill", label: skill.name };
	const contextFile = resourceCatalog.contextFiles.find(file => file.path === normalizedPath);
	return contextFile === undefined ? undefined : { kind: "context-file", label: contextFile.label };
}

function memoryProvenanceTarget(toolName: string, args: unknown): ActivityProvenanceTarget | undefined {
	if (toolName === "read") {
		const raw = readTarget(toolName, args);
		return raw?.startsWith("memory://") === true ? { kind: "memory", label: "read" } : undefined;
	}
	if (toolName === "recall" || toolName === "reflect" || toolName === "retain" || toolName === "learn") {
		return { kind: "memory", label: toolName };
	}
	return toolName === "memory_edit" ? { kind: "memory", label: "memory edit" } : undefined;
}

function qmdProvenanceTarget(toolName: string, args: unknown): ActivityProvenanceTarget | undefined {
	let operation = toolName;
	if (toolName === "write") {
		const bridgePath = asRecord(args)?.path;
		if (typeof bridgePath !== "string" || !bridgePath.startsWith("xd://")) return undefined;
		operation = bridgePath.slice("xd://".length);
	}
	if (operation === "mcp__qmd_query") return { kind: "qmd", label: "QMD query" };
	if (operation === "mcp__qmd_get") return { kind: "qmd", label: "QMD get" };
	if (operation === "mcp__qmd_multi_get") return { kind: "qmd", label: "QMD multi-get" };
	return operation === "mcp__qmd_status" ? { kind: "qmd", label: "QMD status" } : undefined;
}

function resourceUsageSnapshot(agents: Iterable<TrackedAgent>): ActivityResourceUsageSnapshot {
	let skillInvocationCount = 0;
	let contextFileReadCount = 0;
	let memoryOperationCount = 0;
	let qmdOperationCount = 0;
	for (const agent of agents) {
		skillInvocationCount += agent.resourceUsage.skillInvocationCount;
		contextFileReadCount += agent.resourceUsage.contextFileReadCount;
		memoryOperationCount += agent.resourceUsage.memoryOperationCount;
		qmdOperationCount += agent.resourceUsage.qmdOperationCount;
	}
	const totalCount = skillInvocationCount + contextFileReadCount + memoryOperationCount + qmdOperationCount;
	if (totalCount === 0) return EMPTY_RESOURCE_USAGE;
	return Object.freeze({
		skillInvocationCount,
		contextFileReadCount,
		memoryOperationCount,
		qmdOperationCount,
		totalCount,
	});
}

export class ActivityTelemetryBus {
	#roots = new Set<RootScope>();
	#sessions = new Map<string, SessionBinding>();
	#scheduler: ActivityLifecycleScheduler;
	#completionFlashMs: number;
	#retentionMs: number;
	#activityTrailMs: number;

	constructor(options: ActivityTelemetryBusOptions = {}) {
		this.#scheduler =
			options.scheduler ??
			(options.now === undefined
				? DEFAULT_LIFECYCLE_SCHEDULER
				: { now: options.now, schedule: () => () => undefined });
		this.#completionFlashMs = options.completionFlashMs ?? DEFAULT_COMPLETION_FLASH_MS;
		this.#retentionMs = options.retentionMs ?? ACTIVITY_ROSTER_DEFAULTS.retentionMs;
		this.#activityTrailMs = options.activityTrailMs ?? DEFAULT_ACTIVITY_TRAIL_MS;
	}

	registerSession(registration: ActivitySessionRegistration): ActivityProbe {
		const existing = this.#sessions.get(registration.sessionId);
		if (existing !== undefined) {
			if (
				existing.isRoot ||
				existing.agent.completedAt === undefined ||
				this.#scheduler.now() - existing.agent.completedAt < existing.scope.retentionMs
			)
				return this.#probe(existing);
			this.#retireAgent(existing.scope, existing.agent);
			this.#changed(existing.scope);
		}
		if (registration.hasUI) return this.#registerRoot(registration);
		return this.#registerChild(registration);
	}

	#registerRoot(registration: ActivitySessionRegistration): ActivityProbe {
		const agent: TrackedAgent = {
			sessionId: registration.sessionId,
			id: "main",
			depth: 0,
			cwd: registration.cwd,
			resourceCatalog: sanitizeSessionResources(registration.sessionResources, registration.cwd),
			model: registration.model,
			tools: new Map(),
			provenance: new Map(),
			resourceUsage: emptyTrackedResourceUsage(),
		};
		const scope: RootScope = {
			rootSessionId: registration.sessionId,
			artifactsDir: registration.artifactsDir,
			agents: new Map([[registration.sessionId, agent]]),
			retiredAgentIds: new Set(),
			pendingAgentOutcomes: new Map(),
			operations: new Map(),
			subscribers: new Set(),
			retentionMs: Math.max(MIN_COMPLETION_RETENTION_MS, registration.retentionMs ?? this.#retentionMs),
			detail: registration.detail ?? ACTIVITY_ROSTER_DEFAULTS.detail,
		};
		const binding = { scope, agent, isRoot: true };
		this.#roots.add(scope);
		this.#sessions.set(registration.sessionId, binding);
		return this.#probe(binding);
	}

	#registerChild(registration: ActivitySessionRegistration): ActivityProbe {
		const match = this.#matchingRoot(registration.sessionFile);
		const identity =
			match?.artifactsDir !== undefined && registration.sessionFile !== undefined
				? childIdentity(match.artifactsDir, registration.sessionFile)
				: undefined;
		if (match !== undefined && this.#retireExpiredOutcomes(match, this.#scheduler.now())) this.#changed(match);
		if (match === undefined || identity === undefined || match.retiredAgentIds.has(identity.id)) {
			return new RegisteredActivityProbe({
				startTool: () => undefined,
				updateTool: () => undefined,
				endTool: () => undefined,
				beginRequest: () => undefined,
				noteAgentOutcome: () => undefined,
				complete: () => undefined,
				snapshot: emptySnapshot,
				subscribe: () => () => undefined,
				dispose: () => undefined,
			});
		}
		const outcome = match.pendingAgentOutcomes.get(identity.id);
		match.pendingAgentOutcomes.delete(identity.id);
		const agent: TrackedAgent = {
			sessionId: registration.sessionId,
			id: identity.id,
			parentId: identity.parentId,
			depth: identity.depth,
			cwd: registration.cwd,
			resourceCatalog: sanitizeSessionResources(registration.sessionResources, registration.cwd),
			model: registration.model,
			tools: new Map(),
			provenance: new Map(),
			resourceUsage: emptyTrackedResourceUsage(),
			completedAt: outcome?.completedAt,
			terminalStatus: outcome?.terminalStatus,
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
		const active = (): boolean => !disposed && this.#sessions.get(binding.agent.sessionId) === binding;
		return new RegisteredActivityProbe({
			startTool: event => {
				if (active()) this.#startTool(binding, event);
			},
			updateTool: event => {
				if (active()) this.#updateTool(binding, event);
			},
			endTool: event => {
				if (active()) this.#endTool(binding, event);
			},
			beginRequest: () => {
				if (active() && binding.isRoot) this.#beginRequest(binding.scope);
			},
			noteAgentOutcome: (id, outcome, completedAt) => {
				if (active() && binding.isRoot) this.#noteAgentOutcome(binding.scope, id, outcome, completedAt);
			},
			complete: () => {
				if (active()) this.#complete(binding);
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
		if (binding.agent.completedAt !== undefined) return;
		const tool: TrackedTool = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			targets: activityTargets(event.toolName, event.args, binding.agent.cwd),
			observedProvenance: new Set(),
			startedAt: this.#scheduler.now(),
			isError: false,
		};
		binding.agent.tools.set(event.toolCallId, tool);
		binding.agent.startedAt ??= tool.startedAt;
		this.#observeProvenance(binding.agent, tool);
		this.#replaceOperations(binding, event);
		this.#changed(binding.scope);
	}

	#updateTool(binding: SessionBinding, event: ActivityToolStart): void {
		if (binding.agent.completedAt !== undefined) return;
		const tool = binding.agent.tools.get(event.toolCallId);
		if (tool === undefined) {
			this.#startTool(binding, event);
			return;
		}
		tool.toolName = event.toolName;
		tool.args = event.args;
		tool.targets = activityTargets(event.toolName, event.args, binding.agent.cwd);
		this.#observeProvenance(binding.agent, tool);
		if (normalizeMutationTargets(event.toolName, event.args, binding.agent.cwd).length > 0) {
			this.#replaceOperations(binding, event);
		}
		this.#changed(binding.scope);
	}

	#observeProvenance(agent: TrackedAgent, tool: TrackedTool): void {
		const target =
			skillProvenanceTarget(tool.toolName, tool.args) ??
			fileProvenanceTarget(tool.toolName, tool.args, agent.cwd, agent.resourceCatalog) ??
			memoryProvenanceTarget(tool.toolName, tool.args) ??
			qmdProvenanceTarget(tool.toolName, tool.args);
		if (target === undefined) return;
		const id = `${tool.toolCallId}:${target.kind}`;
		const existing = agent.provenance.get(id);
		if (!tool.observedProvenance.has(id)) {
			tool.observedProvenance.add(id);
			if (target.kind === "skill") agent.resourceUsage.skillInvocationCount++;
			if (target.kind === "context-file") agent.resourceUsage.contextFileReadCount++;
			if (target.kind === "memory") agent.resourceUsage.memoryOperationCount++;
			if (target.kind === "qmd") agent.resourceUsage.qmdOperationCount++;
		}
		if (existing === undefined) {
			agent.provenance.set(id, {
				id,
				toolCallId: tool.toolCallId,
				kind: target.kind,
				label: target.label,
				startedAt: tool.startedAt,
				isError: false,
			});
		} else {
			existing.label = target.label;
		}
		const chronological = [...agent.provenance.values()].sort(
			(left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id),
		);
		while (chronological.length > MAX_PROVENANCE_EVENTS) {
			const oldest = chronological.shift();
			if (oldest !== undefined) agent.provenance.delete(oldest.id);
		}
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
		const now = this.#scheduler.now();
		const tool = binding.agent.tools.get(event.toolCallId);
		if (tool !== undefined) {
			tool.endedAt = now;
			tool.isError = event.isError;
		}
		for (const provenance of binding.agent.provenance.values()) {
			if (provenance.toolCallId !== event.toolCallId) continue;
			provenance.endedAt = now;
			provenance.isError = event.isError;
		}
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
		binding.agent.terminalStatus ??= "completed";
		this.#changed(binding.scope);
	}

	#noteAgentOutcome(scope: RootScope, id: string, outcome: "completed" | "aborted", completedAt: number): void {
		if (id === "main" || !Number.isFinite(completedAt)) return;
		let agent: TrackedAgent | undefined;
		for (const candidate of scope.agents.values()) {
			if (candidate.id !== id) continue;
			agent = candidate;
			break;
		}
		if (agent === undefined) {
			if (scope.retiredAgentIds.has(id)) return;
			const prior = scope.pendingAgentOutcomes.get(id);
			const terminalStatus = prior?.terminalStatus === "aborted" ? "aborted" : outcome;
			const earliest = Math.min(prior?.completedAt ?? completedAt, completedAt);
			if (prior?.terminalStatus === terminalStatus && prior.completedAt === earliest) return;
			scope.pendingAgentOutcomes.set(id, { terminalStatus, completedAt: earliest });
			this.#retireExpiredOutcomes(scope, this.#scheduler.now());
			this.#changed(scope);
			return;
		}
		const terminalStatus = agent.terminalStatus === "aborted" ? "aborted" : outcome;
		const earliest = Math.min(agent.completedAt ?? completedAt, completedAt);
		if (agent.terminalStatus === terminalStatus && agent.completedAt === earliest) return;
		agent.terminalStatus = terminalStatus;
		agent.completedAt = earliest;
		this.#changed(scope);
	}

	#beginRequest(scope: RootScope): void {
		for (const agent of scope.agents.values()) {
			if (agent.id !== "main" && agent.completedAt !== undefined) this.#retireAgent(scope, agent);
		}
		for (const id of scope.pendingAgentOutcomes.keys()) scope.retiredAgentIds.add(id);
		scope.pendingAgentOutcomes.clear();
		this.#changed(scope);
	}

	#retireAgent(scope: RootScope, agent: TrackedAgent): void {
		scope.retiredAgentIds.add(agent.id);
		scope.agents.delete(agent.sessionId);
		this.#sessions.delete(agent.sessionId);
		for (const [id, operation] of scope.operations) {
			if (operation.ownerSessionId === agent.sessionId) scope.operations.delete(id);
		}
	}

	#retireExpiredOutcomes(scope: RootScope, now: number): boolean {
		const previousSize = scope.pendingAgentOutcomes.size;
		for (const [id, outcome] of scope.pendingAgentOutcomes) {
			if (now - outcome.completedAt < scope.retentionMs) continue;
			scope.retiredAgentIds.add(id);
			scope.pendingAgentOutcomes.delete(id);
		}
		return scope.pendingAgentOutcomes.size !== previousSize;
	}

	#dispose(binding: SessionBinding): void {
		if (binding.isRoot) {
			binding.scope.stopLifecycleTimer?.();
			this.#roots.delete(binding.scope);
			binding.scope.retiredAgentIds.clear();
			binding.scope.pendingAgentOutcomes.clear();
			for (const [sessionId, candidate] of this.#sessions) {
				if (candidate.scope === binding.scope) this.#sessions.delete(sessionId);
			}
			return;
		}
		this.#complete(binding);
	}

	#snapshot(scope: RootScope): ActivityRosterSnapshot {
		const now = this.#scheduler.now();
		this.#retireExpiredOutcomes(scope, now);
		for (const [id, operation] of scope.operations) {
			if (operation.endedAt !== undefined && now - operation.endedAt > this.#completionFlashMs) {
				scope.operations.delete(id);
			}
		}
		for (const agent of scope.agents.values()) {
			for (const [toolCallId, tool] of agent.tools) {
				if (tool.endedAt !== undefined && now - tool.endedAt > this.#activityTrailMs) {
					agent.tools.delete(toolCallId);
				}
			}
			const completed = [...agent.tools.values()]
				.filter(tool => tool.endedAt !== undefined)
				.sort((a, b) => a.startedAt - b.startedAt);
			while (agent.tools.size > MAX_ACTIVITY_TOOLS && completed.length > 0) {
				const oldest = completed.shift();
				if (oldest !== undefined) agent.tools.delete(oldest.toolCallId);
			}
			if (agent.id === "main" || agent.completedAt === undefined || now - agent.completedAt < scope.retentionMs)
				continue;
			this.#retireAgent(scope, agent);
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
			.map(agent => this.#agentSnapshot(agent, now))
			.sort((a, b) => {
				const left = scope.agents.get(a.sessionId)?.depth ?? 0;
				const right = scope.agents.get(b.sessionId)?.depth ?? 0;
				return left - right || a.id.localeCompare(b.id);
			});
		const activeOperations = trackedOperations.filter(operation => operation.endedAt === undefined);
		return {
			agents,
			retiredAgentIds: [...scope.retiredAgentIds],
			operations,
			resourceCatalog: aggregateResourceCatalog(scope.agents.values()),
			resourceUsage: resourceUsageSnapshot(scope.agents.values()),
			liveWriterCount: new Set(activeOperations.map(operation => operation.ownerSessionId)).size,
			pathCount: new Set(activeOperations.map(operation => operation.path)).size,
			runningCount: agents.filter(agent => agent.phase === "active").length,
			idleCount: agents.filter(agent => agent.phase !== "active").length,
			detail: scope.detail,
		};
	}

	#agentSnapshot(agent: TrackedAgent, now: number): ActivityAgentSnapshot {
		const phase =
			agent.completedAt === undefined
				? "active"
				: now - agent.completedAt <= this.#completionFlashMs
					? "completing"
					: "recent";
		const tools = [...agent.tools.values()].sort(
			(a, b) => a.startedAt - b.startedAt || a.toolCallId.localeCompare(b.toolCallId),
		);
		const current = tools.filter(tool => tool.endedAt === undefined).at(-1);
		const steps: ActivityStepSnapshot[] = [];
		for (const tool of tools) {
			const status: ActivityStepStatus = tool.endedAt === undefined ? "active" : tool.isError ? "error" : "complete";
			steps.push({
				id: `${tool.toolCallId}:tool`,
				kind: "tool",
				label: tool.toolName,
				status,
				startedAt: tool.startedAt,
			});
			for (const [index, target] of tool.targets.entries()) {
				steps.push({
					id: `${tool.toolCallId}:${target.kind}:${index}`,
					kind: target.kind,
					label: target.label,
					status,
					startedAt: tool.startedAt,
				});
			}
		}
		const provenance = Object.freeze(
			[...agent.provenance.values()]
				.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
				.map(entry =>
					Object.freeze({
						id: entry.id,
						kind: entry.kind,
						label: entry.label,
						status: entry.endedAt === undefined ? "active" : entry.isError ? "error" : "complete",
						startedAt: entry.startedAt,
					}),
				),
		);
		return {
			id: agent.id,
			parentId: agent.parentId,
			sessionId: agent.sessionId,
			model: agent.model,
			phase,
			startedAt: agent.startedAt,
			completedAt: agent.completedAt,
			terminalStatus: agent.terminalStatus,
			currentTool: current?.toolName,
			currentTarget: current?.targets[0]?.label,
			steps,
			provenance,
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
			consider(agent.completedAt + scope.retentionMs);
		}
		for (const outcome of scope.pendingAgentOutcomes.values()) {
			consider(outcome.completedAt + this.#completionFlashMs + 1);
			consider(outcome.completedAt + scope.retentionMs);
		}
		for (const agent of scope.agents.values()) {
			for (const tool of agent.tools.values()) {
				if (tool.endedAt !== undefined) consider(tool.endedAt + this.#activityTrailMs + 1);
			}
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
