// @oh-my-pi/animations — the oh-my-pi animation plugin suite (single package).
//
// Public surface: the vendored kit, the single config-driven registrar (the one
// plugin entry oh-my-pi loads, declared in package.json#omp.extensions), and the
// shipped animations' `createXExtension()` factories. Feature-internal helpers/
// constants are NOT flattened here — several feature modules share internal names
// (two constellation star-maps, multiple token-rate widgets), so a full star
// re-export would be ambiguous; import those from their module path when needed.
//
// Two rounds of cuts narrowed the registered suite: Plan 007 unregistered 6
// status-bar-duplicating animations (`tokenTide`, `cadenceEqualizer`, `costCandle`,
// `contextConstellation`, `modelWeatherVane`, `contextWeather`); a later scope call
// dropped 4 more (`toolConstellation`, `todoMeteors`, `breathingBorder`,
// `reflectionRipple`). All dropped animations' source is kept on disk but their
// factories are intentionally no longer re-exported here — import them directly from
// their module path (e.g. `./tool-constellation`, `./token-tide`) if needed.

// Shipped (13) factories
export { createAgentFleetExtension } from "./agent-fleet";
export * from "./appearance";
export { createAuditTrailBoxExtension } from "./audit-trail-box";
export { createCacheMeterExtension } from "./cache-meter";
export { createDiffBloomExtension } from "./diff-bloom";
export { createDriftBuoyExtension } from "./drift-buoy";
export { createFourHandsExtension } from "./four-hands";
export { createGoalHorizonExtension } from "./goal-horizon";
export * from "./kit";
export { createMemoryCrystalsExtension } from "./memory-crystals";
export { createPalimpsestExtension } from "./palimpsest";
export { createPromptChargeExtension } from "./prompt-charge";
export { createRateLimitTidepoolExtension } from "./rate-limit-tidepool";
export * from "./registrar";
export { createSessionBonsaiExtension } from "./session-bonsai";
export { createSessionStrataExtension } from "./session-strata";
