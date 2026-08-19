/**
 * Breathing Border: while the agent works, a faint luminance pulse breathes on
 * a ~4s inhale/exhale — ambient presence, felt not seen. On `agent_end` it
 * winds down in one slow exhale then goes perfectly still; `turn_start`/
 * `turn_end` modulate the breath cadence from the just-finished turn's
 * duration.
 *
 * The motion has no surface of its own. It renders as the Audit Box's border
 * chrome: `../animations-box/controller.ts` owns the phase machine (importing
 * {@link BreathingBorderState}, {@link breathEnvelope}, {@link exhaleEnvelope}
 * and {@link EXHALE_DURATION_MS} from here) and exposes the live `0..1`
 * envelope to `../animations-box/widget.ts`, which colors the border with
 * {@link breathingBorderColors} / {@link BreathingBorderColors} after bucketing
 * that envelope through {@link brightnessToken} / {@link BorderBrightnessToken}.
 *
 * Everything exported here is pure: deterministic functions of their numeric
 * inputs plus a clock-injected state machine, so the box's frames stay
 * byte-stable and snapshot-testable.
 */
export * from "./breath";
export * from "./colors";
export * from "./state";
