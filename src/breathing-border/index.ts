/**
 * Breathing Border: while the agent works, a faint luminance pulse breathes
 * with turn-modulated cadence while a fixed-speed gloss circles the perimeter.
 * On `agent_end`, the gloss freezes while the border winds down in one slow
 * exhale, then goes perfectly still.
 *
 * The motion primitives have no surface of their own. An Audit Box consumer
 * supplies perimeter geometry, reads {@link BreathingBorderState}, and combines
 * the envelope and gloss helpers with {@link breathingBorderColors} /
 * {@link BreathingBorderColors} when painting border chrome.
 *
 * Everything exported here is pure: deterministic functions of their numeric
 * inputs plus a clock-injected state machine, so the box's frames stay
 * byte-stable and snapshot-testable.
 */
export * from "./breath";
export * from "./colors";
export * from "./state";
