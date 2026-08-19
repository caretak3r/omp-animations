/**
 * Cadence Equalizer: a multi-band VU-style meter for live token throughput,
 * grounded on the same `tokensPerSecond` provider (`token-rate.ts`) the Audit
 * Box already samples. {@link BAND_COUNT} bands each track the identical
 * signal through a differently-tuned exponential moving average — a fast band
 * that jitters with every burst, a slow band that lags and smooths — so the
 * bars visibly dance relative to each other rather than moving in lockstep as
 * one filled bar would. Each band also keeps a peak-hold marker (a classic
 * hardware VU-meter cue) that snaps up on a new high and decays slowly,
 * leaving a faint cap over a band that's coasting down from a recent spike.
 *
 * The Audit Box's `cadence` row is the only surface that renders this signal:
 * it owns the state, ticks {@link CadenceEqualizerState.pushSample} once per
 * frame, and picks a glyph variant from `./render` to fit the row's width.
 */
export * from "./bars";
export * from "./render";
export * from "./scale";
export * from "./state";
