import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AnimatedWidgetOptions, FrameScheduler, MotionPolicy } from "../kit";
import { AnimatedWidget } from "../kit";
import {
	BORDER_CHAR,
	type BorderBrightnessToken,
	breathEnvelope,
	brightnessGlyph,
	brightnessToken,
	EXHALE_DURATION_MS,
	exhaleEnvelope,
	pulsePosition,
} from "./breath";
import type { BreathingBorderPhase } from "./state";

/** The slice of {@link Theme} the renderer needs — just foreground coloring. */
export type BreathingBorderTheme = Pick<Theme, "fg">;

/** Fixed width used only for the motion-`off` static fallback, which has no real terminal width to size against. */
export const STATIC_BORDER_WIDTH = 40;

/**
 * Named color map. `peak` — the border's brightest moment, a traveling pulse
 * or the exhale's crest — is the primary accent slot and the only token an
 * accent override replaces; `muted`/`base` stay on their fixed border tokens,
 * mirroring Palimpsest's underline/amber-stay-fixed, only-the-hottest-tier
 * convention.
 */
export interface BreathingBorderColors {
	muted: ThemeColor;
	base: ThemeColor;
	peak: ThemeColor;
}

/** Built-in palette — the exact border tokens the renderer used before colors were configurable. */
export const BREATHING_BORDER_COLORS: BreathingBorderColors = {
	muted: "borderMuted",
	base: "border",
	peak: "borderAccent",
};

/** The palette with the accent slot applied, or the built-in palette when none is given. */
export function breathingBorderColors(accentColor: ThemeColor | undefined): BreathingBorderColors {
	return accentColor === undefined ? BREATHING_BORDER_COLORS : { ...BREATHING_BORDER_COLORS, peak: accentColor };
}

/** Resolve a raw {@link brightnessToken} classification through the configured palette. */
function resolveBorderColor(token: BorderBrightnessToken, colors: BreathingBorderColors): ThemeColor {
	if (token === "borderMuted") return colors.muted;
	if (token === "border") return colors.base;
	return colors.peak;
}

/**
 * Pure renderer for one breathing-border row. `envelope` is the current 0..1
 * brightness (from {@link breathEnvelope} while active, {@link exhaleEnvelope}
 * while winding down, or a fixed `0` when idle). `travelPos`, when given,
 * draws a single traveling pulse glyph at that column against an otherwise
 * resting row (the `full` tier while actively breathing); omitted, the whole
 * relevant span (the full row for `full`, just the two corners for `subtle`)
 * breathes together with no travel — used for the idle row, the exhale
 * wind-down, and the `subtle` tier throughout.
 */
export function renderBreathingBorderRow(
	envelope: number,
	width: number,
	theme: BreathingBorderTheme,
	tier: "full" | "subtle",
	travelPos?: number,
	colors: BreathingBorderColors = BREATHING_BORDER_COLORS,
	preset: SymbolPreset = "unicode",
): string {
	if (width <= 0) return "";
	const token = resolveBorderColor(brightnessToken(envelope), colors);

	if (tier === "subtle") {
		const glyph = brightnessGlyph(envelope, preset);
		if (width === 1) return theme.fg(token, glyph);
		const middle = BORDER_CHAR.repeat(width - 2);
		return theme.fg(token, glyph) + theme.fg(colors.muted, middle) + theme.fg(token, glyph);
	}

	if (travelPos === undefined) {
		return theme.fg(token, BORDER_CHAR.repeat(width));
	}
	const pos = Math.min(Math.max(travelPos, 0), width - 1);
	const glyph = brightnessGlyph(envelope, preset);
	const before = BORDER_CHAR.repeat(pos);
	const after = BORDER_CHAR.repeat(width - pos - 1);
	return theme.fg(colors.muted, before) + theme.fg(token, glyph) + theme.fg(colors.muted, after);
}

/** The byte-identical idle frame: envelope `0`, no travel — reused as the exhale's landing frame so the wind-down settles without a visible jump. */
export function renderBreathingBorderIdleRow(width: number, theme: BreathingBorderTheme): string {
	return renderBreathingBorderRow(0, width, theme, "full");
}

/** Static one-line fallback for the motion-`off` tier: a fixed-width dim border, drawn once and never re-derived from phase. */
export function renderBreathingBorderOffText(theme: BreathingBorderTheme): string {
	return theme.fg("borderMuted", BORDER_CHAR.repeat(STATIC_BORDER_WIDTH));
}

/** Minimal clock seam the widget needs — shared with the controller so breath/exhale timestamps and render reads agree. */
export type BreathingBorderClock = Pick<FrameScheduler, "now">;

/** Minimal state seam the widget needs. */
export interface BreathingBorderWidgetState {
	readonly phase: BreathingBorderPhase;
	breathElapsedMs(now: number): number;
	exhaleElapsedMs(now: number): number;
	breathPeriodMs(): number;
	settleIfDone(now: number): boolean;
}

export interface BreathingBorderWidgetOptions extends AnimatedWidgetOptions {
	state: BreathingBorderWidgetState;
	theme: BreathingBorderTheme;
	/** Same clock the controller stamps breath/exhale start times with — NOT the host's internal relative elapsed-ms. */
	clock: BreathingBorderClock;
	/**
	 * Invoked exactly once, from {@link onFrame}, on the `exhaling` -> `idle`
	 * transition. The controller uses this to dispose the animated host and
	 * fall back to the static widget, so idle really does leave zero
	 * subscriptions rather than an animated widget that just stopped changing.
	 */
	onSettled: () => void;
	/** Accent override for the primary accent slot (the peak brightness); `undefined` keeps the built-in palette. */
	accentColor?: ThemeColor;
	/** The host's live symbol preset; `undefined` keeps the `"unicode"` default (see `../glyph-presets.ts`). */
	glyphPreset?: SymbolPreset;
}

/**
 * Ambient widget for the breathing border. Render-backpressure is wired into
 * the {@link AnimationHost} directly (constructed by the controller), which
 * time-skips frame emission while under pressure — this widget's `onFrame`
 * simply never fires during a skipped frame, so the last-rendered breath
 * phase freezes in place and resumes from the correct wall-clock phase once
 * pressure clears. Each frame it checks whether the wind-down exhale just
 * finished. Reads {@link BreathingBorderClock}
 * rather than `this.elapsedMs` for the same reason as the other Wave 2
 * widgets: the host's relative elapsed-ms is anchored to whenever the host's
 * first subscriber attached, not to `agent_start`/`agent_end`, so breath/exhale
 * phase math needs its own shared clock seam.
 */
export class BreathingBorderWidget extends AnimatedWidget {
	#state: BreathingBorderWidgetState;
	#theme: BreathingBorderTheme;
	#policy: MotionPolicy;
	#clock: BreathingBorderClock;
	#onSettled: () => void;
	#colors: BreathingBorderColors;
	#glyphPreset: SymbolPreset;

	constructor(options: BreathingBorderWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#clock = options.clock;
		this.#onSettled = options.onSettled;
		this.#colors = breathingBorderColors(options.accentColor);
		this.#glyphPreset = options.glyphPreset ?? "unicode";
	}

	onFrame(_elapsedMs: number): void {
		if (this.#state.settleIfDone(this.#clock.now())) {
			this.#onSettled();
		}
	}

	renderFrame(width: number): readonly string[] {
		if (this.#policy.tier === "off") {
			// Off tier is a hard no-op: fully static regardless of agent lifecycle.
			return [renderBreathingBorderIdleRow(width, this.#theme)];
		}
		const tier = this.#policy.tier === "full" ? "full" : "subtle";
		const now = this.#clock.now();
		switch (this.#state.phase) {
			case "idle":
				return [renderBreathingBorderIdleRow(width, this.#theme)];
			case "active": {
				const period = this.#state.breathPeriodMs();
				const elapsed = this.#state.breathElapsedMs(now);
				const envelope = breathEnvelope(elapsed, period);
				const travelPos = tier === "full" ? pulsePosition(elapsed, period, width) : undefined;
				return [
					renderBreathingBorderRow(envelope, width, this.#theme, tier, travelPos, this.#colors, this.#glyphPreset),
				];
			}
			case "exhaling": {
				const elapsed = this.#state.exhaleElapsedMs(now);
				const envelope = exhaleEnvelope(elapsed, EXHALE_DURATION_MS);
				return [
					renderBreathingBorderRow(envelope, width, this.#theme, tier, undefined, this.#colors, this.#glyphPreset),
				];
			}
		}
	}
}
