// @oh-my-pi/animations — the oh-my-pi animation plugin suite (single package).
//
// Public surface: the vendored kit, the single config-driven registrar (the one
// plugin entry oh-my-pi loads, declared in package.json#omp.extensions), and the
// shipped animations' `createXExtension()` factories. Feature-internal helpers/
// constants are NOT flattened here — several feature modules reuse the same
// internal names (state/widget/controller classes), so a full star re-export
// would be ambiguous; import those from their module path when needed.
//
// This package ships a curated animation keep-set: audit-trail-box,
// breathing-border, cache-meter, cadence-equalizer, palimpsest,
// rate-limit-tidepool, reflection-ripple, and tool-constellation. Every other
// animation from the broader oh-my-pi-animations suite was deliberately left out
// of this package's copy rather than shipped unregistered.

export * from "./animations-box/doctor";
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
