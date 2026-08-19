import { type AgentBonsaiRef, type AgentBonsaiSnapshot, buildAgentBonsai } from "../agent-bonsai";
import type { SegmentSample } from "../animations-box/segments";
import { buildLiveFilesSnapshotSegment, type LiveFileEntry, type LiveFileSnapshot } from "../live-files";
import type { ActivityAgentSnapshot, ActivityRosterSnapshot } from "./bus";

const EMPTY_AGENTS: AgentBonsaiSnapshot = { nodes: [], hiddenCount: 0, visible: false };

function agentStatus(agent: ActivityAgentSnapshot): AgentBonsaiRef["status"] {
	if (agent.phase === "active") return "running";
	if (agent.phase === "completing") return "idle";
	return "parked";
}

function agentActivity(agent: ActivityAgentSnapshot): string | undefined {
	if (agent.currentTool === undefined) return undefined;
	return agent.currentTarget === undefined ? agent.currentTool : `${agent.currentTool} ${agent.currentTarget}`;
}

function exactAgentSnapshot(roster: ActivityRosterSnapshot): AgentBonsaiSnapshot {
	const ids = new Set(roster.agents.map(agent => agent.id));
	const refs = roster.agents.map<AgentBonsaiRef>((agent, index) => ({
		id: agent.id,
		displayName: agent.id,
		kind: agent.id === "main" ? "main" : "sub",
		parentId:
			agent.parentId !== undefined && ids.has(agent.parentId)
				? agent.parentId
				: agent.id === "main"
					? undefined
					: "main",
		status: agentStatus(agent),
		createdAt: index,
		activity: agentActivity(agent),
	}));
	const models = new Map(roster.agents.flatMap(agent => (agent.model === undefined ? [] : [[agent.id, agent.model]])));
	return buildAgentBonsai(refs, { model: models, seen: ids });
}

export function projectActivityAgents(
	roster: ActivityRosterSnapshot | undefined,
	fallback: AgentBonsaiSnapshot | undefined,
): AgentBonsaiSnapshot {
	if (roster === undefined) return fallback ?? EMPTY_AGENTS;
	return exactAgentSnapshot(roster);
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
	return buildLiveFilesSnapshotSegment({ entries: activeEntries(roster, fallback) }, priority);
}
