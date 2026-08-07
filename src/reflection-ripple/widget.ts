import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import {
	DIM_DURATION_MS,
	dimMultiplier,
	RIPPLE_DURATION_MS,
	reflectDimAmount,
	ringGlyph,
	rippleBrightness,
	rippleProgress,
	rippleRadius,
} from "./ripple";
import type { ReflectionRipplePhase } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type ReflectionRippleTheme = Pick<Theme, "fg">;

/** Fixed width used only for the motion-`off` static fallback, which has no real terminal width to size against. */
export const STATIC_RIPPLE_WIDTH = 40;

const RESTING_GLYPH = "·";
const DARK_GLYPH = " ";

/**
 * Named color map. `ring` is the primary accent slot — the only token an
 * accent override replaces; `calm` (the resting water) stays fixed dim.
 */
export interface ReflectionRippleColors {
	ring: ThemeColor;
	calm: ThemeColor;
}

/** Built-in palette — the exact tokens the renderer used before colors were configurable. */
export const REFLECTION_RIPPLE_COLORS: ReflectionRippleColors = { ring: "accent", calm: "dim" };

/** The palette with the accent slot applied, or the built-in palette when none is given. */
export function reflectionRippleColors(accentColor: ThemeColor | undefined): ReflectionRippleColors {
	return accentColor === undefined ? REFLECTION_RIPPLE_COLORS : { ...REFLECTION_RIPPLE_COLORS, ring: accentColor };
}

/** Calm-water background glyph: goes fully dark while the breath dim is more than half applied, resting dots otherwise. Pure. */
function calmGlyph(dimAmount: number): string {
	const clamped = dimAmount <= 0 ? 0 : dimAmount >= 1 ? 1 : dimAmount;
	return clamped > 0.5 ? DARK_GLYPH : RESTING_GLYPH;
}

/**
 * Pure renderer for one reflection-ripple row at `elapsedMs` since the
 * triggering `ttsr_triggered` event. In the `full` tier, two wavefronts
 * expand symmetrically outward from center over calm water; the `subtle`
 * tier collapses that to a single centered pulse (no travel). Deterministic
 * given its numeric inputs — no wall-clock reads.
 */
export function renderReflectionRippleRow(
	elapsedMs: number,
	width: number,
	theme: ReflectionRippleTheme,
	tier: "full" | "subtle",
	colors: ReflectionRippleColors = REFLECTION_RIPPLE_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";
	const progress = rippleProgress(elapsedMs, RIPPLE_DURATION_MS);
	const dimAmount = reflectDimAmount(elapsedMs, DIM_DURATION_MS);
	const brightness = rippleBrightness(progress) * dimMultiplier(dimAmount);
	const glyph = ringGlyph(brightness, preset);
	const bg = calmGlyph(dimAmount);

	if (tier === "subtle") {
		if (width === 1) return theme.fg(colors.ring, glyph);
		const center = Math.floor((width - 1) / 2);
		const before = bg.repeat(center);
		const after = bg.repeat(width - center - 1);
		return theme.fg(colors.calm, before) + theme.fg(colors.ring, glyph) + theme.fg(colors.calm, after);
	}

	const center = Math.floor(width / 2);
	const radius = Math.round(rippleRadius(progress, center));
	const leftPos = center - radius;
	const rightPos = center + radius;
	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		if (i === leftPos || i === rightPos) {
			cells.push(theme.fg(colors.ring, glyph));
		} else {
			cells.push(theme.fg(colors.calm, bg));
		}
	}
	return cells.join("");
}

/** The byte-identical resting frame: full-brightness calm water, no ring anywhere — used for the idle phase and reused as the settle transition's landing frame. */
export function renderReflectionRippleIdleRow(width: number, theme: ReflectionRippleTheme): string {
	if (width <= 0) return "";
	return theme.fg("dim", RESTING_GLYPH.repeat(width));
}

/** Static one-line fallback for the motion-`off` tier: which rule(s) the most recent trigger matched. */
export function renderReflectionRippleOffText(ruleNames: readonly string[]): string {
	if (ruleNames.length === 0) return "no reflection yet";
	return `↺ reflecting: ${ruleNames.join(", ")}`;
}

/** Minimal clock seam the widget needs — shared with the controller so trigger timestamps and render reads agree. */
export type ReflectionRippleClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface ReflectionRippleWidgetState {
	readonly phase: ReflectionRipplePhase;
	rippleElapsedMs(now: number): number;
	settleIfDone(now: number): boolean;
}

export interface ReflectionRippleWidgetOptions extends AnimatedWidgetOptions {
	state: ReflectionRippleWidgetState;
	theme: ReflectionRippleTheme;
	/** Same clock the controller stamps trigger timestamps with — NOT the host's internal relative elapsed-ms. */
	clock: ReflectionRippleClock;
	/**
	 * Invoked exactly once, from {@link onFrame}, on the `rippling` -> `idle`
	 * transition. The controller uses this to dispose the animated host and
	 * remove the widget entirely — a settled reflection carries zero
	 * subscriptions and no lingering visual, matching the bead's "felt, not
	 * seen" ambient framing for something that only ever fires briefly.
	 */
	onSettled: () => void;
	/** Accent override for the primary accent slot (the ring); `undefined` keeps the built-in palette. */
	accentColor?: ThemeColor;
	/** The host's live symbol preset; `undefined` keeps the `"unicode"` default (see `../glyph-presets.ts`). */
	glyphPreset?: SymbolPreset;
}

/**
 * Ambient widget for the reflection ripple. Render-backpressure is wired
 * into the {@link AnimationHost} directly (constructed by the controller),
 * which time-skips frame emission while under pressure — this widget's
 * `onFrame` simply never fires during a skipped frame, so the ripple freezes
 * in place and resumes from the correct wall-clock phase once pressure
 * clears. Each frame it checks whether the ripple just finished settling.
 * Reads {@link ReflectionRippleClock} rather than `this.elapsedMs` for the same
 * dual-clock-seam reason as every other Wave 2 widget: the host's relative
 * elapsed-ms is anchored to whenever the host's first subscriber attached,
 * not to the triggering event, so ripple-phase math needs its own shared
 * clock seam.
 */
export class ReflectionRippleWidget extends AnimatedWidget {
	#state: ReflectionRippleWidgetState;
	#theme: ReflectionRippleTheme;
	#policy: MotionPolicy;
	#clock: ReflectionRippleClock;
	#onSettled: () => void;
	#colors: ReflectionRippleColors;
	#glyphPreset: SymbolPreset;

	constructor(options: ReflectionRippleWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#onSettled = options.onSettled;
		this.#colors = reflectionRippleColors(options.accentColor);
		this.#glyphPreset = options.glyphPreset ?? "unicode";
	}

	onFrame(_elapsedMs: number): void {
		if (this.#state.settleIfDone(this.#clock.now())) {
			this.#onSettled();
		}
	}

	renderFrame(width: number): readonly string[] {
		if (this.#policy.tier === "off") {
			// Off tier is a hard no-op: fully static regardless of ripple phase.
			return [renderReflectionRippleIdleRow(width, this.#theme)];
		}
		if (this.#state.phase === "idle") {
			return [renderReflectionRippleIdleRow(width, this.#theme)];
		}
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		const elapsed = this.#state.rippleElapsedMs(this.#clock.now());
		return [renderReflectionRippleRow(elapsed, width, this.#theme, tier, this.#colors, this.#glyphPreset)];
	}
}
