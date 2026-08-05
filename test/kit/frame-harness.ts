import type { AnimatedWidgetHost, FrameScheduler, MotionEnvironment, MotionTier } from "../../src/kit";
import { AnimationHost, MotionPolicy } from "../../src/kit";

/**
 * Deterministic clock/scheduler seam: timers fire only on explicit {@link step}/
 * {@link fire}, never on wall time, so every frame is driven by the test.
 * Reusable across any animation's frame-snapshot tests (originally
 * `context-weather`'s local helper, promoted here so a second consumer doesn't
 * have to redefine it).
 */
export class FakeScheduler implements FrameScheduler {
	#now = 0;
	#tick: (() => void) | undefined;
	intervalMs = 0;
	startCount = 0;

	now(): number {
		return this.#now;
	}

	start(intervalMs: number, tick: () => void): () => void {
		this.intervalMs = intervalMs;
		this.#tick = tick;
		this.startCount++;
		return () => {
			this.#tick = undefined;
			this.intervalMs = 0;
		};
	}

	/** Advance the clock without emitting a frame. */
	advance(ms: number): void {
		this.#now += ms;
	}

	/** Emit a frame at the current clock without advancing. */
	fire(): void {
		this.#tick?.();
	}

	/** Advance by one active cadence and emit a frame (the common animation step). */
	step(): void {
		if (this.intervalMs > 0) {
			this.#now += this.intervalMs;
			this.#tick?.();
		}
	}
}

/** No-op scoped-repaint host for widget tests. */
export const noopHost: AnimatedWidgetHost = { requestComponentRender: () => {} };

/** The minimal surface {@link captureFrameSequence} needs from the widget under test. */
export interface FrameHarnessWidget {
	render(width: number): readonly string[];
	dispose(): void;
}

export interface FrameSnapshotFixture<W extends FrameHarnessWidget> {
	/** Terminal width every frame renders at. */
	width: number;
	/** Number of animation frames to step through and capture, beyond the initial render. */
	frameCount: number;
	/** Motion tier to drive the fixture at. Defaults to `"full"`. */
	tier?: MotionTier;
	/** Motion environment fed to the `MotionPolicy` (defaults to a TTY-with-UI environment). */
	env?: Partial<MotionEnvironment>;
	/** Build the widget under test, wired to the given deterministic host/policy/scheduler. */
	createWidget(deps: { host: AnimationHost; policy: MotionPolicy; scheduler: FakeScheduler }): W;
}

/**
 * Reusable deterministic frame-snapshot harness: wires a {@link FakeScheduler}-backed
 * {@link AnimationHost}/{@link MotionPolicy}, builds the widget under test via the
 * fixture's `createWidget`, then steps the scheduler `frameCount` times capturing
 * `widget.render(width)` at each step. Byte-stable given a byte-stable fixture, because
 * every widget in this kit derives its animation phase from the injected clock
 * (`this.elapsedMs`, or a widget-local clock seam also backed by the same scheduler),
 * never from wall-clock reads inside `render`/`renderFrame`.
 *
 * Any animation built on `AnimatedWidget` can opt in: supply a `createWidget` factory
 * and a fixture (initial state, forecast, etc.) — see `test/context-weather/harness.test.ts`
 * and `test/goal-horizon-harness.test.ts` for two independent consumers of this same seam.
 */
export function captureFrameSequence<W extends FrameHarnessWidget>(fixture: FrameSnapshotFixture<W>): string[] {
	const scheduler = new FakeScheduler();
	const env: MotionEnvironment = { hasUI: true, isTTY: true, env: {}, ...fixture.env };
	const policy = new MotionPolicy(env, fixture.tier ?? "full");
	const host = new AnimationHost({ policy, scheduler });
	const widget = fixture.createWidget({ host, policy, scheduler });

	// Prime the width cache so the frame loop diffs against a real render.
	widget.render(fixture.width);

	const frames: string[] = [];
	for (let i = 0; i < fixture.frameCount; i++) {
		scheduler.step();
		frames.push(widget.render(fixture.width).join("\n"));
	}
	widget.dispose();
	return frames;
}
