// Width-budgeted segment composer — vendored from the oh-my-pi-e4r prototype
// (mock-realestate.py's `Segment`/`compose()`), ported to the shared display-width
// primitives the rest of this package already depends on (`@oh-my-pi/pi-tui`'s
// `visibleWidth`/`truncateToWidth`, which additionally strip ANSI/OSC escapes —
// something the prototype's plain `unicodedata`-based `dw()` never had to do).
import { visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * One composable unit of the live box: an id, a priority (lower number = kept
 * longer when the budget gets tight), and its own detail ladder, widest first.
 * `minWidth` is the visible width of the narrowest variant — what the composer
 * checks a segment can still afford before dropping it entirely.
 */
export interface Segment {
	readonly id: string;
	readonly priority: number;
	readonly minWidth: number;
	/** Widest-first. The composer picks among these; it never invents new text. */
	readonly variants: readonly string[];
}

/** Build a {@link Segment}, deriving `minWidth` from the narrowest (last) variant. */
export function segment(id: string, priority: number, variants: readonly string[]): Segment {
	const narrowest = variants[variants.length - 1] ?? "";
	return { id, priority, minWidth: visibleWidth(narrowest), variants };
}

/** Joins composed segments on the same row. */
export const SEGMENT_SEPARATOR = " · ";

export interface ComposedRow {
	/** The joined row, ready to print — `""` when nothing fit at all. */
	readonly row: string;
	/** Ids of the segments that made it into `row`, in priority order. */
	readonly keptIds: readonly string[];
}

/**
 * Priority-ranked, width-budgeted composition. Ported 1:1 from the prototype's
 * `compose()`: drop the lowest-priority segment (highest `priority` number)
 * until the remaining segments' narrowest variants fit `budget`, then spend
 * whatever budget is left upgrading segments to wider variants, in priority
 * order — each segment jumping straight to the widest variant it can afford.
 * Segments with no variants are dropped before ranking (nothing to show).
 */
export function composeSegments(segments: readonly Segment[], budget: number): ComposedRow {
	const sepWidth = visibleWidth(SEGMENT_SEPARATOR);
	let kept = segments.filter(s => s.variants.length > 0).sort((a, b) => a.priority - b.priority);

	while (kept.length > 0) {
		const need = kept.reduce((sum, s) => sum + s.minWidth, 0) + sepWidth * (kept.length - 1);
		if (need <= budget) break;
		kept = kept.slice(0, -1); // ascending priority sort => last is the lowest-priority segment
	}
	if (kept.length === 0) return { row: "", keptIds: [] };

	const chosen = new Map<string, number>(kept.map(s => [s.id, s.variants.length - 1]));
	let used = kept.reduce((sum, s) => sum + s.minWidth, 0) + sepWidth * (kept.length - 1);
	for (const s of kept) {
		const narrowIdx = chosen.get(s.id) as number;
		for (let idx = 0; idx < narrowIdx; idx++) {
			const delta = visibleWidth(s.variants[idx] as string) - visibleWidth(s.variants[narrowIdx] as string);
			if (used + delta <= budget) {
				used += delta;
				chosen.set(s.id, idx);
				break;
			}
		}
	}

	const row = kept.map(s => s.variants[chosen.get(s.id) as number]).join(SEGMENT_SEPARATOR);
	return { row, keptIds: kept.map(s => s.id) };
}
