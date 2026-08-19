/**
 * Rate-Limit Tidepool: one status line inside the Audit Box reading how much
 * rate-limit headroom the last response reported. A full pool reads as calm;
 * receding headroom exposes pebbles, then wet sand near-empty; the response's
 * own `*-reset` header drives a slow refill back toward full between
 * requests.
 *
 * The signal has no surface of its own. `src/animations-box/controller.ts`
 * feeds it — `familyForProvider` on the assistant `message_start`'s provider,
 * then `readRateLimitHeaders` on the headers stashed by the preceding
 * `after_provider_response` — and `src/animations-box/segments.ts` draws it
 * with `renderTidepoolRow` over `refillLevel` and `TIDEPOOL_COLORS`.
 *
 * The family whitelist is exactly two header shapes, keyed on
 * `AssistantMessage.provider`: Anthropic's
 * `anthropic-ratelimit-{resource}-{field}` (absolute RFC3339 reset) and
 * OpenAI's `x-ratelimit-{field}-{resource}` (Go-style duration reset). Every
 * other gateway stays invisible rather than guessed at — see `tidepool.ts`'s
 * module doc for the provenance of that rule.
 */
export * from "./render";
export * from "./state";
export * from "./tidepool";
