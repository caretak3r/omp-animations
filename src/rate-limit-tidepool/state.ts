import type { RateLimitFamily } from "./tidepool";

/**
 * One provider's rate-limit pool, as read off its most recent recognized
 * response. Memoryless by design (see `tidepool.ts`'s module doc) — there is
 * exactly one snapshot, never a per-provider history, so a provider switch
 * replaces it outright rather than blending two pools together.
 */
export interface TidepoolSnapshot {
	/** The configured gateway this response came through (`AssistantMessage.provider`) — also the family key. */
	readonly provider: string;
	readonly family: RateLimitFamily;
	/** `remaining / limit` of the response's most-depleted recognized bucket, in `[0, 1]`. */
	readonly level: number;
	/** Absolute epoch ms the binding bucket refills at; `undefined` if that bucket reported no reset. */
	readonly resetAtMs: number | undefined;
	/** When this response was ingested (the controller's clock) — the refill animation's start point. */
	readonly observedAtMs: number;
}

/**
 * Mutable holder for the single live pool. `applySample` always replaces the
 * whole snapshot — there is no accumulation, averaging, or per-provider
 * history to merge; the latest recognized response is the only thing this
 * ever reports, which is exactly what makes a provider switch an instant,
 * un-blended swap rather than a gradual transition between two pools.
 */
export class RateLimitTidepoolState {
	#snapshot: TidepoolSnapshot | undefined;

	/** `undefined` before the first recognized response — the controller's cue to stay unmounted. */
	snapshot(): TidepoolSnapshot | undefined {
		return this.#snapshot;
	}

	applySample(sample: TidepoolSnapshot): void {
		this.#snapshot = sample;
	}
}
