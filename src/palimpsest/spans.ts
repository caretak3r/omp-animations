/**
 * Pure line-span math for Palimpsest: parsing unified-diff hunk headers into
 * new-file line ranges, and merging those ranges into overlap-counted
 * regions. No clock reads, no file I/O — every function here is a total,
 * deterministic transform of its arguments.
 */

/** A closed, 1-based line range in the file's current (post-edit) content. */
export interface EditSpan {
	readonly start: number;
	readonly end: number;
}

/**
 * Same tolerant shape as the edit tool's own `UNIFIED_HUNK_HEADER_REGEX`
 * (`edit/diff.ts`, not exported) — `\s*`/`\s+` around the markers so hunk
 * headers with the standard single space or any other whitespace variant
 * still parse. Captures the new-file `+start[,count]` half only; the
 * old-file half is irrelevant to "where does this land in the file today".
 */
const HUNK_HEADER_RE = /^@@\s*-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s*@@/;

/**
 * Parse every `@@ -a,b +c,d @@` hunk header out of a unified diff into the
 * new-file line span it touched. A hunk with a new-file count of `0` (a pure
 * deletion — nothing survives at that point in the new file) still yields a
 * single-line anchor span at `c`, clamped to line 1, since the ledger is
 * about "where in the file does this edit land", not "how many lines
 * changed". Lines that aren't hunk headers are ignored. Pure string parsing —
 * never reads the file.
 */
export function parseHunkSpans(diff: string): readonly EditSpan[] {
	const spans: EditSpan[] = [];
	for (const line of diff.split("\n")) {
		const match = HUNK_HEADER_RE.exec(line);
		if (!match) continue;
		const start = Number(match[1]);
		if (!Number.isFinite(start) || start < 1) continue;
		const count = match[2] === undefined ? 1 : Number(match[2]);
		const end = count > 0 ? start + count - 1 : start;
		spans.push({ start: Math.max(1, start), end: Math.max(1, end) });
	}
	return spans;
}

/** One merged, overlap-counted region of a file's edit ledger. */
export interface CountedRegion extends EditSpan {
	/** Number of distinct touches whose span covered this exact sub-range. */
	readonly overlapCount: number;
	/** Turn index of the most recent touch that covered this sub-range — the fade clock's input. */
	readonly lastTouchedTurn: number;
}

/** Merge adjacent regions that carry identical count/age into one — keeps the region list minimal and lets independently-aged neighbors fade apart. Pure. */
function mergeAdjacent(regions: readonly CountedRegion[]): CountedRegion[] {
	const merged: CountedRegion[] = [];
	for (const region of regions) {
		const last = merged[merged.length - 1];
		if (
			last &&
			last.overlapCount === region.overlapCount &&
			last.lastTouchedTurn === region.lastTouchedTurn &&
			last.end + 1 === region.start
		) {
			merged[merged.length - 1] = { ...last, end: region.end };
		} else {
			merged.push({ ...region });
		}
	}
	return merged;
}

/**
 * A per-file ledger of touched line spans, merged on overlap with a running
 * overlap count and a per-region "last touched" turn stamp for fading. Every
 * {@link addSpan} call resegments the existing regions against the new span's
 * boundaries (a small sweep over breakpoints, not a full rebuild of anything
 * external), so overlap counts stay exact even across many touches with
 * partially-overlapping ranges.
 */
export class IntervalSet {
	#regions: CountedRegion[] = [];

	/** Current merged regions, sorted by `start`. */
	get regions(): readonly CountedRegion[] {
		return this.#regions;
	}

	get isEmpty(): boolean {
		return this.#regions.length === 0;
	}

	/**
	 * Record one touch's line span at `turn`: every sub-range the new span
	 * covers gets its overlap count bumped by one and its `lastTouchedTurn`
	 * stamped to `turn`; sub-ranges outside the new span keep their existing
	 * count/age untouched. A malformed span (`end < start`) is a no-op.
	 */
	addSpan(span: EditSpan, turn: number): void {
		if (span.end < span.start) return;
		const breakpoints = new Set<number>([span.start, span.end + 1]);
		for (const region of this.#regions) {
			breakpoints.add(region.start);
			breakpoints.add(region.end + 1);
		}
		const sorted = [...breakpoints].sort((a, b) => a - b);

		const next: CountedRegion[] = [];
		for (let i = 0; i < sorted.length - 1; i++) {
			const start = sorted[i];
			const end = sorted[i + 1] - 1;
			if (start > end) continue;
			const covering = this.#regions.find(r => r.start <= start && end <= r.end);
			const touched = start >= span.start && end <= span.end;
			const overlapCount = (covering?.overlapCount ?? 0) + (touched ? 1 : 0);
			if (overlapCount === 0) continue;
			const lastTouchedTurn = touched ? turn : (covering?.lastTouchedTurn ?? turn);
			next.push({ start, end, overlapCount, lastTouchedTurn });
		}
		this.#regions = mergeAdjacent(next);
	}

	/** Drop every region whose last touch is `maxAge` turns or older than `currentTurn`. Returns whether anything was dropped. */
	pruneStale(currentTurn: number, maxAge: number): boolean {
		const kept = this.#regions.filter(r => currentTurn - r.lastTouchedTurn < maxAge);
		if (kept.length === this.#regions.length) return false;
		this.#regions = kept;
		return true;
	}
}

/** How many turns a region (or a degraded path-level entry) can go without a re-touch before it's dropped from the ledger. */
export const FADE_AFTER_TURNS = 3;

/** Thrash requires at least a second touch. */
export const GLOW_THRESHOLD = 2;
