import { describe, expect, it } from "bun:test";
import {
	BASE_BREATH_PERIOD_MS,
	breathEnvelope,
	breathPeriodMsForTurnDuration,
	brightnessGlyph,
	brightnessToken,
	EXHALE_DURATION_MS,
	exhaleEnvelope,
	MAX_BREATH_PERIOD_MS,
	MIN_BREATH_PERIOD_MS,
	pulsePosition,
} from "../src/breathing-border/breath";
import { type BreathingBorderContext, BreathingBorderController } from "../src/breathing-border/controller";
import { BreathingBorderState } from "../src/breathing-border/state";
import {
	BREATHING_BORDER_COLORS,
	type BreathingBorderTheme,
	BreathingBorderWidget,
	renderBreathingBorderIdleRow,
	renderBreathingBorderOffText,
	renderBreathingBorderRow,
	STATIC_BORDER_WIDTH,
} from "../src/breathing-border/widget";
import { AnimationHost, backpressureFromTui, type FrameScheduler, MotionPolicy } from "../src/kit";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: BreathingBorderTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which token the renderer chose.
const taggedTheme: BreathingBorderTheme = { fg: (color, text) => `${color}:${text}` };

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

describe("breathing border pure math", () => {
	it("breathEnvelope starts at 0, peaks mid-cycle, and returns to 0 at the boundary", () => {
		expect(breathEnvelope(0, BASE_BREATH_PERIOD_MS)).toBeCloseTo(0, 5);
		expect(breathEnvelope(BASE_BREATH_PERIOD_MS / 2, BASE_BREATH_PERIOD_MS)).toBeCloseTo(1, 5);
		expect(breathEnvelope(BASE_BREATH_PERIOD_MS, BASE_BREATH_PERIOD_MS)).toBeCloseTo(0, 5);
	});

	it("breathEnvelope wraps past one full period", () => {
		expect(breathEnvelope(BASE_BREATH_PERIOD_MS + 1, BASE_BREATH_PERIOD_MS)).toBeCloseTo(
			breathEnvelope(1, BASE_BREATH_PERIOD_MS),
			5,
		);
	});

	it("breathEnvelope is a smooth curve, not a strobe: never jumps straight from 0 to 1", () => {
		const samples = Array.from({ length: 20 }, (_, i) =>
			breathEnvelope((i * BASE_BREATH_PERIOD_MS) / 20, BASE_BREATH_PERIOD_MS),
		);
		for (let i = 1; i < samples.length; i++) {
			expect(Math.abs(samples[i] - samples[i - 1])).toBeLessThan(0.3);
		}
	});

	it("exhaleEnvelope decays from 1 to 0 over the fixed duration and clamps after", () => {
		expect(exhaleEnvelope(0, EXHALE_DURATION_MS)).toBeCloseTo(1, 5);
		expect(exhaleEnvelope(EXHALE_DURATION_MS / 2, EXHALE_DURATION_MS)).toBeCloseTo(0.5, 5);
		expect(exhaleEnvelope(EXHALE_DURATION_MS, EXHALE_DURATION_MS)).toBe(0);
		expect(exhaleEnvelope(EXHALE_DURATION_MS + 500, EXHALE_DURATION_MS)).toBe(0);
	});

	it("exhaleEnvelope is monotonically non-increasing", () => {
		const samples = Array.from({ length: 10 }, (_, i) =>
			exhaleEnvelope((i * EXHALE_DURATION_MS) / 10, EXHALE_DURATION_MS),
		);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
		}
	});

	it("pulsePosition sweeps 0..width-1 across one period and wraps", () => {
		const width = 10;
		expect(pulsePosition(0, BASE_BREATH_PERIOD_MS, width)).toBe(0);
		expect(pulsePosition(BASE_BREATH_PERIOD_MS / 2, BASE_BREATH_PERIOD_MS, width)).toBe(5);
		expect(pulsePosition(BASE_BREATH_PERIOD_MS + 1, BASE_BREATH_PERIOD_MS, width)).toBe(
			pulsePosition(1, BASE_BREATH_PERIOD_MS, width),
		);
	});

	it("breathPeriodMsForTurnDuration resolves to the base period when no turn is known", () => {
		expect(breathPeriodMsForTurnDuration(undefined)).toBe(BASE_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(0)).toBe(BASE_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(-100)).toBe(BASE_BREATH_PERIOD_MS);
	});

	it("breathPeriodMsForTurnDuration clamps to the min/max cadence", () => {
		expect(breathPeriodMsForTurnDuration(1)).toBe(MIN_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(100_000)).toBe(MAX_BREATH_PERIOD_MS);
	});
});

describe("breathing border pure rendering", () => {
	it("full tier: a resting row (no travel) is a single dim-toned border", () => {
		const row = renderBreathingBorderRow(0, 10, taggedTheme, "full");
		expect(row).toBe(`borderMuted:${"─".repeat(10)}`);
	});

	it("full tier: a traveling pulse brightens the glyph at its column and leaves the rest dim", () => {
		const row = renderBreathingBorderRow(0.9, 10, taggedTheme, "full", 4);
		expect(row).toBe(`borderMuted:${"─".repeat(4)}borderAccent:█borderMuted:${"─".repeat(5)}`);
	});

	it("subtle tier: only the two corners carry the brightness token; the middle stays borderMuted", () => {
		const row = renderBreathingBorderRow(0.9, 10, taggedTheme, "subtle");
		expect(row).toBe(`borderAccent:█borderMuted:${"─".repeat(8)}borderAccent:█`);
	});

	it("subtle tier at width 1 renders a single corner glyph", () => {
		const row = renderBreathingBorderRow(0.9, 1, taggedTheme, "subtle");
		expect(row).toBe("borderAccent:█");
	});

	it("threads a live preset into the subtle-tier corner glyph — not just the default", () => {
		const row = renderBreathingBorderRow(0.9, 1, idTheme, "subtle", undefined, undefined, "ascii");
		expect(row).toBe(brightnessGlyph(0.9, "ascii"));
		expect(row).not.toBe(brightnessGlyph(0.9, "unicode"));
	});

	it("width <= 0 renders an empty row", () => {
		expect(renderBreathingBorderRow(0.5, 0, taggedTheme, "full")).toBe("");
	});

	it("the idle row is byte-identical across repeated calls and matches a resting envelope-0 full-tier row", () => {
		const a = renderBreathingBorderIdleRow(12, idTheme);
		const b = renderBreathingBorderIdleRow(12, idTheme);
		expect(a).toBe(b);
		expect(a).toBe(renderBreathingBorderRow(0, 12, idTheme, "full"));
	});

	it("the off-tier static text is a fixed width, independent of any phase input", () => {
		const text = renderBreathingBorderOffText(idTheme);
		expect(text).toBe("─".repeat(STATIC_BORDER_WIDTH));
	});
});

describe("BreathingBorderState", () => {
	it("starts idle and agent_start moves it to active", () => {
		const state = new BreathingBorderState();
		expect(state.phase).toBe("idle");
		state.applyAgentStart(1000);
		expect(state.phase).toBe("active");
		expect(state.breathElapsedMs(1500)).toBe(500);
	});

	it("agent_end from idle is a no-op (nothing to wind down)", () => {
		const state = new BreathingBorderState();
		state.applyAgentEnd(1000);
		expect(state.phase).toBe("idle");
	});

	it("agent_end from active begins exhaling, and settleIfDone flips to idle exactly at the exhale boundary", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(1000);
		expect(state.phase).toBe("exhaling");

		expect(state.settleIfDone(1000 + EXHALE_DURATION_MS - 1)).toBe(false);
		expect(state.phase).toBe("exhaling");

		expect(state.settleIfDone(1000 + EXHALE_DURATION_MS)).toBe(true);
		expect(state.phase).toBe("idle");
		// Only fires once on the transition, not on every subsequent call.
		expect(state.settleIfDone(1000 + EXHALE_DURATION_MS + 500)).toBe(false);
	});

	it("a fresh agent_start interrupts an in-progress exhale and resumes active breathing", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(1000);
		expect(state.phase).toBe("exhaling");
		state.applyAgentStart(1200);
		expect(state.phase).toBe("active");
		expect(state.breathElapsedMs(1300)).toBe(100);
	});

	it("turn_start/turn_end measure duration via the injected clock, not the raw event fields", () => {
		const state = new BreathingBorderState();
		expect(state.breathPeriodMs()).toBe(BASE_BREATH_PERIOD_MS);
		state.applyTurnStart(1, 0);
		state.applyTurnEnd(1, 1);
		expect(state.breathPeriodMs()).toBe(MIN_BREATH_PERIOD_MS);
	});

	it("turn_end for a mismatched turnIndex is ignored", () => {
		const state = new BreathingBorderState();
		state.applyTurnStart(1, 0);
		state.applyTurnEnd(2, 100_000);
		expect(state.breathPeriodMs()).toBe(BASE_BREATH_PERIOD_MS);
	});
});

describe("BreathingBorderWidget", () => {
	it("renders phase-varying rows while active, driven by the injected clock", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		const tui = new ToggleTui();
		const widget = new BreathingBorderWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		const first = widget.render(20)[0];
		scheduler.advance(BASE_BREATH_PERIOD_MS / 4);
		widget.markDirty();
		const second = widget.render(20)[0];
		expect(second).not.toBe(first);
		widget.dispose();
	});

	it("idle produces a single static frame and the host has zero subscribers", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BreathingBorderState(); // never started -> idle
		const tui = new ToggleTui();
		const widget = new BreathingBorderWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		expect(widget.render(20)[0]).toBe(renderBreathingBorderIdleRow(20, idTheme));
		scheduler.advance(1000);
		expect(widget.render(20)[0]).toBe(renderBreathingBorderIdleRow(20, idTheme));
		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("agent_end fires exactly one exhale sequence, calling onSettled once when it completes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		let settledCount = 0;
		const tui = new ToggleTui();
		const widget = new BreathingBorderWidget({
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

		scheduler.advance(1000);
		state.applyAgentEnd(scheduler.now());
		expect(state.phase).toBe("exhaling");

		scheduler.advance(EXHALE_DURATION_MS / 2);
		expect(settledCount).toBe(0);

		scheduler.advance(EXHALE_DURATION_MS / 2);
		expect(settledCount).toBe(1);
		expect(state.phase).toBe("idle");

		// Further ticks do not call onSettled again.
		scheduler.advance(1000);
		expect(settledCount).toBe(1);
		widget.dispose();
	});

	it("backpressure freezes the widget instantly: no frame is emitted while under pressure, the widget stays subscribed, and it resumes once pressure clears", () => {
		const scheduler = manualScheduler();
		const tui = new ToggleTui();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, backpressure: backpressureFromTui(tui), scheduler });
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		const widget = new BreathingBorderWidget({
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
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		const widget = new BreathingBorderWidget({
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

	it("subtle tier animates only the corners: the middle span stays the resting border char across frames", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "subtle");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		const tui = new ToggleTui();
		const widget = new BreathingBorderWidget({
			tui,
			host,
			policy,
			state,
			theme: idTheme,
			clock: scheduler,
			onSettled: () => {},
		});

		const row = widget.render(10)[0];
		expect(row.slice(1, -1)).toBe("─".repeat(8));
		widget.dispose();
	});

	it("off tier renders one static frame and never subscribes", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "off");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		const tui = new ToggleTui();
		const widget = new BreathingBorderWidget({
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
		expect(widget.render(20)[0]).toBe(renderBreathingBorderIdleRow(20, idTheme));
	});

	it("an accent override recolors only the peak brightness, leaving muted/base on their fixed tokens", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		scheduler.advance(BASE_BREATH_PERIOD_MS / 2); // mid-cycle: the breath envelope peaks here
		const widget = new BreathingBorderWidget({
			tui: new ToggleTui(),
			host,
			policy,
			state,
			theme: taggedTheme,
			clock: scheduler,
			onSettled: () => {},
			accentColor: "accent",
		});
		const row = widget.render(20)[0];
		expect(row).toContain("accent:");
		expect(row).not.toContain(`${BREATHING_BORDER_COLORS.peak}:`);
		widget.dispose();
	});
});

describe("breathing border controller", () => {
	function recordingContext(overrides: Partial<BreathingBorderContext> = {}): {
		ctx: BreathingBorderContext;
		calls: Array<{ key: string; content: unknown }>;
	} {
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx: BreathingBorderContext = {
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

	it("mounts an animated widget on agent_start", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");
		expect(controller.state.phase).toBe("active");
	});

	it("agent_end -> exhale -> settles back to the static widget with the host disposed, then a later agent_start remounts", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: BreathingBorderTheme) => BreathingBorderWidget;
		const tui = new ToggleTui();
		const widget = factory(tui, idTheme);
		widget.render(20);
		expect(scheduler.running).toBe(true);

		controller.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
		expect(controller.state.phase).toBe("exhaling");

		scheduler.advance(EXHALE_DURATION_MS);
		expect(controller.state.phase).toBe("idle");
		expect(scheduler.running).toBe(false); // the animated host was disposed on settle
		expect(calls[calls.length - 1].content).toEqual([renderBreathingBorderOffText(idTheme)]);

		controller.onAgentStart({ type: "agent_start" }, ctx);
		expect(typeof calls[calls.length - 1].content).toBe("function"); // remounted fresh
	});

	it("turn_start/turn_end modulate the breath cadence without remounting", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		controller.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
		scheduler.advance(1);
		controller.onTurnEnd({ type: "turn_end", turnIndex: 0, message: {} as never, toolResults: [] }, ctx);
		expect(calls).toHaveLength(1); // no remount from turn events
		expect(controller.state.snapshot().periodMs).toBe(MIN_BREATH_PERIOD_MS);
	});

	it("renders a static line for the off tier with zero frame-clock subscriptions", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext({ motionSetting: "off" });

		controller.onAgentStart({ type: "agent_start" }, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
		expect(scheduler.running).toBe(false);
	});

	it("falls back to a static line outside a TTY even when animations are on", () => {
		const controller = new BreathingBorderController();
		const { ctx, calls } = recordingContext({ isTTY: false, motionSetting: "full" });

		controller.onAgentStart({ type: "agent_start" }, ctx);
		expect(Array.isArray(calls[0].content)).toBe(true);
	});

	it("stays dormant when there is no UI surface", () => {
		const controller = new BreathingBorderController();
		const { ctx, calls } = recordingContext({ hasUI: false });

		controller.onAgentStart({ type: "agent_start" }, ctx);
		controller.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose tears down the animated host with no leaked subscription or timer", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		const factory = calls[0].content as (tui: ToggleTui, theme: BreathingBorderTheme) => BreathingBorderWidget;
		factory(new ToggleTui(), idTheme);
		expect(scheduler.running).toBe(true);

		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();
		expect(scheduler.running).toBe(false);
	});

	it("dispose before any mount is a no-op: no setWidget call at all", () => {
		const controller = new BreathingBorderController();
		const { ctx, calls } = recordingContext();

		controller.dispose(ctx);
		expect(calls).toHaveLength(0);
	});

	it("dispose is idempotent: a second call after teardown does not re-invoke setWidget", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		controller.dispose(ctx);
		const callsAfterFirstDispose = calls.length;

		controller.dispose(ctx);
		expect(calls).toHaveLength(callsAfterFirstDispose); // no additional setWidget(undefined) call
	});

	it("agent_end fired before any agent_start mounts fresh (the documented unlikely-order case), starting straight into the exhale", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
		expect(calls).toHaveLength(1);
		expect(typeof calls[0].content).toBe("function");
		expect(controller.state.phase).toBe("idle"); // applyAgentEnd from idle is a no-op per BreathingBorderState
	});

	it("a fresh agent_start after dispose() remounts (event-after-dispose is not a dead controller)", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		controller.dispose(ctx);
		expect(calls[calls.length - 1].content).toBeUndefined();

		controller.onAgentStart({ type: "agent_start" }, ctx);
		expect(typeof calls[calls.length - 1].content).toBe("function");
		expect(controller.state.phase).toBe("active");
	});

	it("onTurnStart/onTurnEnd before any agent_start are safely absorbed into state with no widget mount", () => {
		const scheduler = manualScheduler();
		const controller = new BreathingBorderController({ scheduler });
		const { ctx, calls } = recordingContext();

		controller.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
		scheduler.advance(1);
		controller.onTurnEnd({ type: "turn_end", turnIndex: 0, message: {} as never, toolResults: [] }, ctx);
		expect(calls).toHaveLength(0);
		expect(controller.state.snapshot().periodMs).toBe(MIN_BREATH_PERIOD_MS);
	});
});

describe("breathing border hardening: adversarial/non-finite inputs", () => {
	it("brightnessGlyph(NaN) falls back to the dimmest glyph instead of an out-of-bounds `undefined` lookup (real bug, fixed)", () => {
		// GLYPH_RAMP[Math.floor(NaN * 4)] is GLYPH_RAMP[NaN] === undefined without a fallback —
		// concatenated into a rendered row this would print the literal text "undefined".
		expect(brightnessGlyph(Number.NaN)).toBe("·");
		expect(typeof brightnessGlyph(Number.NaN)).toBe("string");
	});

	it("brightnessGlyph clamps +Infinity to the heaviest glyph and -Infinity to the dimmest", () => {
		expect(brightnessGlyph(Number.POSITIVE_INFINITY)).toBe("█");
		expect(brightnessGlyph(Number.NEGATIVE_INFINITY)).toBe("·");
	});

	it("brightnessToken(NaN) is a documented quirk, not a crash: NaN fails both threshold comparisons and falls through to the brightest bucket", () => {
		// `NaN < 0.15` and `NaN < 0.6` are both false, so the fallthrough branch wins —
		// unlike the glyph ramp this is a plain comparison chain, not an array lookup,
		// so it degrades to a valid (if surprising) token rather than corrupting text.
		expect(brightnessToken(Number.NaN)).toBe("borderAccent");
	});
});

describe("brightnessGlyph — glyph preset", () => {
	it("defaults to the unicode ramp when no preset is passed, matching the original hardcoded GLYPH_RAMP values", () => {
		expect(brightnessGlyph(0)).toBe("·");
		expect(brightnessGlyph(0.3)).toBe("─");
		expect(brightnessGlyph(0.6)).toBe("━");
		expect(brightnessGlyph(1)).toBe("█");
	});

	it("resolves the same ramp for an explicit 'unicode' preset", () => {
		expect(brightnessGlyph(0, "unicode")).toBe("·");
		expect(brightnessGlyph(1, "unicode")).toBe("█");
	});

	it("swaps to the ascii ramp for 'ascii', dimmest to heaviest", () => {
		expect(brightnessGlyph(0, "ascii")).toBe(".");
		expect(brightnessGlyph(0.3, "ascii")).toBe("-");
		expect(brightnessGlyph(0.6, "ascii")).toBe("=");
		expect(brightnessGlyph(1, "ascii")).toBe("#");
	});

	it("'nerd' aliases 'unicode' exactly", () => {
		for (const brightness of [0, 0.3, 0.6, 1]) {
			expect(brightnessGlyph(brightness, "nerd")).toBe(brightnessGlyph(brightness, "unicode"));
		}
	});

	it("breathEnvelope/exhaleEnvelope propagate NaN for a NaN clock or period rather than silently clamping", () => {
		expect(breathEnvelope(Number.NaN, BASE_BREATH_PERIOD_MS)).toBeNaN();
		expect(breathEnvelope(100, Number.NaN)).toBeNaN();
		expect(exhaleEnvelope(Number.NaN, EXHALE_DURATION_MS)).toBeNaN();
	});

	it("exhaleEnvelope clamps any non-positive elapsed (not just 0) to full brightness", () => {
		expect(exhaleEnvelope(-1, EXHALE_DURATION_MS)).toBe(1);
		expect(exhaleEnvelope(-1_000_000, EXHALE_DURATION_MS)).toBe(1);
	});

	it("pulsePosition returns 0 for non-positive width/period but propagates NaN when width or elapsed itself is NaN", () => {
		expect(pulsePosition(100, BASE_BREATH_PERIOD_MS, 0)).toBe(0);
		expect(pulsePosition(100, BASE_BREATH_PERIOD_MS, -5)).toBe(0);
		expect(pulsePosition(100, 0, 10)).toBe(0);
		// width<=0/periodMs<=0 guards don't catch NaN (NaN <= 0 is false), so these propagate NaN.
		expect(pulsePosition(100, BASE_BREATH_PERIOD_MS, Number.NaN)).toBeNaN();
		expect(pulsePosition(Number.NaN, BASE_BREATH_PERIOD_MS, 10)).toBeNaN();
	});

	it("breathPeriodMsForTurnDuration treats Infinity and NaN the same as no-turn-known: the base period, not an unclamped runaway value", () => {
		expect(breathPeriodMsForTurnDuration(Number.POSITIVE_INFINITY)).toBe(BASE_BREATH_PERIOD_MS);
		expect(breathPeriodMsForTurnDuration(Number.NaN)).toBe(BASE_BREATH_PERIOD_MS);
	});

	it("renderBreathingBorderRow never contains the literal text 'undefined' for a NaN envelope or NaN travelPos, at any tier", () => {
		for (const tier of ["full", "subtle"] as const) {
			expect(renderBreathingBorderRow(Number.NaN, 10, idTheme, tier)).not.toContain("undefined");
			expect(renderBreathingBorderRow(Number.NaN, 10, idTheme, tier, Number.NaN)).not.toContain("undefined");
			expect(renderBreathingBorderRow(0.5, 10, idTheme, tier, Number.NaN)).not.toContain("undefined");
		}
	});

	it("renderBreathingBorderRow with a NaN width doesn't crash (falls through the width<=0 guard, but String.repeat(NaN) is '')", () => {
		// NaN <= 0 is false, so this doesn't take the early-return empty-row path like a
		// literal 0 or negative width does -- documented as a surprising but harmless quirk.
		expect(() => renderBreathingBorderRow(0.5, Number.NaN, idTheme, "full")).not.toThrow();
		expect(renderBreathingBorderRow(0.5, Number.NaN, idTheme, "full")).toBe("");
	});

	it("BreathingBorderState.settleIfDone is idempotent once idle: repeated calls stay false with no re-triggered onSettled", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(0);
		expect(state.settleIfDone(EXHALE_DURATION_MS)).toBe(true); // fires exactly once
		expect(state.settleIfDone(EXHALE_DURATION_MS)).toBe(false); // already idle, no re-trigger
		expect(state.settleIfDone(EXHALE_DURATION_MS + 5000)).toBe(false);
	});

	it("BreathingBorderState.applyAgentEnd called twice in a row restarts the exhale timer from the second call", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(0);
		state.applyAgentEnd(1000);
		expect(state.exhaleElapsedMs(1500)).toBe(500);

		state.applyAgentEnd(2000); // fires again mid-exhale, e.g. a second agent_end
		expect(state.phase).toBe("exhaling");
		expect(state.exhaleElapsedMs(2500)).toBe(500); // measured from the restarted start, not the first
	});

	it("BreathingBorderState.applyTurnEnd is ignored when no turn_start was ever observed (turnStartedAt undefined)", () => {
		const state = new BreathingBorderState();
		state.applyTurnEnd(0, 1000);
		expect(state.snapshot().periodMs).toBe(BASE_BREATH_PERIOD_MS); // no turn duration recorded
	});

	it("BreathingBorderState clamps backward wall-clock skew in turn duration to the base period, never a negative-duration cadence", () => {
		const state = new BreathingBorderState();
		state.applyTurnStart(0, 5000);
		state.applyTurnEnd(0, 1000); // "now" moved backward relative to turn_start
		expect(state.snapshot().periodMs).toBe(BASE_BREATH_PERIOD_MS); // negative duration guarded by breathPeriodMsForTurnDuration
	});

	it("breathElapsedMs/exhaleElapsedMs clamp backward clock skew to 0 rather than going negative", () => {
		const state = new BreathingBorderState();
		state.applyAgentStart(5000);
		expect(state.breathElapsedMs(1000)).toBe(0);

		state.applyAgentEnd(5000);
		expect(state.exhaleElapsedMs(1000)).toBe(0);
	});
});
