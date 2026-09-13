// @oh-my-pi/animations — the oh-my-pi animation plugin suite (single package).
//
// Public surface: the vendored kit, the single config-driven registrar (the one
// plugin entry oh-my-pi loads, declared in package.json#omp.extensions), and the
// headless Audit Trail service that registrar shares its ledger with. Every other
// signal is presentation owned by the Audit Box, so there is no per-animation
// `createXExtension()` factory left to export. Feature-internal helpers/constants
// are NOT flattened here — several feature modules reuse the same internal names
// (state/render/colors), so a full star re-export would be ambiguous; import those
// from their module path when needed.
//
// This package ships one consolidated Audit Box with Agent Bonsai plus the
// audit, border, cache, file, rate-limit, and tool signals.

export * from "./agent-bonsai";
export * from "./animations-box/doctor";
export * from "./animations-box/legend";
export * from "./appearance";
export { createAuditTrailBoxExtension } from "./audit-trail-box";
export * from "./kit";
export * from "./live-files";
export * from "./registrar";
export * from "./signal-extras";
