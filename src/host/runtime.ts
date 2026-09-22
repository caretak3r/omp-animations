/**
 * Runtime value adapter for host dependency (@oh-my-pi/pi-coding-agent).
 *
 * Host subpath imports carry no semver commitment. This module re-exports every
 * runtime value the plugin consumes so a host refactor breaks once here, not across 21 files.
 *
 * See plan 023 and the Biome fence at biome.json (noRestrictedImports override).
 */

export { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
export { expandPath, resolveReadPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
export { getContextUsageLevel, getContextUsageThemeColor } from "@oh-my-pi/pi-tui/chrome/context-thresholds";
// splitInternalUrlSel/splitPathAndSel moved from pi-coding-agent/tools/path-utils to
// pi-tui/tools/read between host v17 and v18; pi-coding-agent's own path-utils now
// imports them from here too. Track the host's current location, not the historical one.
export { splitInternalUrlSel, splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
