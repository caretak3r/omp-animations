import type { ToolCategory } from "./categories";
import { categorizeTool } from "./categories";
import { assignCell, GRID_CELLS } from "./sky";

/** One tool type's star: identity, assigned cell, category color, and last-fire bookkeeping. */
export interface StarRecord {
	readonly toolName: string;
	readonly category: ToolCategory;
	readonly cell: number;
	/** `clock.now()` reading (the shared controller/widget clock) at the most recent fire. */
	lastFireAt: number;
	fireCount: number;
}

/** Immutable snapshot handed to the pure renderer each frame. */
export interface ConstellationSnapshot {
	readonly stars: readonly StarRecord[];
	readonly lastFired: string | undefined;
	readonly previousFired: string | undefined;
}

/**
 * Mutable, session-scoped model of the star field. Stars are created lazily
 * on a tool's first fire (so an unused session stays an empty sky rather than
 * pre-populating every builtin tool) and keep a stable grid cell for the rest
 * of the session. Mutation happens only in {@link recordFire}, driven by
 * `tool_call` events; rendering reads an immutable {@link snapshot} and is a
 * pure function of that snapshot plus the current clock reading.
 */
export class ConstellationState {
	#stars = new Map<string, StarRecord>();
	/** Same records as {@link #stars}, in first-fire order — kept in parallel so {@link snapshot} can hand
	 * out a live view instead of spreading the map every frame (`recordFire` only ever appends). */
	#starsList: StarRecord[] = [];
	#occupied = new Set<number>();
	#lastFired: string | undefined;
	#previousFired: string | undefined;

	/** Record a tool firing at `elapsedMs` (the host clock's current elapsed time). */
	recordFire(toolName: string, elapsedMs: number): void {
		let star = this.#stars.get(toolName);
		if (!star) {
			const cell = assignCell(toolName, this.#occupied, GRID_CELLS);
			this.#occupied.add(cell);
			star = { toolName, category: categorizeTool(toolName), cell, lastFireAt: elapsedMs, fireCount: 0 };
			this.#stars.set(toolName, star);
			this.#starsList.push(star);
		} else {
			star.lastFireAt = elapsedMs;
		}
		star.fireCount++;
		if (toolName !== this.#lastFired) {
			this.#previousFired = this.#lastFired;
			this.#lastFired = toolName;
		}
	}

	/** Immutable view for the pure renderer. `stars` is the live backing list (never mutated after push), not a copy. */
	snapshot(): ConstellationSnapshot {
		return { stars: this.#starsList, lastFired: this.#lastFired, previousFired: this.#previousFired };
	}

	/** Per-category fire counts. Caller orders by {@link CATEGORY_ORDER}. Pure read. */
	categoryCounts(): Map<ToolCategory, number> {
		const counts = new Map<ToolCategory, number>();
		for (const star of this.#stars.values()) {
			counts.set(star.category, (counts.get(star.category) ?? 0) + star.fireCount);
		}
		return counts;
	}
}
