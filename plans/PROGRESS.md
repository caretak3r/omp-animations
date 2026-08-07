# Plan execution progress

Tracks status, gate results, and any decisions/escape-hatches per plan. See `plans/README.md`
for the priority order and dependency notes.

## Plan 001 — Registrar honors stored plugin settings (+ label + docs)

**Status: DONE**

- `src/registrar.ts`: added `readPluginSettingsSync(cwd, home?)`, a synchronous mirror of the
  stock `getPluginSettings(PLUGIN_NAME, cwd)` (global `omp-plugins.lock.json` via
  `getPluginsLockfile()` from `@oh-my-pi/pi-utils`, merged with the first existing
  `<dir>/plugin-overrides.json` across `.omp`/`.claude`/`.codex`/`.gemini`, project settings
  winning per key). `createAnimationsPlugin` now defaults `options.settings` to
  `readPluginSettingsSync(options.cwd, options.home)` instead of `{}`, so the production
  default export (`export default createAnimationsPlugin()`) resolves gating from the real
  stored settings. The `settings` injection seam is preserved for tests/hosts that already
  resolve settings themselves. Never throws — any missing/malformed config file degrades to
  `{}`, matching the plan's zero-crash requirement (a deliberate deviation from the async
  original, which rethrows on non-ENOENT errors reading the global lockfile).
- **Label fix (DX-01):** `api.setLabel("oh-my-pi animations")` moved to *after* the mount
  loop in `createAnimationsPlugin`, so it wins over Context Weather's inner
  `pi.setLabel("Context Weather")` (setLabel is last-write-wins on the shared extension).
  Verified via a new behavioral test (`registrar.test.ts`: "the registrar's own label wins
  over Context Weather's inner setLabel").
- **README:** rewrote the install/enable section — the settings UI/CLI path
  (`omp plugin config set/get/list @oh-my-pi/animations <key> <val>`) is now documented as
  the primary, working channel, with `OMP_*` env vars as the fallback; added the concrete
  local-install command `omp plugin install ./path/to/oh-my-pi-animations` (verified against
  `packages/coding-agent/src/cli/plugin-cli.ts` usage text in the read-only source monorepo).
  Updated the validation-status test counts (779 pass / 3511 assertions / registrar = 14).
- **DOCS-02 (version claim) — explicit escape hatch taken, partial:** the plan asserted that
  the installed `@oh-my-pi/pi-coding-agent@16.3.12` / `pi-tui@16.3.12` expose
  `ContextUsage.tokensUntilCompaction`/`compactionThresholdTokens` and
  `TUI.renderUnderPressure`, and asked to change the README's "stock @16 does not expose"
  wording to name the first minor that ships them. **Verified false against the actually
  installed packages**: `grep -rn "tokensUntilCompaction\|renderUnderPressure"
  node_modules/@oh-my-pi/pi-coding-agent node_modules/@oh-my-pi/pi-tui` (both `dist/types`
  and `src`) returns zero matches; `ContextUsage` in
  `node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts:165`
  has only `{ tokens, contextWindow, percent }`, no forecast fields; `TUI` in
  `node_modules/@oh-my-pi/pi-tui/dist/types/tui.d.ts` has no `renderUnderPressure` member
  (only `synchronizedOutput`). The existing README wording ("stock
  `@oh-my-pi/pi-coding-agent@16` / `pi-tui@16` do not expose [these]") is therefore already
  accurate for the pinned `^16` / installed `16.3.12` and was left unchanged rather than
  rewritten to a false claim. This is the one piece of Plan 001's doc pass not applied;
  everything else (settings-UI-primary rewrite, install command, label fix, sync reader,
  tests) is done.

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean, **779 pass / 0 fail /
3511 assertions / 26 files** (baseline was 773; +6 new tests in `test/registrar.test.ts`:
1 label-precedence test + 5 `readPluginSettingsSync` fixture tests).

**Files touched:** `src/registrar.ts`, `test/registrar.test.ts`, `README.md`,
`plans/README.md` (status table), `plans/PROGRESS.md` (this file).

## Plan 002 — Wire render-backpressure into every animated host

**Status: DONE**

- **Step 1 (the 12 no-backpressure controllers)** — `token-tide`, `tool-constellation`,
  `cadence-equalizer`, `prompt-charge`, `cost-candle`, `goal-horizon`, `context-constellation`,
  `memory-crystals`, `model-weather-vane`, `session-bonsai`, `todo-meteors`, `agent-fleet`. Each
  controller's `AnimationHost` is constructed *before* the widget factory hands back the real
  `tui` (unlike `context-weather`, where the host is built inside the factory), so
  `backpressureFromTui(tui)` could not be passed at host-construction time directly. Added a
  small per-file `deferredBackpressure()` adapter (a `BackpressureSignal` whose `underPressure`
  getter forwards to a `tui` captured later) so the host still gets a live `backpressure` field
  at construction, and the factory just calls `.attach(tui)` once the real `tui` is known. This
  keeps `src/kit/*` completely untouched (out of scope per the plan) while still routing through
  the existing `backpressureFromTui` primitive.
- **Step 2 (the 3 policy-refresh controllers — subsumes PERF-05)** — `breathing-border`,
  `diff-bloom`, `reflection-ripple` previously wired backpressure into the *policy* environment
  (`policy.setEnvironment({..., backpressure: backpressureFromTui(tui)})`, set once in the
  factory) and re-read it 30×/sec via `this.#policy.refresh()` in `onFrame`, which forced a full
  tier flip to `off` under pressure (collapsing to the static frame and unsubscribing). Moved all
  3 onto the same host-level `deferredBackpressure()` path as the 12 and **deleted the per-frame
  `policy.refresh()` call** from each widget's `onFrame`. This is a deliberate, plan-anticipated
  behavior change: backpressure now *freezes* the widget (host time-skips frame emission,
  subscription and tier stay untouched, phase resumes from the correct wall-clock position once
  pressure clears) instead of *collapsing to the off tier*. The plan's own Test Plan section
  names this exact outcome ("assert the widget still freezes under pressure"), and the kit's
  `AnimationHost` docstring already documents time-skip-not-collapse as the intended mechanism
  (`src/kit/animation-host.ts`), so this was implemented rather than escape-hatched. The one
  existing test per widget that asserted the old "tier flips off" contract
  (`test/breathing-border.test.ts`, `test/diff-bloom.test.ts`, `test/reflection-ripple.test.ts`,
  each titled "backpressure freezes the widget instantly: the tier flips off...") was rewritten
  to assert the new freeze contract (no tier change, no unsubscribe, `elapsedMs` frozen while
  under pressure, resumes and advances once pressure clears), plus a new sibling test asserting
  a live tier change via `policy.setSetting` still works independently through the unchanged
  policy-subscription path — the plan's "two distinct assertions" requirement.
- **Stale docstrings** on all 3 widgets' `onFrame`/class-doc comments (which described the old
  "re-resolves the policy every frame" mechanism) were rewritten to describe the new host-level
  freeze mechanism.
- **New tests:** one "wires host-level backpressure into the mounted widget" test per each of
  the 12 Step-1 controllers (asserts a `tui` with `renderUnderPressure = true` freezes
  `elapsedMs` — no new frame observed — while the widget stays subscribed, then resumes and
  advances once pressure clears), plus the 3 rewritten/added tests for the Step-2 controllers
  described above. 15 new tests total (12 + 3).
- **Verified:** `grep -n "new AnimationHost(" src/*/controller.ts src/*/extension.ts` shows all
  16 sites now pass a `backpressure` field; `grep -rn "policy.refresh()" src/*/widget.ts` returns
  no matches — both Done Criteria satisfied with no escape hatch needed for either step.

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean, **794 pass / 0 fail /
3583 assertions / 26 files** (baseline after Plan 001 was 779; +15 new tests).

**Files touched:** the 12 no-backpressure controllers' `controller.ts` (+ their test files); the
3 policy-refresh controllers' `controller.ts` and `widget.ts` (+ their test files);
`plans/README.md` (status table), `plans/PROGRESS.md` (this file). `src/kit/*` untouched, as
required by the plan's "files out of scope."

## Plan 003 — Kill per-frame allocation in the always-on hot paths

**Status: DONE (one sub-item partially deviated — documented below, evidence-backed)**

- **PERF-03 (`tool-constellation`), step 1 — frame-content memo:** `ToolConstellationWidget`
  (`src/tool-constellation/widget.ts`) now caches the last-rendered rows plus a cheap per-star
  "visual code" array (`starVisualCode`/`starVisualCodes`, new pure helpers): comet flag folded
  into a reserved code, else the discrete `starGlyphIndex` (0–3) the brightness ramp already
  quantizes to (new `sky.ts` export; `starGlyph` now delegates to it, unchanged output). Both
  `isTwinkling` and the decay curve are recomputed from the *real* `elapsedMs` every frame when
  building the codes — nothing about the memo key is itself time-bucketed — so the twinkle blip
  cannot freeze; only the expensive part (`Map`/`Set`/`theme.fg`/`join` inside
  `renderConstellationGrid`) is skipped when the codes plus `lastFired`/`previousFired` are
  unchanged from the previous frame. `renderConstellationGrid` itself (the exported pure
  function tests call directly) is untouched byte-for-byte except for step 2 below — the memo
  lives entirely in the widget, per the plan's own instruction.
- **PERF-03, step 2 — keyed lookup instead of the two `.find()` scans:** rather than exposing a
  second `Map` from `ConstellationState`, `renderConstellationGrid`'s existing single loop over
  `snapshot.stars` (already building the `starAt` cell map) now also tracks `prevStar`/`lastStar`
  inline as it iterates, so the previous two full-array `.find()` scans for the ley-line
  endpoints are gone with zero extra allocation (cheaper than the plan's literal suggestion of a
  second Map).
- **PERF-03, step 3 (optional, taken) — no more spread per frame:** `ConstellationState` now
  keeps a parallel `#starsList: StarRecord[]` appended to only on first-fire (mirrors `#stars`
  Map's insertion order exactly), and `snapshot()` returns that live array directly instead of
  `[...this.#stars.values()]`.
- **PERF-04 (`token-tide`):** `TokenTideState.snapshot()` returns the live `#buffer` (no `[...]`
  spread); `renderWaveformRow` indexes the tail directly in the column loop (`start..buffer.length`)
  instead of `buffer.slice(...)`.
- **PERF-04 (`cadence-equalizer`) — partial, evidence-backed deviation:** `CadenceEqualizerState
  .pushSample` now steps `#bands`/`#peaks` **in place**, one band at a time via the still-pure
  `stepBand`/`stepPeak` (no longer calling `stepBands`, which allocates two fresh arrays via
  `.map()` on every call — this runs once per animation frame, so it was the real hot-path
  allocation). **`snapshotBands()`/`snapshotPeaks()` still return `[...]` copies, unlike the
  plan's literal "drop the spreads" instruction**, because `test/cadence-equalizer.test.ts:192-198`
  ("snapshots are immutable copies — mutating one does not affect the next read") pins
  copy-on-read semantics for `snapshotBands()`: it mutates the returned array and asserts the
  *next* `snapshotBands()` call is unaffected, with no state-changing call in between — a
  guarantee a live view can never satisfy, by construction, regardless of buffering strategy.
  Breaking that pinned test to force the plan's literal wording through would violate the gate's
  "preserve baseline" requirement, which the run's own instructions (never re-gold a test to fit
  the implementation) rank above a plan step's literal phrasing. `stepBands` itself
  (`src/cadence-equalizer/bars.ts`) is untouched and remains exported/pure — it's simply no
  longer on the per-frame hot path, only exercised directly by its own tests. The *actual*
  every-frame churn this sub-item targeted (the two `.map()` calls inside `stepBands`, invoked
  from `pushSample` 30×/sec) is eliminated; only the once-per-render defensive copy remains, and
  it remains because a pre-existing test requires it.
- **New tests** (`test/tool-constellation.test.ts`, "tool constellation frame-content memo
  (PERF-03)"): (1) two direct `renderFrame` calls with no state/clock change return the exact
  same rows array (`toBe`, reference equality — proves a memo hit, not just coincidentally equal
  content); (2) advances the clock across a twinkle period with no new fires and asserts the
  rendered rows change during the blip and revert afterward (proves the twinkle bucket stays in
  the memo key rather than freezing it).

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean, **796 pass / 0 fail /
3586 assertions / 26 files** (baseline after Plan 002 was 794; +2 new tests).

**Files touched:** `src/tool-constellation/{widget,state,sky}.ts`,
`src/token-tide/{widget,state}.ts`, `src/cadence-equalizer/state.ts`,
`test/tool-constellation.test.ts`, `plans/README.md` (status table), `plans/PROGRESS.md` (this
file). `src/cadence-equalizer/bars.ts`, `src/kit/*`, and the constellation layout hashing were
not touched, as required by the plan's "files out of scope"/"not worth doing" sections.

## Plan 004 — Terminal-width glyph safety in grids & bars

**Status: DONE (partial: only the one genuinely wide glyph swapped — evidence-backed)**

- **Ground-truth check before touching any glyph:** the plan's own preferred verification
  method — `visibleWidth` from `@oh-my-pi/pi-tui` (used by `context-weather/renderer.ts`, the
  plan's cited reference implementation) — is `Bun.stringWidth(str, { ambiguousIsNarrow: true
  })` plus tab/OSC-66 corrections (`node_modules/@oh-my-pi/pi-tui/src/utils.ts:184-262`). Ran
  every glyph the plan names as a "confirmed offender" through it directly
  (`bun -e 'import {visibleWidth} from "@oh-my-pi/pi-tui"; ...'`): `☄` U+2604 → **1**, `☀`
  U+2600 → **1**, `⛏` U+26CF → **1**; only `⚡` U+26A1 → **2**. This matches real Unicode
  `EastAsianWidth.txt` data — `☄`/`☀`/`⛏` are `East_Asian_Width=A` (Ambiguous), which this
  codebase's `visibleWidth` deliberately renders narrow by design (`ambiguousIsNarrow: true`,
  "matching `unicode-width`'s non-CJK tables that back truncate/slice/wrap" — see the comment
  at `utils.ts:184-188`), while `⚡` is genuinely `East_Asian_Width=W` (Wide) with no override
  applying. So of AESTHETIC-01/02/03's named glyphs, only `⚡` actually violates the plan's own
  Done Criteria ("no ramp contains a glyph whose East_Asian_Width is W/A **without going
  through visibleWidth accounting**") — the `A`-class glyphs already pass that bar because the
  codebase's canonical width function is the accounting, and it already returns 1 for them.
  This is the same category of finding as Plan 001's DOCS-02 (verify the plan's specific claim
  against the real tool before acting on it) and Plan 003's cadence-equalizer partial (don't
  force a literal instruction the evidence contradicts).
- **AESTHETIC-02, fix applied — `src/prompt-charge/widget.ts`:** the bar-prefix glyph in
  `renderPromptChargeRow` (both `full` and `subtle` tiers) was `theme.fg(color, "⚡")` — a
  genuinely 2-cell glyph immediately before the fixed `BAR_CELLS`-wide bar. Swapped to a new
  `CHARGE_GLYPH = "↯"` (U+21AF, `visibleWidth` 1, the plan's own suggested alternative — still
  reads as a lightning/charge zigzag). `renderPromptChargeOffText`'s `⚡` usages (the
  motion-`off` fallback text, not a fixed bar, not the line the plan cited) were left untouched
  — out of the specific finding's scope.
- **AESTHETIC-03, fix applied — `src/tool-constellation/categories.ts`:** `CATEGORY_ICON.bash`
  was `"⚡"`, the one entry that actually broke the "narrow single-column glyph per category"
  comment (every other entry — `⛏ ✎ ◈ ◆ ⬡ ∘` — already measures `visibleWidth` 1). Swapped to
  `"↯"` (same rationale/glyph as the prompt-charge fix, for visual consistency across the two
  "bash" icons in the family) and rewrote the comment to name `visibleWidth` as the enforcement
  mechanism, per the plan's maintenance note. The comment is now literally true.
- **AESTHETIC-01, no glyph swap — evidence-backed partial:** `COMET_GLYPH = "☄"`
  (tool-constellation, context-constellation, todo-meteors) and `FLARE_GLYPHS`'s `"☀"`
  (goal-horizon) were **not** swapped, because they measure `visibleWidth` 1 — identical to
  every other glyph already in their respective ramps (`STAR_GLYPHS`, `EMBER`/`METEOR_GLYPHS`,
  bar fill/empty cells) — so leaving them in place introduces no actual column drift under the
  tool this codebase uses to define "safe." Swapping them anyway would be an unmotivated glyph
  identity change with no real defect behind it, which the run's own "no unrelated refactors"
  guidance weighs against.
- **Regression guard added regardless (per the Test Plan, independent of whether glyphs
  changed):** one width-invariant test per affected widget, all using `visibleWidth` from
  `@oh-my-pi/pi-tui` directly (matching the plan's own instruction to "follow the existing
  snapshot-test harness" and import `visibleWidth` in the test):
  - `test/tool-constellation.test.ts` — every row of a `renderConstellationGrid` "full" frame
    with an active comet has equal `visibleWidth`, and that width is exactly `GRID_COLS * 2 - 1`.
  - `test/context-constellation.test.ts` — same invariant for a mid-sweep (comet-front) frame
    and a fresh-grow (flare) frame.
  - `test/goal-horizon.test.ts` — `renderHorizonBar`'s `visibleWidth` stays exactly
    `HORIZON_BAR_WIDTH` both at a full-intensity (`☀`) milestone flare and once it's decayed.
  - `test/prompt-charge.test.ts` — the subtle-tier glyph+bar line's `visibleWidth` is constant
    (`1 + 1 + BAR_CELLS`) across empty/mid/full charge levels — this one *is* a real regression
    guard for the `↯` fix, since `⚡` would have made it `2 + 1 + BAR_CELLS`.
  - `test/todo-meteors.test.ts` — the meteor lane's `visibleWidth` equals its plain codepoint
    count at progress 0 (comet-head glyph occupying a lane slot), proving the glyph doesn't
    inflate the fixed-size lane.
  These are the enforcement the plan's maintenance note asks for: a future genuinely-wide-glyph
  regression (in any of these ramps) now fails a test instead of silently misaligning a grid.
- No changes to color/theme handling anywhere (per the plan's explicit "do not change colors,
  only glyph identity/width handling").

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean, **801 pass / 0 fail /
3600 assertions / 26 files** (baseline after Plan 003 was 796; +5 new width-invariant tests).

**Files touched:** `src/prompt-charge/widget.ts`, `src/tool-constellation/categories.ts`,
`test/{tool-constellation,context-constellation,goal-horizon,prompt-charge,todo-meteors}.test.ts`,
`plans/README.md` (status table), `plans/PROGRESS.md` (this file). `src/context-constellation/`,
`src/todo-meteors/ember.ts`, `src/goal-horizon/horizon.ts`, `src/kit/*`, and color/theme code
were not touched — no source change was needed in those files once the evidence showed their
existing glyphs are already `visibleWidth`-safe.

## Plan 005 — Motion-tier ladder + off-badge polish

**Status: DONE**

- **AESTHETIC-04 (`prompt-charge`) — subtle is now a real reduction:** `renderPromptChargeRow`'s
  `subtle` branch no longer calls `displayedFraction` (which mixes the live typed charge with a
  decaying release-burst driven by `now`). It now renders a static bar from
  `chargeFraction(snapshot.typedChars)` alone — no per-frame decay animation — while `full`
  keeps the existing live/burst-max animation unchanged. Extracted a small `renderChargeBar`
  helper shared by both branches to avoid duplicating the bar-building logic.
- **AESTHETIC-04 (`model-weather-vane`) — subtle drops spin interpolation:** added
  `settledEmblem(snapshot)`, which always returns the settled target direction/color with no
  `elapsedMs`-driven sweep. `renderModelWeatherVaneRow` now picks `settledEmblem` for `subtle`
  and the existing `currentEmblem` (which spins) for `full`. A model switch still updates
  `subtle`'s badge instantly (state-driven), it just never animates the sweep.
  `currentEmblem`/`full` are byte-for-byte unchanged.
- **AESTHETIC-05 — one shared width-1 off-badge convention:** picked `↯` (U+21AF, already
  established by Plan 004 as `CHARGE_GLYPH` in `prompt-charge/widget.ts`, `visibleWidth` 1,
  genuinely `East_Asian_Width=N` so it carries none of `◆`'s Ambiguous-width fragility) as the
  one shared badge and applied it to all four in-scope off-tier renderers: `prompt-charge`
  (`⚡` → `↯`, reusing the existing `CHARGE_GLYPH` const), `model-weather-vane` (`🧭` → `↯`, new
  local `OFF_BADGE` const), `goal-horizon` (`🌅` → `↯`, new local `OFF_BADGE` const), and
  `memory-crystals` (`◆` → `↯`, new local `OFF_BADGE` const). Updated the two controller
  docstrings (`goal-horizon/controller.ts`, `model-weather-vane/controller.ts`) that quoted the
  old off-text format literally. Left `context-constellation`'s `✦` and `cadence-equalizer`'s
  no-badge `"eq ..."` form untouched — both already outside the plan's core in-scope file list
  and neither is width-unsafe (✦ already measures `visibleWidth` 1; cadence-equalizer already
  leads with a label, not a badge, which is the plan's other explicitly sanctioned convention).
  Did not touch `memory-crystals/crystal.ts`'s `GEM_GLYPHS` `◆` (an unrelated magnitude-tier
  glyph in the animated tray, not an off-badge) or `context-weather/renderer.ts`'s `◆` marker
  (a different, out-of-scope feature) or `tool-constellation/categories.ts`'s `agent: "◆"`
  (category icon, not an off-badge).
- **New tests:**
  - `test/prompt-charge.test.ts` — "subtle tier is invariant across now/elapsedMs for a fixed
    snapshot, while full tier varies" (an in-flight release burst is held static across
    `now` in `subtle` but visibly decays in `full`); "renderPromptChargeOffText's badge is
    width-1".
  - `test/model-weather-vane.test.ts` — the same elapsedMs-invariance-vs-variance pair for a
    mid-spin snapshot; "renderModelWeatherVaneOffText's badge is width-1".
  - `test/goal-horizon.test.ts` — "off-tier badge is width-1".
  - `test/memory-crystals.test.ts` — "off-tier badge is width-1".
  6 new tests total. All pre-existing off-text assertions in these four test files were updated
  in place to the new `↯` badge (a straight find/replace on the literal badge character in each
  expected string — no test logic changed). One unrelated fixture in
  `test/model-weather-vane.test.ts` (`"🧭-model-emoji"`, an adversarial model-id string testing
  `modelDirectionIndex`'s unicode handling, not an off-badge) was caught by an overly broad
  first-pass replace and restored to its original emoji.

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean, **807 pass / 0 fail /
3610 assertions / 26 files** (baseline after Plan 004 was 801; +6 new tests).

**Files touched:** `src/prompt-charge/widget.ts`, `src/model-weather-vane/{widget,controller}.ts`,
`src/goal-horizon/{widget,controller}.ts`, `src/memory-crystals/widget.ts`,
`test/{prompt-charge,model-weather-vane,goal-horizon,memory-crystals}.test.ts`,
`plans/README.md` (status table), `plans/PROGRESS.md` (this file). `src/kit/*`,
`src/context-constellation/*`, `src/cadence-equalizer/*`, and color/theme code were not touched,
as required by the plan's "files out of scope."

## Plan 006 — SPIKE: one shared frame clock for the family

**Status: STOPPED-escape-hatch (no-go per the plan's own step-1 measurement gate)**

Plan 006 requires measuring the paint-batching payoff of consolidating 16 per-controller
`AnimationHost` timers into one shared, family-level host *before* committing to the L-sized,
16-controller refactor, and explicitly permits stopping at "correct the stale docstring +
record the decision" if the measured win is negligible. It is.

- **Claim under test:** the plan's premise is that up to 16 independent 30fps `setInterval`
  timers, each firing its own `requestComponentRender`, cost meaningfully more than one shared
  timer + one batched render, because the core TUI might paint once per caller.
- **Finding 1 — the core TUI already coalesces same-tick render requests.**
  `packages/tui/src/tui.ts#requestOrdinaryRender` (called by both `requestRender(false)` and
  `requestComponentRender`) guards on a single `#renderRequested` boolean: the first caller in a
  given JS macrotask sets it and schedules exactly one `scheduleImmediate` (`setImmediate` in the
  default `DEFAULT_RENDER_SCHEDULER`, `tui.ts:112-125`); every other caller before that
  `setImmediate` fires just returns (`tui.ts:1852-1877`, "Coalesce non-forced renders..."). So N
  render requests arriving in the same macrotask always produce exactly one paint, regardless of
  caller count — this is unconditional, not something a shared clock would add.
- **Finding 2 — the family's timers land in the same macrotask on effectively every tick.**
  Two structural facts combine to make that coalescing window hit in practice, not just in
  theory: (a) `MotionPolicy`'s tier (and therefore `TIER_CADENCE_MS`, `src/kit/motion-policy.ts:52-59`)
  is one value the whole family shares — every mounted controller's host runs the identical
  cadence (33.33ms at `full`, 83.33ms at `subtle`); (b) `createAnimationsPlugin`
  (`src/registrar.ts:284-287`) mounts every enabled controller synchronously in one `for` loop at
  plugin load, so all `new AnimationHost(...)` → `setInterval(tick, cadence)` calls fire back to
  back within microseconds of each other. Same interval + near-identical start time means the
  timers' due-times stay aligned tick over tick (no relative drift to accumulate), so Node/Bun's
  event-loop timer phase processes them in the same synchronous batch on essentially every frame,
  *before* yielding to the `setImmediate` (check) phase where the render actually executes.
  Verified directly (not just reasoned about) with a minimal repro
  (`bun -e`, two independent `setInterval(fn, 33)` timers started back-to-back driving the exact
  `#renderRequested`-guard-then-`setImmediate` pattern `requestOrdinaryRender` uses): every tick
  produced exactly one `"RENDER"` regardless of both timers firing, with the second timer's call
  observed as `"...:coalesced"` — reproducing the real coalescing path end-to-end outside the TUI
  package.
- **Conclusion:** the scenario Plan 006 worries about (16 independent timers → 16 separate
  paints) does not occur at the current suite size; it's already prevented by (1) the shared
  motion tier giving every host the same cadence and (2) the registrar's synchronous mount loop
  starting them together, combined with the core TUI's pre-existing request-coalescing guard.
  What a shared host would additionally save is N-1 idle `setInterval` timer-phase wake-ups per
  tick (genuinely cheap — an empty due-timer check) and per-widget elapsed-clock drift (a
  correctness/consistency nicety, not the measured perf claim the plan opened with). That's a
  materially smaller win than the plan's premise, and does not justify an L-effort, MED-risk
  refactor touching all 16 controllers + their tests + lifecycle ownership, per the plan's own
  escape hatch: *"If measurement (step 1) shows the paint-batching win is negligible, STOP — do
  only the cheap part."*
- **Cheap part done:** corrected the stale docstring at `src/kit/animation-host.ts:37-52` — it
  previously claimed "One shared frame clock for the whole animated-plugin family" (true only
  within a single `AnimationHost` instance, not across the family's 16 instances); it now
  describes the real per-controller-instance ownership and records why the family-wide version
  was spiked and rejected, pointing at this section for the evidence.
- **Not implemented (per the no-go path):** no shared/injected host mode, no registrar-level host
  ownership change, no controller/test changes, no single-timer test — none of Plan 006's "if
  implemented" scope applies once step 1 resolves no-go.

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean, **807 pass / 0 fail / 3610
assertions / 26 files** (unchanged from the Plan 005 baseline — a docstring-only change adds no
tests and removes none).

**Files touched:** `src/kit/animation-host.ts` (docstring only), `plans/README.md` (status
table), `plans/PROGRESS.md` (this file). No controller, widget, state, or test files touched —
correct for a no-go spike per the plan's own "files in scope (if the spike goes to
implementation)" gate, which never opens.

## Plan 007 — Cut the 6 status-bar duplicators + native default

**Status: DONE (one deliberate, maintainer-directed deviation from the plan's literal step 4 —
evidence-backed below)**

- **Two `007`-prefixed plan files exist; verified which governs.** `plans/007-cut-status-bar-
  duplicators.md` (cut 6 animations, unregister-only, `subtle` tier default for the remaining 10
  at `default: true`) and `plans/007-native-default-posture.md` (no cut at all — keep all 16
  registered, but default-disable everything except a hand-picked on-by-default trio:
  `contextWeather`, `tokenTide`, `costCandle`). These are two different strategies for the same
  problem, not two parts of one plan — read side by side, they directly conflict (one cuts
  `contextWeather`/`tokenTide`/`costCandle` from the registrar entirely; the other wants exactly
  those three on by default). The maintainer's 2026-07-13 decision (fixed retain-10/cut-6 list,
  in the task brief) matches `007-cut-status-bar-duplicators.md`'s recommendation exactly and is
  incompatible with `007-native-default-posture.md`'s on-by-default trio (all three of its
  recommended defaults — `contextWeather`, `tokenTide`, `costCandle` — are in the maintainer's cut
  set). **Executed `007-cut-status-bar-duplicators.md`; treated `007-native-default-posture.md` as
  superseded/rejected by the later maintainer decision.** The one piece of common ground between
  both files — "ship the manifest tier default as `subtle`, not `full`" — is already folded into
  `007-cut-status-bar-duplicators.md`'s own step 7, so nothing from the superseded file was lost.
- **Maintainer's fixed lists applied exactly:** retained (10, all `default: true`, registrar-
  mounted) — `toolConstellation`, `sessionBonsai`, `todoMeteors`, `diffBloom`, `reflectionRipple`,
  `memoryCrystals`, `breathingBorder`, `promptCharge`, `goalHorizon`, `agentFleet` (the plan's own
  prose flagged `goalHorizon`/`agentFleet` "borderline" — the maintainer's decision explicitly
  retains both, so they were kept, not cut, per instruction). Cut (6, unregistered): `tokenTide`,
  `cadenceEqualizer`, `costCandle`, `contextConstellation`, `modelWeatherVane`, `contextWeather`.
- **Deliberate deviation from the plan's step 4 ("`rm -rf` the 5 module dirs + their tests"),
  directed by the maintainer's own instruction ("unregister ... keep the source code in place, do
  NOT delete files"), which controls over the plan's default and is explicitly anticipated by the
  plan's own escape hatch ("if you'd rather not delete, move them to a `parked/` dir and
  unregister instead — but do not leave them registered").** Applied the stricter form: no
  deletion AND no relocation — `src/{token-tide,cadence-equalizer,cost-candle,
  context-constellation,model-weather-vane,context-weather}/` and their
  `test/{token-tide,cadence-equalizer,cost-candle,context-constellation,
  model-weather-vane}.test.ts` + `test/context-weather/**` stay exactly where they were. Verified
  via `grep -rn "token-tide\|cadence-equalizer\|cost-candle\|context-constellation\|
  model-weather-vane" src/ test/` — the only remaining hits are the new documentary comments in
  `src/registrar.ts`/`src/index.ts` explaining the cut (no active imports/mounts). Consequence:
  the plan's Done Criteria line "`grep ... returns nothing` (fully removed)" does NOT hold, by
  design — the maintainer's instruction supersedes that specific criterion; "unregistered" (not
  "deleted") is the actual done state now.
- **`src/registrar.ts`:** removed the 6 imports and the 6 `AnimationEntry` entries from
  `ANIMATIONS` (now 10). Updated the stale doc comments (top-of-file docstring no longer claims
  Context Weather subscribes via this registrar; `ANIMATIONS`'s own doc comment now says "10
  retained"; the `setLabel`-ordering comment now explains the historical Context-Weather rationale
  without claiming it still applies). Per the plan's step 7 ("leave `src/registrar.ts` code
  fallbacks unchanged"), `DEFAULT_TIER` stays `"full"` — added a one-line comment distinguishing
  the manifest's curated `subtle` default from this programmatic-use code fallback (the note the
  plan asked for, in `registrar.ts` since `package.json` is plain JSON and cannot hold a comment —
  the equivalent note was instead written into the `animations` setting's own `description`
  string, which is machine-visible in a way a JSON comment couldn't be anyway).
- **`src/index.ts`:** removed the 6 barrel re-exports; header comment now documents that the cut
  factories are importable directly from their module path (they're simply no longer flattened
  into the package's default surface).
- **`package.json#omp.settings`:** deleted the 6 boolean keys plus Context Weather's 4 sub-settings
  (`contextWeatherStyle`/`…Placement`/`…StormAtPercent`/`…NotifyOnImminent`); `animations.default`
  `"full"` → `"subtle"`, with the row-stacking caveat folded into the setting's own `description`.
- **`README.md`:** rewrote the animation-count section (18 → 10 registrar-mounted + explicit "Not
  included" design-law section naming which omp status-line segment each cut animation
  duplicated), the settings table (16 booleans → 10, default `full` → `subtle`), the Layout
  section's barrel comment, and the Validation status section (stale 779 baseline → the actual new
  809 baseline, replacing the already-stale per-category arithmetic from Plan 001 that had never
  been updated through Plans 002-006 either).
- **Tests — `test/registrar.test.ts`:** updated every reference to a cut id (`contextWeather`,
  `tokenTide`) to a retained id (`sessionBonsai`, `memoryCrystals`) so existing assertions stay
  meaningful; rewrote "the registrar's own label wins over Context Weather's inner setLabel" (no
  longer exercisable — Context Weather isn't mounted here anymore) into "the registrar's own label
  is always the last one set, regardless of the enabled subset" — same ordering contract, no longer
  tied to a mount that can't happen; added two new tests per the plan's test plan: (1) "the 6 cut
  ids are not in the registrar's mounted set and register no listeners" (asserts `ALL_IDS`
  excludes all 6, has length 10, and that a stored settings record with the cut ids force-set
  `true` mounts nothing — a stale/adversarial stored-settings file can't resurrect them), (2) a new
  `describe("package.json#omp.settings — Plan 007's native default")` block that reads the real
  shipped `package.json` via `Bun.file(...).json()` (behavioral — asserts the shipped manifest, not
  source-grepped logic) and asserts `animations.default === "subtle"`, exactly the 10 retained ids
  default `true`, and the 6 cut ids are absent from the settings object entirely.
- **Tests — `test/wave2-gallery.test.ts`:** removed the 5 cut Wave-2 controllers' mount blocks,
  imports, and now-dead per-block fixture helpers (`assistantMessage`, `messageStartEvent`,
  `messageUpdateEvent`, `messageEndEvent`, `usageReading` — each was only called from a removed
  block); recomputed `EXPECTED_PLACEMENT` for the 10 retained controllers (6 `aboveEditor` / 4
  `belowEditor`, down from 8/7 over 15 — the 5 cut ids were 2 above/3 below); updated all 3 tests'
  hardcoded counts (15→10 controllers, 8/7→6/4 placement split) and titles accordingly.
- **Test-count deviation from the plan's own expectation, evidence-backed:** the plan's Test Plan
  section assumed deletion and said "the total DROPS ... do NOT assert the old 807 floor ...
  record the NEW pass count." Because the maintainer's "do not delete" instruction means none of
  the 6 cut animations' ~181+ per-feature tests were removed, the count did not drop — it *rose* to
  **809** (807 + 2 new registrar tests), since removing registrar/manifest/barrel wiring alone
  doesn't touch the cut modules' own test files, which exercise their pure render/state/widget
  functions directly, never through the registrar. The new floor for all subsequent plans is
  **809 pass / 0 fail**.

**Gate:** `bun run fix && bun check && bun test` — biome+tsgo clean (131 files), **809 pass / 0
fail / 3600 assertions / 26 files** (baseline after Plan 006 was 807; +2 net — the 5 cut Wave-2
per-feature test files and Context Weather's suite are unchanged and still counted, `registrar`
gained 2 tests, `wave2-gallery` lost none — its 3 tests were rescoped in place, not removed).

**Files touched:** `src/registrar.ts`, `src/index.ts`, `package.json`, `README.md`,
`test/registrar.test.ts`, `test/wave2-gallery.test.ts`, `plans/README.md` (status table),
`plans/PROGRESS.md` (this file). `src/context-weather/**`, `test/context-weather*`,
`src/{token-tide,cadence-equalizer,cost-candle,context-constellation,model-weather-vane}/**`, and
`test/{token-tide,cadence-equalizer,cost-candle,context-constellation,
model-weather-vane}.test.ts` were NOT touched (kept in place, unregistered only, per the
maintainer's directive); the 8 non-borderline retained animations' + `goalHorizon`'s +
`agentFleet`'s own render/controller code was not touched (only registrar/manifest/barrel wiring
changed); `src/kit/**` untouched.

## Plan 017 — Animations Box: dxi.2 port scaffolding + cache-meter segment

**Status: DONE** (scoped to `oh-my-pi-dxi.2` — cache-meter segment only; the remaining six
keepers, breathing-border chrome, composition/width goldens, and registrar/manifest wiring are
`dxi.3`–`dxi.7`, out of scope here)

- **`src/kit/segment.ts` (new):** ported 1:1 from `/tmp/anim-livebox/src/kit/segment.ts` —
  `Segment`, `segment()` (derives `minWidth` from the narrowest/last variant), `SEGMENT_SEPARATOR`
  (`" · "`), `composeSegments(segments, budget): ComposedRow` (drop lowest-priority from the tail
  until the narrowest variants fit, then upgrade widest-affordable in ascending priority order).
  Byte-identical to the source; re-exported from `src/kit/index.ts`.
- **`src/animations-box/settings.ts` (new, reworked per spec Decision 3, not a straight port):**
  `BOX_SEGMENT_IDS` (the 7 keepers, priority order: cacheMeter, cadenceEqualizer, auditTrailBox,
  rateLimitTidepool, toolConstellation, palimpsest, reflectionRipple); `BOX_MIGRATED_ANIMATION_IDS`
  derived as `[...BOX_SEGMENT_IDS, "breathingBorder"]` (not a second hand-written 8-id list, to
  keep the two arrays impossible to drift apart). Config shape: `display` (`rows|box|both`,
  default `box`, env `OMP_ANIMATIONS_DISPLAY`), `animationsBoxDetail` (`simple|detailed`, default
  `detailed`, no `off` value), `animationsBoxPlacement` (`aboveEditor|belowEditor`, default
  `belowEditor`). `animationsBoxOnly` and the old `off` detail value are gone entirely — no dead
  states. `PLUGIN_NAME` duplicated locally (matches `registrar.ts`'s own constant) rather than
  imported, so `registrar.ts` never has to import this module back once `dxi.7` wires it in.
  `resolveAnimationsBoxConfigFromSources(pluginSettings, env)` keeps stored > env > default
  precedence for all three enum keys.
- **Deviation, evidence-backed — `AnimationsBoxConfig` gained a 4th field, `enabled`, not in
  Phase-1's shape.** The task brief says `segmentActive(config, id)` should read "the existing
  per-animation boolean keys" (e.g. `cacheMeter: true`, the same key that gates the standalone
  row) rather than Phase-1's dropped `only` subset list. That requires the resolved config to
  carry a per-segment enabled map somewhere, since `segmentActive`'s signature stays
  `(config, id) => boolean`. Added `enabled: Readonly<Record<BoxSegmentId, boolean>>`, resolved in
  `resolveAnimationsBoxConfigFromSources` using the exact same key/env pair (`raw[id]` /
  `animationsEnvKey(id)`, imported from `../appearance.ts`, not re-derived) the registrar's own
  `resolveAnimationsConfig` already uses for that animation's standalone-row boolean — one enable
  decision, two consumers. `segmentActive(config, id)` is then a one-line `config.enabled[id]`
  read. Verified: `test/animations-box-settings.test.ts` — "resolves each segment's enable boolean
  through the SAME key/env pair its standalone row already uses" and "a stored false beats an env
  true for the same segment."
- **`src/animations-box/segments.ts` (new, cache-meter only):** kept `INACTIVE`, `dedupe()`,
  `buildCacheMeterSegment` + a local `formatCost` copy (cache-meter's own `formatCost` is not
  exported from its barrel — verified via `grep -n "formatCost" src/cache-meter/*.ts`). Deleted
  the other five Phase-1 builders (context/driftBuoy/fourHands/promptCharge/sessionStrata) along
  with their imports entirely — `grep -rn "drift-buoy\|four-hands\|prompt-charge\|session-strata\|
  context-weather" src/animations-box/` returns zero matches. Active gate:
  `snapshot().promptTokens > 0`; variants via `renderCacheMeterRow` at budgets 999/40/18/3,
  deduped; `priority` derived as `BOX_SEGMENT_IDS.indexOf("cacheMeter") + 1` rather than a literal
  `1`, so it can't drift from the settings module's own ordering.
- **Deviation, evidence-backed — `SegmentSample.detail` is now always a `SegmentDetail` (dropped
  the `| undefined` Phase-1 had for the inactive case), and `INACTIVE` no longer includes a
  `detail: undefined` field.** Required by Decision 5's own text, not invented: "enabled-but-idle
  segments get a dim resting row (`glyph · label · —`), not absence." A widget that must draw a
  resting row for an inactive segment needs real column text to draw, so `buildCacheMeterSegment`'s
  idle branch now returns `detail: { glyph: theme.fg("dim", BADGE_GLYPH), label: "cache",
  primary: "—", secondary: "", trailing: "" }` instead of `detail: undefined`. This keeps all
  segment-specific knowledge (glyph, label, resting text) inside `segments.ts`, leaving
  `widget.ts` a pure renderer with zero segment-specific logic of its own — the same separation
  Phase-1's widget already had, just extended to cover the resting case too.
- **`src/animations-box/widget.ts` (new, chrome ported + ADAPTED per Decision 5):** `BORDER_COLS`
  = 4, `BORDER_ROWS` = 2, `cell()` (pad/truncate via `truncateToWidth`/`visibleWidth`),
  `borderTop`/`borderBottom` (`╭─╮`/`╰─╯`), `detailRowText` (glyph 6 · label 8 · primary 8 ·
  secondary 12 · 4 gutters · trailing = `inner − 38`) all ported unchanged. The adaptation:
  `renderFrame` no longer filters samples to `active` before the detailed-mode branch (Phase-1
  did: `buildSamples(now).filter(s => s.active)`) — every ENABLED sample gets one row in detailed
  mode regardless of activity, and simple mode still composes only the `active` ones into its one
  strip. Height is therefore `samples.length` (detailed) or a fixed 3 (simple), never a function
  of runtime activity. Golden frame at width 69 (inner 65, trailing 27) for a single resting
  cache-meter segment is pinned exactly in `test/animations-box-widget.test.ts`.
- **`src/animations-box/controller.ts` (new, skeleton, cache-meter only):** widget key
  `oh-my-pi-animations-box` (not Phase-1's `animations-live-box`, not cache-meter's own
  `cache-meter` — namespaced per the key-collision memory the task brief named). Constructs a
  FRESH `CacheMeterState` (never `CacheMeterController`'s instance or the controller itself — see
  the module's own doc comment for why, ported from Phase-1's rationale). One `FrameScheduler`
  (`this.#scheduler`) stamps both `recordUsage`/`recordEvent` timestamps and is the same clock
  object handed to the widget as `clock`, satisfying Decision 4 (one epoch wall clock for both
  state stamps and renders — never the host's mount-relative `elapsedMs`). Wired: `onMessageEnd`,
  `onSessionCompact`, `onAutoCompactionStart`, `onSessionSwitch` (resets `#cacheMeterState` to a
  fresh instance without tearing down the mount — mirrors `CacheMeterController`'s
  `session_switch → dispose()` per the brief), `mount()`/`dispose()`.
- **Scope call, not a deviation from anything explicitly requested — omitted Phase-1's
  `onTurnEnd`/`#refreshConfig` live-settings-reread loop.** The task's itemized controller.ts scope
  (construct fresh state, subscribe to its events, one clock) never mentions live config refresh;
  it's orthogonal to "cache-meter segment wired" (Phase-1 combined it with Four Hands/Session
  Strata's own turn_end-triggered state changes, both cut here). `initialConfig` is a required
  constructor option and stays fixed for the controller's lifetime in this bead — reasonable since
  nothing calls `mount()` from the registrar yet (`dxi.7`). Flagged here rather than silently
  dropped in case `dxi.7`'s registrar wiring expects to find it.
- **Also omitted (same reasoning):** `getEditorText`/`getContextUsage`/`cwd` on
  `AnimationsBoxContext` (only needed by the five cut segments' controllers) and the
  `readPluginSettings` constructor option (only needed by the omitted refresh loop).
- **Tests (all new):** `test/kit/segment.test.ts` (10 — `segment()`'s minWidth derivation,
  `composeSegments`'s drop/upgrade logic at literal widths including a golden 3-segment
  composition at budget 65, i.e. width 69 minus the box's 4 border columns);
  `test/animations-box-settings.test.ts` (17 — id-list correctness derived from
  `ANIMATIONS`/never a hardcoded 7 or 8, resolver defaults/precedence, the dropped
  `animationsBoxOnly`/`off` states, `segmentActive`); `test/animations-box-segments.test.ts` (12 —
  resting vs. active row content, dedupe, saved-cost vs. hit/req fallback, priority derivation);
  `test/animations-box-widget.test.ts` (13 — border/zero-width guards, detailed-mode height =
  enabled count not active count, the width-69 golden resting-row frame, simple-mode fixed 3 rows,
  truncation safety net, lifecycle/onTick); `test/animations-box-controller.test.ts` (12 — mount
  idempotency/placement, dispose teardown, end-to-end state wiring verified by building the real
  widget from the captured `setWidget` factory and reading `renderFrame()`, the enabled-gate
  hiding a disabled segment entirely). Total 64 new tests, all pinned against exact hand-computed
  values (no snapshot tests).
- **Verified zero imports of any cut animation:** `grep -rln "drift-buoy\|four-hands\|
  prompt-charge\|session-strata\|context-weather" src/animations-box/` returns nothing; the box
  does not mount from anywhere yet — `grep -rn "AnimationsBoxController\|animations-box"
  src/registrar.ts src/index.ts package.json` returns nothing (confirms `dxi.7` is untouched).

**Gate:** `bun test && bun run check:types && biome check .` — **758 pass / 0 fail / 2497
assertions / 23 files** (baseline immediately before this bead's tests, on the same tree with the
5 new source files already present but unimported by any test, was 694 pass / 18 files; +64 new
tests across the 5 new test files matches exactly). tsgo and biome both clean.

**Files touched:** `src/kit/segment.ts` (new), `src/kit/index.ts` (+1 export line),
`src/animations-box/settings.ts` (new), `src/animations-box/segments.ts` (new),
`src/animations-box/widget.ts` (new), `src/animations-box/controller.ts` (new),
`test/kit/segment.test.ts` (new), `test/animations-box-settings.test.ts` (new),
`test/animations-box-segments.test.ts` (new), `test/animations-box-widget.test.ts` (new),
`test/animations-box-controller.test.ts` (new), `plans/PROGRESS.md` (this entry). No existing
file besides `src/kit/index.ts` was modified; nothing in `src/registrar.ts`, `package.json`, or
any of the 8 keeper animations' own directories was touched.
