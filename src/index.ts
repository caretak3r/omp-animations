// @oh-my-pi/animations — the oh-my-pi animation plugin suite (single package).
//
// Public surface: the vendored kit, the single config-driven registrar (the one
// plugin entry oh-my-pi loads, declared in package.json#omp.extensions), and the
// shipped animations' `createXExtension()` factories. Feature-internal helpers/
// constants are NOT flattened here — several feature modules reuse the same
// internal names (state/widget/controller classes), so a full star re-export
// would be ambiguous; import those from their module path when needed.
//
// This package ships one consolidated Audit Box with Agent Bonsai plus the
// audit, border, cache, cadence, file, rate-limit, reflection, and tool signals.

export * from "./agent-bonsai";
export * from "./animations-box/doctor";
export * from "./animations-box/legend";
export * from "./appearance";
export { createAuditTrailBoxExtension } from "./audit-trail-box";
export { createBreathingBorderExtension } from "./breathing-border";
export { createCacheMeterExtension } from "./cache-meter";
export { createCadenceEqualizerExtension } from "./cadence-equalizer";
export * from "./kit";
export { createPalimpsestExtension } from "./palimpsest";
export { createRateLimitTidepoolExtension } from "./rate-limit-tidepool";
export { createReflectionRippleExtension } from "./reflection-ripple";
export * from "./registrar";
export { createToolConstellationExtension } from "./tool-constellation";
