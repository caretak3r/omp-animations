import { type BackpressureSignal, NO_BACKPRESSURE } from "./backpressure";
import type { MotionPolicy, MotionTier } from "./motion-policy";

/**
 * Clock/scheduler seam so tests drive frames deterministically without real
 * timers. `start` begins a repeating tick every `intervalMs` and returns a stop
 * function; `now` supplies the single time base every reading in the plugin
 * shares. That base is wall-clock epoch ms, not `performance.now`: elapsed-ms
 * deltas do not care, but absolute provider instants do — a rate-limit
 * `resetAtMs` parsed out of an RFC3339 header is epoch ms, and subtracting a
 * process-relative clock from it renders an epoch-sized ETA
 * (`resets 29779368m`) on every real session.
 */
export interface FrameScheduler {
	/** Wall-clock milliseconds since the Unix epoch. */
	now(): number;
	/** Begin ticking every `intervalMs`. Returns a function that stops the tick. */
	start(intervalMs: number, tick: () => void): () => void;
}

/** Default scheduler backed by `Date.now` + `setInterval`/`clearInterval`. */
export const DEFAULT_FRAME_SCHEDULER: FrameScheduler = {
	now: () => Date.now(),
	start(intervalMs, tick) {
		const id = setInterval(tick, intervalMs);
		return () => clearInterval(id);
	},
};

/** Called each emitted frame with a monotonic frame index and elapsed-ms since host start. */
export type FrameListener = (frame: number, elapsedMs: number) => void;

export interface AnimationHostOptions {
	/** Supplies the cadence tier and notifies on live changes. */
	policy: MotionPolicy;
	/** Render-backpressure signal; the host frame-skips (time-based) while under pressure. */
	backpressure?: BackpressureSignal;
	/** Injectable clock/scheduler seam. Defaults to real timers. */
	scheduler?: FrameScheduler;
}

// Budget all synchronous listeners, including widget rendering/diffing, together:
// 2ms at 30fps leaves most of each 33ms frame for the host TUI and agent work.
// Date.now has millisecond resolution, so recovery needs <=1ms, not borderline
// 2ms samples. These are admission thresholds, not a CPU benchmark.
const FRAME_WORK_BUDGET_MS = 2;
const HEALTHY_FRAME_MS = 1;
const PRESSURE_SAMPLES = 4;
const RECOVERY_SAMPLES = 30;
const STATIC_SAMPLE_MS = 250;

/**
 * One shared frame clock per instance. Each registrar-mounted controller
 * constructs its own `AnimationHost`, but within a given instance N
 * subscribers still coalesce onto exactly one underlying timer; the timer
 * stops when the last subscriber leaves and restarts on re-subscribe. Cadence
 * follows the {@link MotionPolicy} tier (`off` never starts); the host
 * re-syncs live when the policy changes. Elapsed-ms is wall-time-based so
 * effects derive phase from time and stay smooth across frames skipped under
 * backpressure.
 *
 * The family does not currently share one `AnimationHost` across controllers
 * (spiked and rejected — see `plans/PROGRESS.md` Plan 006): the registrar
 * mounts all controllers synchronously in one loop and every widget shares
 * one {@link MotionPolicy} tier, so same-cadence timers created back-to-back
 * land in the same event-loop timer phase on effectively every tick; the core
 * TUI's `requestComponentRender`/`requestRender` already coalesce same-tick
 * requests onto a single scheduled render (see
 * `packages/tui/src/tui.ts#requestOrdinaryRender`). Consolidating to one host
 * would mostly save N-1 idle `setInterval` callbacks, not paint work.
 */
export class AnimationHost {
	#policy: MotionPolicy;
	#backpressure: BackpressureSignal;
	#scheduler: FrameScheduler;
	#listeners = new Set<FrameListener>();
	#stopTimerFn: (() => void) | undefined;
	#activeCadenceMs = 0;
	#frame = 0;
	#startedAt: number | undefined;
	#unsubscribePolicy: (() => void) | undefined;
	#disposed = false;
	#pressureLevel = 0;
	#slowFrames = 0;
	#healthyFrames = 0;
	#motionNow: number | undefined;

	constructor(options: AnimationHostOptions) {
		this.#policy = options.policy;
		this.#backpressure = options.backpressure ?? NO_BACKPRESSURE;
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#unsubscribePolicy = this.#policy.subscribe(() => {
			this.#slowFrames = 0;
			this.#healthyFrames = 0;
			this.#sync();
		});
	}

	/** Number of live subscribers. */
	get subscriberCount(): number {
		return this.#listeners.size;
	}

	/** Whether the underlying timer is currently running. */
	get running(): boolean {
		return this.#stopTimerFn !== undefined;
	}

	/** Optional motion only. Configured policy still owns subscription/off semantics. */
	get effectiveTier(): MotionTier {
		if (this.#policy.tier === "off" || this.#pressureLevel === 3) return "off";
		return this.#pressureLevel > 0 ? "subtle" : this.#policy.tier;
	}

	/** The same timer coarsens twice before static motion; static still samples work. */
	get cadenceMs(): number {
		const configured = this.#policy.cadenceMs;
		if (configured === 0) return 0;
		const coarse = configured * 2 ** Math.min(this.#pressureLevel, 2);
		return this.#pressureLevel === 3 ? Math.max(coarse, STATIC_SAMPLE_MS) : coarse;
	}

	/** Decorative phase only. Never use this for deadlines, evidence age or lifecycle. */
	motionTime(now: number): number {
		return this.#pressureLevel === 0 ? now : (this.#motionNow ?? now);
	}

	/**
	 * Subscribe to frame ticks. Returns an unsubscribe function. Adding the first
	 * subscriber (when the tier allows motion) starts the shared timer; removing
	 * the last one stops it.
	 */
	subscribe(listener: FrameListener): () => void {
		if (this.#disposed) return () => {};
		this.#listeners.add(listener);
		this.#sync();
		return () => {
			if (!this.#listeners.delete(listener)) return;
			this.#sync();
		};
	}

	/** Stop the timer, drop all subscribers, and detach from the policy. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#listeners.clear();
		this.#stopTimer();
		this.#unsubscribePolicy?.();
		this.#unsubscribePolicy = undefined;
	}

	/** Reconcile the timer with the current subscriber count and policy tier. */
	#sync(): void {
		if (this.#disposed) return;
		const cadence = this.cadenceMs;
		const wantTimer = this.#listeners.size > 0 && cadence > 0;
		if (!wantTimer) {
			this.#stopTimer();
			return;
		}
		if (this.#stopTimerFn !== undefined && this.#activeCadenceMs === cadence) {
			// Already running at the right cadence — nothing to reconcile.
			return;
		}
		this.#stopTimer();
		this.#activeCadenceMs = cadence;
		if (this.#startedAt === undefined) {
			this.#startedAt = this.#scheduler.now();
		}
		this.#stopTimerFn = this.#scheduler.start(cadence, () => this.#tick());
	}

	#stopTimer(): void {
		if (this.#stopTimerFn === undefined) return;
		this.#stopTimerFn();
		this.#stopTimerFn = undefined;
		this.#activeCadenceMs = 0;
	}

	#tick(): void {
		// External pressure still skips the entire frame. Skips are not healthy
		// samples; the existing timer resumes measurement when pressure clears.
		if (this.#backpressure.underPressure) {
			this.#slowFrames = 0;
			this.#healthyFrames = 0;
			return;
		}
		const started = this.#scheduler.now();
		this.#frame++;
		if (this.#pressureLevel < 3) this.#motionNow = started;
		const elapsedMs = started - (this.#startedAt ?? started);
		try {
			// Snapshot so a listener unsubscribing mid-emit cannot skip a sibling.
			for (const listener of [...this.#listeners]) {
				listener(this.#frame, elapsedMs);
			}
		} catch (error) {
			this.#slowFrames = 0;
			this.#healthyFrames = 0;
			throw error;
		}
		this.#observeFrameCost(this.#scheduler.now() - started);
	}

	#observeFrameCost(costMs: number): void {
		if (costMs > FRAME_WORK_BUDGET_MS && Number.isFinite(costMs)) {
			this.#healthyFrames = 0;
			this.#slowFrames = Math.min(this.#slowFrames + 1, PRESSURE_SAMPLES);
			if (this.#slowFrames < PRESSURE_SAMPLES || this.#pressureLevel === 3) return;
			this.#pressureLevel++;
		} else if (costMs >= 0 && costMs <= HEALTHY_FRAME_MS) {
			this.#slowFrames = 0;
			this.#healthyFrames = Math.min(this.#healthyFrames + 1, RECOVERY_SAMPLES);
			if (this.#healthyFrames < RECOVERY_SAMPLES || this.#pressureLevel === 0) return;
			this.#pressureLevel--;
		} else {
			// Borderline work or a backwards clock cannot establish a healthy run.
			this.#slowFrames = 0;
			this.#healthyFrames = 0;
			return;
		}
		this.#slowFrames = 0;
		this.#healthyFrames = 0;
		this.#sync();
	}
}
