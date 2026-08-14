import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export type AgentBonsaiStatus = "running" | "idle" | "parked" | "aborted";
export type AgentBonsaiKind = "main" | "sub" | "advisor";

export interface AgentBonsaiRef {
	readonly id: string;
	readonly displayName: string;
	readonly kind: AgentBonsaiKind;
	readonly parentId?: string;
	readonly status: AgentBonsaiStatus;
	readonly createdAt: number;
	readonly activity?: string;
}

export interface AgentSkillRef {
	readonly name: string;
	readonly path: string;
}

export interface AgentBonsaiCaches {
	readonly model?: ReadonlyMap<string, string>;
	readonly task?: ReadonlyMap<string, string>;
	readonly seen?: ReadonlySet<string>;
	readonly cohort?: ReadonlyMap<string, number>;
	readonly activeSkill?: ReadonlyMap<string, AgentSkillRef>;
	readonly loadedSkills?: ReadonlyMap<string, readonly AgentSkillRef[]>;
}

export interface AgentBonsaiNode {
	readonly id: string;
	readonly cohortLabel: string;
	readonly name: string;
	readonly depth: number;
	readonly isLast: boolean;
	readonly ancestorsLast: readonly boolean[];
	readonly status: AgentBonsaiStatus;
	readonly model?: string;
	readonly activeSkill?: AgentSkillRef;
	readonly loadedSkills: readonly AgentSkillRef[];
	readonly gist?: string;
	readonly task?: string;
}

export interface AgentBonsaiSnapshot {
	readonly nodes: readonly AgentBonsaiNode[];
	readonly hiddenCount: number;
	readonly visible: boolean;
}

export const MAX_BONSAI_ROWS = 8;
export const GIST_MAX_CHARS = 200;
const EMPTY_SNAPSHOT: AgentBonsaiSnapshot = { nodes: [], hiddenCount: 0, visible: false };

export function normalizeAgentLine(text: string, maxChars: number = GIST_MAX_CHARS): string {
	const sanitized = replaceTabs(sanitizeText(text))
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return truncateCodePoints(sanitized, maxChars);
}

function truncateCodePoints(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const chars = [...text];
	if (chars.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function buildAgentBonsai(refs: readonly AgentBonsaiRef[], caches: AgentBonsaiCaches = {}): AgentBonsaiSnapshot {
	const peers = refs.filter(ref => ref.kind !== "advisor");
	let root: AgentBonsaiRef | undefined;
	for (const ref of peers) {
		if (ref.kind !== "main") continue;
		if (root === undefined || ref.createdAt < root.createdAt) root = ref;
	}
	if (root === undefined) return EMPTY_SNAPSHOT;

	const childrenOf = new Map<string, AgentBonsaiRef[]>();
	for (const ref of peers) {
		if (ref.kind !== "sub" || ref.parentId === undefined || !isRenderableDetachedRef(ref, caches)) continue;
		const siblings = childrenOf.get(ref.parentId);
		if (siblings) siblings.push(ref);
		else childrenOf.set(ref.parentId, [ref]);
	}
	for (const siblings of childrenOf.values()) {
		siblings.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	const nodes: AgentBonsaiNode[] = [];
	let total = 0;
	const visit = (ref: AgentBonsaiRef, depth: number, isLast: boolean, ancestorsLast: readonly boolean[]): void => {
		total++;
		if (nodes.length < MAX_BONSAI_ROWS) nodes.push(toNode(ref, depth, isLast, ancestorsLast, caches));
		const children = childrenOf.get(ref.id) ?? [];
		const childAncestors = depth === 0 ? ancestorsLast : [...ancestorsLast, isLast];
		for (let i = 0; i < children.length; i++) {
			visit(children[i] as AgentBonsaiRef, depth + 1, i === children.length - 1, childAncestors);
		}
	};
	visit(root, 0, true, []);
	return { nodes, hiddenCount: total - nodes.length, visible: total > 1 };
}

function toNode(
	ref: AgentBonsaiRef,
	depth: number,
	isLast: boolean,
	ancestorsLast: readonly boolean[],
	caches: AgentBonsaiCaches,
): AgentBonsaiNode {
	const name = normalizeAgentLine(ref.displayName);
	const gist = ref.status === "running" && ref.activity ? normalizeAgentLine(ref.activity, GIST_MAX_CHARS) : undefined;
	const cachedTask = caches.task?.get(ref.id);
	const task = cachedTask === undefined ? undefined : normalizeAgentLine(cachedTask);
	const cohort = caches.cohort?.get(ref.id);
	return {
		id: ref.id,
		cohortLabel: ref.kind === "main" ? "M" : `A${cohort ?? "?"}`,
		name,
		depth,
		isLast,
		ancestorsLast,
		status: ref.status,
		model: caches.model?.get(ref.id),
		activeSkill: caches.activeSkill?.get(ref.id),
		loadedSkills: caches.loadedSkills?.get(ref.id) ?? [],
		gist,
		task: task !== undefined && task !== name ? task : undefined,
	};
}

function isRenderableDetachedRef(ref: AgentBonsaiRef, caches: AgentBonsaiCaches): boolean {
	if (ref.status !== "parked" && ref.status !== "aborted") return true;
	return caches.seen?.has(ref.id) === true;
}
