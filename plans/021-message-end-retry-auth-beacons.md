# Plan 021: Beacons on message_end, retry fallback, and disabled credentials

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e2e78cd..HEAD -- src/signal-extras src/animations-box/controller.ts src/animations-box/widget.ts src/registrar.ts package.json`
> The tree at plan time was intentionally dirty; excerpts cite files as on
> disk. Any mismatch between an excerpt below and the live code is a STOP.

## Status

- **Priority**: P2
- **Effort**: S per finding (three additive beacons)
- **Risk**: LOW — all three are conditional surfaces that render nothing today and nothing when healthy
- **Depends on**: none (independent of 020; land in triage order 020 → 021)
- **Category**: fix (consume host facts that already fire)
- **Planned at**: commit `e2e78cd`, 2026-09-12

## Why this matters

Three classes of session-degrading host facts fire today and are consumed by
nobody in `src/` (verified: `grep -rn 'stopReason\|upstreamProvider\|disabledFeatures\|retry_fallback\|credential_disabled' src/` → zero hits outside this plan's work):

- **A2 — reply integrity**: the provider silently truncated a reply
  (`stopReason === "length"`), a gateway rerouted the request to a different
  upstream (`upstreamProvider !== provider`), or the provider dropped a
  configured feature (`disabledFeatures`). The operator finds out only when
  output quality craters.
- **A3 — model fallback**: auto-retry switched the session to a fallback
  model (`retry_fallback_applied`); the `retryRadar` row shows the fuse but
  never that the session is now running on a different model.
- **A4 — credential disabled**: `AuthStorage` soft-disabled a credential
  (OAuth `invalid_grant`); every later request on that provider is doomed,
  and nothing in the box says so.

## Current state

### Host facts, all currently unconsumed

`node_modules/@oh-my-pi/pi-ai/src/types.ts:908-933` (`AssistantMessage`):

```ts
	/**
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	usage: Usage;
	stopReason: StopReason;
	...
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). ...
	 */
	disabledFeatures?: string[];
```

`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/shared-events.ts:269-282`:

```ts
/** Fired when auto-retry switches to a configured fallback model/provider. */
export interface RetryFallbackAppliedEvent {
	type: "retry_fallback_applied";
	from: string;
	to: string;
	role: string;
}

/** Fired when a request succeeds on the fallback model applied by auto-retry. */
export interface RetryFallbackSucceededEvent {
	type: "retry_fallback_succeeded";
	model: string;
	role: string;
}
```

`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:788-794`:

```ts
/** Fired when AuthStorage automatically soft-disables a credential (e.g. OAuth `invalid_grant`). Not fired for user-initiated `remove()` or duplicate-credential dedup. */
export interface CredentialDisabledEvent {
	type: "credential_disabled";
	/** Provider id whose credential was disabled (e.g. "anthropic"). */
	provider: string;
	/** Verbatim error captured for forensics (truncated upstream). */
	disabledCause: string;
```

All three are in the host's `on(...)` overload set (`extensions/types.ts:1233-1240`: `auto_retry_start`, `auto_retry_end`, `retry_fallback_applied`, `retry_fallback_succeeded`, `credential_disabled`) — no `declare module` additions needed.

### Existing surfaces this plan extends

`src/signal-extras/state.ts:250-252` and `:362` — tool-failure isotope, gated at ≥2:

```ts
	noteError(): void {
		this.#errorCount++;
	}
...
			error: this.#errorCount >= 2 ? Object.freeze({ count: this.#errorCount }) : undefined,
```

`src/signal-extras/segments.ts:457-464` — the isotope row builder:

```ts
	add(
		"errorIsotope",
		error === undefined
			? undefined
			: sample("errorIsotope", "alert", "error", "error", [
					{ key: "class", text: "tool failures", tone: "alert" },
					{ key: "count", text: `×${error.count}`, tone: "alert" },
				]),
```

`src/signal-extras/segments.ts:503-515` — the retryRadar row renders only the fuse frame:

```ts
	const retry = retryFuse(state.retry, now, { ... });
	add(
		"retryRadar",
		retry === undefined
			? undefined
			: sample("retryRadar", "notable", "retry", "warning", [
					{ key: "fuse", text: retry.text.trimEnd(), tone: "notable" },
				]),
	);
```

`src/animations-box/controller.ts:691-715` — auto-retry is already wired
(`onAutoRetryStart`/`onAutoRetryEnd` → `noteRetrySchedule`/`noteRetryEnd`);
fallback events are not.

`src/registrar.ts:501-502` — the subscription line pattern to copy:

```ts
	api.on("auto_retry_start", (event, ctx) => controller.onAutoRetryStart(event, ctx));
	api.on("auto_retry_end", (event, ctx) => controller.onAutoRetryEnd(event, ctx));
```

`src/animations-box/controller.ts:498-525` — `onMessageEnd` already branches on
`event.message.role === "assistant"` (cache sample, content sizes, timing);
A2's integrity read joins that branch.

### The border seam for A4

`src/breathing-border/colors.ts:18-36` — the palette layer defines exactly one
overridable slot:

```ts
export interface BreathingBorderColors {
	muted: ThemeColor;
	base: ThemeColor;
	peak: ThemeColor;
}
...
export function breathingBorderColors(accentColor: AccentColor | undefined): BreathingBorderColors {
	return accentColor === undefined
		? BREATHING_BORDER_COLORS
		: { ...BREATHING_BORDER_COLORS, peak: accentToThemeColor(accentColor) };
}
```

`src/animations-box/widget.ts:263,282` — the widget resolves the palette once at
construction (`this.#colors = breathingBorderColors(options.accentColor);`) and
buckets every border cell through `colorForToken(token, paint.colors)`
(`widget.ts:68-71,113-115`). The widget is constructed by the controller with
getter-style options (`src/animations-box/controller.ts:247-262`:
`getBorderFrame`, `getCollisionDiffraction`, `getAgentBonsai` — the escalation
getter follows this exact pattern).

`package.json:172-177` — the manifest pattern for a new sidecar toggle:

```json
			"retryRadar": {
				"type": "boolean",
				"description": "Show active automatic retry and fallback progress.",
				"default": true,
				"env": "OMP_ANIMATIONS_RETRY_RADAR"
			},
```

`src/signal-extras/settings.ts:12-17,32-37` — `SIGNAL_EXTRA_IDS` +
`DEFAULT_SIGNAL_EXTRAS_CONFIG` are the two other places a new row id lands.

### Decisions this plan makes (triage left open)

1. **A2 surface shape**: extend the existing `errorIsotope` row with integrity
   classes rather than adding a row — the triage names that row as the
   surface, and "reply trouble" is one fact family; the row's label stays
   `error`. Truncation and dropped-features render on FIRST occurrence
   (threshold 1) while tool failures keep their ≥2 gate — a silent truncation
   is individually actionable, a single tool failure is routine noise.
   A gateway reroute (`upstreamProvider` differing) is NOT rendered as an
   error span; it renders as a muted `via <upstream>` span only while the
   route differs from the previous assistant message's route — steady-state
   openrouter traffic would otherwise render a permanent non-fact (the S1
   lesson from plan 020).
2. **A3 fallback persistence**: fallback state lives beside the fuse
   (`#fallback` in `SignalExtrasState`), not inside `reduceRetryFuse` — the
   fuse is a self-clearing countdown effect whose reducer clears on every
   terminal edge (`src/signal-extras/lifecycle-effects.ts:277-279`), while
   "this session now runs on model X" persists after the retry saga settles.
   Cleared by `resetSession()` (a fresh session starts on the configured
   model).
3. **A4 row id**: new default-on conditional sidecar row `authBeacon`
   (label `auth`) following the `retryRadar` settings pattern — default on
   because it renders nothing until a credential dies, at which point it is
   the most important line in the box.
4. **A4 border escalation tone (triage left open)**: while an
   unacknowledged credential alert exists, the widget swaps the palette's
   `peak` slot to the theme's `error` token and leaves `muted`/`base` fixed —
   escalation rides the palette layer's single documented override seam
   (`colors.ts:31-36`) instead of adding a second color channel; the breath
   motion itself is untouched (D6: escalate and hold, no blinking; identical
   under reduced motion).
5. **A4 lifetime**: the alert survives `resetSession()` — a disabled
   credential does not heal on session switch; there is no re-auth event to
   clear it, so it holds until process end. It never echoes `disabledCause`
   (untrusted, prompt-injection surface — hard rule 4): the row renders the
   provider id only, length-clamped to 24 chars.

### Design invariants to preserve

ONE widget on ONE `AnimationHost`/shared clock; no fabricated telemetry; no
eased/blinking alerts (persist-and-hold); settings apply at wire time;
fixed-width rendering with the 45/69/120 ladder; finite motion with a
reduced-motion form; `bun test` conventions (no `mock.module`/`any`/
`ReturnType`, no wording/glyph/default pins). Corner accent belongs to beads
`omp-animations-o80`/`r7z` — the escalation must not touch corner glyphs.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | exit 0; baseline 51 files / 1213 pass / 0 fail + this plan's new tests |
| Focused suites | `bun test test/signal-extras.test.ts test/registrar.test.ts test/animations-box-widget.test.ts` | pass |
| Sandbox + lint | `./scripts/sandbox-omp.sh prepare` → restart tmux session `omp-anim-sandbox` → `bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5` → `bun run probe:lint` | 0 violations |

## Scope

**In scope**:

- `src/signal-extras/state.ts`
- `src/signal-extras/segments.ts`
- `src/signal-extras/settings.ts`
- `src/animations-box/controller.ts`
- `src/animations-box/widget.ts`
- `src/registrar.ts`
- `package.json` (`omp.settings` block only)
- `test/signal-extras.test.ts`
- `test/registrar.test.ts`
- `test/animations-box-widget.test.ts`
- `test/animations-box-controller.test.ts`
- `plans/README.md` (status row)

**Out of scope**:

- `src/breathing-border/**` — the palette layer and phase machine are
  untouched; escalation happens where the widget already resolves tokens.
- `src/signal-extras/lifecycle-effects.ts` — `reduceRetryFuse` is not
  modified (decision 2).
- Corner accent work (beads `omp-animations-o80`/`r7z`), tools row
  (`omp-animations-747`), Bonsai height (`mg5.4`/`mg5.6`).
- `test/animations-box-goldens.test.ts` — no golden should move; all three
  beacons are absent in healthy sessions, which is what every golden captures.

## Git workflow

Branch `advisor/021-message-end-retry-auth-beacons`; one Conventional Commit
per phase (`feat(signal-extras): …`); no push/PR unless the operator says so.

## Steps

### Phase A — A2: reply-integrity classes on the isotope row

Files (5): `src/signal-extras/state.ts`, `src/signal-extras/segments.ts`, `src/animations-box/controller.ts`, `test/signal-extras.test.ts`, `test/animations-box-controller.test.ts`.

1. `src/signal-extras/state.ts`:
   - New private state: `#truncatedCount = 0`, `#droppedFeatures = new Set<string>()`, `#route: { upstream: string | undefined; changed: boolean } = { upstream: undefined, changed: false }`.
   - New method `noteAssistantIntegrity(input: { stopReason: string; provider: string; upstreamProvider?: string; disabledFeatures?: string[] }): void`:
     - `stopReason === "length"` → `#truncatedCount++`.
     - each entry of `disabledFeatures ?? []` → `#droppedFeatures.add(feature)`.
     - route: `const upstream = input.upstreamProvider; #route = { upstream, changed: upstream !== undefined && upstream !== #route.upstream && #route.upstream !== undefined };` — `changed` is true only when a *previously observed* upstream differs (first observation establishes the baseline; steady-state gateway traffic renders nothing).
   - Extend the snapshot's `error` field: keep the tool-failure ≥2 gate, and surface integrity regardless: emit `error` when `#errorCount >= 2 || #truncatedCount > 0 || #droppedFeatures.size > 0 || #route.changed`, carrying `{ count, truncated, droppedFeatures: readonly string[], reroutedTo: string | undefined }` (extend the `ErrorSignal` interface at `state.ts:67`).
   - `resetSession()` (`state.ts:324-341`) clears all three.
2. `src/signal-extras/segments.ts:457-464`: build the isotope spans from
   whichever classes are live, in severity order:
   `trunc ×N` (tone `alert`) → `dropped <a,b>` (tone `alert`, features joined,
   clamp the joined list to 24 chars) → `tool failures ×N` (tone `alert`,
   only when count ≥ 2) → `via <upstream>` (tone `muted`, only when
   `reroutedTo` set). Row dot stays `alert` when any alert-tone span exists,
   else `notable`.
3. `src/animations-box/controller.ts` `onMessageEnd` assistant branch
   (`:503-523`): add
   `this.#signalState.noteAssistantIntegrity({ stopReason: event.message.stopReason, provider: event.message.provider, upstreamProvider: event.message.upstreamProvider, disabledFeatures: event.message.disabledFeatures });`
   (confirm the `provider` field name on `AssistantMessage` at
   `pi-ai/src/types.ts:891-904` when editing — the excerpt window above starts
   at 904).
4. Tests (behavioral, assert snapshot/span structure, never exact wording):
   - state: truncation surfaces at count 1; single tool failure still hidden;
     dropped feature surfaces once and dedupes; first upstream observation
     renders nothing, a *changed* upstream renders; `resetSession` clears.
   - controller: a `message_end` fixture with `stopReason: "length"` reaches
     the snapshot (extend an existing `onMessageEnd` fixture in
     `test/animations-box-controller.test.ts` rather than building new
     plumbing).

**Verify**: `bun run fix && bun run check && bun test` → exit 0, no golden diffs.

### Phase B — A3: fallback transition on the retry radar

Files (5): `src/registrar.ts`, `src/animations-box/controller.ts`, `src/signal-extras/state.ts`, `src/signal-extras/segments.ts`, `test/signal-extras.test.ts`.

1. `src/registrar.ts` — two lines after the existing retry pair (`:501-502`), same shape:

   ```ts
   	api.on("retry_fallback_applied", (event, ctx) => controller.onRetryFallbackApplied(event, ctx));
   	api.on("retry_fallback_succeeded", (event, ctx) => controller.onRetryFallbackSucceeded(event, ctx));
   ```

2. `src/animations-box/controller.ts` — two handlers beside
   `onAutoRetryStart` (`:691`), same `Pick<AnimationsBoxContext, "hasUI">`
   guard pattern:
   - `onRetryFallbackApplied(event: RetryFallbackAppliedEvent, ctx)` →
     `this.#signalState.noteRetryFallback(event.from, event.to); this.#changed();`
   - `onRetryFallbackSucceeded(event: RetryFallbackSucceededEvent, ctx)` →
     `this.#signalState.noteRetryFallbackSucceeded(); this.#changed();`
   - Import both event types from the same module the `AutoRetryStartEvent`
     import already uses.
3. `src/signal-extras/state.ts`: `#fallback: { from: string; to: string; succeeded: boolean } | undefined`;
   `noteRetryFallback(from, to)` sets it (succeeded false),
   `noteRetryFallbackSucceeded()` flips the flag if set; cleared in
   `resetSession()`; exposed on the snapshot as `retryFallback`.
4. `src/signal-extras/segments.ts:503-515`: the radar row now renders when
   `retry !== undefined || fallback !== undefined`. Spans: fuse frame first
   (when live), then `fallback <from>→<to>` (tone `notable` while
   unconfirmed, `positive` once succeeded; clamp each model id to 20 chars).
   When only the fallback exists the row keeps label `retry` and dot
   `notable` — the session is in a degraded-but-working state, not an alert.
5. Tests: fallback-only snapshot renders the radar row with the transition
   span; success flips the span tone; `resetSession` clears; fuse+fallback
   renders both spans with fuse first. Assert span keys/tones/order, not text
   wording (the `→` glyph is part of meaning here, but assert via the span
   *key* `fallback`, not the arrow, to respect the no-glyph-pin rule).

**Verify**: repo gate → exit 0. Add the two subscriptions to
`test/registrar.test.ts`'s wiring expectations ONLY if that suite fails —
follow its existing pattern for `auto_retry_start` (see `test/registrar.test.ts:55-90`).

### Phase C — A4: `authBeacon` sidecar row

Files (5): `src/signal-extras/settings.ts`, `src/signal-extras/state.ts`, `src/signal-extras/segments.ts`, `package.json`, `test/signal-extras.test.ts`.

1. `src/signal-extras/settings.ts`: add `"authBeacon"` to `SIGNAL_EXTRA_IDS`
   (after `"retryRadar"`, `:13`) and `authBeacon: true` to
   `DEFAULT_SIGNAL_EXTRAS_CONFIG` (`:32-37`).
2. `package.json` `omp.settings`: new entry after `retryRadar` (`:172-177`),
   same shape:

   ```json
   			"authBeacon": {
   				"type": "boolean",
   				"description": "Show a persistent alert when a provider credential is auto-disabled.",
   				"default": true,
   				"env": "OMP_ANIMATIONS_AUTH_BEACON"
   			},
   ```

3. `src/signal-extras/state.ts`: `#credentialAlerts = new Set<string>()`
   (provider ids); `noteCredentialDisabled(provider: string)` adds a
   24-char-clamped provider id; NOT cleared by `resetSession()` (decision 5 —
   add the one-line comment there); snapshot exposes
   `credentialAlerts: readonly string[]` (sorted for determinism).
4. `src/signal-extras/segments.ts`: add `"authBeacon"` to the row order list
   (`:24-30`, after `"retryRadar"`) and build the row: absent when the set is
   empty; else `sample("authBeacon", "alert", "auth", "error", [...])` with
   one span per provider: `<provider> credential disabled` (tone `alert`).
   Never render anything from `disabledCause`.
5. Tests: row absent by default; present after `noteCredentialDisabled`;
   survives `resetSession`; two providers render two spans sorted; provider
   id clamped. Also extend the settings test for the new id if
   `test/animations-box-settings.test.ts` or `test/signal-extras.test.ts`
   asserts the id list length — fix count-style assertions, do not pin
   defaults beyond what the existing suite already does.

**Verify**: repo gate → exit 0.

### Phase D — A4: wiring + border escalation

Files (5): `src/registrar.ts`, `src/animations-box/controller.ts`, `src/animations-box/widget.ts`, `test/animations-box-widget.test.ts`, `test/registrar.test.ts`.

1. `src/registrar.ts` (same block as Phase B):
   `api.on("credential_disabled", (event, ctx) => controller.onCredentialDisabled(event, ctx));`
2. `src/animations-box/controller.ts`:
   - `onCredentialDisabled(event: CredentialDisabledEvent, ctx: Pick<AnimationsBoxContext, "hasUI">)` →
     `if (!ctx.hasUI) return; this.#signalState.noteCredentialDisabled(event.provider); this.#changed();`
   - At the widget construction site (`:247-262`), pass a getter following
     the `getBorderFrame` pattern:
     `getBorderAlert: () => this.#signalState.snapshot().credentialAlerts.length > 0`
     (if `snapshot()` allocation per frame is a concern, add a cheap
     `hasCredentialAlert()` accessor on the state instead — prefer the
     accessor; snapshots freeze several objects per call).
3. `src/animations-box/widget.ts`:
   - Store `#getBorderAlert: () => boolean` (default `() => false`) beside
     `#getCollisionDiffraction` (`:262-282`).
   - Where the render pass builds `paint` (`:373-377`), resolve the palette
     per frame: `const colors = this.#getBorderAlert() ? { ...this.#colors, peak: "error" as ThemeColor } : this.#colors;`
     and feed `colors` into `paint`. Confirm `"error"` is a member of the
     host `ThemeColor` union (`node_modules/@oh-my-pi/pi-coding-agent/src/modes/theme/theme.ts`)
     before using it — if the token is named differently (e.g. `danger`),
     use the theme's error token, and note it in the commit message. The
     spread is two words per frame; do not cache it across frames (the alert
     can arrive mid-breath).
4. Tests:
   - `test/animations-box-widget.test.ts`: behavioral — with
     `getBorderAlert: () => true`, border cells that would resolve the peak
     token render with the error color; with `false`, output is byte-identical
     to today. Follow the file's existing border-rendering fixtures; assert on
     the painted color choice, not on specific border glyphs.
   - `test/registrar.test.ts`: extend the wiring expectations for
     `credential_disabled` per the suite's existing pattern.

**Verify**: repo gate → exit 0.

## Test plan

- **Re-run unchanged**: all golden and screenshot suites
  (`test/animations-box-goldens.test.ts`, `test/screenshot-regression.test.ts`)
  — healthy sessions render none of the three beacons, so **zero golden
  movement is an acceptance criterion**, not a hope. Any golden diff is a STOP.
- **New behavioral tests**: listed per phase — integrity thresholds and
  route-change gating (A2), fallback span lifecycle (A3), authBeacon row
  lifecycle + reset survival + border escalation (A4), registrar wiring rows.
- **No pins**: no test may assert exact row wording, arrows, glyphs, or
  manifest defaults; assert span keys, tones, presence, order, and painted
  color decisions.

## Sandbox verification

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

A healthy sandbox run must show NO new rows:
`grep -hcE '^│ [○◐●✗]  (auth|error|retry) ' .frames/run-<new>/*.txt` — `auth`
must be 0; `error`/`retry` only if the run genuinely hit failures. Forcing a
retry in the sandbox is optional (triage: "if feasible"); do not fabricate
provider failures by editing source.

## Done criteria

- [ ] Repo gate exits 0 (`bun run fix && bun run check && bun test`).
- [ ] Zero golden/screenshot diffs.
- [ ] All new behavioral tests pass; no wording/glyph/default pins.
- [ ] `bun run probe:lint` on a fresh capture: 0 violations; no `auth` row in a healthy run.
- [ ] `git status` clean outside the in-scope list; `plans/README.md` row updated.

## STOP conditions

- Any "Current state" excerpt no longer matches the live file.
- Any golden or screenshot moves — these beacons must be invisible when healthy.
- `"error"` (or an equivalent error token) does not exist in the host
  `ThemeColor` union — report; do not invent a color.
- `credential_disabled` or the fallback events are missing from the installed
  host's `on(...)` overloads (host version drift) — report the installed
  version (`node_modules/@oh-my-pi/pi-coding-agent/package.json`).
- The `AssistantMessage` in `message_end` turns out not to carry `provider`
  (field-name drift) — re-ground at `pi-ai/src/types.ts:891-940`.
- A step's verification fails twice after a reasonable fix attempt.

## Rollback

One commit per phase on the plan branch; `git revert <phase-sha>` unwinds any
single beacon. No pushes.

## Beads

- `omp-animations-o80` / `r7z` — corner accent; the border escalation here
  touches only the palette `peak` slot, never corner glyphs. If those beads
  landed a conflicting border-color mechanism, STOP and reconcile.
- `omp-animations-747` — tools row; untouched.

## Maintenance notes

- If the host ever emits a "credential re-enabled" event, clear the matching
  entry in `#credentialAlerts` — the persist-forever lifetime is a stand-in
  for that missing event, not a product decision.
- Plan 024 will relocate the sidecar builder call sites; land 021 before 024
  (triage order).
