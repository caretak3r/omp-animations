import {
	extractTaskAsyncState,
	extractTaskProgress,
	skillNamesFromProgress,
	type TaskAgentProgress,
	type TaskAgentStatus,
} from "./progress";
import { createSkillPathResolver, type SkillPathResolver } from "./skill-paths";
import {
	type AgentBonsaiNode,
	type AgentBonsaiRef,
	type AgentBonsaiSnapshot,
	type AgentSkillRef,
	buildAgentBonsai,
	normalizeAgentLine,
} from "./state";

export const MAIN_BONSAI_ID = "Main";
const EMPTY_SNAPSHOT: AgentBonsaiSnapshot = { nodes: [], hiddenCount: 0, visible: false };

/** Subset of `tool_execution_update` the Bonsai reads. */
export interface TaskUpdateEvent {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly partialResult: unknown;
}

/** Subset of `tool_execution_end` the Bonsai reads. */
export interface TaskEndEvent {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly result?: unknown;
	readonly isError?: boolean;
}

export interface AgentBonsaiControllerOptions {
	/** Fired whenever the snapshot changes; the Box uses it to request a render. */
	readonly onChange?: () => void;
	/** Resolves a skill name to its `SKILL.md`; defaults to a disk scan rooted at `cwd`. */
	readonly resolveSkillPath?: SkillPathResolver;
	readonly cwd?: string;
	readonly now?: () => number;
}

interface AgentEntry {
	readonly id: string;
	readonly name: string;
	readonly cohort: number;
	readonly createdAt: number;
	status: TaskAgentStatus;
	model?: string;
	task?: string;
	activity?: string;
	activeSkill?: string;
	/** Every skill name seen so far, insertion-ordered — `recentTools` rotates. */
	readonly skills: Set<string>;
}

const STATUS_MAP: Readonly<Record<TaskAgentStatus, AgentBonsaiRef["status"]>> = {
	pending: "idle",
	running: "running",
	completed: "idle",
	failed: "aborted",
	aborted: "aborted",
};

function nodeKey(node: AgentBonsaiNode): string {
	const skills = node.loadedSkills.map(skill => skill.name).join(",");
	return [
		node.id,
		node.cohortLabel,
		node.name,
		node.depth,
		node.isLast,
		node.status,
		node.model ?? "",
		node.activeSkill?.name ?? "",
		skills,
		node.gist ?? "",
		node.task ?? "",
	].join("\u0000");
}

function snapshotsEqual(a: AgentBonsaiSnapshot, b: AgentBonsaiSnapshot): boolean {
	if (a.visible !== b.visible || a.hiddenCount !== b.hiddenCount || a.nodes.length !== b.nodes.length) return false;
	for (const [index, node] of a.nodes.entries()) {
		const other = b.nodes[index];
		if (other === undefined || nodeKey(node) !== nodeKey(other)) return false;
	}
	return true;
}

/**
 * Headless subagent observer consumed by the Audit Box widget.
 *
 * Fed by the `task` tool's streamed progress rather than the host's agent
 * registry — see `progress.ts` for why the registry is unreachable from a
 * plugin. Finished subagents stay on the tree for the rest of the agent loop and
 * are dropped when the next user request starts, so a completed run is still
 * readable after it lands — pruning per provider turn would erase a subagent the
 * moment the parent resumed reasoning about its result.
 */
export class AgentBonsaiController {
	#onChange: () => void;
	#resolveSkillPath: SkillPathResolver;
	#now: () => number;
	#snapshot: AgentBonsaiSnapshot = EMPTY_SNAPSHOT;
	#agents = new Map<string, AgentEntry>();
	#skillPaths = new Map<string, AgentSkillRef>();
	#mainModel: string | undefined;
	#mainBusy = false;
	#mounted = false;
	#nextCohort = 1;

	constructor(options: AgentBonsaiControllerOptions = {}) {
		this.#onChange = options.onChange ?? (() => {});
		this.#resolveSkillPath = options.resolveSkillPath ?? createSkillPathResolver(options.cwd ?? process.cwd());
		this.#now = options.now ?? Date.now;
	}

	snapshot(): AgentBonsaiSnapshot {
		return this.#snapshot;
	}

	mount(): void {
		this.#mounted = true;
		this.#agents.clear();
		this.#nextCohort = 1;
		this.#rebuild();
	}

	dispose(): void {
		this.#mounted = false;
		this.#agents.clear();
		this.#skillPaths.clear();
		this.#mainModel = undefined;
		this.#mainBusy = false;
		this.#nextCohort = 1;
		this.#snapshot = EMPTY_SNAPSHOT;
	}

	/** Record the parent session's model so the root row is labelled like its children. */
	noteMainModel(model: string | undefined): void {
		const next = model === undefined ? undefined : normalizeAgentLine(model);
		if (next === this.#mainModel) return;
		this.#mainModel = next;
		this.#rebuild();
	}

	/** New user request: drop settled subagents so the tree shows the work in flight. */
	onAgentStart(): void {
		this.#mainBusy = true;
		for (const [id, entry] of this.#agents) {
			if (entry.status === "running" || entry.status === "pending") continue;
			this.#agents.delete(id);
		}
		this.#rebuild();
	}

	/** Agent loop settled; `willContinue` marks an automatic continuation, not a user-visible end. */
	onAgentEnd(willContinue = false): void {
		if (willContinue) return;
		this.#mainBusy = false;
		this.#rebuild();
	}

	onToolExecutionUpdate(event: TaskUpdateEvent): void {
		if (event.toolName !== "task") return;
		const progress = extractTaskProgress(event.partialResult);
		if (progress === undefined) return;
		for (const row of progress) this.#applyProgress(event.toolCallId, row);
		this.#rebuild();
	}

	onToolExecutionEnd(event: TaskEndEvent): void {
		if (event.toolName !== "task") return;
		const progress = extractTaskProgress(event.result);
		if (progress !== undefined) {
			for (const row of progress) this.#applyProgress(event.toolCallId, row);
		}
		// A backgrounded job keeps reporting after its call returns, so only a
		// synchronous task settles its agents here.
		if (extractTaskAsyncState(event.result) !== "running") {
			const prefix = `${event.toolCallId}:`;
			for (const entry of this.#agents.values()) {
				if (!entry.id.startsWith(prefix)) continue;
				if (entry.status !== "running" && entry.status !== "pending") continue;
				entry.status = event.isError === true ? "failed" : "completed";
				entry.activity = undefined;
			}
		}
		this.#rebuild();
	}

	#applyProgress(toolCallId: string, row: TaskAgentProgress): void {
		const id = `${toolCallId}:${row.id}`;
		let entry = this.#agents.get(id);
		if (entry === undefined) {
			entry = {
				id,
				name: normalizeAgentLine(row.id),
				cohort: this.#nextCohort++,
				createdAt: this.#now(),
				status: row.status,
				skills: new Set<string>(),
			};
			this.#agents.set(id, entry);
		}
		entry.status = row.status;
		if (row.resolvedModel !== undefined) entry.model = normalizeAgentLine(row.resolvedModel);
		const activity = row.lastIntent ?? row.currentTool;
		entry.activity = activity === undefined ? undefined : normalizeAgentLine(activity);
		const task = row.description ?? row.task;
		if (entry.task === undefined && task !== undefined) entry.task = normalizeAgentLine(task);
		for (const skill of skillNamesFromProgress(row)) {
			entry.skills.add(skill);
			entry.activeSkill = skill;
		}
	}

	#skillRef(name: string): AgentSkillRef {
		const cached = this.#skillPaths.get(name);
		if (cached !== undefined) return cached;
		const ref: AgentSkillRef = { name, path: this.#resolveSkillPath(name) ?? `skill://${name}` };
		this.#skillPaths.set(name, ref);
		return ref;
	}

	#rebuild(): void {
		if (!this.#mounted) return;
		const refs: AgentBonsaiRef[] = [
			{
				id: MAIN_BONSAI_ID,
				displayName: MAIN_BONSAI_ID,
				kind: "main",
				status: this.#mainBusy ? "running" : "idle",
				createdAt: 0,
			},
		];
		const model = new Map<string, string>();
		const task = new Map<string, string>();
		const cohort = new Map<string, number>();
		const activeSkill = new Map<string, AgentSkillRef>();
		const loadedSkills = new Map<string, readonly AgentSkillRef[]>();
		const seen = new Set<string>();
		if (this.#mainModel !== undefined) model.set(MAIN_BONSAI_ID, this.#mainModel);
		for (const entry of [...this.#agents.values()].sort((a, b) => a.cohort - b.cohort)) {
			refs.push({
				id: entry.id,
				displayName: entry.name,
				kind: "sub",
				parentId: MAIN_BONSAI_ID,
				status: STATUS_MAP[entry.status],
				createdAt: entry.createdAt,
				activity: entry.activity,
			});
			seen.add(entry.id);
			cohort.set(entry.id, entry.cohort);
			if (entry.model !== undefined) model.set(entry.id, entry.model);
			if (entry.task !== undefined) task.set(entry.id, entry.task);
			if (entry.skills.size > 0) {
				loadedSkills.set(
					entry.id,
					[...entry.skills].map(name => this.#skillRef(name)),
				);
			}
			if (entry.activeSkill !== undefined) activeSkill.set(entry.id, this.#skillRef(entry.activeSkill));
		}
		const next = buildAgentBonsai(refs, { model, task, seen, cohort, activeSkill, loadedSkills });
		if (snapshotsEqual(this.#snapshot, next)) return;
		this.#snapshot = next;
		this.#onChange();
	}
}
