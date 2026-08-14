/**
 * Subagent facts the Bonsai can actually observe from inside a plugin.
 *
 * The host's `AgentRegistry` singleton lives in a static class field of the CLI
 * bundle, and the bundle re-exports only its barrel — so a plugin that imports
 * `@oh-my-pi/pi-coding-agent/registry/agent-registry` resolves its own copy of
 * that module and observes a registry that is never populated. The subagent data
 * that genuinely crosses into an extension is the `task` tool's streamed
 * progress (`tool_execution_update` → `partialResult.details.progress`), so the
 * Bonsai is fed from there instead.
 */

/**
 * Progress row streamed by the host's `task` tool for one subagent — the fields
 * the Bonsai reads out of the host's own `AgentProgress` (`src/task/types.ts`).
 * `id` is the allocated agent name (`SkillProbe`), `agent` its type (`scout`).
 * There is no skill field upstream, so an active skill is inferred from the
 * agent's `read` of a `skill://` URL.
 */
export interface TaskAgentProgress {
	readonly index: number;
	readonly id: string;
	readonly agent?: string;
	readonly status: TaskAgentStatus;
	readonly task?: string;
	readonly description?: string;
	readonly lastIntent?: string;
	readonly currentTool?: string;
	readonly currentToolArgs?: string;
	/** Newest-first, capped at 5 by the host — accumulate across updates. */
	readonly recentTools?: readonly { readonly tool: string; readonly args: string; readonly endMs: number }[];
	/** `<provider>/<id>[:<thinkingLevel>]`, absent when the model never resolved. */
	readonly resolvedModel?: string;
}

export type TaskAgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** Shape of the `task` tool's streamed partial result, as far as the Bonsai reads it. */
interface TaskUpdatePayload {
	readonly details?: { readonly progress?: unknown; readonly async?: unknown };
}

/** Lifecycle of a backgrounded `task` job, mirroring the host's `TaskToolDetails.async.state`. */
export type TaskAsyncState = "running" | "completed" | "failed";

const TASK_AGENT_STATUSES: readonly string[] = ["pending", "running", "completed", "failed", "aborted"];
const TASK_ASYNC_STATES: readonly string[] = ["running", "completed", "failed"];
const SKILL_URL = /^skill:\/\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/;

function asProgress(value: unknown): TaskAgentProgress | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as TaskAgentProgress;
	if (typeof row.id !== "string" || row.id.length === 0) return undefined;
	if (!TASK_AGENT_STATUSES.includes(row.status)) return undefined;
	return typeof row.index === "number" ? row : { ...row, index: 0 };
}

/**
 * Narrow a `tool_execution_update` payload to the task tool's progress rows.
 * Returns `undefined` when the payload carries no progress array at all, so
 * callers can tell "not a subagent update" from "no rows yet".
 */
export function extractTaskProgress(partialResult: unknown): readonly TaskAgentProgress[] | undefined {
	if (typeof partialResult !== "object" || partialResult === null) return undefined;
	const progress = (partialResult as TaskUpdatePayload).details?.progress;
	if (!Array.isArray(progress)) return undefined;
	const rows: TaskAgentProgress[] = [];
	for (const entry of progress) {
		const row = asProgress(entry);
		if (row !== undefined) rows.push(row);
	}
	return rows;
}

/**
 * Lifecycle of the backgrounded job behind a `task` call, or `undefined` when the
 * call was synchronous. A `running` job keeps streaming progress long after its
 * own `tool_execution_end`, so the Bonsai must not settle those subagents there.
 */
export function extractTaskAsyncState(result: unknown): TaskAsyncState | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const job = (result as TaskUpdatePayload).details?.async;
	if (typeof job !== "object" || job === null || !("state" in job)) return undefined;
	const state = (job as { readonly state: unknown }).state;
	if (typeof state !== "string" || !TASK_ASYNC_STATES.includes(state)) return undefined;
	return state as TaskAsyncState;
}

/** Skill name behind a `skill://` read, or `undefined` for any other tool call. */
export function skillNameFromToolArgs(tool: string | undefined, args: string | undefined): string | undefined {
	if (tool !== "read" || args === undefined) return undefined;
	const match = SKILL_URL.exec(args.trim());
	const target = match?.[1];
	if (target === undefined) return undefined;
	const segments = target.split("/");
	return segments[segments.length - 1];
}

/**
 * Skill names this progress row still remembers reading, oldest first. The
 * host caps and rotates `recentTools`, so callers must accumulate across
 * updates to keep a subagent's full skill set.
 */
export function skillNamesFromProgress(progress: TaskAgentProgress): readonly string[] {
	const names: string[] = [];
	const recent = progress.recentTools ?? [];
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		if (entry === undefined) continue;
		const name = skillNameFromToolArgs(entry.tool, entry.args);
		if (name !== undefined) names.push(name);
	}
	const current = skillNameFromToolArgs(progress.currentTool, progress.currentToolArgs);
	if (current !== undefined) names.push(current);
	return names;
}
