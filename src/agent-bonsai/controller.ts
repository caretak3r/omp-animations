import { FULL_FLASH_MS } from "../animations-box/status-line";
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
	normalizeAgentDescription,
	normalizeAgentLine,
	summarizeAgentTask,
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
	readonly settleSeconds?: number;
	readonly onAgentOutcome?: (id: string, outcome: "completed" | "aborted", completedAt: number) => void;
}

interface AgentEntry {
	readonly id: string;
	readonly name: string;
	readonly cohort: number;
	readonly createdAt: number;
	status: TaskAgentStatus;
	toolCallId: string;
	completedAt?: number;
	model?: string;
	task?: string;
	activity?: string;
	activeSkill?: string;
	/** Every skill name seen so far, insertion-ordered — `recentTools` rotates. */
	readonly skills: Set<string>;
}

const STATUS_MAP: Readonly<Record<TaskAgentStatus, AgentBonsaiRef["status"]>> = {
	pending: "pending",
	running: "running",
	completed: "completed",
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
		node.completedAt ?? "",
		node.model ?? "",
		node.activeSkill?.name ?? "",
		skills,
		node.gist ?? "",
		node.task ?? "",
	].join("\u0000");
}

function snapshotsEqual(a: AgentBonsaiSnapshot, b: AgentBonsaiSnapshot): boolean {
	if (a.visible !== b.visible || a.hiddenCount !== b.hiddenCount || a.nodes.length !== b.nodes.length) return false;
	if (
		a.hiddenAgentIds?.length !== b.hiddenAgentIds?.length ||
		a.hiddenAgentIds?.some((id, index) => id !== b.hiddenAgentIds?.[index])
	)
		return false;
	for (const [index, node] of a.nodes.entries()) {
		const other = b.nodes[index];
		if (other === undefined || nodeKey(node) !== nodeKey(other)) return false;
	}
	return true;
}

/**
 * Headless subagent observer consumed by the Audit Box widget.
 *
 * Fed by the task tool's streamed progress. Terminal entries retain their first
 * completion time until the next request, so repeated progress cannot renew an
 * announcement or bring an expired row back.
 */
export class AgentBonsaiController {
	#onChange: () => void;
	#resolveSkillPath: SkillPathResolver;
	#now: () => number;
	#retentionMs: number;
	readonly #onAgentOutcome: AgentBonsaiControllerOptions["onAgentOutcome"];
	#nextExpiryAt = Number.POSITIVE_INFINITY;
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
		const seconds = options.settleSeconds ?? 300;
		this.#retentionMs = Math.max(FULL_FLASH_MS, (Number.isFinite(seconds) ? Math.max(0, seconds) : 300) * 1_000);
		this.#onAgentOutcome = options.onAgentOutcome;
	}

	snapshot(retiredAgentIds?: readonly string[]): AgentBonsaiSnapshot {
		if (this.#now() >= this.#nextExpiryAt) this.#rebuild(false);
		if (this.#mounted && retiredAgentIds?.length) return this.#buildSnapshot(new Set(retiredAgentIds));
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
		this.#nextExpiryAt = Number.POSITIVE_INFINITY;
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
			for (const entry of this.#agents.values()) {
				if (entry.toolCallId !== event.toolCallId) continue;
				if (entry.status !== "running" && entry.status !== "pending") continue;
				entry.status = event.isError === true ? "failed" : "completed";
				entry.completedAt = this.#now();
				entry.activity = undefined;
				this.#reportOutcome(entry);
			}
		}
		this.#rebuild();
	}

	#applyProgress(toolCallId: string, row: TaskAgentProgress): void {
		const id = row.id;
		let entry = this.#agents.get(id);
		if (entry === undefined) {
			entry = {
				id,
				name: row.id,
				cohort: this.#nextCohort++,
				createdAt: this.#now(),
				status: row.status,
				toolCallId,
				skills: new Set<string>(),
			};
			this.#agents.set(id, entry);
		} else if (entry.toolCallId !== toolCallId) {
			if (entry.completedAt !== undefined) {
				this.#agents.delete(id);
				entry = {
					id,
					name: row.id,
					cohort: this.#nextCohort++,
					createdAt: this.#now(),
					status: row.status,
					toolCallId,
					skills: new Set<string>(),
				};
				this.#agents.set(id, entry);
			} else {
				entry.toolCallId = toolCallId;
			}
		}
		if (entry.completedAt === undefined) {
			entry.status = row.status;
			if (row.status !== "running" && row.status !== "pending") entry.completedAt = this.#now();
		} else if (row.status === "failed" || row.status === "aborted") {
			entry.status = row.status;
		}
		if (row.resolvedModel !== undefined) entry.model = normalizeAgentLine(row.resolvedModel);
		const activity = row.lastIntent ?? row.currentTool;
		entry.activity =
			entry.status !== "running" || activity === undefined ? undefined : normalizeAgentDescription(activity);
		const task = row.description ?? row.task;
		if (entry.task === undefined && task !== undefined) entry.task = summarizeAgentTask(task);
		for (const skill of skillNamesFromProgress(row)) {
			entry.skills.add(skill);
			entry.activeSkill = skill;
		}
		this.#reportOutcome(entry);
	}

	#reportOutcome(entry: AgentEntry): void {
		if (entry.completedAt === undefined) return;
		this.#onAgentOutcome?.(entry.name, entry.status === "completed" ? "completed" : "aborted", entry.completedAt);
	}

	#skillRef(name: string): AgentSkillRef {
		const cached = this.#skillPaths.get(name);
		if (cached !== undefined) return cached;
		const ref: AgentSkillRef = { name, path: this.#resolveSkillPath(name) ?? `skill://${name}` };
		this.#skillPaths.set(name, ref);
		return ref;
	}

	#rebuild(notify = true): void {
		if (!this.#mounted) return;
		const next = this.#buildSnapshot();
		if (snapshotsEqual(this.#snapshot, next)) return;
		this.#snapshot = next;
		if (notify) this.#onChange();
	}

	#buildSnapshot(retiredAgentIds?: ReadonlySet<string>): AgentBonsaiSnapshot {
		const now = this.#now();
		let nextExpiryAt = Number.POSITIVE_INFINITY;
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
			if (retiredAgentIds?.has(entry.id)) continue;
			if (entry.completedAt !== undefined) {
				const expiresAt = entry.completedAt + this.#retentionMs;
				if (now >= expiresAt) continue;
				nextExpiryAt = Math.min(nextExpiryAt, expiresAt);
			}
			refs.push({
				id: entry.id,
				displayName: entry.name,
				kind: "sub",
				parentId: MAIN_BONSAI_ID,
				status: STATUS_MAP[entry.status],
				createdAt: entry.createdAt,
				completedAt: entry.completedAt,
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
		if (retiredAgentIds === undefined) this.#nextExpiryAt = nextExpiryAt;
		return buildAgentBonsai(refs, { model, task, seen, cohort, activeSkill, loadedSkills });
	}
}
