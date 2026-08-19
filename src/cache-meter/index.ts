/**
 * Cache Meter: a session-scoped LLM prompt-cache ledger. Its ambient surface
 * is the Audit Box's `cache` row — a compact line showing how much of each
 * finalized request was served from the provider's cache versus re-paid for,
 * aggregated over the whole session; `/cache` prints the full breakdown,
 * grouped by provider and model, with totals, the dollar cost/savings behind
 * those tokens (`Usage.cost`, see `state.ts`), and the count of detected
 * cache invalidations — each credited, when possible, to the compaction,
 * auto-compaction, session switch, or model switch that most recently
 * preceded it.
 */
export * from "./render";
export * from "./state";
