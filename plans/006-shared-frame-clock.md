# Plan 006 — SPIKE: one shared frame clock for the family (measure first)

**Written against commit:** `31d90c8` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** speed/performance (architectural) · **Effort:** L · **Risk:** MED · **Status:** OPTIONAL SPIKE

## Why this is a spike, not a build

`src/kit/animation-host.ts:37-44` documents "one shared frame clock for the whole animated-plugin
family… N subscribers coalesce onto exactly one underlying timer." **In reality that coalescing only
runs at N=1**: every controller does its own `new AnimationHost(...)` (16 sites — see Plan 002), so with
the full suite active there are up to ~16 independent `setInterval` timers at 30 fps, each with its own
`#startedAt` elapsed clock and its own `requestComponentRender` burst. The docstring is stale vs. the
code (doc-drift), and the win from fixing it is **real but unmeasured** — it depends on how the core TUI
batches component renders, which you must measure before committing to an L-sized, all-controllers
refactor.

## Spike deliverable (this plan produces a decision + a plan, not necessarily the refactor)

1. **Measure the payoff.** Determine whether 16 uncoordinated 30 fps timers + 16 separate
   `requestComponentRender` calls actually cost meaningfully more than one shared timer + one batched
   render, on the real core TUI. Look at how `requestComponentRender` / the paint loop in
   `/Users/rohit/Documents/oh-my-pi/packages/tui/` coalesces renders within a tick. If the core already
   batches all component renders in a frame regardless of caller count, the win is mostly "one timer +
   phase-aligned widgets," which is smaller. Write the finding.
2. **Prototype the shared host** behind the existing interfaces: one family-level `AnimationHost`
   created once (lazily, at the registrar/extension entry) and injected into every controller;
   controllers `subscribe`/`unsubscribe` instead of `new AnimationHost` + `dispose`. This also:
   - removes per-widget elapsed-clock drift (today many widgets bolt on a separate wall-clock seam
     because their host clocks drift out of phase),
   - collapses Plan 002's per-controller backpressure wiring to a single place.
3. **Report** with a go/no-go and, if go, a full implementation plan (it touches all 16 controllers +
   their tests + lifecycle ownership).

## The hard part — lifecycle (design it before coding)

Ownership changes fundamentally: a shared host must **not stop** when one feature goes idle; "dispose"
becomes "unsubscribe," and the host's timer runs while ≥1 subscriber is active and stops when the last
unsubscribes. Get this wrong and either (a) the clock dies while a widget still needs it, or (b) a timer
leaks after the last widget unmounts. The 18-mount gallery test (`test/wave2-gallery.test.ts`) is your
leak oracle — it must still show zero leaked timers/subscriptions after teardown.

## Files in scope (if the spike goes to implementation)
`src/kit/animation-host.ts` (add a shared/injected mode; fix the docstring either way); the 16
controllers; the registrar entry (`src/registrar.ts`) to own/inject the shared host; all affected tests.

## Files OUT of scope
The pure render/state modules (a shared clock doesn't change their signatures); color/glyph code.

## Escape hatches
- If measurement (step 1) shows the paint-batching win is negligible, **STOP** — do only the cheap part:
  correct the stale docstring at `animation-host.ts:37-44` to describe actual behavior (per-controller
  hosts), and record "shared clock not worth the refactor at current suite size" in `plans/README.md`.
  That alone resolves the doc-drift finding.
- If lifecycle ownership can't be made leak-free against the gallery test, STOP and report — do not ship
  a version that leaks or dies mid-session.

## Test plan (if implemented)
- The 18-mount gallery test must pass with zero leaked timers/subscriptions after dispose/unsubscribe.
- Add a test asserting exactly **one** underlying timer exists with the full suite mounted (use the
  kit's scheduler seam / fake timer the existing kit tests use — assert a single scheduled interval).
- All animation snapshot tests unchanged (phase alignment must not change rendered output for a given
  elapsed input — if it does, the elapsed-clock semantics changed and that's a regression to reconcile).

## Done criteria
- Spike report written (payoff measurement + go/no-go) in `plans/README.md` or a `plans/006-notes.md`.
- If go: `bun run fix && bun check` exit 0; `bun test` 0 fail, pass ≥ 773; single-timer test added;
  gallery leak test green.
- If no-go: docstring corrected; decision recorded. Either outcome closes the doc-drift.

## Maintenance note
Revisit if the suite grows well past ~18 always-on widgets or if profiling on a real user's terminal
shows paint thrash. Until then, Plan 002 (per-host backpressure) delivers most of the practical benefit
at a fraction of the risk.
