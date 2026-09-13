import { describe, expect, it } from "bun:test";
import {
	AnimatedWidget,
	type AnimatedWidgetHost,
	AnimationHost,
	type BackpressureSignal,
	type FrameScheduler,
	type MotionEnvironment,
	MotionPolicy,
	REDUCED_MOTION_CADENCE_MULTIPLIER,
	resolveMotionTier,
	TIER_CADENCE_MS,
} from "../../src/kit";

/**
 * Deterministic clock/scheduler seam. Timers fire on `advance`, never on real
 * wall time, so every test drives frames explicitly. `activeTimers` and
 * `startCount` let coalescing tests assert the single-timer contract directly.
 */
class FakeScheduler implements FrameScheduler {
	#now = 0;
	#nextId = 0;
	#timers = new Map<number, { intervalMs: number; tick: () => void; nextAt: number }>();
	startCount = 0;
	maxActiveTimers = 0;

	now(): number {
		return this.#now;
	}

	spend(ms: number): void {
		this.#now += ms;
	}

	start(intervalMs: number, tick: () => void): () => void {
		const id = this.#nextId++;
		this.startCount++;
		this.#timers.set(id, { intervalMs, tick, nextAt: this.#now + intervalMs });
		this.maxActiveTimers = Math.max(this.maxActiveTimers, this.#timers.size);
		return () => {
			this.#timers.delete(id);
		};
	}

	get activeTimers(): number {
		return this.#timers.size;
	}

	/** Interval of the single active timer, or undefined when none is running. */
	get activeIntervalMs(): number | undefined {
		for (const t of this.#timers.values()) return t.intervalMs;
		return undefined;
	}

	/** Advance the clock by `ms`, firing due ticks in chronological order. */
	advance(ms: number): void {
		const target = this.#now + ms;
		let guard = 0;
		while (true) {
			let due: { intervalMs: number; tick: () => void; nextAt: number } | undefined;
			for (const t of this.#timers.values()) {
				if (t.nextAt <= target && (due === undefined || t.nextAt < due.nextAt)) due = t;
			}
			if (due === undefined) break;
			this.#now = Math.max(this.#now, due.nextAt);
			due.nextAt += due.intervalMs;
			due.tick();
			if (++guard > 1_000_000) throw new Error("runaway scheduler advance");
		}
		this.#now = Math.max(this.#now, target);
	}
}

/** Mutable backpressure signal for frame-skip tests. */
class ToggleBackpressure implements BackpressureSignal {
	underPressure = false;
}

const interactiveEnv = (overrides: Partial<MotionEnvironment> = {}): MotionEnvironment => ({
	hasUI: true,
	isTTY: true,
	env: {},
	...overrides,
});

function fullPolicy(env: Partial<MotionEnvironment> = {}): MotionPolicy {
	return new MotionPolicy(interactiveEnv(env), "full");
}

describe("AnimationHost coalescing", () => {
	it("shares one timer across N subscribers and stops on last unsubscribe", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });

		const unsubs = [host.subscribe(() => {}), host.subscribe(() => {}), host.subscribe(() => {})];
		expect(host.subscriberCount).toBe(3);
		expect(scheduler.activeTimers).toBe(1);
		expect(scheduler.startCount).toBe(1);

		unsubs[0]!();
		unsubs[1]!();
		expect(scheduler.activeTimers).toBe(1);

		unsubs[2]!();
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);
		expect(host.running).toBe(false);
	});

	it("restarts the timer when a subscriber returns after the host went idle", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });

		const stop = host.subscribe(() => {});
		expect(scheduler.startCount).toBe(1);
		stop();
		expect(scheduler.activeTimers).toBe(0);

		host.subscribe(() => {});
		expect(scheduler.activeTimers).toBe(1);
		expect(scheduler.startCount).toBe(2);
	});

	it("emits monotonic frame indices and non-decreasing elapsed values", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const frames: number[] = [];
		const elapsed: number[] = [];
		host.subscribe((frame, elapsedMs) => {
			frames.push(frame);
			elapsed.push(elapsedMs);
		});

		// +1ms past the 4th frame so the boundary tick can't drift under float rounding.
		scheduler.advance(TIER_CADENCE_MS.full * 4 + 1);

		expect(frames).toEqual([1, 2, 3, 4]);
		expect(elapsed[0]).toBe(TIER_CADENCE_MS.full);
		for (let i = 1; i < elapsed.length; i++) {
			expect(elapsed[i]!).toBeGreaterThan(elapsed[i - 1]!);
		}
	});
});

describe("MotionPolicy gating", () => {
	it("forces off for every hard gate regardless of the setting", () => {
		expect(resolveMotionTier(interactiveEnv({ hasUI: false }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ isTTY: false }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ env: { CI: "true" } }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ env: { NO_COLOR: "1" } }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ env: { TERM: "dumb" } }), "full")).toBe("off");
		expect(resolveMotionTier(interactiveEnv({ backpressure: { underPressure: true } }), "full")).toBe("off");
	});

	it("passes the setting through on an interactive TTY", () => {
		expect(resolveMotionTier(interactiveEnv(), "subtle")).toBe("subtle");
		expect(resolveMotionTier(interactiveEnv(), "full")).toBe("full");
		expect(resolveMotionTier(interactiveEnv(), "off")).toBe("off");
	});

	it("treats an empty env var as unset (CI= does not gate)", () => {
		expect(resolveMotionTier(interactiveEnv({ env: { CI: "" } }), "full")).toBe("full");
	});

	it("notifies subscribers only when the resolved tier changes", () => {
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const seen: string[] = [];
		policy.subscribe(tier => seen.push(tier));

		policy.setSetting("full"); // no-op, no notification
		policy.setSetting("subtle");
		policy.setSetting("off");
		expect(seen).toEqual(["subtle", "off"]);
	});

	it("maps each tier to its cadence; off never starts a host timer", () => {
		expect(TIER_CADENCE_MS.off).toBe(0);
		expect(TIER_CADENCE_MS.subtle).toBeGreaterThan(TIER_CADENCE_MS.full);

		const scheduler = new FakeScheduler();
		const offHost = new AnimationHost({ policy: new MotionPolicy(interactiveEnv(), "off"), scheduler });
		offHost.subscribe(() => {});
		expect(scheduler.activeTimers).toBe(0);

		const subtleScheduler = new FakeScheduler();
		const subtleHost = new AnimationHost({
			policy: new MotionPolicy(interactiveEnv(), "subtle"),
			scheduler: subtleScheduler,
		});
		subtleHost.subscribe(() => {});
		expect(subtleScheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.subtle);
	});

	it("re-syncs host cadence live when the policy tier changes", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const host = new AnimationHost({ policy, scheduler });
		host.subscribe(() => {});
		expect(scheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.full);

		policy.setSetting("subtle");
		expect(scheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.subtle);

		policy.setSetting("off");
		expect(scheduler.activeTimers).toBe(0);
	});
});

describe("MotionPolicy reduced motion", () => {
	it("enables reduced motion when OMP_ANIMATIONS_REDUCED_MOTION=1", () => {
		const policy = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } }), "full");
		expect(policy.reducedMotion).toBe(true);
	});

	it("enables reduced motion when OMP_ANIMATIONS_REDUCED_MOTION=true (case-insensitive)", () => {
		const policyLower = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "true" } }), "full");
		expect(policyLower.reducedMotion).toBe(true);

		const policyUpper = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "TRUE" } }), "full");
		expect(policyUpper.reducedMotion).toBe(true);

		const policyMixed = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "True" } }), "full");
		expect(policyMixed.reducedMotion).toBe(true);
	});

	it("disables reduced motion when env var is unset or has other values", () => {
		const unset = new MotionPolicy(interactiveEnv(), "full");
		expect(unset.reducedMotion).toBe(false);

		const empty = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "" } }), "full");
		expect(empty.reducedMotion).toBe(false);

		const zero = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "0" } }), "full");
		expect(zero.reducedMotion).toBe(false);

		const false_ = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "false" } }), "full");
		expect(false_.reducedMotion).toBe(false);

		const other = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "yes" } }), "full");
		expect(other.reducedMotion).toBe(false);
	});

	it("applies cadence multiplier when reduced motion is enabled", () => {
		const normalFull = new MotionPolicy(interactiveEnv(), "full");
		expect(normalFull.cadenceMs).toBe(TIER_CADENCE_MS.full);

		const reducedFull = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } }), "full");
		expect(reducedFull.cadenceMs).toBe(TIER_CADENCE_MS.full * REDUCED_MOTION_CADENCE_MULTIPLIER);

		const normalSubtle = new MotionPolicy(interactiveEnv(), "subtle");
		expect(normalSubtle.cadenceMs).toBe(TIER_CADENCE_MS.subtle);

		const reducedSubtle = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } }), "subtle");
		expect(reducedSubtle.cadenceMs).toBe(TIER_CADENCE_MS.subtle * REDUCED_MOTION_CADENCE_MULTIPLIER);
	});

	it("does not affect off tier (cadence stays 0)", () => {
		const reducedOff = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } }), "off");
		expect(reducedOff.cadenceMs).toBe(0);
	});

	it("updates reduced motion state when environment changes", () => {
		const policy = new MotionPolicy(interactiveEnv(), "full");
		expect(policy.reducedMotion).toBe(false);
		expect(policy.cadenceMs).toBe(TIER_CADENCE_MS.full);

		policy.setEnvironment(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } }));
		expect(policy.reducedMotion).toBe(true);
		expect(policy.cadenceMs).toBe(TIER_CADENCE_MS.full * REDUCED_MOTION_CADENCE_MULTIPLIER);

		policy.setEnvironment(interactiveEnv());
		expect(policy.reducedMotion).toBe(false);
		expect(policy.cadenceMs).toBe(TIER_CADENCE_MS.full);
	});

	it("updates reduced motion state on refresh", () => {
		const env = interactiveEnv();
		const policy = new MotionPolicy(env, "full");
		expect(policy.reducedMotion).toBe(false);

		// Simulate env change (though in real usage, env would be read from Bun.env)
		env.env = { OMP_ANIMATIONS_REDUCED_MOTION: "1" };
		policy.refresh();
		expect(policy.reducedMotion).toBe(true);
		expect(policy.cadenceMs).toBe(TIER_CADENCE_MS.full * REDUCED_MOTION_CADENCE_MULTIPLIER);
	});

	it("applies reduced cadence to AnimationHost timer", () => {
		const scheduler = new FakeScheduler();
		const reducedPolicy = new MotionPolicy(interactiveEnv({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } }), "full");
		const host = new AnimationHost({ policy: reducedPolicy, scheduler });
		host.subscribe(() => {});

		expect(scheduler.activeIntervalMs).toBe(TIER_CADENCE_MS.full * REDUCED_MOTION_CADENCE_MULTIPLIER);
	});
});

describe("AnimationHost backpressure frame-skip", () => {
	it("emits fewer frames within a window while under pressure", () => {
		const scheduler = new FakeScheduler();
		const backpressure = new ToggleBackpressure();
		const host = new AnimationHost({ policy: fullPolicy(), backpressure, scheduler });

		let calmFrames = 0;
		let pressuredFrames = 0;
		let underPressure = false;
		host.subscribe(() => {
			if (underPressure) pressuredFrames++;
			else calmFrames++;
		});

		const window = TIER_CADENCE_MS.full * 10 + 1;
		scheduler.advance(window);
		expect(calmFrames).toBe(10);

		underPressure = true;
		backpressure.underPressure = true;
		scheduler.advance(window);
		expect(pressuredFrames).toBe(0);
		expect(pressuredFrames).toBeLessThan(calmFrames);
	});
});

describe("AnimationHost motion governor", () => {
	it("budgets aggregate work, coarsens twice, then keeps one static sampling timer", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		let elapsed = 0;
		host.subscribe((_frame, now) => {
			elapsed = now;
			scheduler.spend(1.5);
		});
		host.subscribe(() => scheduler.spend(1.5));
		const initialCadence = policy.cadenceMs;
		for (let frame = 0; frame < 3; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("full");
		expect(host.cadenceMs).toBe(initialCadence);
		scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		expect(host.cadenceMs).toBe(initialCadence * 2);
		for (let frame = 0; frame < 4; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		expect(host.cadenceMs).toBe(initialCadence * 4);
		for (let frame = 0; frame < 4; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		expect(host.cadenceMs).toBe(250);
		expect(policy.tier).toBe("full");
		expect(policy.cadenceMs).toBe(initialCadence);
		const motionAt = host.motionTime(scheduler.now());
		const elapsedAtFreeze = elapsed;
		scheduler.advance(250);
		expect(host.motionTime(scheduler.now())).toBe(motionAt);
		expect(elapsed).toBeGreaterThan(elapsedAtFreeze);
		expect(host.running).toBe(true);
		expect(scheduler.activeTimers).toBe(1);
		expect(scheduler.maxActiveTimers).toBe(1);
		host.dispose();
		expect(scheduler.activeTimers).toBe(0);
	});

	it("requires sustained healthy work at each recovery step and resets streaks across pressure skips", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const backpressure = new ToggleBackpressure();
		const host = new AnimationHost({ policy, scheduler, backpressure });
		let workMs = 3;
		let frames = 0;
		host.subscribe(() => {
			frames++;
			scheduler.spend(workMs);
		});
		for (let frame = 0; frame < 12; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		workMs = 0;
		for (let frame = 0; frame < 29; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		workMs = 2;
		scheduler.advance(host.cadenceMs);
		workMs = 0;
		for (let frame = 0; frame < 29; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		backpressure.underPressure = true;
		const beforeSkip = frames;
		scheduler.advance(10_000);
		expect(frames).toBe(beforeSkip);
		expect(host.effectiveTier).toBe("off");
		expect(scheduler.activeTimers).toBe(1);
		backpressure.underPressure = false;
		for (let frame = 0; frame < 29; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		expect(host.cadenceMs).toBe(policy.cadenceMs * 4);
		for (let frame = 0; frame < 30; frame++) scheduler.advance(host.cadenceMs);
		expect(host.cadenceMs).toBe(policy.cadenceMs * 2);
		for (let frame = 0; frame < 29; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("full");
		expect(host.cadenceMs).toBe(policy.cadenceMs);
		expect(scheduler.maxActiveTimers).toBe(1);
		host.dispose();
	});

	it("does not count failed listener batches toward motion recovery", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		let workMs = 3;
		let fail = false;
		const failure = new Error("render failed");
		host.subscribe(() => {
			if (fail) throw failure;
			scheduler.spend(workMs);
		});
		for (let frame = 0; frame < 12; frame++) scheduler.advance(host.cadenceMs);
		workMs = 0;
		for (let frame = 0; frame < 29; frame++) scheduler.advance(host.cadenceMs);
		fail = true;
		expect(() => scheduler.advance(host.cadenceMs)).toThrow(failure);
		expect(host.effectiveTier).toBe("off");
		fail = false;
		for (let frame = 0; frame < 29; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		host.dispose();
	});

	it("honors live off and reduced-motion policy while recovering to the configured tier", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy({ env: { OMP_ANIMATIONS_REDUCED_MOTION: "1" } });
		const host = new AnimationHost({ policy, scheduler });
		let workMs = 3;
		host.subscribe(() => scheduler.spend(workMs));
		for (let frame = 0; frame < 12; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("off");
		expect(host.cadenceMs).toBe(policy.cadenceMs * 4);
		policy.setSetting("off");
		expect(host.cadenceMs).toBe(0);
		expect(scheduler.activeTimers).toBe(0);
		policy.setSetting("subtle");
		expect(scheduler.activeTimers).toBe(1);
		workMs = 0;
		for (let frame = 0; frame < 90; frame++) scheduler.advance(host.cadenceMs);
		expect(host.effectiveTier).toBe("subtle");
		expect(host.cadenceMs).toBe(TIER_CADENCE_MS.subtle * REDUCED_MOTION_CADENCE_MULTIPLIER);
		expect(policy.reducedMotion).toBe(true);
		expect(policy.tier).toBe("subtle");
		host.dispose();
	});
});

describe("determinism", () => {
	it("reproduces the same elapsed sequence for a fixed injected clock", () => {
		const run = (): number[] => {
			const scheduler = new FakeScheduler();
			const host = new AnimationHost({ policy: fullPolicy(), scheduler });
			const elapsed: number[] = [];
			host.subscribe((_frame, elapsedMs) => elapsed.push(elapsedMs));
			scheduler.advance(TIER_CADENCE_MS.full * 5 + 1);
			return elapsed;
		};

		const a = run();
		const b = run();
		// Same injected clock → byte-identical elapsed sequence.
		expect(a).toEqual(b);
		expect(a).toHaveLength(5);
		// First frame lands exactly one cadence in; elapsed is strictly increasing.
		expect(a[0]).toBe(TIER_CADENCE_MS.full);
		for (let i = 1; i < a.length; i++) {
			expect(a[i]!).toBeGreaterThan(a[i - 1]!);
		}
	});
});

/** Counts scoped repaint requests without touching a real TUI. */
class CountingHost implements AnimatedWidgetHost {
	renders = 0;
	requestComponentRender(): void {
		this.renders++;
	}
}

class StaticWidget extends AnimatedWidget {
	renderFrame(): readonly string[] {
		return ["static"];
	}
}

class MutableWidget extends AnimatedWidget {
	value = "before";

	renderFrame(): readonly string[] {
		return [this.value];
	}
}

class ClockWidget extends AnimatedWidget {
	renderFrame(): readonly string[] {
		// Content changes every frame (phase-dependent), forcing a repaint each tick.
		return [`t=${Math.floor(this.elapsedMs)}`];
	}
}

describe("AnimatedWidget lifecycle", () => {
	it("subscribes on mount and returns the host to zero subscribers on dispose", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const widget = new StaticWidget({ tui: new CountingHost(), host, policy: fullPolicy() });

		expect(host.subscriberCount).toBe(1);
		expect(widget.animating).toBe(true);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);

		// Idempotent: a second dispose is a no-op.
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("never requests a repaint for identical consecutive frames", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const tui = new CountingHost();
		const widget = new StaticWidget({ tui, host, policy: fullPolicy() });

		// Establish width + baseline rows (what the TUI does when it mounts the widget).
		expect(widget.render(80)).toEqual(["static"]);

		scheduler.advance(TIER_CADENCE_MS.full * 5 + 1);
		expect(tui.renders).toBe(0);

		widget.dispose();
	});

	it("invalidates cached rows and requests one repaint for external state changes", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "off");
		const host = new AnimationHost({ policy, scheduler });
		const tui = new CountingHost();
		const widget = new MutableWidget({ tui, host, policy });

		expect(widget.render(80)).toEqual(["before"]);
		widget.value = "after";
		expect(widget.render(80)).toEqual(["before"]);

		widget.requestRender();
		expect(tui.renders).toBe(1);
		expect(widget.render(80)).toEqual(["after"]);
	});

	it("requests a scoped repaint each frame when the rendered rows change", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const tui = new CountingHost();
		const widget = new ClockWidget({ tui, host, policy: fullPolicy() });
		widget.render(80);

		scheduler.advance(TIER_CADENCE_MS.full * 4 + 1);
		expect(tui.renders).toBe(4);

		widget.dispose();
	});

	it("renders one static frame and never subscribes when the tier is off", () => {
		const scheduler = new FakeScheduler();
		const host = new AnimationHost({ policy: fullPolicy(), scheduler });
		const tui = new CountingHost();
		const offPolicy = new MotionPolicy(interactiveEnv(), "off");
		const widget = new StaticWidget({ tui, host, policy: offPolicy });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(80)).toEqual(["static"]);

		scheduler.advance(TIER_CADENCE_MS.full * 5 + 1);
		expect(tui.renders).toBe(0);
	});
});

describe("AnimatedWidget live tier changes", () => {
	it("animates without a remount when the tier changes from off to full", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "off");
		const host = new AnimationHost({ policy, scheduler });
		const tui = new CountingHost();
		const widget = new ClockWidget({ tui, host, policy });

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);

		widget.render(80);
		policy.setSetting("full");

		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);
		expect(tui.renders).toBe(1);

		widget.render(80);
		scheduler.advance(TIER_CADENCE_MS.full * 4 + 1);
		expect(tui.renders).toBe(5);

		widget.dispose();
	});

	it("stops the clock and settles on one static frame when the tier changes from full to off", () => {
		const scheduler = new FakeScheduler();
		const policy = new MotionPolicy(interactiveEnv(), "full");
		const host = new AnimationHost({ policy, scheduler });
		const tui = new CountingHost();
		const widget = new ClockWidget({ tui, host, policy });

		widget.render(80);
		scheduler.advance(TIER_CADENCE_MS.full * 2 + 1);
		expect(widget.animating).toBe(true);

		const rendersBeforeOff = tui.renders;
		policy.setSetting("off");
		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(scheduler.activeTimers).toBe(0);
		expect(tui.renders).toBe(rendersBeforeOff + 1);

		const rows = widget.render(80);
		const rendersAfterStaticFrame = tui.renders;
		scheduler.advance(TIER_CADENCE_MS.full * 10 + 1);
		expect(tui.renders).toBe(rendersAfterStaticFrame);
		expect(widget.render(80)).toEqual(rows);

		widget.dispose();
	});

	it("unsubscribes from both host and policy on dispose and stays idempotent", () => {
		const scheduler = new FakeScheduler();
		const policy = fullPolicy();
		const host = new AnimationHost({ policy, scheduler });
		const widget = new StaticWidget({ tui: new CountingHost(), host, policy });

		expect(policy.listenerCount).toBe(2);
		expect(host.subscriberCount).toBe(1);

		widget.dispose();
		expect(policy.listenerCount).toBe(1);
		expect(host.subscriberCount).toBe(0);

		policy.setSetting("off");
		policy.setSetting("full");
		expect(host.subscriberCount).toBe(0);

		widget.dispose();
		expect(policy.listenerCount).toBe(1);
	});
});
