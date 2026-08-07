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

## Plan 017 — Animations Box: dxi.3 segments A (audit trail, tool constellation, palimpsest)

**Status: DONE**

- **`src/animations-box/segments.ts` — three new builders, same template as `buildCacheMeterSegment`:**
  - `buildAuditTrailBoxSegment(state: AuditLedgerState, now, theme, colors?)` — active once
    `state.size > 0` (mirrors `AuditTrailBoxController`'s own lazy-mount-from-first-touch policy).
    Variants: `renderAuditMeterRow` at the exact 999/40/18 budgets from Decision 1's table, deduped.
    Detail: glyph = badge (poisoned color when `snapshot.counts.poisoned > 0`, else the badge
    accent) — never pulsed, the same accepted per-widget-cosmetic gap `buildCacheMeterSegment`
    already takes for the hit-rate ease; primary = status counts (`STATUS_RISK_ORDER`/`STATUS_GLYPHS`,
    both exported from the keeper); secondary = basename of the most-recently-touched path (own
    scan over `snapshot.paths`, since that list is risk-sorted, not recency-sorted); trailing =
    `r/w <reads>/<writes> · ×<write amplification>`.
  - `buildToolConstellationSegment(state: ConstellationState, now, theme)` — **no `colors` param**:
    the keeper's own extension exposes no `accentColor` option either (seven-way
    `CATEGORY_THEME_COLOR` rainbow, no single accent slot — Decision 1 says keep it, don't invent
    one). Active once a star exists. Its grid renderer is 3 rows tall (Decision 1's first stated
    exception), so both simple-mode variants reuse the exported `renderConstellationTally`: the
    widest variant over every fired category, the narrow one filtered to the dominant category
    alone (ties broken by `CATEGORY_ORDER`'s own canonical order, not insertion order). Detail:
    primary = total fire count, secondary = dominant category name, trailing = a plain (uncolored)
    icon+count tally in `CATEGORY_ORDER`.
  - `buildPalimpsestSegment(state: PalimpsestState, now, theme, colors?)` — Decision 1's second
    stated exception: `renderPalimpsestRows` is multi-row and width-blind, so this segment derives
    its own one-line summary directly from `snapshot().rows` instead of calling it — the single
    hottest row at or above `GLOW_THRESHOLD`, sorted by the exact same recency/overlap/path
    comparator `renderPalimpsestRows` uses internally (reproduced locally as
    `compareVisibleRows`, since that comparator isn't exported), narrowing `path ×N` → `basename
    ×N` → `×N` per Decision 1's literal ladder. Active once one row clears the threshold (same gate
    `PalimpsestController` mounts on). Palimpsest exports no badge glyph of its own — added a local
    `PALIMPSEST_GLYPH = "▓"`, matching Decision 5's own detailed-mode mock row (`▓ files —`)
    verbatim, so the resting row is pinned exactly against the spec.
- **`src/animations-box/controller.ts`:**
  - Three fresh state instances (`AuditLedgerState`, `ConstellationState`, `PalimpsestState`), never
    the standalone controllers.
  - `onToolResult` fans one `tool_result` event out to both Audit Trail (via the keeper's own
    exported `auditTouchesFromToolResult(event, ctx.cwd)`, so `AnimationsBoxContext` gained a
    required `cwd: string` field — the one adapter surface Audit Trail's ledger needs that no
    existing box event carried) and Palimpsest (a local `applyPalimpsestTouch`/`isEditToolResult`/
    `PalimpsestFileTouch`, byte-identical reproductions of `../palimpsest/controller.ts`'s own
    private, unexported helpers of the same names — same precedent `toCacheRequestSample` already
    set for Cache Meter in `dxi.2`).
  - `onToolCall` feeds Tool Constellation's `recordFire`.
  - `onTurnEnd` (new) advances both Audit Trail's cold-eviction sweep (`noteTurn()`) and
    Palimpsest's fade clock (`advanceTurn(event.turnIndex)`) from the one `turn_end` event.
  - `onSessionCompact` (extended) and the new `onAutoCompactionEnd` both call Audit Trail's
    `noteRecovery`, alongside Cache Meter's existing compaction attribution.
  - `onSessionSwitch` (extended) additionally calls `AuditLedgerState.noteSessionSwitch()` — mirrors
    the standalone `AuditTrailBoxController`'s own `session_switch` wiring exactly (resets the
    ledger map in place, not a fresh instance, since its own `noteSessionSwitch` already counts
    unresolved POISONED/DIRTY paths as a teardown leak). Tool Constellation and Palimpsest wire no
    `session_switch` handler in their own standalone extensions either, so their state is
    deliberately left untouched by this method too — not an oversight, verified against both
    keepers' own `index.ts` event lists.
  - `#buildSamples`'s array literal order is priority order (`[cacheMeter, auditTrailBox,
    toolConstellation, palimpsest]`), not builder-declaration order — `widget.ts`'s detailed mode
    renders `samples` top-to-bottom with no sort of its own, so this array's order IS the render
    order. **Gotcha flagged for `dxi.4`'s worker:** `cadenceEqualizer` (pri 2) and
    `rateLimitTidepool` (pri 4) must be *inserted between* existing entries at their correct
    priority slots, not appended after `palimpsest` — appending would render them in the wrong
    position in detailed mode even though simple mode (which sorts by priority via
    `composeSegments`) would still look correct, masking the bug.
- **Deviation, evidence-backed — the Audit Trail segment never sees POISONED via its own probe.**
  `AuditTrailBoxController` additionally owns an async, rate-limited, round-robin `DiskProbe`
  (`probeNow`/`#maybeProbe`) that is the *only* source of the `divergence` family (hence POISONED
  status) beyond the exact 2-tick hysteresis. The task brief's own framing — "Only the row/ledger
  state feeds the box," contrasted explicitly with the `setStatus` alarm surface it excludes — reads
  as scoping out this off-path filesystem I/O too: it is no more "row/ledger state" than the alarm
  surface it's called out alongside. Not wiring it means the box's Audit Trail segment can still
  show POISONED (verified — `test/animations-box-segments.test.ts`'s "colors the glyph with the
  poisoned token..." test drives two `state.noteProbe(...)` calls directly against the ledger to
  reach it), but only if something external calls `noteProbe` on the shared state — nothing in this
  bead's wiring ever does that on its own. Flagged for `dxi.7`'s registrar wiring to decide
  explicitly rather than resolve implicitly by omission.
- **Cosmetic gaps (same accepted category as Cache Meter's hit-rate ease/invalidation blink,
  `dxi.2`):** Audit Trail's alarm badge pulse (`badgeCell`'s blink while POISONED, `full` tier only)
  and Palimpsest's ember hot-pulse bolding (`isEmberHot`) both live inside their standalone
  `AnimatedWidget` classes' own per-frame state, not on the shared `*State`, so neither segment
  reproduces them — both always draw the plain, unpulsed/unbolded color. Noted in each builder's own
  doc comment in `segments.ts`.
- **Pre-existing `dxi.2` tests updated, not broken:** three `test/animations-box-controller.test.ts`
  cache-meter tests asserted the *whole* rendered box excluded `"—"` once cache went active, which
  was only true while cache meter was the box's sole segment. With audit/tools/files now enabled by
  default and genuinely resting alongside an active cache row, those assertions were narrowed to the
  cache row specifically (`frame.find(row => row.includes("cache"))`) — same intent, correct once
  more than one segment exists. The "disabled cacheMeter never appears" test was changed from
  asserting an empty widget (`toEqual([])`) to asserting the rendered text excludes `"cache"`, since
  the box is no longer empty once other segments are enabled by default.
- **`test/animations-box-controller.test.ts`'s `recordingContext()` helper gained a `cwd: "/repo"`
  field**, required by the new `AnimationsBoxContext.cwd` member.
- **`biome check --write .`** reordered a few import groups (alphabetical-within-group,
  `assist/source/organizeImports`) and reformatted two multi-line object literals in `segments.ts`
  that Biome's own formatter wanted split further — no logic changes, re-verified with a full
  `bun test` + `bun run check:types` pass after the auto-fix.
- **Tests (all new, literal pinned expectations, no snapshots):** 34 new tests in
  `test/animations-box-segments.test.ts` (priority derivation, resting-row content and dim color per
  builder, active-row content/variants/dedupe, the Audit Trail POISONED-glyph path via two
  `noteProbe` ticks, the Tool Constellation single-vs-multi-category variant collapse and
  `CATEGORY_ORDER` tie-break, the Palimpsest hottest-region pick and bare-filename ladder collapse);
  13 new tests in `test/animations-box-controller.test.ts` (resting-before-first-event, active-flip
  per event, `hasUI` gating, the `session_compact`/`auto_compaction_end` recovery smoke test, the
  `session_switch` reset, Palimpsest's `onTurnEnd` fade-out across `FADE_AFTER_TURNS`, and one
  integration test proving a single `edit` `tool_result` feeds both Audit Trail's and Palimpsest's
  ledgers from the same event).

**Gate:** `bun test && bun run check:types && biome check .` — **805 pass / 0 fail / 2560
assertions / 23 files** (baseline immediately before this bead was 758 pass / 2497 assertions per
`dxi.2`'s own gate line above; +47 new tests / +63 assertions, matching the 34+13 test counts
above exactly). tsgo and biome both clean.

**Files touched:** `src/animations-box/segments.ts`, `src/animations-box/controller.ts`,
`test/animations-box-segments.test.ts`, `test/animations-box-controller.test.ts`,
`plans/PROGRESS.md` (this entry). No keeper directory (`src/audit-trail-box/`,
`src/tool-constellation/`, `src/palimpsest/`) was touched; `src/animations-box/widget.ts` and
`src/animations-box/settings.ts` were read but not modified; `src/registrar.ts` and `package.json`
remain untouched (`dxi.7`'s scope).

## Plan 017 — Animations Box: dxi.4 segments B (cadence equalizer, rate-limit tidepool, reflection ripple)

**Status: DONE**

- **`src/animations-box/segments.ts` — three new builders, inserted at their priority slots (not
  appended), same template as `buildCacheMeterSegment` where the keeper's own state permits:**
  - `buildCadenceEqualizerSegment(state: CadenceEqualizerState, hasStreamed, tokensPerSecond, now,
    theme, colors?)` — the one builder in this file that DEVIATES from the `(state, now, theme,
    colors?)` template, and the reason is structural, not stylistic: `CadenceEqualizerState`'s own
    EMA bands decay *toward* but never *reach* exactly zero between turns, so the state alone can't
    answer "has anything ever happened" the way `state.size > 0`/`snapshot().stars.length > 0` do
    for Audit Trail/Tool Constellation. `hasStreamed` (latched permanently on the first assistant
    `message_start`, owned by the controller) and `tokensPerSecond` (the live sampled rate, also
    controller-owned — `CadenceEqualizerState` has no rate field, only bands/peaks) are threaded in
    explicitly. Variants: the Decision-1 ladder is three DIFFERENT renderers, not one renderer at
    three widths — `renderEqualizerRow` (full band bar with peak caps) → `renderCompactEqualizer`
    (bare band strip) → `renderEqualizerText` (numeric fallback), deduped. Detail: glyph is always
    the live `renderCompactEqualizer` strip over the state's *actual* current bands — including at
    rest, where the bands are genuinely all-zero, so the same call already produces the correct dim
    resting strip. This reuses the exported renderer instead of inventing a fixed resting-badge
    literal (the pattern every other segment in this file uses), because unlike Palimpsest/Tidepool/
    Ripple, Cadence Equalizer actually has real per-frame state to draw even at rest. Primary =
    `<N> t/s` or the keeper's own idle convention `"--"` (reproduced locally as `cadenceRateLabel`,
    since `renderEqualizerText`'s version carries an `"eq "` row prefix this column doesn't want).
    Secondary = `peak <N>`, the highest live band-peak amplitude denormalized back through
    `MAX_REFERENCE_RATE` (`normalizeAmplitude`'s inverse). Trailing = the full `renderEqualizerRow`
    band bar (peak caps included) — distinct from the glyph column's bare compact strip, matching
    Decision 1's table naming the two columns differently ("compact eq" vs. "band bar").
  - `buildRateLimitTidepoolSegment(state: RateLimitTidepoolState, now, theme, colors?)` — active
    once `state.snapshot() !== undefined`. The `{anthropic, openai}` family whitelist from Decision
    1's table is enforced entirely upstream, in `controller.ts`'s `onMessageStart` (mirroring
    `RateLimitTidepoolController.onMessageStart` exactly) — this builder only ever sees a snapshot
    that already passed that gate, so it never re-checks it. Variants: `renderTidepoolRow` at the
    999/30/12 budgets, fixed `subtle` motion tier (same fixed-tier choice `dxi.2`/`dxi.3` already
    made for Cache Meter/Audit Trail, so the filled-edge shimmer — a `full`-tier-only,
    per-frame-only cosmetic — never reproduces here). Level is refill-adjusted via the keeper's own
    exported `refillLevel(level, now, observedAtMs, resetAtMs)` before rendering, off the SAME
    `now` the controller stamped `observedAtMs` with (Decision 4 — verified with a dedicated test
    asserting the percentage actually moves between two `now` readings, not just that it renders).
    Detail: glyph = a new local literal `TIDEPOOL_BADGE_GLYPH = "◗"` (this keeper exports no badge
    glyph of its own, only bar-fill glyphs — same precedent as `PALIMPSEST_GLYPH`), colored via the
    `water` accent slot; primary = rounded level percentage; secondary = bare provider; trailing =
    a new local `resetEtaLabel` (`"resets <N>m"` / `"resets <N>s"` / `"resets now"` / `""`) — no
    exported formatter existed for this, so it's original text, not reused text; flagged here as
    the one spot in this bead that isn't a straight reuse.
  - `buildReflectionRippleSegment(state: ReflectionRippleState, now, theme, colors?)` — Decision
    1's explicitly-called-out inversion: **idle is the COMMON state**, not a startup gap. `active`
    means "a ripple is CURRENTLY in flight" (`phase === "rippling"`), never latching, unlike
    Cadence's `hasStreamed`. Variants: `renderReflectionRippleRow` at 999/40/12, fixed `subtle`
    tier, `elapsedMs = state.rippleElapsedMs(now)`. Detail: glyph = a new local literal
    `REFLECTION_RIPPLE_GLYPH = "○"` (this keeper exports no badge either, only the
    phase-parametrized `ringGlyph(brightness)`); primary = joined rule names; secondary = the bare
    session trigger count (no exported formatter needed — a raw number, per Decision 1's table
    naming this column "trigger count" with no template, unlike every other segment's columns);
    trailing = the literal fixed string `"—"` — Decision 1's table names this column '—' verbatim
    for this one segment, meaning there genuinely is no fifth data point here, not "empty because
    idle" (resting trailing is `""`, matching every other segment; only the ACTIVE trailing is the
    literal dash, straight from the spec table).
  - **Deep-import gotcha, flagged for future cleanup:** `MAX_REFERENCE_RATE` (`cadence-equalizer`)
    and `normalizeAmplitude` (`cadence-equalizer`, used in `controller.ts`) both live in
    `cadence-equalizer/scale.ts`, which that keeper's own `index.ts` barrel does NOT re-export
    (only `bars`/`controller`/`state`/`widget` do — `CadenceEqualizerColors`/`cadenceEqualizerColors`
    happen to be re-exportable only because `widget.ts` itself defines them, not because `scale.ts`
    is reachable). Fixing the keeper's own barrel is out of this bead's scope (keeper-directory
    edits are explicitly excluded), so both imports go straight to `../cadence-equalizer/scale`
    instead — documented inline at each import site. A future bead touching `cadence-equalizer/`
    should add `export * from "./scale"` to its `index.ts` and these two imports can move to the
    barrel.
- **`src/animations-box/controller.ts`:**
  - Three fresh state instances (`CadenceEqualizerState`, `RateLimitTidepoolState`,
    `ReflectionRippleState`), never the standalone controllers — same Decision 6 pattern as every
    prior bead.
  - New `onMessageStart` handler does double duty: it's the ONE event both Cadence Equalizer
    (`toAssistantSample`, mirrored byte-identical from `../cadence-equalizer/controller.ts`'s own
    private helper, latches `#cadenceHasStreamed` permanently) and Rate-Limit Tidepool (consumes
    `#tidepoolPendingHeaders`, mirroring `RateLimitTidepoolController.onMessageStart`'s own
    stash-then-consume ordering trick) subscribe to independently in their standalone extensions —
    same "one handler, two keepers" precedent `onToolResult` already set for Audit Trail+Palimpsest
    in `dxi.3`.
  - New `onMessageUpdate` (Cadence only) and `onAfterProviderResponse` (Tidepool only, stashes
    headers) round out the two keepers' full event surfaces.
  - New `onTtsrTriggered` (Ripple only) just calls `state.applyTrigger(ruleNames,
    this.#scheduler.now())` — no mount/teardown dance to mirror, since the box has no per-segment
    widget to construct/dispose; the segment's own `active` flag already IS the "is it showing"
    signal.
  - `onMessageEnd` (extended) now ALSO clears Cadence's tracked in-flight message
    (`#cadenceCurrent`/`#cadenceStreaming`) on every finalized assistant message, mirroring
    `CadenceEqualizerController.onMessageEnd`'s own clear — otherwise the next sample would keep
    reporting the just-finished turn's average rate indefinitely instead of settling to idle.
  - **New `#onTick(now)` seam wiring — the actual novel plumbing this bead adds.** Neither Cadence
    Equalizer's per-tick EMA-band stepping nor Reflection Ripple's per-tick settle check has an
    event to hang off; the standalone widgets drive both from their OWN `AnimatedWidget#onFrame`
    hook, which this box doesn't have per segment. `#onTick` (previously a documented no-op,
    exactly anticipating this) now calls `this.#cadenceState.pushSample(normalizeAmplitude(
    this.#sampleCadenceRate(now) ?? 0))` and `this.#reflectionRippleState.settleIfDone(now)` every
    tick, both off the SAME `now` the seam is called with — `AnimationsBoxWidget.onFrame` already
    calls `this.#onTick(this.#clock.now())`, i.e. the scheduler's wall clock, never the host's
    mount-relative `elapsedMs` (Decision 4 was already correctly wired in `dxi.2`; this bead is the
    first to actually have per-tick mutation to run through it). `#sampleCadenceRate` is called a
    second time, independently, inside `#buildSamples` for the render-time reading — both calls are
    pure given the same `#cadenceCurrent`/`#cadenceStreaming`/`now`, so no double-counting risk.
  - `onSessionSwitch` (extended) additionally resets Tidepool to a fresh instance and drops its
    pending header buffer, mirroring `RateLimitTidepoolController`'s own `session_switch ->
    dispose()` wiring. Cadence Equalizer and Reflection Ripple wire NO `session_switch` handler in
    their own standalone extensions, so both are deliberately left untouched here too — verified
    against each keeper's own `index.ts` event list, not an oversight.
  - `#buildSamples`'s array literal — the ordering hazard `dxi.3`'s worker flagged for this bead —
    now reads `[cacheMeter, cadenceEqualizer, auditTrailBox, rateLimitTidepool, toolConstellation,
    palimpsest, reflectionRipple]`, i.e. `BOX_SEGMENT_IDS`' own priority order verbatim, each new
    builder inserted between its correct neighbors rather than appended. Pinned by a new dedicated
    controller test asserting all 7 detailed-mode rows render in that exact order regardless of
    which segments were activated in which order.
- **MANDATORY acceptance test (bead criterion) — wall-clock seam:** a new
  `test/animations-box-controller.test.ts` test triggers a ripple BEFORE `controller.mount()` is
  ever called (`onTtsrTriggered` only needs `ctx.hasUI`, not a live mount), advances the manual
  scheduler to one tick short of `SETTLE_MS`, THEN mounts, and asserts the ripple is still active
  at that point and settles exactly one tick later — proving `state.rippleElapsedMs(now)` is
  measured off the ORIGINAL trigger timestamp on the shared scheduler, not reset to zero at mount
  time. Chose an observable transition (active → resting timing) over string-matching rendered
  ripple glyphs, since it's a strictly more direct probe of the actual clock-seam contract and
  isn't sensitive to exact glyph-rendering details.
- **Test-writing gotcha, worth flagging for future segments with a literal fixed `trailing`:** the
  `dxi.2`/`dxi.3` convention of asserting "segment went active" via `expect(row).not.toContain("—
  ")` (5 trailing spaces) false-positives on Reflection Ripple, because its ACTIVE `detail.trailing`
  is ALSO always the literal `"—"` (see above) — the 27-column-wide trailing cell pads that dash
  with plenty of trailing spaces, matching the same substring the idiom was checking for. Its tests
  use a segment-specific resting-row substring (`"reflect  —"` — the exact two-space gap the
  8-column label cell plus one join-space produces before a genuinely resting `primary`) instead.
- **Cosmetic gaps (same accepted category as Cache Meter's hit-rate ease, `dxi.2`):** Tidepool's
  filled-edge shimmer (`shimmerBeat`, `full`-tier only) is never reproduced, by construction (this
  segment fixes `motionTier: "subtle"`, same as every prior segment's fixed-`subtle` choice) —
  noted in `buildRateLimitTidepoolSegment`'s own doc comment. Neither Cadence Equalizer nor
  Reflection Ripple's standalone widgets have any additional per-frame-only cosmetic beyond what
  their own shared state already drives (peak-hold decay and ripple phase both live on `*State`
  itself, sampled/ticked identically here), so there is no equivalent gap to note for those two.
- **Tests (all new, literal pinned expectations, no snapshots):** 39 new tests in
  `test/animations-box-segments.test.ts` (priority derivation, resting-row content and dim color
  per builder, active-row content/variants/dedupe against the exact renderer call each keeper's own
  widget would make, the cadence idle-vs-sampled primary label, the tidepool refill-adjusted level
  and all four `resetEtaLabel` branches, the ripple idle-is-common-state assertion including a
  force-settled round trip, and a same-inputs-same-output purity check for ripple's phase math); 21
  new tests in `test/animations-box-controller.test.ts` (resting-before-first-event, active-flip
  per event including the two-keepers-share-one-event cases for `onMessageStart`, `hasUI` gating,
  the enabled-gate per segment, the `onFrame`-driven per-tick EMA step, Tidepool's
  unwhitelisted-provider and message-role gates, Tidepool's `session_switch` reset, the ripple
  settle-via-tick round trip, the MANDATORY wall-clock-seam acceptance test, and the 7-row
  detailed-mode ordering test).

**Gate:** `bun test && bun run check:types && biome check .` — **865 pass / 0 fail / 2660
assertions / 23 files** (baseline immediately before this bead was 805 pass / 2560 assertions per
`dxi.3`'s own gate line above; +60 new tests / +100 new assertions, matching the 39+21 test counts
above exactly). tsgo and biome both clean (biome's own `--write` auto-fixed import ordering and a
few multi-line-object reformats across all 4 touched files — no logic changes, re-verified with a
full `bun test` + `bun run check:types` pass after).

**Files touched:** `src/animations-box/segments.ts`, `src/animations-box/controller.ts`,
`test/animations-box-segments.test.ts`, `test/animations-box-controller.test.ts`,
`plans/PROGRESS.md` (this entry). No keeper directory (`src/cadence-equalizer/`,
`src/rate-limit-tidepool/`, `src/reflection-ripple/`) was touched. `src/animations-box/widget.ts`
and `src/animations-box/settings.ts` were read but not modified (both already anticipated the full
7-segment set). `src/registrar.ts` and `package.json` remain untouched (`dxi.7`'s scope).
`dxi.5`'s worker note: the border-breathing bead can now assume all 7 segments are wired and the
`#onTick` seam is live (no longer a no-op) — any border-breathing per-tick state should be added
alongside the two calls already there, not as a separate seam.

## Plan 017 — Animations Box: dxi.5 breathing border (border chrome, not a segment)

**Status: DONE**

- **`src/animations-box/widget.ts`** — the border chrome itself now breathes (Decision 2).
  `borderTop`/`borderBottom`/`contentLine` all gained a `theme`/`color: ThemeColor | undefined`
  pair; `undefined` is the literal plain, pre-dxi.5 uncolored path (`colorize()` never calls
  `theme.fg` at all when `color` is `undefined` — not "call it with a dim token", a hard branch),
  which is exactly what both static cases fall back to. `renderFrame` computes ONE
  `#resolveBorderColor(now)` per frame and threads it uniformly into every border glyph — top row,
  bottom row, AND the two side pipes in `contentLine` (only the pipes, never the inner content,
  which stays whatever the segment builders already colored). `#resolveBorderColor` is a hard
  `policy.tier === "off"` check first (new `#policy: MotionPolicy` field, mirroring
  `BreathingBorderWidget`'s own tier check exactly — the box previously had no reason to keep its
  own `policy` reference), then defers to the new `getBorderBrightness(now): number | undefined`
  option (`undefined` = `breathingBorder` disabled in config, same plain fallback as tier `off`).
  A live brightness buckets through `brightnessToken` (re-exported from `../breathing-border`) into
  a `ThemeColor` via a new local `colorForToken` — a byte-identical copy of
  `../breathing-border/widget.ts`'s own private `resolveBorderColor`, which isn't exported from
  that module's barrel (same "not exported from that barrel" precedent `segments.ts` already
  documents for `formatCost`/`compareVisibleRows`). New `#colors: BreathingBorderColors =
  breathingBorderColors(options.accentColor)` at construction — identical pattern to the standalone
  `BreathingBorderWidget`'s own accent handling: peak-only recolor, muted/base stay fixed. Geometry
  is untouched: `borderTop`/`borderBottom`/`contentLine` still produce exactly the same characters
  at every width, colored or not — only wrapped, never resized (verified by a dedicated
  geometry-invariance test asserting identical row count and exact `row.length === width` across
  all three states at 45/69/120).
- **`src/animations-box/controller.ts`** — owns a fresh `BreathingBorderState` instance (Decision
  6, same reasoning as every other keeper here: `BreathingBorderController` only ever constructs
  its own animated widget from inside ITS OWN `setWidget` factory, which this box must never
  invoke). Three NEW handlers — `onAgentStart`, `onAgentEnd`, `onTurnStart` — plus one EXTENDED
  handler — `onTurnEnd` now also calls `applyTurnEnd` — mirror `BreathingBorderController`'s own
  four event handlers byte-for-byte (same `ctx.hasUI` gate, same `this.#scheduler.now()` stamping).
  These are necessary, not speculative: without them the state can never leave `idle`, and there
  would be no way to unit-test "brightness actually varies across the breath phase" at all (the
  state field is private). Actual `api.on(...)` registration is still `dxi.7`'s scope — these are
  class methods only, same posture as every other handler already in this file. `#onTick` gained
  one more call, `this.#breathingBorderState.settleIfDone(now)`, riding the exact same per-tick
  seam Reflection Ripple's settle check already uses — no second tick path. New private
  `#getBorderBrightness(now)` is the seam the widget reads: `undefined` when `config.breathingBorder`
  is `false`, otherwise a phase switch (`idle` → literal `0`; `active` → `breathEnvelope(elapsed,
  breathPeriodMs())`; `exhaling` → `exhaleEnvelope(elapsed, EXHALE_DURATION_MS)`) — identical math
  to `BreathingBorderWidget.renderFrame`'s own phase switch, just returning the bare envelope
  instead of a fully rendered/colored row (coloring is the widget's job, not the controller's).
  New constructor option `accentColor?: ThemeColor` threads straight through to the widget at
  `mount()` time, unchanged — the registrar (`dxi.7`) will resolve it via the EXISTING
  `resolveAnimationAppearance("breathingBorder", ...)` call and pass the result in; no new accent
  key, per Decision 3.
- **`src/animations-box/settings.ts`** — `AnimationsBoxConfig` gained one field,
  `breathingBorder: boolean`, resolved through the SAME `breathingBorder` raw key/env
  (`animationsEnvKey("breathingBorder")`) its standalone row's registrar entry already reads —
  identical stored > env > default precedence to the 7 segment booleans, just not indexed by
  `BoxSegmentId` (a new local `BREATHING_BORDER_ID` const, also reused to build
  `BOX_MIGRATED_ANIMATION_IDS` in place of the old inline literal). Default `true`, matching every
  other per-animation enable boolean's default.
- **Deviation from the literal plan text, with evidence:** Decision 2's prose reads "Motion tier
  `off`, or `breathingBorder: false`, renders a static plain border" as one sentence covering both
  cases identically. I implemented both as the exact SAME output — zero `theme.fg` calls, the
  literal pre-dxi.5 uncolored chrome — rather than a colored-but-static `borderMuted` frame (which
  is what the STANDALONE widget's own `off`-tier/idle fallback does, `renderBreathingBorderOffText`/
  `renderBreathingBorderIdleRow`, both `theme.fg("borderMuted", ...)`). Evidence for going
  uncolored instead: `widget.ts`'s own pre-dxi.5 doc comment on the `theme` option said "the border
  itself is static/plain until then" to describe literally-uncolored output — this bead's own
  target module already used "static/plain" as established vocabulary for zero-`theme.fg` output,
  not for a colored-but-frozen one. No test relies on the alternative reading; if the maintainer
  wants the colored-idle variant instead, `#resolveBorderColor`'s two `undefined` branches are the
  only two lines to change.
- **Tests (all new, literal pinned/tagged-theme frames, no snapshots):** 7 new tests in
  `test/animations-box-widget.test.ts` (brightness→token bucketing at three brightness levels,
  side-pipe coloring, phase variance over two `nowMs` readings, peak-only accent override, the
  motion-`off` hard override, the `breathingBorder`-disabled fallback, and geometry invariance
  across all three states at 45/69/120 widths); 8 new tests in
  `test/animations-box-controller.test.ts` (idle-before-any-event, `onAgentStart` phase variance,
  `onAgentEnd` → exhale → `#onTick`-driven settle back to idle, `onTurnStart`/`onTurnEnd` cadence
  modulation proven via two elapsed-time-identical scenarios with/without a fast turn, the
  controller-level accent override, the `breathingBorder: false` config gate, and the `hasUI: false`
  gate on all four new handlers); 2 new tests in `test/animations-box-settings.test.ts`
  (`breathingBorder`'s default/boolean-string resolution, and its stored>env precedence through
  the shared `animationsEnvKey`).

**Gate:** `bun test && bun run check:types && ./node_modules/.bin/biome check .` — **882 pass / 0
fail / 2729 assertions / 23 files** (baseline immediately before this bead was 865 pass / 2660
assertions per `dxi.4`'s own gate line above; +17 new tests / +69 new assertions, matching the
7+8+2 test counts above exactly). tsgo clean. biome flagged import-order/formatting only
(`--write` auto-fixed 3 files: `src/animations-box/controller.ts`, `src/animations-box/widget.ts`,
`test/animations-box-controller.test.ts` — no logic changes), re-verified clean with a full
`bun test` + `bun run check:types` pass after.

**Files touched:** `src/animations-box/widget.ts`, `src/animations-box/controller.ts`,
`src/animations-box/settings.ts`, `test/animations-box-widget.test.ts`,
`test/animations-box-controller.test.ts`, `test/animations-box-settings.test.ts`,
`plans/PROGRESS.md` (this entry). No keeper directory (`src/breathing-border/`) was touched —
every import from it is either already-exported barrel surface (`BreathingBorderState`,
`breathEnvelope`, `exhaleEnvelope`, `EXHALE_DURATION_MS`, `brightnessToken`,
`BorderBrightnessToken`, `breathingBorderColors`, `BreathingBorderColors`) or a documented local
copy of a private helper (`colorForToken`). `renderBreathingBorderRow` and `BreathingBorderWidget`
are never imported anywhere in `src/animations-box/` — confirmed by construction, not just by
test, since the only breathing-border imports in the whole directory are the ones listed above.
`src/registrar.ts` and `package.json` remain untouched (`dxi.7`'s scope — that bead still owns
wiring `agent_start`/`agent_end`/`turn_start` into the box controller's new handlers, and resolving
`accentColor` via `resolveAnimationAppearance("breathingBorder", ...)` into the controller's new
constructor option).

`dxi.6`'s worker note: the border now colors itself whenever `breathingBorder` is enabled and the
motion tier isn't `off` — full-box golden frames built with a REAL (non-identity) theme stub will
show colored border glyphs by default. Use `getBorderBrightness: () => undefined` (or leave
`breathingBorder` disabled in the resolved config) if a golden needs the plain, pre-dxi.5 chrome
for a clean content-only comparison. `AnimationsBoxWidgetOptions` now requires `getBorderBrightness`
— any golden test constructing the widget directly (not through `AnimationsBoxController`) needs
that field or it won't compile.

## Plan 017 — Animations Box: dxi.6 full-box golden-frame tests + width/height correctness

**Status: DONE** (test bead — no source bugs surfaced; all 7 segment builders, the widget, the
controller, and `composeSegments` behaved exactly as `dxi.2`–`dxi.5` left them)

- **New file `test/animations-box-goldens.test.ts` (11 tests, 104 assertions).** Three sections,
  per the bead's scope:
  1. **Full-box golden frames** — `driveFullBox(detail)` mounts a real `AnimationsBoxController`
     and drives it through its actual public event handlers (`onMessageEnd`, two `onMessageStart`
     calls, two `onToolResult` calls, `onAfterProviderResponse`, two `onToolCall` calls, one
     `scheduler.advance(50) + widget.onFrame(0)` tick) to build a representative "5 of 7 active"
     scene — cache meter, cadence, audit trail, rate-limit tidepool, and tool constellation go
     active; palimpsest and reflection ripple stay resting — matching Decision 5's own
     detailed-mode mock's activation pattern. The exact literal frames were generated once by
     running this same driven scene through a throwaway script, hand-verified against each
     segment's real formula (cache warmth `600/(600+200+400) = 50.0%`; tok/s `(100×1000)/1000 =
     100`; tool-constellation dominant-category tie broken by `CATEGORY_ORDER`'s `read` before
     `write`; tidepool `resets 12m` from a deliberately non-round reset offset, `725_000ms`, chosen
     so the one scheduler tick doesn't cross a minute boundary and flip the pinned string), then
     pasted as `toEqual([...])` literals — a real golden, not a self-referential "call the builder,
     assert it equals itself" test. Pinned at all three required widths (69/45/120) in both detail
     modes (6 frame assertions total), plus one more test asserting every rendered row's
     `visibleWidth` (from `@oh-my-pi/pi-tui`) equals the literal target width across both modes ×
     all three widths — no overflow, no underflow anywhere.
  2. **Height stability** — `restingSamples()`/`activeSamples()` build one real `SegmentSample`
     per `BOX_SEGMENT_IDS` entry (idle vs. warmed `*State` instances, fed through the same
     `build*Segment` functions `segments.ts` itself calls — never hand-rolled samples), asserted
     1:1-aligned with `BOX_SEGMENT_IDS` order. Toggling any single segment active↔resting (looped
     via `BOX_SEGMENT_IDS`, never a hardcoded id list) leaves `widget.render(69).length` unchanged
     in both detail modes; so does flipping all 7 at once. A dedicated assertion pins detailed
     height to `BOX_BORDER_ROWS + BOX_SEGMENT_IDS.length` and simple height to `BOX_BORDER_ROWS +
     1` — both derived from the widget's own exported constants/id-list length, no magic 7/8/3.
     Separately, `AnimationsBoxController — config-driven height changes` mounts real controllers
     under `resolveAnimationsBoxConfig({...})` variants (no events driven — height is a pure
     function of the enabled set and detail level, never of activity, per Decision 5) and, looping
     over `BOX_SEGMENT_IDS`, confirms disabling any one segment shortens detailed-mode height by
     exactly 1 and leaves simple mode's height untouched; a separate test confirms
     `breathingBorder: false` changes height not at all in either mode (the border chrome survives,
     just uncolored — already proven at the widget level by `dxi.5`'s own geometry-invariance test,
     re-confirmed here through the controller/config seam).
  3. **Degradation ladder** — builds the same `activeSamples()` (all 7 segments active at once),
     converts each to a kit `Segment` via `segment(s.id, s.priority, s.variants)`, and calls the
     kit's exported `composeSegments` directly (the same function `widget.ts`'s simple-mode branch
     calls internally) at `width - BOX_BORDER_COLS` for width ∈ {69, 45, 120}. `LADDER` is expressed
     as `{ 69: BOX_SEGMENT_IDS, 45: BOX_SEGMENT_IDS.slice(0, -1), 120: BOX_SEGMENT_IDS }` rather than
     three independently hand-typed id arrays — since `composeSegments` returns `keptIds` already
     sorted ascending by priority, and priority is exactly each id's index in `BOX_SEGMENT_IDS`, the
     kept set at any width is always some prefix/subset of that same array in that same order; this
     both derives the expectation from the id list (no magic list duplication) and gives the actual
     ladder for free from the real computed narrow-variant widths. A second assertion maps `keptIds`
     back to priority via a local `priorityOf` and checks the sequence is already ascending-sorted
     (proves `composeSegments`'s priority-order guarantee, not just the specific membership).

- **Ladder observed (everything active, simple mode):** at width 69 and 120, all 7 segments'
  narrowest variants fit the budget (65 and 116 respectively) — nothing drops. At width 45 (inner
  41), the combined narrowest-variant width across all 7 is exactly 56 with separators, which
  doesn't fit 41; dropping the single lowest-priority segment (`reflectionRipple`, priority 7 —
  its narrowest variant alone is 12 columns, since `renderReflectionRippleRow`'s "subtle" tier pads
  to the FULL requested render width rather than a compact form) brings the remaining 6 down to
  exactly 41, which fits with zero room to spare. So the pinned ladder is `{69: all 7, 45: all but
  reflectionRipple, 120: all 7}` — a real, width-45-only degradation, not a fabricated one.

- **No source bugs found.** All three test sections passed on first run against the `dxi.2`–`dxi.5`
  implementation with zero source-file edits — this bead's acceptance criteria are entirely
  test-authoring plus the one-time golden-generation/verification pass described above.

- **Gotcha hit during authoring, worth flagging forward:** `expect(arr).toEqual(BOX_SEGMENT_IDS)`
  fails `tsgo` (not at runtime) because `BOX_SEGMENT_IDS` is a `readonly [...] as const` tuple and
  bun's `toEqual` overload wants a mutable array type on that side; spread it (`[...BOX_SEGMENT_IDS]`)
  when asserting id-list equality, same as this file's own "restingSamples()/activeSamples() line up
  1:1 with BOX_SEGMENT_IDS" test does. Comparing `readonly BoxSegmentId[]` against `keptIds` (typed
  `readonly string[]`, not a literal tuple) did not hit this, so it's specifically the "both sides
  are literal `as const` tuples" case that trips the overload.

**Gate:** `bun test && bun run check:types && ./node_modules/.bin/biome check .` — **893 pass / 0
fail / 2833 assertions / 24 files** (baseline immediately before this bead was 882 pass / 2729
assertions per `dxi.5`'s own gate line above; +11 new tests / +104 new assertions / +1 file, exactly
this bead's new file). tsgo clean after the `toEqual([...BOX_SEGMENT_IDS])` fix above. biome flagged
formatting only (long import lines / call-argument wrapping) — `--write --unsafe` auto-fixed the one
new file, re-verified clean with a full `bun test` + `bun run check:types` + `biome check .` pass
after.

**Files touched:** `test/animations-box-goldens.test.ts` (new), `plans/PROGRESS.md` (this entry). No
`src/` file was touched — this bead's acceptance was met entirely by new tests against the existing
`dxi.2`–`dxi.5` implementation; registrar/package.json wiring (`dxi.7`), keeper directories, and
sandbox validation (`dxi.8`) remain untouched, as required by this bead's own scope.

`dxi.7`'s worker note: this bead's `driveFullBox` helper (in the new goldens test file) is a second,
independent proof — alongside `animations-box-controller.test.ts` — that the controller's full event
surface (`onMessageEnd`/`onMessageStart`/`onMessageUpdate`/`onAfterProviderResponse`/`onToolResult`/
`onToolCall`/`onTtsrTriggered`/`onAgentStart`/`onAgentEnd`/`onTurnStart`/`onTurnEnd`/
`onSessionCompact`/`onAutoCompactionStart`/`onAutoCompactionEnd`/`onSessionSwitch`) is exactly what
`dxi.7`'s registrar wiring needs to subscribe to `api.on(...)` — nothing new was discovered here that
changes that list. Separately: `AnimationsBoxContext.cwd` is required by the controller
(`onToolResult`'s Audit Trail adapter) — the registrar wiring must supply the real working directory,
not a placeholder, or Audit Trail's box segment will resolve every touched path relative to the
wrong root.

## Plan 017 — Animations Box: dxi.7 manifest + registrar + README

**Status: DONE**

- **`package.json#omp.settings`** — added exactly 3 keys, grouped together right after
  `animations` (both are shared, non-per-animation settings) rather than pure alphabetical
  order, mirroring how each animation's own boolean/Placement/AccentColor trio is already
  grouped: `display` (enum `rows`/`box`/`both`, default `box`, env `OMP_ANIMATIONS_DISPLAY`),
  `animationsBoxDetail` (enum `simple`/`detailed`, default `detailed`, env
  `OMP_ANIMATIONS_BOX_DETAIL` — matches `BOX_SETTING_ENV.detail` in `settings.ts` exactly),
  `animationsBoxPlacement` (enum `aboveEditor`/`belowEditor`, default `belowEditor`, env
  `OMP_ANIMATIONS_BOX_PLACEMENT`). Manifest: 24 -> 27 keys. Zero new accent keys, zero subset
  keys, zero inert keys, per the stale-bead-text correction in this bead's brief — confirmed
  by `test/registrar.test.ts`'s own key-set test, which now derives the 3 new names from
  `BOX_SETTING_KEYS` (`Object.values(...)`) rather than a literal list.

- **`src/registrar.ts`** — `createAnimationsPlugin` now resolves a second config,
  `boxConfig = resolveAnimationsBoxConfigFromSources(settings, env)`, alongside the existing
  `config`. The mount loop over `ANIMATIONS` gained one guard: when `boxConfig.display ===
  "box"` and the animation's id is in `BOX_MIGRATED_ANIMATION_IDS`, its standalone `mount()`
  is skipped (`continue`) instead of called — rows mode and both mode are byte-for-byte
  unchanged (the guard only fires for `display === "box"`). A new `mountAnimationsBox` helper
  constructs one `AnimationsBoxController` (placement from `boxConfig.placement`,
  `motionSetting` from the SAME shared `config.tier` every row uses, `accentColor` from
  `config.appearance.breathingBorder.accentColor` — the existing `breathingBorderAccentColor`
  setting, reused per Decision 3/no-new-accent-key) and subscribes its full 16-event surface
  (`session_start` for `mount()`, plus the 15 `on...` methods `dxi.6`'s note above enumerated)
  via the same `api.on(event, (event, ctx) => controller.onX(event, ctx))` convention every
  other keeper's `index.ts` uses. It mounts whenever `display` is `"box"` or `"both"`. A small
  discovery simplified the wiring considerably: `AnimationsBoxContext`'s per-event methods
  only need `Pick<AnimationsBoxContext, "hasUI">` or `"hasUI" | "cwd"`, both of which
  `ExtensionContext` already has under the same field names — so no per-event adapter
  function was needed (unlike every other keeper's `toXContext`), only one
  `toAnimationsBoxContext(ctx)` for `mount()`/`dispose()`, which additionally need
  `setWidget` (adapted from `ctx.ui.setWidget`), matching the real (non-placeholder) `ctx.cwd`
  `dxi.6`'s note flagged as load-bearing for Audit Trail Box's box segment.

- **Audit Trail alarm surface — option (b), a minimal addition to `audit-trail-box/`** (per
  this bead's own hazard ordering: prefer an existing flag, then a minimal addition, then
  document a gap). No existing flag suppressed only the row while keeping the ledger/probe/
  alarm live, so `AuditTrailBoxControllerOptions` gained `suppressRow?: boolean` (threaded
  through `AuditTrailBoxExtensionOptions` in `index.ts`). Internally, `Mount` gained a third
  variant, `{ mode: "headless"; policy: MotionPolicy }`, returned by `#mountWidget` before the
  existing `tier === "off"` check when `suppressRow` is set — so headless mode preempts the
  static-widget fallback rather than falling through into it. `#refresh` skips widget
  maintenance for headless mode (nothing to draw), and `#refreshStatus` was restructured
  around one real behavioral decision: the existing "off tier already shows the counts on its
  static line, so stay silent" rule is scoped to `mode === "static"` specifically (not `policy
  === undefined` as before) — a headless controller has NO static line at any tier, so its
  alarm must not go dark just because the shared `animations` tier happens to resolve to
  `"off"`; it is the SOLE surface for POISONED in that mode (Decision 6) and the one thing
  this bead's brief called out as a hard requirement. `dispose()` skips the now-unnecessary
  `setWidget(WIDGET_KEY, undefined, ...)` clear call for headless mode (nothing was ever set).
  The registrar wires this via the SAME `createAuditTrailBoxExtension(...)` factory the normal
  `ANIMATIONS` entry calls (same `motionSetting`/`...appearance.auditTrailBox` spread, plus
  `suppressRow: true`) — so its probe, ledger, `setStatus` alarm, and `/audit-trail` command
  (including `/audit-trail remedy`) all stay wired exactly as in rows mode, only the row itself
  is gone. This only fires in `display === "box"`; in `"both"` mode Audit Trail Box mounts
  fully normally (row + alarm) via its regular `ANIMATIONS` entry, so there is never a second,
  duplicate probe running — `AuditLedgerState` inside `AnimationsBoxController` (the box's own
  audit segment, per `dxi.3`) never runs a probe in any variant, matching this bead's
  no-duplicate-probe-IO hazard.

- **`README.md`** — new "The Animations Box" section (ASD-STE100: short sentences, one idea
  each) between "The animations" and "Install", explaining what the box is, the `display`
  three-way switch and how it interacts with each animation's own enable boolean, the two
  box-only settings, how per-animation `Placement`/`AccentColor` settings apply differently in
  `rows` vs `box` mode, Breathing Border's row-less border-only role, and Audit Trail Box's
  alarm-survives-row-suppression special case. The top intro paragraph and the "Turn animations
  on and off" settings list were updated to mention the box and its 3 settings without
  duplicating the new section's explanation.

- **Tests (`test/registrar.test.ts`)** — the file's own `mount()`/`only()` helpers predate
  `display` and implicitly tested `rows`-mode behavior throughout; `mount()` now defaults
  `settings` to `{ display: "rows", ...enabled }` (callers can still override), which was the
  minimal fix keeping every pre-existing assertion in this file — and in `test/boot-smoke.test.ts`,
  `test/cache-meter.test.ts`, and `test/appearance.test.ts`'s own registrar-integration tests,
  none of which had ever needed a `display` key before — meaningful, rather than rewriting each
  one's internal assertions. All four call sites are now explicit about which mode they exercise
  (each with a one-line comment explaining why `display: "box"`, the new default, would have
  broken them). A new `describe("display modes (Animations Box integration, Plan 017)")` block
  covers: `BOX_MIGRATED_ANIMATION_IDS` is exactly the shipped `ANIMATIONS` set (a documented
  invariant the box-mode multiset arithmetic below depends on); the production default really is
  `"box"` when unstored (via a new `mountRaw` helper that, unlike `mount()`, never forces
  `display`); box mode's subscription multiset equals Audit Trail Box's own rows-mode solo
  events plus the box's own solo event set (proving every OTHER migrated animation contributes
  literally zero subscriptions, and that Audit Trail's own event wiring is byte-for-byte
  unchanged by `suppressRow`), plus `commands === ["audit-trail"]` (proves `/cache` is gone but
  `/audit-trail` survives); both mode's multiset equals the full rows-mode union plus the box's
  own events, with the same command set as rows mode; rows mode never subscribes to
  `session_start` (the box's own mount hook); and box/both mode each subscribe to it exactly
  once. A nested `describe("widgets actually mounted, driven through a real session_start")`
  adds a `makeDrivableApi()` (captures `session_start` handlers and simulates firing them
  against a fake `ExtensionContext`, recording `setWidget` calls by key) proving directly, not
  just via subscription counts, that box mode mounts exactly one widget — `BOX_WIDGET_KEY` —
  and rows mode mounts nothing on `session_start` at all. Widget-mount checks were deliberately
  scoped to the box's own key only (not every migrated animation's WIDGET_KEY): the other 8
  keepers mount lazily on their own first event, not `session_start`, and their per-animation
  mount correctness is already exhaustively covered by each keeper's own test file — re-driving
  all of them here would duplicate that coverage without adding proof beyond what the
  subscription-multiset tests above already establish.

- **No hardcoded counts.** Per this bead's own COUNTER HAZARD: nowhere does a test or
  source file write a literal `3`, `24`, or `27` for a settings-key count — the manifest test
  derives the 3 box keys from `Object.values(BOX_SETTING_KEYS)` and the per-animation keys from
  `ALL_IDS`/`ANIMATIONS`, exactly as it already did pre-dxi.7.

- **Headless-mode unit tests, `test/audit-trail-box-controller.test.ts`.** The registrar-level
  tests above prove `suppressRow`'s *wiring* survives (subscriptions/commands unchanged); this
  new `describe("audit trail box controller — headless mode (suppressRow)")` block proves the
  *behavior* directly, against the real controller, reusing this file's own `alarmingPath`/
  `recordingContext`/`fakeDisk` fixtures: never mounts `WIDGET_KEY` at any motion tier
  (`off`/`subtle`/`full`); the alarm fires at tier `off` in headless mode specifically — the one
  new behavioral decision this bead made (`#refreshStatus`'s silence rule now scopes to `mode
  === "static"`, not "any tier-off policy") — with a paired control test proving the ROW-mounted
  `off` tier still stays silent, unchanged; the alarm still clears on `noteSessionSwitch`; and
  `dispose()` clears the status without ever touching the widget key. All 5 passed against the
  implementation with no further source changes, confirming the off-tier exemption is correct
  and not just type-safe.

**Gate:** `bun test && bun run check:types && ./node_modules/.bin/biome check .` — **906 pass / 0
fail / 2858 assertions / 24 files** (baseline immediately before this bead was 893 pass / 2833
assertions per `dxi.6`'s own gate line above; +13 new tests / +25 new assertions, 0 new files —
this bead only extended existing test files, per its own scope). tsgo clean. biome flagged
import-sort and formatting only in `src/registrar.ts` and `test/registrar.test.ts` —
`--write --unsafe` auto-fixed both, re-verified clean with a full `bun test` +
`bun run check:types` + `biome check .` pass after.

**Files touched:** `package.json`, `src/registrar.ts`, `src/audit-trail-box/controller.ts`,
`src/audit-trail-box/index.ts`, `README.md`, `test/registrar.test.ts`, `test/boot-smoke.test.ts`,
`test/cache-meter.test.ts`, `test/appearance.test.ts`, `test/audit-trail-box-controller.test.ts`,
`plans/PROGRESS.md` (this entry). No other `src/` directory was touched, per this bead's own
scope — `audit-trail-box/` was touched for exactly the `suppressRow` seam (hazard option (b)),
nothing else in that directory changed.

`dxi.8`'s worker note: live-sandbox validation should specifically check (1) that `display=box`'s
default actually renders the box on a fresh install with no stored settings (nothing here exercises
the REAL `getPluginsLockfile()`/RPC settings channel end to end, only the injectable `settings`
seam); (2) that Audit Trail Box's footer alert genuinely fires from a real stale-file scenario in
`box` mode — this bead's tests prove the wiring survives `suppressRow`, not that the probe/alarm
sequence itself still behaves correctly end-to-end under real disk I/O (that's `audit-trail-box-*`'s
own coverage, unchanged by this bead, but never re-verified against a REAL headless mount here); and
(3) the border's breathing motion and the box's own placement/detail rendering at a real terminal
width, which this bead's registrar-level tests do not and should not attempt (that's `dxi.6`'s
golden-frame territory, already covered).

## Plan 017 — Animations Box: dxi.8 gates + live sandbox validation

**Status: DONE (gates clean; 4 of 5 assigned sandbox scenarios proven with evidence; one assigned
scenario surfaced a real settings-UI gap in the installed omp build rather than the expected result;
worker-note item (2) above — Audit Trail Box's real stale-file alarm — was out of this bead's
assigned scope and was not exercised. Final "perfect-bar" acceptance is Rohit's, per the bead.)**

- **Gates, run at `/Users/rohit/Documents/omp-animations` HEAD `8d5c48cd05f8d06e7cf624e6211836b51aaf9d2f`:**
  - `bun test` → **906 pass / 0 fail / 2858 expect() calls / 24 files**, exit 0. Matches `dxi.7`'s
    own gate line above exactly (no drift since that bead's commit).
  - `bun run check:types` → `tsgo -p tsconfig.json --noEmit`, no output, exit 0.
  - `./node_modules/.bin/biome check .` → `Checked 84 files in 32ms. No fixes applied.`, exit 0.
  - Logs: `/tmp/dxi8-evidence/bun-test.log`, `/tmp/dxi8-evidence/typecheck.log`,
    `/tmp/dxi8-evidence/biome.log`.

- **Sandbox discovery.** `tmux has-session -t anim-keepset` initially failed — the session did not
  exist yet (only `2`, `pair3-base`, `pair3-fork`, `zen-sandbox-test` were live; `xxz6` was not
  present either, so the "never touch it" hazard was moot by construction). Created it fresh:
  `tmux new-session -d -s anim-keepset -x 69 -y 42 -c /tmp/omp-anim-keepset`. Profile selection:
  `/Users/rohit/.omp/profiles/anim-keepset/plugins/node_modules/@oh-my-pi/animations` is a symlink
  (`readlink -f` confirms) directly to `/Users/rohit/Documents/omp-animations` — not a copy — so
  whatever is on disk there (HEAD `8d5c48c`) is exactly what loads; no re-link needed.
  `omp-plugins.lock.json` for that profile shows `{"plugins": {"@oh-my-pi/animations": {"version":
  "0.1.0", "enabled": true}}, "settings": {}}` — **`settings` is empty**, i.e. this profile has no
  stored per-key overrides for `display`/`animationsBoxDetail`/`animationsBoxPlacement` at all. This
  directly answers worker-note item (1) from `dxi.7` above: the box-by-default behavior observed
  below is exercised through the REAL `getPluginsLockfile()` settings channel with a genuinely empty
  settings object, not the injectable test seam.
  **Correction to the brief's premise:** the sandbox is NOT auth-blocked. `omp --profile
  anim-keepset` launched straight to a "Welcome back!" screen already authenticated (GPT-5.5 via
  `openai-codex`, one prior session). No credentials were seeded, configured, or touched by this
  bead — this is pre-existing profile state discovered, not created.

- **(a) Default launch (`display=box`, detailed) — PROVEN.** `omp --profile anim-keepset`, idle
  capture: a 9-row box (2 border + 7 segment rows — cache, cadence, audit, limits, tools, files,
  reflect, matching `BOX_SEGMENT_IDS` minus `breathingBorder`) directly below the model-status
  header, each of the 11 box+header rows measured at **exactly 69 columns** via a Python width
  check (`len()` on the ANSI-stripped line), borders intact (`╭…╮`/`│…│`/`╰…╯`), no clipped glyphs,
  no standalone animation rows anywhere in the capture. Drove a real read-only prompt ("List the
  files… summarize README.md") through the live GPT-5.5 session: `cache` (47.3%, saved $0.12, r
  27K/w 0), `audit` (2✓, MEMORY.md, r/w 2/0), and `tools` (3 calls, read, ⛏3) all populated with
  real live data mid-generation; `limits`/`files`/`reflect` correctly stayed idle (`—`) — no rate
  pressure, no file edits, no reflection event, exactly as their mount policies predict. Height
  stayed fixed at 9 rows throughout. Evidence: `/tmp/dxi8-evidence/a-launch-idle.txt`,
  `a-launch-idle-color.txt`, `a-during-tool-call-{1,2,3}.txt`, `a-after-tool-call.txt`.

- **(b) `OMP_ANIMATIONS_BOX_DETAIL=simple` relaunch — PROVEN.** Box collapses to exactly **3 rows**
  (border/content/border), 69 columns, both idle (blank content row) and mid-activity, where the
  content row condensed cache+audit+tools into one line: `▤ H 47.5% (1/2) R 27K W 0 M 29K ·
  · ▣ 3✓ · ⛏ 3`. Height never grew past 3 regardless of how many segments had data. Evidence:
  `/tmp/dxi8-evidence/b-simple-detail-launch.txt`, `b-simple-detail-during{,2}.txt`.

- **(c) `OMP_ANIMATIONS_DISPLAY=rows` relaunch — PROVEN.** No box anywhere in any capture — only the
  pre-existing model-status header. Driving activity produced classic **standalone, unboxed** rows:
  a cadence-equalizer strip (`──────━───…`), a cache row (`▤ SAVED $0.12 ▁█ HIT 47.5% (1/2) READ
  27K WRITE 0 MISS 29K`), and an audit dot-grid block (`· · · · · · · · · ✦` / `▣ 2✓ r/w 2/0 ×0.0
  ↻0%`) — no border characters anywhere near them, confirming `box` mode is fully suppressed.
  Evidence: `/tmp/dxi8-evidence/c-rows-launch.txt`, `c-rows-during{,2,3}.txt`.

- **(d) `/settings` → Plugins page — NOT FOUND, this is a real gap, not an auth-block.** Swept all
  10 tabs the settings TUI actually has in this installed build (`omp v17.2.9`): Appearance, Model,
  Interaction, Context, Memory, Files, Shell, Tools, Tasks, Providers — none contain any
  animations/box/plugin-specific settings (checked every row of every tab, including scrolling
  Appearance/Tools to their true bottom). There is no "Plugins" tab at all. `/plugin` and
  `/plugins` both just print a static, non-interactive list (`npm plugins: @oh-my-pi/animations@0.1.0`)
  — no drill-down, no per-plugin key/enum listing. This means the 3 box settings keys are
  **not currently surfaced in the `/settings` TUI of the installed omp binary** (a newer version,
  17.2.10, was flagged as available via an in-app banner but was not installed, per this bead's "no
  workarounds, report the blockage" instruction extended to unexpected UI gaps — updating the
  sandbox's omp binary was out of scope and not attempted). The 3 keys are confirmed working via
  their env-var overrides (scenarios a/b/c above); whether they're reachable through
  `omp plugin config set/get/list @oh-my-pi/animations <key> <val>` (the CLI path `dxi.1`'s README
  rewrite documents as primary) was not tested — worth a quick follow-up, but is a CLI check, not a
  `/settings` TUI one, and wasn't part of this bead's literal step (d). Evidence:
  `/tmp/dxi8-evidence/d-settings-1.txt`, `d-settings-tabs-scan.txt`, `d-{model,interaction,context,
  memory,files,shell,tools,tasks,providers}-tab.txt`, `d-appearance-{scrolled,bottom}.txt`,
  `d-plugins-{list,cmd}.txt`.

- **(e) Border breathing — PROVEN with an honest capture-method caveat.** Extracted the box's own
  top-border RGB color (`\x1b[38;2;R;G;Bm`, isolated from the separate, always-blue model-status
  header border by matching the exact 69-col all-dash stripped line) across 8 idle samples spread
  over ~9s: **constant** at `31;37;45` in every single sample — the border does not visibly change
  while nothing is happening. Then drove a real multi-step prompt and sampled the same border color
  6 times at ~1s intervals during active generation: `42;48;56`, then two samples with no color code
  immediately preceding the corner cell (i.e. it drops to the terminal's default/uncolored state),
  then `42;48;56` again, then back to the idle baseline `31;37;45` — a different color on at least 3
  of 6 one-second samples versus a flat 8-for-8 constant at idle. **Caveat, stated plainly:** a text
  capture proves discrete ANSI color-code changes frame to frame — it does not and cannot prove a
  smooth perceptual brightness waveform (the actual "breathing" look) at sub-second resolution;
  that visual judgment is exactly the kind of thing that belongs in Rohit's live acceptance pass,
  per the bead's own acceptance criteria. What IS proven here: the border is not static color during
  activity, and it is perfectly static at idle — consistent with an activity-gated motion effect,
  not a bug. Evidence: `/tmp/dxi8-evidence/e-breathe-{t0,t1,s1..s6}.txt` (idle),
  `e-breathe-active-s1..s6.txt` (active).

- **Not exercised, explicitly out of this bead's given scope:** `dxi.7`'s worker-note item (2) —
  Audit Trail Box's footer alert firing from a real stale-file scenario under real disk I/O in `box`
  mode. This bead's assigned step list (from the team-lead brief) covers gates + scenarios (a)–(e)
  above only; triggering a real stale-file/poisoned-audit condition in the sandbox was not part of
  it and was not attempted, to avoid unrequested scope creep into the sandbox's scratch repo. Flagged
  here, as the prior worker asked, for a follow-up bead if wanted.

- **Sandbox left in a clean state.** All `omp --profile anim-keepset` sessions launched during this
  bead were exited via `/exit` (never killed/signaled) before the next scenario; the `anim-keepset`
  tmux session itself was left running (created fresh by this bead, at the required 69x42 /
  `/tmp/omp-anim-keepset`) for Rohit's own live acceptance pass. `xxz6` and `omp-anim-showcase` were
  never touched; `/tmp/omp-anim-sandbox-20260730` was never touched; no credentials were seeded; no
  `--plugin-dir` flag was used; no git command was run inside any `/tmp` tree.

**Gate:** `bun test` — 906 pass / 0 fail / 2858 expect() calls / 24 files (exit 0). `bun run
check:types` — clean, exit 0. `./node_modules/.bin/biome check .` — 84 files, no fixes, exit 0. All
three run at HEAD `8d5c48cd05f8d06e7cf624e6211836b51aaf9d2f` (no code changes made in this bead —
verification only).

**Files touched:** `plans/PROGRESS.md` (this entry) only. `/tmp/dxi8-evidence/*.txt` and the 3
`.log` files hold the raw capture/gate evidence referenced above (not committed — outside the repo).

**Remaining checklist for Rohit's live acceptance:** (1) visually confirm the border breathing
*looks* like a smooth pulse, not just a discrete color flip — this bead proved the color changes,
not the perceived motion quality; (2) decide whether the missing `/settings` → Plugins UI page is
in-scope for this plan or a follow-up (env-var + CLI config path both otherwise work); (3) Audit
Trail Box's real stale-file alarm end-to-end in `box` mode (dxi.7's worker-note item (2), not
attempted here); (4) anything about the box's visual polish at 69 cols this bead's automated column
checks can't see (color harmony, glyph legibility, subjective "does it look finished").
