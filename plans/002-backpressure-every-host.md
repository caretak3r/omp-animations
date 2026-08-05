# Plan 002 — Wire render-backpressure into every animated host

**Written against commit:** `31d90c8` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** speed/performance · **Effort:** S · **Risk:** LOW

## Why this matters

The kit has a working, tested render-backpressure path: `AnimationHost.#tick` time-skips frame
emission when `underPressure` is true (`src/kit/animation-host.ts:131`), fed by
`backpressureFromTui(tui)` (`src/kit/backpressure.ts`). It reads the live `TUI.renderUnderPressure`
signal — **which is present in the installed `@oh-my-pi/pi-tui@16.3.12`** (verified in `node_modules`),
so the signal is real, not a `?? false` no-op.

But only **1 of 16** hosts actually uses it: `src/context-weather/extension.ts:121-123` passes
`backpressure` to `new AnimationHost(...)`. The other 15 construct `new AnimationHost({ policy,
scheduler })` with no backpressure. Three of those (`breathing-border`, `diff-bloom`,
`reflection-ripple`) partially compensate by wiring backpressure into their `MotionPolicy` and calling
`policy.refresh()` every frame — but **~12 wire nothing** and keep running the full
sample→render→diff→string-build at 30 fps under exactly the render pressure the mechanism exists to
relieve (~360 needless render passes/sec across the suite when the core renderer is already thrashing).

The ~12 with no backpressure at all (verified — each constructs the host at the cited line without a
`backpressure` field and never calls `policy.refresh()` in `onFrame`):
`token-tide/controller.ts:153`, `tool-constellation/controller.ts:92`, `cadence-equalizer/controller.ts:154`,
`prompt-charge/controller.ts:107`, `cost-candle/controller.ts:103`, `goal-horizon/controller.ts:91`,
`context-constellation/controller.ts:123`, `memory-crystals/controller.ts:107`,
`model-weather-vane/controller.ts:108`, `session-bonsai/controller.ts:120`,
`todo-meteors/controller.ts:134`, `agent-fleet/controller.ts:117`.

## The fix

**Reference pattern (already correct):** `src/context-weather/extension.ts:121-123`:
```ts
const backpressure = backpressureFromTui(tui);
const host = new AnimationHost({ policy, backpressure, scheduler: options.scheduler });
```

### Step 1 — the 12 no-backpressure controllers
In each controller's widget-mount factory (where `new AnimationHost({ policy, scheduler })` is built,
and where the `tui` param is in scope — it already is, the widget factory receives it), construct
`backpressureFromTui(tui)` and pass it as the `backpressure` field to the host. Import
`backpressureFromTui` from the vendored kit (`../kit` / the same path the file already imports kit
symbols from — match existing imports). One-line-ish change per controller.

### Step 2 — subsume PERF-05 (the 3 policy-refresh controllers)
`breathing-border`, `diff-bloom`, `reflection-ripple` currently wire backpressure into the *policy* and
call `this.#policy.refresh()` every frame (`src/breathing-border/widget.ts:122-127` and siblings),
re-reading NO_COLOR/CI/TERM env 30×/sec purely to detect a backpressure change the host can now detect
for free. Move them onto the **host** backpressure path (Step 1) and **delete the per-frame
`policy.refresh()`** from `onFrame`. Keep the policy subscription their `AnimatedWidget` constructor
sets up (that delivers live *setting* changes — off/subtle/full — which is a different signal).
- **VERIFY BEHAVIOR before deleting `refresh()`:** the host-skip path *freezes* frames under pressure;
  the current `policy.refresh()` path may instead collapse to the `off` static frame. Confirm via the
  existing tier/backpressure tests that "freeze" is acceptable (it is the kit's intended behavior). If
  a test asserts the collapse-to-static behavior specifically, keep whichever satisfies the contract
  and note it. **ESCAPE HATCH:** if removing `refresh()` changes a documented visual contract you can't
  reconcile, leave those 3 on the policy path and do only the 12 — report the divergence.

## Files in scope
The 12 controllers listed above; plus `breathing-border`, `diff-bloom`, `reflection-ripple` controllers
+ their widgets (for Step 2). Their test files as needed for re-gold.

## Files OUT of scope
`src/kit/*` (the mechanism is correct — do not change the host/backpressure implementation);
`context-weather` (already correct); all render/state modules.

## Test plan
- Extend each affected controller's behavioral test (or the kit-level backpressure test) to assert: with
  a `tui` whose `renderUnderPressure` is forced true, the host **skips** frame emission (no new rendered
  row) for that widget — mirroring how `context-weather`'s backpressure test asserts it today. Use the
  same fake-TUI/backpressure harness the kit test already uses; do not invent a new one.
- For the 3 refactored controllers: assert the widget still freezes under pressure and still responds to
  a live tier change via the policy subscription (two distinct assertions).
- Dispose test unchanged must still pass (no new leaked timers/subs).

## Done criteria
- `bun run fix && bun check` → exit 0.
- `bun test` → 0 fail; pass ≥ 773 + new assertions.
- Grep review: all 16 `new AnimationHost(` sites now receive a `backpressure` field (or the escape-hatch
  divergence is documented for any that don't).
- No `policy.refresh()` remains in a per-frame `onFrame` unless the escape hatch was taken and noted.

## Maintenance note
This is the small, safe near-term win. If Plan 006 (one shared frame clock) is later pursued, the
backpressure wiring collapses to a single host — this plan's per-controller wiring becomes one line
there. Keep the wiring uniform now so 006 is a clean lift.
