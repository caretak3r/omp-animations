# Plan 003 — Kill per-frame allocation in the always-on hot paths

**Written against commit:** `31d90c8` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** speed/performance · **Effort:** M · **Risk:** LOW

## Why this matters

The kit's `rowsEqual` dirty-check (`src/kit/animated-widget.ts:150-164`) already suppresses the
*repaint* when a frame's output is unchanged — good, keep it. But the widgets still **compute and
allocate** the string they then discard, every tick, at 30 fps. The always-on widgets are the ones that
matter (they run continuously, not just on an event). Two concrete hot spots, verified by reading the
full render path:

### PERF-03 — `tool-constellation` (heaviest single allocator)
`src/tool-constellation/widget.ts:37-96` (`renderConstellationGrid`), called every frame via
`renderFrame` (`:141-144`), allocates per frame: a `Map` (`:43`), a `Set` (`:56`), **two linear
`snapshot.stars.find(...)` scans** (`:63-64`), 3 row arrays each holding a 10-element `parts` array
(`:79-92`), ~30 `theme.fg(...)` strings, and 3 `.join(" ")`. Upstream `ConstellationState.snapshot()`
(`src/tool-constellation/state.ts:55-57`) spreads `[...this.#stars.values()]` every frame too.
≈ 35+ allocations/frame × 30 fps ≈ **1000+/sec** for a fixed 3×10 grid whose output only changes on a
fire / decay-step / twinkle-phase tick.

### PERF-04 — `token-tide` + `cadence-equalizer` defensive copies
- `src/token-tide/state.ts:33` — `snapshot()` returns `[...this.#buffer]` (48 elems) every frame;
  `src/token-tide/widget.ts:30` copies again via `buffer.slice(...)` + a `parts` string array + join.
- `src/cadence-equalizer/bars.ts:52-54` — `stepBands` allocates two arrays via `.map()` every tick;
  `src/cadence-equalizer/state.ts:37-44` returns `[...this.#bands]` / `[...this.#peaks]` spreads each
  render.
These are defensive copies the pure renderers (typed `readonly number[]`) never mutate.

## The fix

**Keep render functions PURE of wall-clock** (phase/elapsed stays an input) — this plan changes
*allocation*, not determinism. All snapshot tests must still pass byte-for-byte unless a memo key is
wrong (which the tests will catch).

### PERF-03
1. **Frame-content memo** in the widget: cache the last-rendered rows plus the cheap scalar inputs that
   actually change the output — the fired/previously-fired star ids, the set of `lastFireAt` values, and
   a **quantized** decay/twinkle bucket (see caution). On each frame, if those inputs equal the cached
   key, return the cached rows without rebuilding. **Caution:** the twinkle animation has an ~1800 ms
   period — the memo key MUST include the twinkle-phase bucket (quantize elapsed to the twinkle step),
   or twinkles freeze. The snapshot tests will fail loudly if the key drops a real input; treat any
   snapshot drift as a wrong key, not a test to re-gold.
2. Replace the two `snapshot.stars.find(...)` linear scans (`:63-64`) with a keyed lookup — the state
   already holds stars in a `Map`; expose/reuse it instead of scanning.
3. Optional: have `ConstellationState.snapshot()` return the live `readonly` view instead of spreading.

### PERF-04
- `token-tide`: return the internal buffer as a `readonly number[]` view (drop the `[...]` spread);
  in the renderer, index the tail directly in the column loop instead of `slice()`.
- `cadence-equalizer`: step the bands **in place** (mutate the internal arrays) and return them as
  `readonly` views; drop the `.map()` and the `[...]` spreads.
- These renderers are already typed `readonly` and provably don't mutate — the spreads are pure
  defensiveness; removing them is safe and snapshot-guarded.

## Files in scope
`src/tool-constellation/{widget,state}.ts`; `src/token-tide/{widget,state}.ts`;
`src/cadence-equalizer/{bars,state}.ts`. Their test files for any needed additions.

## Files OUT of scope
`src/kit/*` (the dirty-check is correct); all other animations; the constellation *layout* hashing
(that is already cached and correct).

## NOT worth doing (do not touch)
`AnimationHost.#tick` snapshots listeners with `[...this.#listeners]` each frame
(`src/kit/animation-host.ts:135`) — one tiny array per host per frame, and it is load-bearing for
correct mid-emit unsubscribe. Leave it. `AnimatedWidget.render`'s width-keyed cache is correct and
cheap. Leave it.

## Test plan
- All existing `tool-constellation` / `token-tide` / `cadence-equalizer` snapshot tests must pass
  **unchanged** (byte-identical output is the correctness proof that the memo/readonly changes are pure).
- Add a memo-correctness test for tool-constellation: advance the clock across a twinkle period with no
  tool fires and assert the rendered rows still change (proves the twinkle bucket is in the memo key);
  and assert two identical-input frames return without recomputation is *not* directly observable, so
  instead assert output equality across a no-change frame (behavioral, not perf-timed — do NOT write
  timing assertions, they're flaky).

## Done criteria
- `bun run fix && bun check` → exit 0.
- `bun test` → 0 fail; all pre-existing animation snapshots unchanged; pass ≥ 773 + new tests.
- Review: the two `stars.find` scans are gone; token-tide/cadence no longer spread their buffers per
  render.

## Maintenance note
Memoization keyed on "what actually changes the frame" is the pattern to reuse for any future
always-on widget. Document the twinkle-bucket subtlety in a code comment so a later editor doesn't drop
it and silently freeze the twinkle.
