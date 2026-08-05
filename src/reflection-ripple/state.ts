import { DIM_DURATION_MS, RIPPLE_DURATION_MS } from "./ripple";

/**
 * `idle`: no motion, byte-identical static/blank row (either never
 * triggered, or the last ripple fully settled).
 * `rippling`: a `ttsr_triggered` event just landed; the wave is expanding
 * and the row is dimming/recovering its breath.
 */
export type ReflectionRipplePhase = "idle" | "rippling";

export interface ReflectionRippleSnapshot {
	readonly phase: ReflectionRipplePhase;
	/** Name(s) of the rule(s) the most recent trigger matched, in event order. Empty before any trigger. */
	readonly ruleNames: readonly string[];
	/** Total triggers observed this session. */
	readonly triggerCount: number;
}

/** How long a ripple stays visibly active before settling — the longer of the wave's own life and the breath's recovery. */
const SETTLE_MS = Math.max(RIPPLE_DURATION_MS, DIM_DURATION_MS);

/**
 * Mutable, session-scoped reflection-ripple model. All timestamps come from
 * the caller's injected clock (never `Date.now`/`performance.now` read
 * directly here), so the whole state machine is deterministic and
 * snapshot-testable.
 */
export class ReflectionRippleState {
	#phase: ReflectionRipplePhase = "idle";
	#triggeredAt = 0;
	#ruleNames: readonly string[] = [];
	#triggerCount = 0;

	get phase(): ReflectionRipplePhase {
		return this.#phase;
	}

	/**
	 * `ttsr_triggered`: (re)start the single ripple from `now`, replacing any
	 * still-expanding one — a fresh trigger reads as a new breath, not a
	 * queued-up backlog of waves.
	 */
	applyTrigger(ruleNames: readonly string[], now: number): void {
		this.#phase = "rippling";
		this.#triggeredAt = now;
		this.#ruleNames = ruleNames;
		this.#triggerCount += 1;
	}

	/** Milliseconds since the current ripple was triggered. Only meaningful while `rippling`. */
	rippleElapsedMs(now: number): number {
		return Math.max(0, now - this.#triggeredAt);
	}

	/**
	 * Advance past a finished ripple. Returns `true` exactly once, on the
	 * `rippling` -> `idle` transition — the caller's cue to tear the animated
	 * mount down to a static widget (zero further frame-clock subscriptions).
	 */
	settleIfDone(now: number): boolean {
		if (this.#phase !== "rippling") return false;
		if (this.rippleElapsedMs(now) < SETTLE_MS) return false;
		this.#phase = "idle";
		return true;
	}

	snapshot(): ReflectionRippleSnapshot {
		return { phase: this.#phase, ruleNames: this.#ruleNames, triggerCount: this.#triggerCount };
	}
}
