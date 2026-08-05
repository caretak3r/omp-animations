import { breathPeriodMsForTurnDuration, EXHALE_DURATION_MS } from "./breath";

/**
 * `idle`: no motion, byte-identical static border (either never started, or
 * settled after the post-`agent_end` exhale finished).
 * `active`: the agent is working; the border breathes continuously.
 * `exhaling`: `agent_end` just fired; a single wind-down decay is running.
 */
export type BreathingBorderPhase = "idle" | "active" | "exhaling";

export interface BreathingBorderSnapshot {
	readonly phase: BreathingBorderPhase;
	readonly periodMs: number;
}

/**
 * Mutable, session-scoped breathing-border model. All timestamps come from
 * the caller's injected clock (never `Date.now`/`performance.now` read
 * directly here), so the whole state machine is deterministic and
 * snapshot-testable.
 */
export class BreathingBorderState {
	#phase: BreathingBorderPhase = "idle";
	#breathStartedAt = 0;
	#exhaleStartedAt = 0;
	#turnIndex: number | undefined;
	#turnStartedAt: number | undefined;
	#lastTurnDurationMs: number | undefined;

	get phase(): BreathingBorderPhase {
		return this.#phase;
	}

	/** `agent_start`: (re)start the continuous breathing cycle from `now`, interrupting any in-progress exhale. */
	applyAgentStart(now: number): void {
		this.#phase = "active";
		this.#breathStartedAt = now;
	}

	/** `agent_end`: begin the single wind-down exhale. A no-op if already idle (no active breath to wind down). */
	applyAgentEnd(now: number): void {
		if (this.#phase === "idle") return;
		this.#phase = "exhaling";
		this.#exhaleStartedAt = now;
	}

	/** `turn_start`: record the turn's start (via the shared clock, not the event's own epoch timestamp) so `turn_end` can measure its duration. */
	applyTurnStart(turnIndex: number, now: number): void {
		this.#turnIndex = turnIndex;
		this.#turnStartedAt = now;
	}

	/** `turn_end`: measure the just-finished turn's duration, used to modulate the breath cadence. Ignored if it doesn't match a tracked `turn_start`. */
	applyTurnEnd(turnIndex: number, now: number): void {
		if (this.#turnIndex !== turnIndex || this.#turnStartedAt === undefined) return;
		this.#lastTurnDurationMs = now - this.#turnStartedAt;
		this.#turnStartedAt = undefined;
	}

	/**
	 * Advance past a finished exhale. Returns `true` exactly once, on the
	 * `exhaling` -> `idle` transition — the caller's cue to tear the animated
	 * mount down to the static widget (zero further frame-clock subscriptions).
	 */
	settleIfDone(now: number): boolean {
		if (this.#phase !== "exhaling") return false;
		if (now - this.#exhaleStartedAt < EXHALE_DURATION_MS) return false;
		this.#phase = "idle";
		return true;
	}

	/** Milliseconds into the current breathing cycle. Only meaningful while `active`. */
	breathElapsedMs(now: number): number {
		return Math.max(0, now - this.#breathStartedAt);
	}

	/** Milliseconds into the wind-down exhale. Only meaningful while `exhaling`. */
	exhaleElapsedMs(now: number): number {
		return Math.max(0, now - this.#exhaleStartedAt);
	}

	/** The live breath period, modulated by the most recently observed turn duration. */
	breathPeriodMs(): number {
		return breathPeriodMsForTurnDuration(this.#lastTurnDurationMs);
	}

	snapshot(): BreathingBorderSnapshot {
		return { phase: this.#phase, periodMs: this.breathPeriodMs() };
	}
}
