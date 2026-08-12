/**
 * Agent Tree — pure state model (Plan 019 S1).
 *
 * Turns one `AgentRegistry.list()` snapshot into an ordered, capped tree of
 * renderable nodes. Pure and wall-clock-free: refs and per-agent caches go in,
 * `AgentNode[]` comes out. Everything display-adjacent (connectors, dots,
 * width fitting, flash) lives in `widget.ts`; everything registry-adjacent
 * (session caches, eviction, lifecycle) lives in `controller.ts`.
 */
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Registry agent status — mirrors `AgentStatus` from `registry/agent-registry.d.ts`. */
export type AgentTreeStatus = "running" | "idle" | "parked" | "aborted";

/** Registry agent kind — mirrors `AgentKind`. Only `main`/`sub` render (D5). */
export type AgentTreeKind = "main" | "sub" | "advisor";

/**
 * The slice of the registry's `AgentRef` the tree consumes. Structural on
 * purpose: the real `AgentRef` satisfies it, and tests build plain objects
 * without fabricating sessions or session files.
 */
export interface AgentTreeRef {
	readonly id: string;
	readonly displayName: string;
	readonly kind: AgentTreeKind;
	readonly parentId?: string;
	readonly status: AgentTreeStatus;
	readonly createdAt: number;
	/** Harness-maintained one-line gist; only `running` agents receive heartbeats. */
	readonly activity?: string;
}

/**
 * Controller-maintained per-agent-id caches (D3): `session` is null exactly
 * when parked/aborted, so last-seen model and derived task lines outlive the
 * live session and are evicted only on `removed`.
 */
export interface AgentTreeCaches {
	/** Last-seen `model.id` tail (after the provider `/`), keyed by agent id. */
	readonly modelTail?: ReadonlyMap<string, string>;
	/** Derived task line (first user message, one bounded line), keyed by agent id. */
	readonly task?: ReadonlyMap<string, string>;
	/** Agent ids observed with a live session during this extension lifetime. */
	readonly seen?: ReadonlySet<string>;
}

/** One renderable tree row. */
export interface AgentNode {
	readonly id: string;
	readonly name: string;
	/** 0 = the Main root. */
	readonly depth: number;
	/** Whether this node is the last child among its siblings (connector shape). */
	readonly isLast: boolean;
	/**
	 * `isLast` for each ancestor below the root, including this node's parent
	 * (outermost first). These values drive vertical connector columns at depth ≥ 2.
	 */
	readonly ancestorsLast: readonly boolean[];
	readonly status: AgentTreeStatus;
	/** Last-seen model id tail; absent when never cached (e.g. restored parked ref). */
	readonly modelTail?: string;
	/** Live activity gist, capped at {@link GIST_MAX_CHARS}; `running` rows only. */
	readonly gist?: string;
	/** Derived task line; omitted when it would just repeat the name. */
	readonly task?: string;
}

/** What one `buildAgentTree` pass yields. */
export interface AgentTreeSnapshot {
	/** Depth-first rows, capped at {@link MAX_TREE_ROWS}. */
	readonly nodes: readonly AgentNode[];
	/** Rows beyond the cap (the dim `… +N more` tail). */
	readonly hiddenCount: number;
	/** D5 self-elision: false while the tree is Main alone (or empty). */
	readonly visible: boolean;
}

/** Row cap (D5): Main + descendants, depth-first, then a dim overflow tail. */
export const MAX_TREE_ROWS = 8;

/** Gist cap (the maintainer's ≤ 200 chars), applied BEFORE width fitting (D4). */
export const GIST_MAX_CHARS = 200;

const EMPTY_SNAPSHOT: AgentTreeSnapshot = { nodes: [], hiddenCount: 0, visible: false };

/** Normalize display text to one bounded line. */
export function normalizeAgentLine(text: string, maxChars: number = GIST_MAX_CHARS): string {
	const normalized = replaceTabs(sanitizeText(text))
		.replace(/[\r\n]+/g, " ")
		.replace(/\p{Cf}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return truncateCodePoints(normalized, maxChars);
}

function truncateCodePoints(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	let codePointCount = 0;
	let cutoff = text.length;
	for (let index = 0; index < text.length; ) {
		const start = index;
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		index += codePoint > 0xffff ? 2 : 1;
		codePointCount++;
		if (codePointCount === maxChars) cutoff = start;
		if (codePointCount > maxChars) return `${text.slice(0, cutoff).trimEnd()}…`;
	}
	return text;
}

/**
 * Build the renderable tree from one registry snapshot (D5):
 * - kinds `main`/`sub` only — `advisor` refs are observability transcripts, never peers;
 * - reachability from the Main root via the `parentId` chain — orphans
 *   (e.g. refs whose parent chain never reaches this session's root) are excluded;
 * - siblings order by `createdAt` (id as the deterministic tie-break);
 * - depth-first flattening, capped at {@link MAX_TREE_ROWS} with `hiddenCount`.
 */
export function buildAgentTree(refs: readonly AgentTreeRef[], caches: AgentTreeCaches = {}): AgentTreeSnapshot {
	const peers = refs.filter(ref => ref.kind !== "advisor");
	let root: AgentTreeRef | undefined;
	for (const ref of peers) {
		if (ref.kind !== "main") continue;
		if (root === undefined || ref.createdAt < root.createdAt) root = ref;
	}
	if (root === undefined) return EMPTY_SNAPSHOT;

	const childrenOf = new Map<string, AgentTreeRef[]>();
	for (const ref of peers) {
		if (ref.kind !== "sub" || ref.parentId === undefined || !isRenderableDetachedRef(ref, caches)) continue;
		const siblings = childrenOf.get(ref.parentId);
		if (siblings) siblings.push(ref);
		else childrenOf.set(ref.parentId, [ref]);
	}
	for (const siblings of childrenOf.values()) {
		siblings.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	const nodes: AgentNode[] = [];
	let total = 0;
	const visit = (ref: AgentTreeRef, depth: number, isLast: boolean, ancestorsLast: readonly boolean[]): void => {
		total++;
		if (nodes.length < MAX_TREE_ROWS) {
			nodes.push(toNode(ref, depth, isLast, ancestorsLast, caches));
		}
		const children = childrenOf.get(ref.id) ?? [];
		const childAncestors = depth === 0 ? ancestorsLast : [...ancestorsLast, isLast];
		for (let i = 0; i < children.length; i++) {
			visit(children[i] as AgentTreeRef, depth + 1, i === children.length - 1, childAncestors);
		}
	};
	visit(root, 0, true, []);

	return { nodes, hiddenCount: total - nodes.length, visible: total > 1 };
}

function toNode(
	ref: AgentTreeRef,
	depth: number,
	isLast: boolean,
	ancestorsLast: readonly boolean[],
	caches: AgentTreeCaches,
): AgentNode {
	const name = normalizeAgentLine(ref.displayName);
	const gist = ref.status === "running" && ref.activity ? normalizeAgentLine(ref.activity, GIST_MAX_CHARS) : undefined;
	const cachedTask = caches.task?.get(ref.id);
	const task = cachedTask === undefined ? undefined : normalizeAgentLine(cachedTask);
	return {
		id: ref.id,
		name,
		depth,
		isLast,
		ancestorsLast,
		status: ref.status,
		modelTail: caches.modelTail?.get(ref.id),
		gist,
		task: task !== undefined && task !== name ? task : undefined,
	};
}

function isRenderableDetachedRef(ref: AgentTreeRef, caches: AgentTreeCaches): boolean {
	if (ref.status !== "parked" && ref.status !== "aborted") return true;
	return caches.seen?.has(ref.id) === true;
}
