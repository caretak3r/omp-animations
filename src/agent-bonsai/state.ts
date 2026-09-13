import * as path from "node:path";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export type AgentBonsaiStatus = "pending" | "running" | "idle" | "completed" | "parked" | "aborted";
export type AgentBonsaiKind = "main" | "sub" | "advisor";

export type AgentActivityStepKind = "tool" | "skill" | "file";
export type AgentActivityStepStatus = "active" | "complete" | "error";
export type AgentProvenanceKind = "skill" | "context-file" | "memory" | "qmd";
export type AgentProvenanceStatus = AgentActivityStepStatus;

export interface AgentActivityStep {
	readonly id: string;
	readonly kind: AgentActivityStepKind;
	readonly label: string;
	readonly status: AgentActivityStepStatus;
	readonly startedAt: number;
}

export interface AgentProvenanceEvent {
	readonly id: string;
	readonly kind: AgentProvenanceKind;
	readonly label: string;
	readonly status: AgentProvenanceStatus;
	readonly startedAt: number;
}

export interface AgentBonsaiRef {
	readonly id: string;
	readonly displayName: string;
	readonly kind: AgentBonsaiKind;
	readonly parentId?: string;
	readonly status: AgentBonsaiStatus;
	readonly createdAt: number;
	readonly completedAt?: number;
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
	readonly activitySteps?: ReadonlyMap<string, readonly AgentActivityStep[]>;
	readonly provenance?: ReadonlyMap<string, readonly AgentProvenanceEvent[]>;
	readonly collisions?: ReadonlySet<string>;
}

export interface AgentBonsaiNode {
	readonly id: string;
	readonly cohortLabel: string;
	readonly name: string;
	readonly depth: number;
	readonly isLast: boolean;
	readonly ancestorsLast: readonly boolean[];
	readonly status: AgentBonsaiStatus;
	/** Spawn time when the backing telemetry provides it. */
	readonly createdAt?: number;
	readonly completedAt?: number;
	readonly model?: string;
	readonly activeSkill?: AgentSkillRef;
	readonly loadedSkills: readonly AgentSkillRef[];
	readonly activitySteps?: readonly AgentActivityStep[];
	readonly provenance?: readonly AgentProvenanceEvent[];
	readonly gist?: string;
	readonly task?: string;
	readonly collision?: boolean;
}

export interface AgentBonsaiSnapshot {
	readonly nodes: readonly AgentBonsaiNode[];
	readonly hiddenCount: number;
	readonly hiddenAgentIds?: readonly string[];
	readonly visible: boolean;
}

export const MAX_BONSAI_ROWS = 8;
export const GIST_MAX_CHARS = 200;
const EMPTY_SNAPSHOT: AgentBonsaiSnapshot = { nodes: [], hiddenCount: 0, visible: false };

export function normalizeAgentLine(text: string, maxChars: number = GIST_MAX_CHARS): string {
	const sanitized = replaceTabs(sanitizeText(text.replace(/\r\n?/g, "\n")))
		.replace(/\s+/g, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
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

export function normalizeAgentDescription(text: string): string {
	return normalizeAgentLine(text.replace(/(?<![\w./~-])\/(?:Users|home)\/[^/\s]+\//gu, "~/"));
}

export function summarizeAgentTask(text: string): string {
	const sections = sanitizeText(text.replace(/\r\n?/g, "\n")).split(
		/^[\t ]*#{1,6}[\t ]+(?![\t ]*TODO\b)(.+?)(?:[\t ]+#+)?[\t ]*$/imu,
	);
	let body = sections[0] ?? "";
	let priority = 0;
	for (let index = 1; index < sections.length; index += 2) {
		const heading = normalizeAgentLine(sections[index] ?? "").toLowerCase();
		const candidate = sections[index + 1]?.trim();
		// Assignment intent is more useful than its file scope or acceptance checklist.
		const rank = heading === "change" ? 3 : heading === "target" ? 2 : 1;
		if (candidate && rank > priority) {
			body = candidate;
			priority = rank;
		}
	}
	const listMarker = /^(?:[-*+]|\d+[.)])\s+/u;
	if (sections.length === 1 && !listMarker.test(body.trim())) return normalizeAgentDescription(body);

	const paragraph: string[] = [];
	for (const line of body.trim().split(/\n|\u2028|\u2029/u)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || (paragraph.length > 0 && listMarker.test(trimmed))) break;
		paragraph.push(trimmed.replace(listMarker, ""));
	}
	return normalizeAgentDescription(paragraph.join(" ") || text);
}

function normalizeProvenanceLabel(event: AgentProvenanceEvent): string {
	const label = normalizeAgentLine(event.label);
	if (event.kind !== "context-file") return label;
	if (path.isAbsolute(label)) return path.basename(label);
	return path.win32.isAbsolute(label) ? path.win32.basename(label) : label;
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

	const ordered: AgentBonsaiRef[] = [];
	const collect = (ref: AgentBonsaiRef): void => {
		ordered.push(ref);
		for (const child of childrenOf.get(ref.id) ?? []) collect(child);
	};
	collect(root);
	if (ordered.length > MAX_BONSAI_ROWS) {
		const visible = new Set([root.id]);
		for (const ref of ordered) {
			if (visible.size === MAX_BONSAI_ROWS) break;
			if (ref.status === "running" || ref.status === "pending" || ref.status === "idle") visible.add(ref.id);
		}
		for (const ref of ordered) {
			if (visible.size === MAX_BONSAI_ROWS) break;
			visible.add(ref.id);
		}
		const byId = new Map(ordered.map(ref => [ref.id, ref]));
		childrenOf.clear();
		for (const ref of ordered) {
			if (ref.id === root.id || !visible.has(ref.id)) continue;
			let parentId = ref.parentId;
			while (parentId !== undefined && !visible.has(parentId)) parentId = byId.get(parentId)?.parentId;
			const siblings = childrenOf.get(parentId ?? root.id);
			if (siblings) siblings.push(ref);
			else childrenOf.set(parentId ?? root.id, [ref]);
		}
	}

	const nodes: AgentBonsaiNode[] = [];
	const visit = (ref: AgentBonsaiRef, depth: number, isLast: boolean, ancestorsLast: readonly boolean[]): void => {
		nodes.push(toNode(ref, depth, isLast, ancestorsLast, caches));
		const children = childrenOf.get(ref.id) ?? [];
		const childAncestors = depth === 0 ? ancestorsLast : [...ancestorsLast, isLast];
		for (const [index, child] of children.entries()) {
			visit(child, depth + 1, index === children.length - 1, childAncestors);
		}
	};
	visit(root, 0, true, []);
	const hiddenCount = ordered.length - nodes.length;
	if (hiddenCount === 0) return { nodes, hiddenCount, visible: ordered.length > 1 };
	const visibleIds = new Set(nodes.map(node => node.id));
	return {
		nodes,
		hiddenCount,
		hiddenAgentIds: ordered.filter(ref => !visibleIds.has(ref.id)).map(ref => ref.displayName),
		visible: ordered.length > 1,
	};
}

function toNode(
	ref: AgentBonsaiRef,
	depth: number,
	isLast: boolean,
	ancestorsLast: readonly boolean[],
	caches: AgentBonsaiCaches,
): AgentBonsaiNode {
	const name = normalizeAgentLine(ref.displayName);
	const gist = ref.status === "running" && ref.activity ? normalizeAgentDescription(ref.activity) : undefined;
	const cachedTask = caches.task?.get(ref.id);
	const task = cachedTask === undefined ? undefined : normalizeAgentDescription(cachedTask);
	const cohort = caches.cohort?.get(ref.id);
	return {
		id: ref.id,
		cohortLabel: ref.kind === "main" ? "M" : `A${cohort ?? "?"}`,
		name,
		depth,
		isLast,
		ancestorsLast,
		status: ref.status,
		createdAt: ref.createdAt,
		completedAt: ref.completedAt,
		model: caches.model?.get(ref.id),
		activeSkill: caches.activeSkill?.get(ref.id),
		loadedSkills: caches.loadedSkills?.get(ref.id) ?? [],
		activitySteps:
			caches.activitySteps?.get(ref.id)?.map(step => ({
				...step,
				label: normalizeAgentLine(step.label),
			})) ?? [],
		provenance:
			caches.provenance
				?.get(ref.id)
				?.map(event => ({ ...event, label: normalizeProvenanceLabel(event) }))
				.sort((left, right) => left.startedAt - right.startedAt) ?? [],
		gist,
		task: task !== undefined && task !== name ? task : undefined,
		collision: caches.collisions?.has(ref.id),
	};
}

function isRenderableDetachedRef(ref: AgentBonsaiRef, caches: AgentBonsaiCaches): boolean {
	if (ref.status !== "parked" && ref.status !== "aborted") return true;
	return caches.seen?.has(ref.id) === true;
}
