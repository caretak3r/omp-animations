# Plan 020: Earn the line — make every permanent row report a real fact or go silent

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e2e78cd..HEAD -- src/rate-limit-tidepool src/animations-box src/signal-extras test/signal-extras.test.ts test/animations-box-segments.test.ts test/animations-box-goldens.test.ts`
> The working tree at plan time was intentionally dirty; excerpts below cite files **as on disk**, not as committed. If any excerpt below no longer matches the live code, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (six small findings; S1 and S2 carry the weight)
- **Risk**: LOW overall; MED for S2 and S4 (goldens move deliberately)
- **Depends on**: none
- **Category**: direction (signal honesty)
- **Planned at**: commit `e2e78cd`, 2026-09-12

## Why this matters

The Audit Box's product rule is that a signal earns its surface only by showing something. A corpus sweep of 368 captured frames (`.frames/run-*/*.txt`, row regex `^│ [○◐●✗]  <row> `) shows six rows failing that rule: `limits` idle 327/327 frames (it has *never* rendered a value for this operator's providers), `rewrite` rendered 293× with a `stripped` value of 0–8 tokens in every frame (15 frames read `shown ~0`), `memory` shows a `◐` warning meaning only "we haven't polled lately" (`stale` 28 frames), `context` renders one number three ways wide and keeps the status-line duplicate at 45 cols, `heading` renders a naked `NN%` that reads as completion progress (banned), and `audit` pushes `0 writes` unconditionally. This plan makes each row either report a real, provider-agnostic fact or occupy zero ink.

## Current state

All excerpts verified on disk at `e2e78cd` (dirty tree).

### S1 — `limits` row is inert: whitelist covers two direct providers; the HTTP status in hand is discarded

`src/rate-limit-tidepool/tidepool.ts:41-49` — the family whitelist:

```ts
const FAMILY_BY_PROVIDER: Readonly<Record<string, RateLimitFamily>> = {
	anthropic: "anthropic",
	openai: "openai",
};

/** `undefined` for any provider not explicitly whitelisted above. */
export function familyForProvider(provider: string): RateLimitFamily | undefined {
	return FAMILY_BY_PROVIDER[provider];
}
```

`src/animations-box/controller.ts:493-496` — the handler receives the full `AfterProviderResponseEvent` and keeps only `headers`; `status` and `requestId` are dropped:

```ts
	onAfterProviderResponse(event: AfterProviderResponseEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#tidepoolPendingHeaders = event.headers;
	}
```

The event type (`node_modules/@oh-my-pi/pi-ai/src/types.ts:336-339`):

```ts
export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
}
```

`src/animations-box/controller.ts:470-491` — `onMessageStart` claims the stashed headers only when `familyForProvider(event.message.provider)` resolves; for openrouter/moonshot/every gateway it never does, so `RateLimitTidepoolState.snapshot()` stays `undefined` forever and the builder renders the permanent idle row (`src/animations-box/segments.ts:422-428`: `snapshot === undefined` → `{ dot: "idle", label: "limits", spans: IDLE_SPANS }`).

`src/rate-limit-tidepool/state.ts:28-38` — `RateLimitTidepoolState` is a deliberately memoryless single-snapshot holder ("applySample always replaces the whole snapshot"); its module doc builds the whole class around "whitelist known families ONLY".

`src/animations-box/settings.ts:18-25` — `limits` is required:

```ts
export const BOX_REQUIRED_SEGMENT_IDS = [
	"contextGauge",
	"cacheMeter",
	"auditTrailBox",
	"rateLimitTidepool",
	"toolActivity",
	"filesLive",
] as const;
```

`scripts/frame-lint.ts:470-481` — `required-row-displacement` counts required rows; the row stays required (this plan changes its content, not its requiredness), so no lint contract change is needed.

### S2 — `rewrite` reports a chars÷4 estimate as telemetry and renders no-ops

`src/animations-box/controller.ts:635-640`:

```ts
	onContext(event: ContextEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "getTranscriptTokens">): void {
		if (!ctx.hasUI) return;
		const sent = estimateContentTokens(event.messages);
		this.#signalState.noteContext(ctx.getTranscriptTokens?.() ?? this.#getTranscriptTokens?.() ?? sent, sent);
		this.#changed();
	}
```

Note the `??` chain: a literal `0` from `getTranscriptTokens()` is not nullish, so it flows through as `shown = 0` — the 15 corpus frames reading `shown ~0`.

`src/signal-extras/state.ts:90-92` and `:180-184`:

```ts
export function estimateContentTokens(value: unknown): number {
	return Math.ceil(contentCharacters(value) / 4);
}
...
	noteContext(shownTokens: number, sentTokens: number): void {
		const shown = Math.max(0, Math.round(shownTokens));
		const sent = Math.max(0, Math.round(sentTokens));
		this.#rewrite = { shown, sent, stripped: Math.max(0, shown - sent) };
	}
```

`src/signal-extras/segments.ts:390-404` — renders whenever `rewrite !== undefined`, no threshold; the only meaningful span (`stripped`) is last and is the first dropped at 45 cols (corpus 45-col frame `.frames/run-2026-09-11T00-39-54-548Z-e8qejK/f0001-t0000011.txt` line 15: `│ ◐  rewrite  shown ~152 · sent ~262`).

Real `sent` is available and unread: every `message_end` carries `usage` (`node_modules/@oh-my-pi/pi-ai/src/types.ts:916`), whose `Usage` fields (`node_modules/@oh-my-pi/pi-catalog/src/types.ts:95-118`) include non-optional `input`, `cacheRead`, `cacheWrite` — the three conversation prompt buckets. The controller already handles `message_end` (`src/animations-box/controller.ts:498-525`) and already reads `usage.input/output/cacheRead/cacheWrite` for the cache meter.

**Decision (triage left open):** `sent` := `usage.input + usage.cacheRead + usage.cacheWrite` from the latest assistant `message_end` — the provider-billed prompt-side buckets, i.e. exactly what was sent; `totalTokens` is wrong here (includes output and orchestration), `contextTokens` is optional per provider. **Activation threshold:** render the row only when `stripped >= 512` tokens. Reason: `shown` remains a chars÷4 transcript estimate, so sub-1% deltas are estimator noise — every no-op frame in the corpus had stripped 0–8, while a real host rewrite (compaction, pruning) strips thousands; 512 is far above observed noise and far below any real rewrite.

### S3 — `memory` renders its own poll age as a warning

`src/signal-extras/memory-tide.ts:339-343`:

```ts
export function memoryObservationFreshness(state: MemoryTideState, now: number): MemoryObservationFreshness {
	if (state.lastGood === undefined) return "missing";
	const safeNow = monotonicTime(now) ?? state.lastGood.observedAt;
	return safeNow - state.lastGood.observedAt > MEMORY_OBSERVATION_STALE_MS ? "stale" : "fresh";
}
```

`src/signal-extras/memory-tide.ts:379-393` — `readinessToken` ranks `status stale` (tone `warning`) above `status unknown`; `warning` is also used for real degradations (`backend off`, `check failed`, `unavailable`, `read only`). `src/signal-extras/segments.ts:593-620` — the row hides only for `backend === "off"` with no usage (`:593-594`); a stale poll age with zero memory usage this session still renders `◐ memory status stale` (corpus: 28 frames; `e8qejK/f0001-t0000011.txt` line 18).

### S4 — `context` says one number three ways wide, keeps the wrong span narrow

`src/animations-box/segments.ts:166-215` — the live row builds `pct` (`NN% budget`), `used` (`45K/218K window`), `turns` (`>99 turns left`, `wideOnly`), `compactions` (`wideOnly`), and `quota` (`218K configured budget`, `wideOnly`). The 45-col corpus frame keeps only `[██░░░░░░░░] 15% budget` (`e8qejK/f0001-t0000011.txt` line 8) — the status-line-adjacent number survives and the forecast dies. Corpus: `turns left` present in 87 frames, 82 of them read `>99` — a non-fact (`turnsLeft > 99 ? ">99 turns left"` at `src/animations-box/segments.ts:200-201`).

### S7 — `heading` renders a naked percent

`src/signal-extras/segments.ts:529-537`:

```ts
				...(progress === undefined
					? []
					: [
							{
								key: "progress",
								text: `${Math.round(progress * 100)}%`,
								gradient: { ratio: progress, direction: "down-good" as const },
							},
						]),
```

`goalHeading` is default-off (`src/signal-extras/settings.ts:35`), so blast radius is opt-in.

### S8 — `audit` pushes `0 writes` unconditionally

`src/animations-box/segments.ts:363-368`:

```ts
	const spans: PhraseSpan[] = [
		{ key: "reads", text: `${metrics.reads} read${metrics.reads === 1 ? "" : "s"}` },
		{ key: "writes", text: `${metrics.writes} write${metrics.writes === 1 ? "" : "s"}` },
	];
	if (poisoned > 0) spans.push({ key: "poisoned", text: `${poisoned} changed on disk`, tone: "alert" });
	if (dirty > 0) spans.push({ key: "dirty", text: `${dirty} edited`, tone: "notable" });
```

### Design invariants this plan must preserve

- ONE Audit Box widget on ONE `AnimationHost`/shared frame clock — no second widget, no second clock.
- No fabricated telemetry; no eased/blinking money or risk figures; no fake progress percentages; D4 undefined ≠ zero; D6 alerts persist without blinking.
- Settings apply at wire time; fixed-width rendering with the 45/69/120-col degradation ladder; finite motion with a reduced-motion form.
- `bun test` conventions: no `mock.module`, no `any`, no `ReturnType`, no source-text/wording/default/glyph pins; assert consumer-observable behavior.
- `limits` stays a REQUIRED row (`BOX_REQUIRED_SEGMENT_IDS` unchanged): this plan changes what the row says, never whether it exists — so `scripts/frame-lint.ts` `required-row-displacement` (`:470-481`) and `idle-row-leak` (`:437-444`) are untouched.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | exit 0; baseline 51 files / 1213 pass / 0 fail (plus this plan's new tests) |
| One test file | `bun test test/signal-extras.test.ts` | pass |
| Sandbox prepare | `./scripts/sandbox-omp.sh prepare` | fake HOME at `/tmp/omp-anim-sandbox/home`, project at `/tmp/omp-anim-sandbox/project` |
| Sandbox session | restart the `omp-anim-sandbox` tmux session (per the script's output) | omp running against the fake HOME |
| Frame capture | `bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5` | a new `.frames/run-<stamp>/` directory |
| Frame lint | `bun run probe:lint` | 0 violations |

## Scope

**In scope** (the only files you may modify):

- `src/rate-limit-tidepool/health.ts` (create)
- `src/rate-limit-tidepool/index.ts`
- `src/animations-box/controller.ts`
- `src/animations-box/segments.ts`
- `src/signal-extras/state.ts`
- `src/signal-extras/segments.ts`
- `src/signal-extras/memory-tide.ts`
- `package.json` (setting descriptions only, under `omp.settings`)
- `AGENTS.md` (row-contract wording that this plan's row changes invalidate)
- `test/rate-limit-tidepool.test.ts`
- `test/signal-extras.test.ts`
- `test/memory-tide.test.ts`
- `test/animations-box-segments.test.ts`
- `test/animations-box-goldens.test.ts`
- `test/animations-box-widget.test.ts`
- `test/screenshot-regression.test.ts`
- `test/animations-box-controller.test.ts`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/animations-box/tool-activity.ts` and the `tools` row — bead `omp-animations-747` owns its deletion; plan 022 owns the counter move.
- `src/animations-box/settings.ts` — `BOX_REQUIRED_SEGMENT_IDS` does not change.
- `scripts/frame-lint.ts` — no lint-contract change is needed; if you find yourself editing it, STOP.
- `src/agent-bonsai/`, `src/activity-roster/` — other plans.
- `src/rate-limit-tidepool/tidepool.ts` header parsing/whitelist — the whitelist stays exactly as documented; do not add families.

## Git workflow

- Branch: `advisor/020-earn-the-line-silent-rows`.
- One commit per phase, Conventional Commits style (repo history uses `feat|fix|refactor|test|docs`), e.g. `fix(signal-extras): gate rewrite row on real stripped tokens`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Phase A — small honesty fixes: S7 heading label, S8 audit spans, S3 memory staleness

Files (5): `src/signal-extras/segments.ts`, `src/signal-extras/memory-tide.ts`, `src/animations-box/segments.ts`, `test/signal-extras.test.ts`, `test/memory-tide.test.ts`.

1. **S7** — in `buildSignalExtraSegments` (`src/signal-extras/segments.ts:533-534`), change the goal progress span text from `` `${Math.round(progress * 100)}%` `` to `` `budget ${Math.round(progress * 100)}%` ``. Keep the `down-good` gradient. (Decision the triage left open — rename, don't delete: the sidecar shows budget burn *between* status-line refreshes, so the fact is not a pure duplicate; only its naked-percent costume was.)
2. **S8** — in `buildAuditTrailBoxSegment` (`src/animations-box/segments.ts:363-366`), push the `reads` span only when `metrics.reads > 0` and the `writes` span only when `metrics.writes > 0`. The row only renders at `state.size > 0`, so at least one span always remains.
3. **S3** — two changes:
   - `src/signal-extras/memory-tide.ts:388` (`readinessToken`): stale-by-age returns `token("status", "status stale", "muted")` instead of `"warning"`. `warning` remains for `backend off`, `check failed`, `unavailable`, `read only`; `negative` for `error`.
   - `src/signal-extras/segments.ts:593-594`: extend the hide rule — currently `backendOff && usage === undefined` hides the row; additionally hide when the readiness token is stale-or-unknown **and** `usage === undefined` (no memory activity this session). Concretely: compute `readinessQuiet = readiness === undefined || readiness.tone === "muted"` and change `showMemory` to `memorySpans.length > 0 && !readinessQuiet || usage !== undefined` — a session that never touched memory and merely has an old poll renders nothing; a `ready` (positive) readiness still renders (that is a live fact, not decay), and any usage or degradation always renders.
4. Tests, in the same phase:
   - `test/memory-tide.test.ts`: behavioral case — a state whose only observation is older than `MEMORY_OBSERVATION_STALE_MS` yields a muted (non-warning) readiness token; a failed poll still yields a warning token. Assert on `tone`, not the wording.
   - `test/signal-extras.test.ts`: (a) memory row absent when the tide is stale with no usage; present when usage exists; (b) goal progress span carries a `budget` label prefix (assert `text.startsWith("budget ")`, not the full string); (c) audit changes are covered in `test/animations-box-segments.test.ts` in Phase C if its existing audit cases fail — a session with 0 writes must not render a writes span.

**Verify**: `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` → exit 0. Existing goldens that pinned `◐ memory status stale` or `0 writes` will fail — re-capture ONLY those frames (see Test plan for the deliberate list).

### Phase B — S2: rewrite row tells the truth or shuts up

Files (5): `src/animations-box/controller.ts`, `src/signal-extras/state.ts`, `src/signal-extras/segments.ts`, `package.json`, `test/signal-extras.test.ts`.

1. `src/signal-extras/state.ts`:
   - Add a private field `#sentTokensActual: number | undefined` and a method `noteUsageSent(promptTokens: number): void` that stores `Math.max(0, Math.round(promptTokens))`.
   - Change `noteContext(shownTokens, sentTokens)` semantics: `shownTokens` may now arrive as `undefined` (no measurement). When `shown` is `undefined` **or zero**, set `#rewrite = undefined` (a zero transcript reading is a missing measurement, not an empty transcript — D4). Otherwise compute `sent = #sentTokensActual ?? estimatedSent`, `stripped = max(0, shown - sent)`, and store `#rewrite` only when `stripped >= REWRITE_MIN_STRIPPED_TOKENS`; else `#rewrite = undefined`. Export `const REWRITE_MIN_STRIPPED_TOKENS = 512` with a comment giving the reason (estimator noise floor vs. real-rewrite magnitude; corpus no-ops were 0–8 tokens).
   - Clear `#sentTokensActual` in `resetSession()` (`state.ts:324-341`).
2. `src/animations-box/controller.ts`:
   - `onMessageEnd` (`:498-525`), inside the existing `event.message.role === "assistant"` branch: `const u = event.message.usage; this.#signalState.noteUsageSent(u.input + u.cacheRead + u.cacheWrite);`
   - `onContext` (`:635-640`): stop letting a literal `0` through the `??` chain. Shape:

     ```ts
     const estimated = estimateContentTokens(event.messages);
     const measured = ctx.getTranscriptTokens?.() ?? this.#getTranscriptTokens?.();
     const shown = measured !== undefined && measured > 0 ? measured : estimated;
     this.#signalState.noteContext(shown, estimated);
     ```

3. `src/signal-extras/segments.ts:390-404`: reorder spans so `stripped` leads (it is the row's only meaning): `stripped ~N` first with tone `notable`, then `shown ~N` / `sent N` (drop the `~` on `sent` when it came from usage — real numbers are not estimates; keep `~` on `shown`). The narrow variant therefore keeps `stripped`.
4. `package.json` `omp.settings.contextRewriteShadow.description` (`package.json:130-133`): update to say the row appears only when the host actually stripped context (≥512 tokens) and that `sent` is provider-reported usage. Do not change the default.
5. `test/signal-extras.test.ts`: behavioral cases — (a) `noteContext` with shown=0 yields no rewrite row; (b) shown/sent within 511 tokens yields no row; (c) stripped ≥ 512 yields a row whose first span is the stripped count; (d) after `noteUsageSent(N)`, stripped is computed against N, not the estimate; (e) `resetSession()` clears the usage baseline. Assert snapshot fields and span order/tone, not exact wording.

**Verify**: repo gate → exit 0. `test/animations-box-goldens.test.ts` frames that previously showed `◐ rewrite shown ~… · sent ~… · stripped ~0` now show no rewrite row — re-capture exactly those (deliberate; list them in the commit message).

### Phase C — S4: context row inverts priority, cuts the third restatement

Files (4): `src/animations-box/segments.ts`, `test/animations-box-segments.test.ts`, `test/animations-box-goldens.test.ts`, `test/screenshot-regression.test.ts`.

1. In `buildContextGaugeSegment` (`src/animations-box/segments.ts:184-216`):
   - Delete the `quota` span (`{ key: "quota", text: `${formatNumber(snapshot.quotaTokens)} configured budget`, wideOnly: true }`, line 215) — the ceiling is already expressed by the bar and pct.
   - Suppress the `>99` non-fact: emit the `turns` span only when `turnsLeft !== null && turnsLeft <= 99`; delete the `">99 turns left"` branch (`:200-201`).
   - Invert narrow priority: remove `wideOnly: true` from the `turns` span and add `wideOnly: true` to the `used` span. Rationale (state it in a comment): the bar+pct is one reading of fill, `turns` is the only *forecast* — the differentiator against the status line — and `used` is the same fill restated in raw tokens, which the detail-width tail can afford but 45 cols cannot.
   - Leave `variants` (simple mode, `:179`) unchanged.
2. `test/animations-box-segments.test.ts`: adjust the context-gauge cases — assert: no span with key `quota`; no turns span when the forecast exceeds 99; turns span present and not wide-only when ≤ 99; used span wide-only. Model on the existing cases in that file; assert span structure (`key`, `wideOnly`, presence), never exact text.
3. Re-capture context-row goldens in `test/animations-box-goldens.test.ts` and the affected slices in `test/screenshot-regression.test.ts`; re-check the degradation `LADDER` at widths 45, 69, 120 (AGENTS.md:129,134). Only rows whose content this phase changed may differ — any other row moving is a STOP.

**Verify**: repo gate → exit 0.

### Phase D — S1: `limits` becomes a provider-agnostic HTTP-status row

**Decision (triage left open, "last HTTP status" vs "status-class counts"):** both, ranked — the row leads with per-class non-2xx counts this session (`429 ×3` / `5xx ×1`) plus the age of the newest non-2xx, and shows `http 200 · N ok` when everything is healthy. Reason: a single "last status" hides a flapping provider (one 200 after five 429s reads healthy); counts carry the pushback history, the age stamps its recency, and the healthy form costs nothing because `limits` is a required row that renders a line either way.

**Decision (triage left open, tidepool absorbs vs sibling):** sibling state class. `RateLimitTidepoolState` is a documented memoryless single-snapshot holder built around "whitelist known families ONLY" (`src/rate-limit-tidepool/state.ts:21-27`, `tidepool.ts:23-26`); status counters are accumulating, provider-agnostic state — bolting them on would break both documented contracts. The header-derived quota level stays the wide-width tail when a whitelisted family mounts.

**Activation threshold:** the row leaves idle on the first `after_provider_response` of the session (count ≥ 1). Reason: the integer is authoritative and already in hand; before the first response there is no measurement and D4 forbids rendering `0`.

Files phase D1 (4): `src/rate-limit-tidepool/health.ts` (create), `src/rate-limit-tidepool/index.ts`, `src/animations-box/controller.ts`, `test/rate-limit-tidepool.test.ts`.

1. Create `src/rate-limit-tidepool/health.ts`:

   ```ts
   /** Provider-agnostic response health, read off `after_provider_response.status`. */
   export type StatusClass = "ok" | "auth" | "throttle" | "server" | "other";

   export interface ProviderHealthSnapshot {
   	readonly okCount: number;
   	readonly lastStatus: number;
   	/** Non-2xx counts per class this session; empty when all responses were 2xx. */
   	readonly troubleCounts: Readonly<Partial<Record<Exclude<StatusClass, "ok">, number>>>;
   	/** Newest non-2xx: its status and when it was observed (controller clock). */
   	readonly lastTrouble: { readonly status: number; readonly observedAtMs: number } | undefined;
   }

   export class ProviderHealthState {
   	// classify: 2xx/3xx → ok, 401/403 → auth, 408/429 → throttle, 5xx → server, else other.
   	noteStatus(status: number, nowMs: number): void { /* accumulate */ }
   	/** `undefined` before the first response — the idle-row cue. */
   	snapshot(): ProviderHealthSnapshot | undefined { /* ... */ }
   	reset(): void { /* session switch */ }
   }
   ```

   Classification is mechanical, never interpreted: the row states "the provider said 429", never a quota percentage or predicted reset (no fabricated telemetry).
2. `src/rate-limit-tidepool/index.ts`: export the new module alongside the existing exports.
3. `src/animations-box/controller.ts`:
   - Add `#providerHealthState = new ProviderHealthState()` beside `#tidepoolState`.
   - `onAfterProviderResponse` (`:493-496`): additionally `this.#providerHealthState.noteStatus(event.status, this.#scheduler.now()); this.#changed();`.
   - Reset it wherever `#tidepoolState` is reset on session switch (find the existing session-reset path; if the tidepool is never reset, reset health in the same place `#signalState.resetSession()` is called).
   - Pass the snapshot into the segment build where `buildRateLimitTidepoolSegment` is called from `#buildAuditSampleGroups`.
4. `test/rate-limit-tidepool.test.ts`: state cases — idle before first status; ok counting; class bucketing at boundaries (200, 299, 300, 401, 408, 429, 500, 503); `lastTrouble` tracks the newest non-2xx; reset clears.

**Verify**: repo gate → exit 0 (builder untouched so far; goldens unchanged).

Files phase D2 (4): `src/animations-box/segments.ts`, `test/animations-box-segments.test.ts`, `test/animations-box-goldens.test.ts`, `AGENTS.md`.

5. `buildRateLimitTidepoolSegment` (`src/animations-box/segments.ts:413-461`) gains the health snapshot as a parameter (keep the tidepool snapshot parameter):
   - Health `undefined` → the existing idle row, unchanged.
   - Healthy (no trouble): dot `live`, spans `http 200 · <okCount> ok`.
   - Trouble: dot `alert` when the newest non-2xx is a `throttle`/`server`/`auth` class, spans worst-first, e.g. `429 ×3 · 40s ago · 12 ok`; age from `lastTrouble.observedAtMs` vs `now`, plain text, no easing (D6: the dot escalates and holds; no pulse — reduced-motion form is identical).
   - When a whitelisted family's tidepool snapshot ALSO exists, append the existing quota spans (`% left`, `resets`, provider) as `wideOnly` tail — one row, health first, quota as the wide tail.
   - 45-col degradation: keep worst class count + age only (`✗ limits 429×3 · 40s`); all-healthy narrow keeps `http 200`.
6. `AGENTS.md`: the row-contract line that excuses idle on "cache, tools, or files" (`AGENTS.md:56`) and any `limits` description must now describe the status-fed row; update the sentence, keep it one line.
7. Tests: `test/animations-box-segments.test.ts` — behavioral cases: idle before first response; healthy form has a `live` dot and an ok-count span; a 429 flips the dot to `alert` and leads with the throttle count; family quota tail present only when a tidepool snapshot exists and marked wide-only. Re-capture `limits`-row goldens (deliberate — the idle `○ limits —` frames stay identical because health starts `undefined`; only frames captured after a synthetic response change).

**Verify**: repo gate → exit 0.

## Test plan

- **Re-run unchanged**: `test/registrar.test.ts`, `test/animations-box-controller.test.ts` (unless its context/rewrite fixtures pin the old `??` behavior — fix only failing cases), `test/animations-box-settings.test.ts`, `test/frame-lint.test.ts`, `test/animations-box-context-gauge.test.ts` (state math is untouched; only the builder changed), all audit-trail, cache-meter, bonsai, roster suites.
- **Deliberately re-captured goldens** (and why):
  - context-row frames in `test/animations-box-goldens.test.ts` + `test/screenshot-regression.test.ts` slices — S4 changed the span set.
  - frames showing `rewrite … stripped ~0` — S2 makes them empty; the row's absence IS the fix.
  - frames showing `◐ memory status stale` with no usage — S3 hides them.
  - frames pinning `0 writes` in audit — S8 drops the span.
  - `limits` frames only where a response was synthesized in the fixture — S1.
  - Any golden outside these five categories moving is a STOP condition.
- **New behavioral tests** (no wording/glyph/default pins): listed per phase above — rewrite threshold/zero-guard/usage-baseline, memory stale-tone + hide rule, context span structure, provider-health bucketing + builder dot/span behavior, audit conditional spans.

## Sandbox verification (after all phases)

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
# (fake HOME /tmp/omp-anim-sandbox/home, cwd /tmp/omp-anim-sandbox/project)
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

Corpus checks over the new run (row regex `^│ [○◐●✗]  <row> `; `<run>` = the new `.frames/run-*/` dir):

| Check | Command | Before (368-frame corpus) | Expected after |
|---|---|---|---|
| limits populated | `grep -hE '^│ [○◐●✗]  limits ' <run>/*.txt \| grep -vc 'limits   —'` | 0 of 327 | ≥ 1 once any provider response landed (busy run: every frame after the first response) |
| rewrite no-ops gone | `grep -hcE '^│ [○◐●✗]  rewrite ' <run>/*.txt` | 293 of 368, all stripped 0–8 | 0 in a run without a real context rewrite |
| memory stale nag gone | `grep -hcE '^│ ◐  memory +status stale' <run>/*.txt` | 28 | 0 |
| >99 non-fact gone | `grep -hc '>99 turns left' <run>/*.txt` | 82 | 0 |
| third restatement gone | `grep -hc 'configured budget' <run>/*.txt` | present in wide frames | 0 |
| zero-writes span gone | `grep -hcE '^│ [○◐●✗]  audit .*\b0 writes' <run>/*.txt` | present | 0 |
| naked heading pct gone | `grep -hE '^│ [○◐●✗]  heading ' <run>/*.txt \| grep -Ec ' [0-9]+%'` | any | 0 lines with a % not preceded by `budget ` (only applies if `goalHeading` was enabled for the run) |

## Done criteria

- [ ] Repo gate exits 0: `bun run fix && bun run check && bun test`.
- [ ] All new behavioral tests above exist and pass; no test pins exact row wording, glyphs, or defaults.
- [ ] Goldens outside the five deliberate categories are byte-identical.
- [ ] `bun run probe:lint` on a fresh sandbox capture: 0 violations.
- [ ] Corpus checks table above: all "Expected after" values hold.
- [ ] `git status` shows no modifications outside the in-scope list.
- [ ] `plans/README.md` status row for 020 updated.

## STOP conditions

- Any excerpt in "Current state" no longer matches the live file (drift since `e2e78cd`).
- A golden outside the five deliberately-changed categories moves.
- You find yourself needing to edit `src/animations-box/settings.ts` (`BOX_REQUIRED_SEGMENT_IDS`) or `scripts/frame-lint.ts` — this plan was designed to avoid the required-row contract; report instead.
- Bead `omp-animations-747`'s tools-row deletion has landed AND removed `onAfterProviderResponse` or restructured `#buildAuditSampleGroups` in a way that contradicts the Phase D excerpts — re-ground before continuing.
- `after_provider_response` turns out not to fire for a provider in the sandbox (health stays `undefined` in a busy run) — the activation assumption is false; report.
- A step's verification fails twice after a reasonable fix attempt.

## Rollback

No executor commits are pushed. Roll back with `git restore --source=HEAD --staged --worktree -- <in-scope paths>` per phase, or `git reset --hard` to the pre-plan commit on the plan branch. Because each phase is one commit, `git revert <phase-sha>` unwinds any single finding independently.

## Beads

- `omp-animations-747` — owns tools-row deletion; this plan must not touch `tool-activity.ts` or the tools row.
- `omp-animations-mg5.4` / `mg5.6` — own Bonsai height; untouched here.
- `omp-animations-o80` / `r7z` — own the corner accent; untouched here.

## Maintenance notes

- If the host ever exposes rate-limit facts in `extensibility` types, the health row should absorb them; the family-header tidepool remains the only quota source until then.
- `REWRITE_MIN_STRIPPED_TOKENS` is a noise floor, not a product threshold — if `getTranscriptTokens` becomes authoritative (host-measured), drop the floor to `> 0`.
- Plan 024 (row registry) will relocate the builder call sites this plan touches; land 020 first (the triage orders 020 → … → 024).
