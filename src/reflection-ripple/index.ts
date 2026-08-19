/**
 * Reflection Ripple: an optional status line inside the Audit Box. Each time
 * TTSR interrupts generation to inject a matched rule (`ttsr_triggered`),
 * `src/animations-box/controller.ts` drives this directory's
 * `ReflectionRippleState` — a calm concentric ripple expands outward while
 * the row briefly dims, the agent visibly "taking a breath" before it
 * reflects, then settles back to nothing once the wave and the breath both
 * recover. `src/animations-box/segments.ts` draws the line with
 * `renderReflectionRippleRow` + `REFLECTION_RIPPLE_COLORS`; everything here
 * is pure state and pure rendering, with no surface of its own.
 */
export * from "./render";
export * from "./ripple";
export * from "./state";
