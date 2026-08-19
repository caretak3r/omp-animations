import { type EditSpan, FADE_AFTER_TURNS, IntervalSet } from "./spans";

/** One reportable row: either a line-precise region (`start`/`end` set) or a degraded path-level entry (`start`/`end` both `undefined` — see {@link PalimpsestState.applyDegradedTouch}). */
export interface PalimpsestRow {
	readonly path: string;
	readonly start: number | undefined;
	readonly end: number | undefined;
	readonly overlapCount: number;
	readonly lastTouchedTurn: number;
}

/** Immutable ledger snapshot. */
export interface PalimpsestSnapshot {
	readonly rows: readonly PalimpsestRow[];
}

interface FileLedgerEntry {
	intervals: IntervalSet;
	/** Once true, this path never returns to line-precise tracking — see {@link PalimpsestState.applyDegradedTouch}. */
	degraded: boolean;
	degradedTouchCount: number;
	degradedLastTurn: number;
}

function emptyEntry(): FileLedgerEntry {
	return { intervals: new IntervalSet(), degraded: false, degradedTouchCount: 0, degradedLastTurn: 0 };
}

/**
 * Mutable, session-scoped thrash ledger: `Map<path, FileLedgerEntry>`, one
 * {@link IntervalSet} of overlap-counted line regions per tracked path. Turn
 * indices (not wall-clock time) drive the fade: {@link advanceTurn} ages out
 * any region — or, for a degraded path, the whole entry — that has gone
 * {@link FADE_AFTER_TURNS} turns without a re-touch, so a file that's cooled
 * off eventually drops out of the ledger entirely on its own.
 *
 * A path degrades to whole-file counting (see {@link applyDegradedTouch})
 * the moment any touch can't be trusted for line-level precision — pruned
 * snapshots or an unparseable diff — and stays degraded for the rest of its
 * ledger life: once specific line history is lost, re-establishing it would
 * mean guessing, which the bead's spec forbids outright.
 */
export class PalimpsestState {
	#ledger = new Map<string, FileLedgerEntry>();
	#turn = 0;

	/** Whether the ledger is tracking nothing at all — every path has either been deleted or faded out. */
	get isEmpty(): boolean {
		return this.#ledger.size === 0;
	}

	/** Current turn index, for tests/introspection. */
	get turn(): number {
		return this.#turn;
	}

	/**
	 * Advance to `turnIndex` and age out anything untouched since. A
	 * `turnIndex` at or behind the current one (a stale/replayed event) is
	 * ignored rather than rewinding the fade clock. Returns whether anything
	 * visible changed (a region faded, or a path emptied out of the ledger).
	 */
	advanceTurn(turnIndex: number): boolean {
		if (turnIndex <= this.#turn) return false;
		this.#turn = turnIndex;

		let changed = false;
		for (const [path, entry] of this.#ledger) {
			if (entry.degraded) {
				if (this.#turn - entry.degradedLastTurn >= FADE_AFTER_TURNS) {
					this.#ledger.delete(path);
					changed = true;
				}
				continue;
			}
			if (entry.intervals.pruneStale(this.#turn, FADE_AFTER_TURNS)) changed = true;
			if (entry.intervals.isEmpty) {
				this.#ledger.delete(path);
				changed = true;
			}
		}
		return changed;
	}

	/** `op: "create"` — establish a fresh, empty ledger entry for `path`, discarding any stale leftover (e.g. the path was deleted and recreated). */
	onCreate(path: string): void {
		this.#ledger.set(path, emptyEntry());
	}

	/** `op: "delete"` — the file is gone; nothing left to glow. */
	onDelete(path: string): void {
		this.#ledger.delete(path);
	}

	/**
	 * Migrate a ledger entry from `sourcePath` to `path` on rename, so the
	 * glow follows the file rather than lying about which path is thrashing.
	 * A pre-existing entry already at `path` (rare — a rename landing on a
	 * path this ledger was independently tracking) is replaced: the rename
	 * establishes a fresh identity for that path, and merging two unrelated
	 * histories would misrepresent both.
	 */
	onRename(sourcePath: string, path: string): void {
		const entry = this.#ledger.get(sourcePath);
		this.#ledger.delete(sourcePath);
		this.#ledger.delete(path);
		if (entry) this.#ledger.set(path, entry);
	}

	/** Record real, line-precise spans for a touch on `path`. A degraded path ignores the spans and counts the touch at path level instead (see class docs). */
	applySpans(path: string, spans: readonly EditSpan[]): void {
		const entry = this.#ledger.get(path) ?? emptyEntry();
		if (entry.degraded) {
			entry.degradedTouchCount += 1;
			entry.degradedLastTurn = this.#turn;
		} else {
			for (const span of spans) entry.intervals.addSpan(span, this.#turn);
		}
		this.#ledger.set(path, entry);
	}

	/**
	 * Record a touch on `path` whose spans can't be trusted — a pruned
	 * snapshot, or a real diff with no parseable hunk header — and degrade
	 * that path to whole-file counting for the rest of its ledger life.
	 * NEVER infers a line span in this case.
	 */
	applyDegradedTouch(path: string): void {
		const entry = this.#ledger.get(path) ?? emptyEntry();
		entry.degraded = true;
		entry.degradedTouchCount += 1;
		entry.degradedLastTurn = this.#turn;
		this.#ledger.set(path, entry);
	}

	/** Immutable view of every tracked row, regardless of overlap count. */
	snapshot(): PalimpsestSnapshot {
		const rows: PalimpsestRow[] = [];
		for (const [path, entry] of this.#ledger) {
			if (entry.degraded) {
				rows.push({
					path,
					start: undefined,
					end: undefined,
					overlapCount: entry.degradedTouchCount,
					lastTouchedTurn: entry.degradedLastTurn,
				});
				continue;
			}
			for (const region of entry.intervals.regions) {
				rows.push({
					path,
					start: region.start,
					end: region.end,
					overlapCount: region.overlapCount,
					lastTouchedTurn: region.lastTouchedTurn,
				});
			}
		}
		return { rows };
	}
}
