import { extractTaskAsyncState, extractTaskProgress } from "../agent-bonsai/progress";
import { normalizeMutationTargets } from "./normalize";

export interface LiveFileEntry {
	readonly owner: string;
	readonly path: string;
	readonly tool: string;
	readonly startedAt: number;
}

export interface LiveFileSnapshot {
	readonly entries: readonly LiveFileEntry[];
}

export interface LiveFileToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: object;
}

/** Current edit/write activity only. Completed calls disappear immediately; this is not a history ledger. */
export class LiveFilesState {
	#entries = new Map<string, LiveFileEntry[]>();
	#now: () => number;
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	onToolCall(event: LiveFileToolCall, cwd: string): void {
		const targets = normalizeMutationTargets(event.toolName, event.input, cwd);
		this.#set(
			event.toolCallId,
			"main",
			event.toolName,
			targets.map(target => target.path),
		);
	}

	onToolResult(toolCallId: string): void {
		this.#entries.delete(toolCallId);
	}
	onTaskProgress(taskCallId: string, payload: unknown, cwd: string): void {
		const progress = extractTaskProgress(payload);
		if (progress === undefined) return;
		for (const row of progress) {
			const key = `${taskCallId}:${row.id}`;
			if (row.status !== "running") {
				this.#entries.delete(key);
				continue;
			}
			const tool = row.currentTool ?? "";
			const targets = normalizeMutationTargets(tool, row.currentToolArgs ?? "", cwd);
			this.#set(
				key,
				row.id,
				tool,
				targets.map(target => target.path),
			);
		}
	}

	onTaskEnd(taskCallId: string, result: unknown, cwd: string): void {
		this.onTaskProgress(taskCallId, result, cwd);
		if (extractTaskAsyncState(result) === "running") return;
		const prefix = `${taskCallId}:`;
		for (const key of this.#entries.keys()) {
			if (key.startsWith(prefix)) this.#entries.delete(key);
		}
	}

	reset(): void {
		this.#entries.clear();
	}

	snapshot(): LiveFileSnapshot {
		const entries = [...this.#entries.values()]
			.flat()
			.sort((a, b) => a.startedAt - b.startedAt || a.owner.localeCompare(b.owner) || a.path.localeCompare(b.path));
		return { entries };
	}

	#set(key: string, owner: string, tool: string, paths: readonly string[]): void {
		if (paths.length === 0) {
			this.#entries.delete(key);
			return;
		}
		const startedAt = this.#entries.get(key)?.[0]?.startedAt ?? this.#now();
		this.#entries.set(
			key,
			[...new Set(paths)].map(filePath => ({ owner, path: filePath, tool, startedAt })),
		);
	}
}
