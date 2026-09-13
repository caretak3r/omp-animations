import {
	type AgentActivityStep,
	type AgentBonsaiNode,
	type AgentBonsaiRef,
	type AgentBonsaiSnapshot,
	type AgentProvenanceEvent,
	buildAgentBonsai,
} from "../agent-bonsai";
import type { SegmentSample } from "../animations-box/segments";
import { buildLiveFilesSnapshotSegment, type LiveFileEntry, type LiveFileSnapshot } from "../live-files";
import type { ActivityAgentSnapshot, ActivityRosterSnapshot } from "./bus";

const EMPTY_AGENTS: AgentBonsaiSnapshot = { nodes: [], hiddenCount: 0, visible: false };

function agentStatus(agent: ActivityAgentSnapshot): AgentBonsaiRef["status"] {
	if (agent.terminalStatus !== undefined) return agent.terminalStatus;
	if (agent.phase === "active") return "running";
	return "completed";
}

interface FallbackAgentIndex {
	readonly byKey: ReadonlyMap<string, AgentBonsaiNode>;
	readonly nodes: readonly AgentBonsaiNode[];
}

function fallbackAgents(snapshot: AgentBonsaiSnapshot | undefined): FallbackAgentIndex {
	const nodes = snapshot?.nodes ?? [];
	const byKey = new Map<string, AgentBonsaiNode>();
	for (const node of nodes) {
		if (node.depth === 0) continue;
		byKey.set(node.id, node);
	}
	return { byKey, nodes };
}

function cohortNumber(node: AgentBonsaiNode | undefined, fallback: number): number {
	const parsed = node?.cohortLabel.match(/^A(\d+)$/u)?.[1];
	return parsed === undefined ? fallback : Number(parsed);
}

function exactAgentSnapshot(
	roster: ActivityRosterSnapshot,
	fallback: AgentBonsaiSnapshot | undefined,
): AgentBonsaiSnapshot {
	const ids = new Set(roster.agents.map(agent => agent.id));
	const retiredIds = new Set(roster.retiredAgentIds);
	const inferred = fallbackAgents(fallback);
	const consumedFallback = new Set<AgentBonsaiNode>();
	const refs: AgentBonsaiRef[] = [];
	const models = new Map<string, string>();
	const tasks = new Map<string, string>();
	const cohorts = new Map<string, number>();
	const activeSkills = new Map<string, NonNullable<AgentBonsaiNode["activeSkill"]>>();
	const loadedSkills = new Map<string, NonNullable<AgentBonsaiNode["loadedSkills"]>>();
	const activitySteps = new Map<string, readonly AgentActivityStep[]>();
	const provenance = new Map<string, readonly AgentProvenanceEvent[]>();
	let nextCohort = 1;
	for (const [index, agent] of roster.agents.entries()) {
		const metadata =
			agent.id === "main" ? inferred.nodes.find(node => node.depth === 0) : inferred.byKey.get(agent.id);
		if (metadata !== undefined) consumedFallback.add(metadata);
		refs.push({
			id: agent.id,
			displayName: metadata?.name ?? agent.id,
			kind: agent.id === "main" ? "main" : "sub",
			parentId:
				agent.parentId !== undefined && ids.has(agent.parentId)
					? agent.parentId
					: agent.id === "main"
						? undefined
						: "main",
			status:
				agent.terminalStatus === "aborted" || metadata?.status === "aborted"
					? "aborted"
					: metadata?.status === "completed"
						? "completed"
						: metadata?.status === "pending" &&
								agent.completedAt === undefined &&
								agent.startedAt === undefined &&
								agent.currentTool === undefined &&
								agent.steps.length === 0 &&
								agent.provenance.length === 0
							? "pending"
							: agentStatus(agent),
			createdAt: metadata?.createdAt ?? index,
			completedAt:
				agent.completedAt === undefined
					? metadata?.completedAt
					: Math.min(agent.completedAt, metadata?.completedAt ?? agent.completedAt),
			activity: metadata?.gist,
		});
		const model = agent.model ?? metadata?.model;
		if (model !== undefined) models.set(agent.id, model);
		if (metadata?.task !== undefined) tasks.set(agent.id, metadata.task);
		if (metadata?.activeSkill !== undefined) activeSkills.set(agent.id, metadata.activeSkill);
		if (metadata?.loadedSkills !== undefined) loadedSkills.set(agent.id, metadata.loadedSkills);
		if (agent.id !== "main") cohorts.set(agent.id, cohortNumber(metadata, nextCohort++));
		activitySteps.set(agent.id, agent.steps);
		provenance.set(agent.id, agent.provenance);
	}
	const mainId = refs.find(ref => ref.kind === "main")?.id;
	if (mainId !== undefined) {
		for (const node of inferred.nodes) {
			if (node.depth === 0 || consumedFallback.has(node) || retiredIds.has(node.id)) continue;
			refs.push({
				id: node.id,
				displayName: node.name,
				kind: "sub",
				parentId: mainId,
				status: node.status,
				createdAt: node.createdAt ?? refs.length,
				completedAt: node.completedAt,
				activity: node.gist,
			});
			ids.add(node.id);
			if (node.model !== undefined) models.set(node.id, node.model);
			if (node.task !== undefined) tasks.set(node.id, node.task);
			cohorts.set(node.id, cohortNumber(node, nextCohort++));
			if (node.activeSkill !== undefined) activeSkills.set(node.id, node.activeSkill);
			loadedSkills.set(node.id, node.loadedSkills);
			if (node.activitySteps !== undefined) activitySteps.set(node.id, node.activitySteps);
			if (node.provenance !== undefined) provenance.set(node.id, node.provenance);
		}
	}
	const projected = buildAgentBonsai(refs, {
		model: models,
		task: tasks,
		seen: ids,
		cohort: cohorts,
		activeSkill: activeSkills,
		loadedSkills,
		activitySteps,
		provenance,
		collisions: writeCollisions(roster).agentIds,
	});
	const hiddenAgentIds = new Set(projected.hiddenAgentIds);
	for (const id of fallback?.hiddenAgentIds ?? []) {
		if (!retiredIds.has(id) && !ids.has(id)) hiddenAgentIds.add(id);
	}
	const hiddenCount = hiddenAgentIds.size;
	return {
		...projected,
		hiddenCount,
		...(hiddenCount > 0 ? { hiddenAgentIds: [...hiddenAgentIds] } : {}),
		visible: projected.visible || hiddenCount > 0,
	};
}

export function projectActivityAgents(
	roster: ActivityRosterSnapshot | undefined,
	fallback: AgentBonsaiSnapshot | undefined,
): AgentBonsaiSnapshot {
	if (roster === undefined) return fallback ?? EMPTY_AGENTS;
	return exactAgentSnapshot(roster, fallback);
}

function activeEntries(
	roster: ActivityRosterSnapshot | undefined,
	fallback: LiveFileSnapshot,
): readonly LiveFileEntry[] {
	const exact =
		roster?.operations
			.filter(operation => operation.phase === "active")
			.map(operation => ({
				owner: operation.agentId,
				path: operation.path,
				tool: operation.tool,
				startedAt: operation.startedAt,
			})) ?? [];
	const keys = new Set(exact.map(entry => `${entry.owner}:${entry.path}`));
	return [...exact, ...fallback.entries.filter(entry => !keys.has(`${entry.owner}:${entry.path}`))];
}

interface WriteCollisions {
	readonly paths: readonly string[];
	readonly agentIds: ReadonlySet<string>;
}

const NO_COLLISIONS: WriteCollisions = { paths: [], agentIds: new Set() };

/** Paths with ≥ 2 distinct agents holding an active operation, and those agents. Exact roster data only — fallback entries cannot prove a collision. */
function writeCollisions(roster: ActivityRosterSnapshot | undefined): WriteCollisions {
	if (roster === undefined) return NO_COLLISIONS;
	const ownersByPath = new Map<string, Set<string>>();
	for (const operation of roster.operations) {
		if (operation.phase !== "active") continue;
		const owners = ownersByPath.get(operation.path);
		if (owners === undefined) ownersByPath.set(operation.path, new Set([operation.agentId]));
		else owners.add(operation.agentId);
	}
	const paths: string[] = [];
	const agentIds = new Set<string>();
	for (const [filePath, owners] of ownersByPath) {
		if (owners.size < 2) continue;
		paths.push(filePath);
		for (const agentId of owners) agentIds.add(agentId);
	}
	return { paths, agentIds };
}

export function projectActivityTitleFiles(
	roster: ActivityRosterSnapshot | undefined,
	fallback: LiveFileSnapshot,
): LiveFileSnapshot {
	const writers = new Map<string, LiveFileEntry>();
	for (const entry of activeEntries(roster, fallback)) {
		if (!writers.has(entry.owner)) writers.set(entry.owner, entry);
	}
	return { entries: [...writers.values()] };
}

export function buildActivityFilesSegment(
	roster: ActivityRosterSnapshot | undefined,
	fallback: LiveFileSnapshot,
	priority: number,
): SegmentSample {
	return buildLiveFilesSnapshotSegment(
		{ entries: activeEntries(roster, fallback), collidingPaths: writeCollisions(roster).paths },
		priority,
	);
}
