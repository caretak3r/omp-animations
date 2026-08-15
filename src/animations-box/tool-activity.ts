/**
 * Animations Box — tool-call tally.
 *
 * The only surviving piece of the deleted Tool Constellation
 * (`omp-animations-buv.4`): a box-owned counter behind the required `tools`
 * row. No star field, no comet, no per-tool particle, no standalone widget —
 * just the tally semantics the row needs.
 *
 * Division of labour with the `audit` row is deliberate: the audit ledger is
 * the authoritative owner of file read/write metrics and already prints
 * `N reads` / `N writes` from it, so this row never breaks `read`/`write` out
 * of its own category tally. Those calls still land in `total` — the row's
 * headline is "how much tool traffic", and dropping file tools from the count
 * would understate it — but the per-category breakdown is restricted to
 * {@link REPORTED_CATEGORIES}, the five buckets no other row covers. Both
 * counts derive from the same `tool_call` event the controller already
 * handles; there is no second counter for the same event.
 */
import { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

/**
 * Coarse grouping of tool names. `mcp` is detected by the `mcp__` bridge
 * prefix (see `mcp/tool-bridge.ts`); everything else falls through
 * {@link normalizeToolName} so legacy aliases (`search` -> `grep`,
 * `find` -> `glob`) land in the right bucket.
 */
export type ToolCategory = "read" | "write" | "bash" | "search" | "agent" | "mcp" | "other";

/**
 * Categories the `tools` row is allowed to name, in display order — which is
 * also the tie-break for equal counts. `read`/`write` are absent because the
 * `audit` row reports them from the file ledger; see module doc.
 */
export const REPORTED_CATEGORIES: readonly ToolCategory[] = ["bash", "search", "agent", "mcp", "other"];

/** At most this many categories appear in a summary's breakdown. */
export const TOP_CATEGORY_LIMIT = 2;

/** Stable classification of a raw tool name into a {@link ToolCategory}. Pure. */
export function categorizeTool(toolName: string): ToolCategory {
	if (toolName.startsWith("mcp__")) return "mcp";
	switch (normalizeToolName(toolName)) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "write";
		case "bash":
			return "bash";
		case "grep":
		case "glob":
			return "search";
		case "task":
			return "agent";
		default:
			return "other";
	}
}

export interface CategoryTally {
	readonly category: ToolCategory;
	readonly count: number;
}

export interface ToolActivitySummary {
	/** Every recorded call, file tools included. */
	readonly total: number;
	/**
	 * Busiest first, {@link REPORTED_CATEGORIES}' own order breaking ties,
	 * capped at {@link TOP_CATEGORY_LIMIT}. Empty while nothing outside
	 * `read`/`write` has fired — a read-only session's row is its total alone.
	 */
	readonly top: readonly CategoryTally[];
}

const EMPTY_SUMMARY: ToolActivitySummary = { total: 0, top: [] };

/** Running tool-call tally. Fed one `tool_call` at a time; derives its summary lazily. */
export class ToolActivityState {
	readonly #counts = new Map<ToolCategory, number>();
	#total = 0;
	#summary: ToolActivitySummary = EMPTY_SUMMARY;
	#stale = false;

	/** Count one tool call. `elapsedMs` is deliberately absent: no timing survived the deletion. */
	record(toolName: string): void {
		const category = categorizeTool(toolName);
		this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
		this.#total++;
		this.#stale = true;
	}

	/** Calls counted so far, across every category. */
	get total(): number {
		return this.#total;
	}

	/**
	 * Memoized derived view — rebuilt only after a {@link record}, so the
	 * per-frame render path re-reads the same object instead of re-sorting.
	 */
	summary(): ToolActivitySummary {
		if (!this.#stale) return this.#summary;
		const top = REPORTED_CATEGORIES.filter(category => (this.#counts.get(category) ?? 0) > 0)
			.sort((a, b) => (this.#counts.get(b) ?? 0) - (this.#counts.get(a) ?? 0))
			.slice(0, TOP_CATEGORY_LIMIT)
			.map(category => ({ category, count: this.#counts.get(category) ?? 0 }));
		this.#summary = { total: this.#total, top };
		this.#stale = false;
		return this.#summary;
	}
}
