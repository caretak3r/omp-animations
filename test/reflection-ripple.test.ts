import { describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { AnimationHost, backpressureFromTui, type FrameScheduler, MotionPolicy } from "../src/kit";
import { type ReflectionRippleContext, ReflectionRippleController } from "../src/reflection-ripple/controller";
import {
	DIM_DURATION_MS,
	dimMultiplier,
	RIPPLE_DURATION_MS,
	reflectDimAmount,
	ringGlyph,
	rippleBrightness,
	rippleProgress,
	rippleRadius,
} from "../src/reflection-ripple/ripple";
import { ReflectionRippleState } from "../src/reflection-ripple/state";
import {
	REFLECTION_RIPPLE_COLORS,
	type ReflectionRippleTheme,
	ReflectionRippleWidget,
	renderReflectionRippleIdleRow,
	renderReflectionRippleOffText,
	renderReflectionRippleRow,
} from "../src/reflection-ripple/widget";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: ReflectionRippleTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which token the renderer chose.
const taggedTheme: ReflectionRippleTheme = { fg: (color, text) => `${color}:${text}` };

function rule(name: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: "",
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

/** Manual frame scheduler: drives host ticks deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

class ToggleTui {
	renderUnderPressure = false;
	requestComponentRender(): void {}
}

describe("reflection ripple pure math", () => {
	it("rippleProgress is 0 at the start, 1 at the boundary, and clamps beyond", () => {
		expect(rippleProgress(0, 1000)).toBe(0);
		expect(rippleProgress(500, 1000)).toBe(0.5);
		expect(rippleProgress(1000, 1000)).toBe(1);
		expect(rippleProgress(5000, 1000)).toBe(1);
		expect(rippleProgress(-100, 1000)).toBe(0);
	});

	it("rippleRadius is 0 at progress 0, maxRadius at progress 1, and monotonic non-decreasing between", () => {
		expect(rippleRadius(0, 10)).toBe(0);
		expect(rippleRadius(1, 10)).toBeCloseTo(10, 5);
		const samples = Array.from({ length: 11 }, (_, i) => rippleRadius(i / 10, 10));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-9);
		}
	});

	it("rippleRadius decelerates: the first half of progress covers more distance than the second half", () => {
		const firstHalf = rippleRadius(0.5, 10) - rippleRadius(0, 10);
		const secondHalf = rippleRadius(1, 10) - rippleRadius(0.5, 10);
		expect(firstHalf).toBeGreaterThan(secondHalf);
	});

	it("rippleBrightness is 1 at birth, 0 at full expansion, and monotonically non-increasing", () => {
		expect(rippleBrightness(0)).toBe(1);
		expect(rippleBrightness(1)).toBe(0);
		const samples = Array.from({ length: 11 }, (_, i) => rippleBrightness(i / 10));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});

	it("ringGlyph maps low brightness to a fainter glyph than high brightness", () => {
		expect(ringGlyph(0)).toBe(" ");
		expect(ringGlyph(1)).toBe("◉");
		expect(ringGlyph(0.1)).not.toBe(ringGlyph(0.9));
	});

	it("ringGlyph defaults to unicode; ascii substitutes are exact one-column values distinct across the ramp", () => {
		expect(ringGlyph(0, "unicode")).toBe(ringGlyph(0));
		expect(ringGlyph(0, "ascii")).toBe(" ");
		expect(ringGlyph(1, "ascii")).toBe("@");
		const ramp = [0, 0.25, 0.5, 0.75, 1].map(b => ringGlyph(b, "ascii"));
		expect(new Set(ramp).size).toBe(ramp.length);
		for (const glyph of ramp) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("ringGlyph's nerd preset aliases unicode exactly", () => {
		for (const b of [0, 0.25, 0.5, 0.75, 1]) {
			expect(ringGlyph(b, "nerd")).toBe(ringGlyph(b, "unicode"));
		}
	});

	it("reflectDimAmount peaks immediately at the trigger and eases back to 0 by the duration, monotonically", () => {
		expect(reflectDimAmount(0, DIM_DURATION_MS)).toBeCloseTo(1, 5);
		expect(reflectDimAmount(DIM_DURATION_MS, DIM_DURATION_MS)).toBe(0);
		expect(reflectDimAmount(DIM_DURATION_MS + 500, DIM_DURATION_MS)).toBe(0);
		const samples = Array.from({ length: 10 }, (_, i) =>
			reflectDimAmount((i * DIM_DURATION_MS) / 10, DIM_DURATION_MS),
		);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});

	it("dimMultiplier pulls brightness down at dimAmount 1 and leaves it untouched at 0, monotonically", () => {
		expect(dimMultiplier(0)).toBe(1);
		expect(dimMultiplier(1)).toBeCloseTo(0.35, 5);
		const samples = Array.from({ length: 6 }, (_, i) => dimMultiplier(i / 5));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});
});

describe("reflection ripple pure math edge cases", () => {
	it("rippleProgress guards non-finite inputs: NaN durationMs/elapsedMs don't crash", () => {
		expect(rippleProgress(500, Number.NaN)).toBeNaN();
		expect(rippleProgress(Number.NaN, 1000)).toBeNaN();
		expect(rippleProgress(Number.POSITIVE_INFINITY, 1000)).toBe(1);
		expect(rippleProgress(500, -100)).toBe(1); // durationMs <= 0 short-circuits to fully-faded
	});

	it("rippleRadius clamps a negative maxRadius to 0 rather than a negative distance", () => {
		expect(rippleRadius(0.5, -10)).toBe(0);
		expect(rippleRadius(0.5, 0)).toBe(0);
	});

	it("rippleRadius(NaN, ...) and rippleBrightness(NaN) propagate NaN rather than throwing", () => {
		expect(rippleRadius(Number.NaN, 10)).toBeNaN();
		expect(rippleBrightness(Number.NaN)).toBeNaN();
		expect(rippleBrightness(Number.POSITIVE_INFINITY)).toBe(0); // clamped to progress=1, fully faded
	});

	it("ringGlyph(NaN) falls back to the faintest glyph instead of returning undefined (regression)", () => {
		expect(ringGlyph(Number.NaN)).toBe(" ");
		expect(ringGlyph(Number.POSITIVE_INFINITY)).toBe("◉"); // clamps to brightness 1
		expect(ringGlyph(Number.NEGATIVE_INFINITY)).toBe(" "); // clamps to brightness 0
	});

	it("reflectDimAmount(NaN, ...) propagates NaN rather than throwing; negative durationMs reads as settled", () => {
		expect(reflectDimAmount(Number.NaN, DIM_DURATION_MS)).toBeNaN();
		expect(reflectDimAmount(500, -1)).toBe(0);
	});

	it("dimMultiplier(NaN) propagates NaN rather than clamping to a safe multiplier", () => {
		expect(dimMultiplier(Number.NaN)).toBeNaN();
		expect(dimMultiplier(-5)).toBe(1); // clamped to dimAmount 0, untouched brightness
		expect(dimMultiplier(Number.POSITIVE_INFINITY)).toBeCloseTo(0.35, 5); // clamped to dimAmount 1
	});
});

describe("reflection ripple pure rendering", () => {
	it("at birth (elapsedMs 0), full tier draws a single centered glyph — the wave hasn't expanded yet", () => {
		const row = renderReflectionRippleRow(0, 11, taggedTheme, "full");
		const brightness = rippleBrightness(0) * dimMultiplier(1);
		const glyph = ringGlyph(brightness);
		const expected = `${"dim: ".repeat(5)}accent:${glyph}${"dim: ".repeat(5)}`;
		expect(row).toBe(expected);
	});

	it("full tier: the wavefront's two positions move outward from center as elapsedMs advances", () => {
		const width = 21;
		const early = renderReflectionRippleRow(50, width, taggedTheme, "full");
		const later = renderReflectionRippleRow(RIPPLE_DURATION_MS / 2, width, taggedTheme, "full");
		expect(early).not.toBe(later);
		// The glyph should not still be dead-center once the wave has traveled.
		const center = Math.floor(width / 2);
		const radius = Math.round(rippleRadius(rippleProgress(RIPPLE_DURATION_MS / 2, RIPPLE_DURATION_MS), center));
		expect(radius).toBeGreaterThan(0);
	});

	it("subtle tier: a single centered pulse over calm water, position fixed regardless of elapsedMs", () => {
		const width = 11;
		const t1 = renderReflectionRippleRow(0, width, taggedTheme, "subtle");
		const t2 = renderReflectionRippleRow(RIPPLE_DURATION_MS / 2, width, taggedTheme, "subtle");
		const centerToken = "accent:";
		expect(t1.includes(centerToken)).toBe(true);
		expect(t2.includes(centerToken)).toBe(true);
		// Exactly one glyph carries the accent token, always at the same offset in the string.
		expect(t1.indexOf(centerToken)).toBe(t2.indexOf(centerToken));
	});

	it("subtle tier at width 1 renders a single glyph with no background", () => {
		const row = renderReflectionRippleRow(0, 1, taggedTheme, "subtle");
		expect(row.startsWith("accent:")).toBe(true);
	});

	it("threads a live preset into the ring glyph — not just the default", () => {
		const brightness = rippleBrightness(0) * dimMultiplier(1);
		const row = renderReflectionRippleRow(0, 1, idTheme, "subtle", undefined, "ascii");
		expect(row).toBe(ringGlyph(brightness, "ascii"));
		expect(row).not.toBe(ringGlyph(brightness, "unicode"));
	});

	it("width <= 0 renders an empty row", () => {
		expect(renderReflectionRippleRow(500, 0, taggedTheme, "full")).toBe("");
		expect(renderReflectionRippleIdleRow(0, idTheme)).toBe("");
	});

	it("the idle row is byte-identical across repeated calls and carries no ring glyph", () => {
		const a = renderReflectionRippleIdleRow(12, idTheme);
		const b = renderReflectionRippleIdleRow(12, idTheme);
		expect(a).toBe(b);
		expect(a).toBe("·".repeat(12));
	});

	it("the off-tier text names the matched rule(s), and falls back to a neutral message before any trigger", () => {
		expect(renderReflectionRippleOffText([])).toBe("no reflection yet");
		expect(renderReflectionRippleOffText(["no-any"])).toBe("↺ reflecting: no-any");
		expect(renderReflectionRippleOffText(["a", "b"])).toBe("↺ reflecting: a, b");
	});

	it("a NaN elapsedMs (e.g. a poisoned clock read) never renders the literal string 'undefined'", () => {
		const full = renderReflectionRippleRow(Number.NaN, 21, taggedTheme, "full");
		const subtle = renderReflectionRippleRow(Number.NaN, 21, taggedTheme, "subtle");
		expect(full).not.toContain("undefined");
		expect(subtle).not.toContain("undefined");
	});

	it("negative width renders an empty row, matching the width <= 0 guard", () => {
		expect(renderReflectionRippleRow(500, -5, taggedTheme, "full")).toBe("");
		expect(renderReflectionRippleIdleRow(-5, idTheme)).toBe("");
	});
});

describe("ReflectionRippleState", () => {
	it("starts idle and a trigger moves it to rippling, tracking rule names and a running trigger count", () => {
		const state = new ReflectionRippleState();
		expect(state.phase).toBe("idle");
		expect(state.snapshot()).toEqual({ phase: "idle", ruleNames: [], triggerCount: 0 });

		state.applyTrigger(["no-console-log"], 1000);
		expect(state.phase).toBe("rippling");
		expect(state.snapshot()).toEqual({ phase: "rippling", ruleNames: ["no-console-log"], triggerCount: 1 });
		expect(state.rippleElapsedMs(1500)).toBe(500);
	});

	it("settleIfDone flips to idle exactly at the settle boundary and only fires once", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const settleMs = Math.max(RIPPLE_DURATION_MS, DIM_DURATION_MS);

		expect(state.settleIfDone(settleMs - 1)).toBe(false);
		expect(state.phase).toBe("rippling");

		expect(state.settleIfDone(settleMs)).toBe(true);
		expect(state.phase).toBe("idle");
		expect(state.settleIfDone(settleMs + 500)).toBe(false);
	});

	it("a fresh trigger while still rippling restarts the wave and updates the rule names", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["first"], 0);
		state.applyTrigger(["second"], 400);
		expect(state.phase).toBe("rippling");
		expect(state.snapshot().ruleNames).toEqual(["second"]);
		expect(state.snapshot().triggerCount).toBe(2);
		expect(state.rippleElapsedMs(500)).toBe(100);
	});

	it("settleIfDone on an already-idle state is a no-op", () => {
		const state = new ReflectionRippleState();
		expect(state.settleIfDone(10_000)).toBe(false);
	});

	it("rippleElapsedMs clamps backward clock skew (now before triggeredAt) to 0, not a negative value", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 1000);
		expect(state.rippleElapsedMs(400)).toBe(0);
	});

	it("a NaN clock read at trigger time poisons rippleElapsedMs, causing settleIfDone to fire on the very next check (NaN < SETTLE_MS is false, so the early-return guard never catches it)", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], Number.NaN);
		expect(state.rippleElapsedMs(10_000)).toBeNaN();
		expect(state.settleIfDone(10_000)).toBe(true);
		expect(state.phase).toBe("idle");
	});

	it("applyTrigger accepts an empty rule-names array without throwing", () => {
		const state = new ReflectionRippleState();
		state.applyTrigger([], 0);
		expect(state.snapshot().ruleNames).toEqual([]);
		expect(state.phase).toBe("rippling");
	});
});

describe("ReflectionRippleWidget", () => {
	it("renders phase-varying rows while rippling, driven by the injected clock", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		const first = widget.render(20)[0];
		scheduler.advance(RIPPLE_DURATION_MS / 4);
		widget.markDirty();
		const second = widget.render(20)[0];
		expect(second).not.toBe(first);
		widget.dispose();
	});

	it("idle produces a single static frame; disposing leaves zero subscribers", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState(); // never triggered -> idle
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		expect(widget.render(20)[0]).toBe(renderReflectionRippleIdleRow(20, idTheme));
		scheduler.advance(1000);
		expect(widget.render(20)[0]).toBe(renderReflectionRippleIdleRow(20, idTheme));
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("a trigger fires exactly one ripple sequence, calling onSettled once when it fully settles", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		let settledCount = 0;
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {
				settledCount++;
			},
		});
		widget.render(20);

		state.applyTrigger(["r"], scheduler.now());
		const settleMs = Math.max(RIPPLE_DURATION_MS, DIM_DURATION_MS);

		scheduler.advance(settleMs - 1);
		expect(settledCount).toBe(0);

		scheduler.advance(1);
		expect(settledCount).toBe(1);
		expect(state.phase).toBe("idle");

		scheduler.advance(1000);
		expect(settledCount).toBe(1);
		widget.dispose();
	});

	it("backpressure freezes the widget instantly: no frame is emitted while under pressure, the widget stays subscribed, and it resumes once pressure clears", () => {
		const scheduler = manualScheduler();
		const tui = new ToggleTui();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, backpressure: backpressureFromTui(tui), scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});
		widget.render(20);
		expect(widget.animating).toBe(true);

		scheduler.advance(1000 / 30);
		const elapsedBeforePressure = widget.elapsedMs;
		expect(elapsedBeforePressure).toBeGreaterThan(0);

		tui.renderUnderPressure = true;
		scheduler.advance(1000 / 30);
		scheduler.advance(1000 / 30);
		// Host-level backpressure skips frame emission entirely (not a tier
		// flip): the widget stays subscribed and its phase freezes at the last
		// emitted frame instead of collapsing to the static `off` frame.
		expect(policy.tier).toBe("full");
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);
		expect(widget.elapsedMs).toBe(elapsedBeforePressure);

		tui.renderUnderPressure = false;
		scheduler.advance(1000 / 30);
		expect(widget.elapsedMs).toBeGreaterThan(elapsedBeforePressure);
		widget.dispose();
	});

	it("still responds to a live tier change via the policy subscription independently of host-level backpressure", () => {
		const scheduler = manualScheduler();
		const tui = new ToggleTui();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, backpressure: backpressureFromTui(tui), scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});
		widget.render(20);
		expect(widget.animating).toBe(true);

		policy.setSetting("off");
		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);

		policy.setSetting("full");
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);
		widget.dispose();
	});

	it("subtle tier: the accent glyph stays at the same column across frames (no travel)", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "subtle");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: taggedTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		const first = widget.render(11)[0];
		scheduler.advance(300);
		widget.markDirty();
		const second = widget.render(11)[0];
		expect(first.indexOf("accent:")).toBe(second.indexOf("accent:"));
		widget.dispose();
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		expect(widget.animating).toBe(false);
		expect(host.subscriberCount).toBe(0);
		expect(widget.render(20)[0]).toBe(renderReflectionRippleIdleRow(20, idTheme));
	});

	it("an accent override recolors only the ring, leaving the calm water on its fixed dim token", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], 0);
		const widget = new ReflectionRippleWidget({
			tui: new ToggleTui(),
			host,
			policy,
			state,
			theme: taggedTheme,
			clock: scheduler,
			onSettled: () => {},
			accentColor: "success",
		});
		const row = widget.render(11)[0];
		expect(row).toContain("success:");
		expect(row).not.toContain(`${REFLECTION_RIPPLE_COLORS.ring}:`);
		widget.dispose();
	});

	it("disposing twice is a no-op the second time (idempotent teardown)", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});
		widget.render(20);
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
		expect(() => widget.dispose()).not.toThrow();
		expect(host.subscriberCount).toBe(0);
	});

	it("a NaN clock reading never surfaces the literal string 'undefined' in a rendered frame", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new ReflectionRippleState();
		state.applyTrigger(["r"], Number.NaN);
		const tui = new ToggleTui();
		const widget = new ReflectionRippleWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});
		const frame = widget.render(20)[0];
		expect(frame).not.toContain("undefined");
		widget.dispose();
	});
});

describe("reflection ripple controller", () => {
	function recordingContext(overrides: Partial<ReflectionRippleContext> = {}): {
		ctx: ReflectionRippleContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: ReflectionRippleContext = {
			hasUI: true,
			isTTY: true,
			env: {},
			motionSetting: "full",
			theme: idTheme,
			glyphPreset: "unicode",
			setWidget: (key, content) => calls.push({ key, content }),
			...overrides,
		};
		return { ctx, calls };
	}

	it("mounts an animated widget on the first ttsr_triggered event", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("no-console-log")] }, ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");
		expect(controller.state.phase).toBe("rippling");
		expect(controller.state.snapshot().ruleNames).toEqual(["no-console-log"]);
	});

	it("a second trigger while still rippling restarts the wave without a second mount call", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		scheduler.advance(100);
		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("b")] }, ctx);
		expect(calls).toHaveLength(1); // no remount — the existing animated mount just re-renders
		expect(controller.state.snapshot().ruleNames).toEqual(["b"]);
	});

	it("settles back to fully unmounted after the ripple completes, then a later trigger remounts fresh", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: ReflectionRippleTheme) => ReflectionRippleWidget;
		const tui = new ToggleTui();
		const widget = factory(tui, idTheme);
		widget.render(20);
		expect(scheduler.running).toBe(true);

		const settleMs = Math.max(RIPPLE_DURATION_MS, DIM_DURATION_MS);
		scheduler.advance(settleMs);
		expect(controller.state.phase).toBe("idle");
		expect(scheduler.running).toBe(false); // the animated host was disposed on settle
		expect(calls[calls.length - 1].content).toBeUndefined(); // widget removed entirely, not left as a static row

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("b")] }, ctx);
		expect(typeof calls[calls.length - 1].content).toBe("function"); // remounted fresh
	});

	it("renders a static line naming the rule for the off tier, refreshed on each trigger", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		expect(calls[0].content).toEqual([renderReflectionRippleOffText(["a"])]);
		expect(scheduler.running).toBe(false);

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("b")] }, ctx);
		expect(calls[calls.length - 1].content).toEqual([renderReflectionRippleOffText(["b"])]);
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new ReflectionRippleController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new ReflectionRippleController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: ReflectionRippleTheme) => ReflectionRippleWidget;
		factory(new ToggleTui(), idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});

	it("dispose before any trigger (never mounted) is a safe no-op", () => {
		const controller = new ReflectionRippleController();
		const { ctx, calls } = recordingContext();

		expect(() => controller.dispose(ctx)).not.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("disposing twice is idempotent — the second call doesn't re-clear the widget", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [rule("a")] }, ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;

		expect(() => controller.dispose(ctx)).not.toThrow();
		expect(calls).toHaveLength(callsAfterFirstDispose);
	});

	it("an empty rules array still triggers a ripple with no rule names", () => {
		const scheduler = manualScheduler();
		const controller = new ReflectionRippleController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTtsrTriggered({ type: "ttsr_triggered", rules: [] }, ctx);
		expect(calls).toHaveLength(1);
		expect(controller.state.snapshot().ruleNames).toEqual([]);
		expect(controller.state.phase).toBe("rippling");
	});
});
