/**
 * Audit Trail Box — the remedy, not the alarm.
 *
 * Knowing a path is POISONED is worthless on its own: "go re-read X" makes the
 * agent spend a turn discovering what it already could have been told. So the
 * plan is built while the stale copy is still in hand — {@link AuditLedgerState}
 * keeps each path's `contextContent` (the bytes the agent believes it holds)
 * next to `contentNow` (what the probe last saw) precisely so the remedy can
 * diff them BEFORE anything is discarded, and say "X changed: <diff>".
 *
 * Two lists come out, matching the two actions a caller can actually take:
 * POISONED and DIRTY paths must be re-read before the agent touches them again;
 * COLD paths are safe to drop. REDUNDANT paths appear in the panel but in
 * neither list — they are prefix waste already spent, not a pending action.
 *
 * Everything here is pure: it reads an {@link AuditSnapshot} and returns data.
 */
import type { AuditSnapshot, PathRecord, PathStatus, Severity, SignalFamily } from "./state";
import { COLD_AFTER_TURNS } from "./state";

/** Lines per side fed to the diff. Bounds the LCS table on a render path; the snapshots are already capped by the tracker. */
export const MAX_DIFF_INPUT_LINES = 400;

/** Changed lines emitted per path before the diff collapses to a remainder note. */
export const MAX_DIFF_LINES = 8;

/** Paths listed per remedy list before it collapses to a remainder count. */
export const DEFAULT_MAX_REMEDY_ENTRIES = 10;

/** One path plus everything a caller needs to act on it without re-deriving anything. */
export interface RemedyEntry {
	readonly path: string;
	readonly status: PathStatus;
	readonly severity: Severity;
	/** Why this path is listed, in one human clause. */
	readonly reason: string;
	/** Which families fired, highest-risk evidence first. */
	readonly families: readonly SignalFamily[];
	/**
	 * The before-discard diff: `-` lines are the copy the agent holds, `+` lines
	 * are what is on disk now. Empty when nothing changed or when no snapshot was
	 * captured on either side.
	 */
	readonly diff: readonly string[];
}

/** The two actionable lists, each capped with a remainder count. */
export interface RemedyPlan {
	readonly turn: number;
	/** POISONED and DIRTY: the agent's copy cannot be trusted for the next touch. */
	readonly mustReread: readonly RemedyEntry[];
	/** Paths elided from {@link mustReread} by the cap. */
	readonly mustRereadOverflow: number;
	/** COLD: untouched long enough to evict without losing anything the agent is using. */
	readonly safeToDrop: readonly RemedyEntry[];
	/** Paths elided from {@link safeToDrop} by the cap. */
	readonly safeToDropOverflow: number;
}

export interface RemedyOptions {
	/** Paths listed per list before overflow. Defaults to {@link DEFAULT_MAX_REMEDY_ENTRIES}. */
	readonly maxEntries?: number;
	/** Changed lines per diff before the remainder note. Defaults to {@link MAX_DIFF_LINES}. */
	readonly maxDiffLines?: number;
}

/** Evidence ordering for the reason line — strongest first. */
const FAMILY_ORDER: readonly SignalFamily[] = ["divergence", "recovery", "ledger", "cache", "lifecycle"];

function orderFamilies(families: ReadonlySet<SignalFamily>): readonly SignalFamily[] {
	return FAMILY_ORDER.filter(family => families.has(family));
}

/** Split for diffing, dropping a single trailing newline so a file's last line is not a phantom empty change. */
function toLines(content: string): readonly string[] {
	const body = content.endsWith("\n") ? content.slice(0, -1) : content;
	const lines = body.split("\n");
	return lines.length <= MAX_DIFF_INPUT_LINES ? lines : lines.slice(0, MAX_DIFF_INPUT_LINES);
}

/** Longest-common-subsequence lengths over `a` × `b`, row-major with a leading zero row/column. */
function lcsLengths(a: readonly string[], b: readonly string[]): Uint32Array {
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? (table[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
		}
	}
	return table;
}

/**
 * Compact line diff between the copy the agent holds and what is on disk now.
 * Emits only changed lines (`-` held, `+` on disk) — a TUI remedy message wants
 * the delta, not context — capped at `maxLines` with a trailing remainder note.
 * `undefined` on either side is treated as empty, so a path first seen by the
 * probe still shows what arrived.
 */
export function diffContent(
	before: string | undefined,
	after: string | undefined,
	maxLines: number = MAX_DIFF_LINES,
): readonly string[] {
	if (before === undefined && after === undefined) return [];
	if (before === after) return [];

	const a = before === undefined ? [] : toLines(before);
	const b = after === undefined ? [] : toLines(after);
	const width = b.length + 1;
	const table = lcsLengths(a, b);

	const changes: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
			changes.push(`-${a[i]}`);
			i++;
		} else {
			changes.push(`+${b[j]}`);
			j++;
		}
	}
	for (; i < a.length; i++) changes.push(`-${a[i]}`);
	for (; j < b.length; j++) changes.push(`+${b[j]}`);

	if (changes.length <= maxLines) return changes;
	const hidden = changes.length - maxLines;
	return [...changes.slice(0, maxLines), `⋯ +${hidden} more changed line${hidden === 1 ? "" : "s"}`];
}

/** One human clause explaining why this path is in the list it is in. */
export function remedyReason(record: PathRecord, turn: number): string {
	if (record.status === "poisoned") {
		if (!record.reachable) return "gone from disk — deleted or no longer readable";
		return `changed on disk, confirmed over ${record.divergenceStreak} probe ticks`;
	}
	if (record.status === "dirty") {
		if (record.formatterAbsorbs > 0) return "rewritten by the repo's formatter after your write";
		return "you wrote it — disk may have moved since";
	}
	if (record.status === "cold") {
		const idle = turn - record.lastTouchTurn;
		return `untouched for ${idle} turn${idle === 1 ? "" : "s"} (evicts at ${COLD_AFTER_TURNS})`;
	}
	if (record.status === "redundant") return `read ${record.reads} times with nothing invalidating it`;
	return "in sync as of the last probe";
}

function toEntry(record: PathRecord, turn: number, maxDiffLines: number): RemedyEntry {
	return {
		path: record.path,
		status: record.status,
		severity: record.severity,
		reason: remedyReason(record, turn),
		families: orderFamilies(record.families),
		diff: diffContent(record.contextContent, record.contentNow, maxDiffLines),
	};
}

/**
 * Build the two actionable lists from a snapshot. The snapshot's paths are
 * already sorted highest-risk first, so both lists inherit that order and the
 * cap drops the least urgent entries. The diffs are computed here, while the
 * stale copies are still held — that is the whole point of the command.
 */
export function buildRemedyPlan(snapshot: AuditSnapshot, options: RemedyOptions = {}): RemedyPlan {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_REMEDY_ENTRIES;
	const maxDiffLines = options.maxDiffLines ?? MAX_DIFF_LINES;

	const stale = snapshot.paths.filter(record => record.status === "poisoned" || record.status === "dirty");
	const cold = snapshot.paths.filter(record => record.status === "cold");

	return {
		turn: snapshot.turn,
		mustReread: stale.slice(0, maxEntries).map(record => toEntry(record, snapshot.turn, maxDiffLines)),
		mustRereadOverflow: Math.max(0, stale.length - maxEntries),
		safeToDrop: cold.slice(0, maxEntries).map(record => toEntry(record, snapshot.turn, maxDiffLines)),
		safeToDropOverflow: Math.max(0, cold.length - maxEntries),
	};
}

/**
 * Plain-text rendering of a plan — no color, no width tiers — for the slash
 * command's transcript output. Each stale path leads with its reason and, when
 * the content moved, the before-discard diff underneath it.
 */
export function formatRemedyPlan(plan: RemedyPlan): readonly string[] {
	const lines: string[] = [];

	if (plan.mustReread.length === 0) {
		lines.push("must re-read: nothing — every tracked copy is still current");
	} else {
		lines.push(`must re-read (${plan.mustReread.length + plan.mustRereadOverflow}):`);
		for (const entry of plan.mustReread) {
			lines.push(`  ${entry.path} — ${entry.reason}`);
			for (const line of entry.diff) lines.push(`    ${line}`);
		}
		if (plan.mustRereadOverflow > 0) lines.push(`  ⋯ +${plan.mustRereadOverflow} more`);
	}

	if (plan.safeToDrop.length > 0) {
		lines.push(`safe to drop (${plan.safeToDrop.length + plan.safeToDropOverflow}):`);
		for (const entry of plan.safeToDrop) lines.push(`  ${entry.path} — ${entry.reason}`);
		if (plan.safeToDropOverflow > 0) lines.push(`  ⋯ +${plan.safeToDropOverflow} more`);
	}

	return lines;
}
