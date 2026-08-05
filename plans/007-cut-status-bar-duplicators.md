# Plan 007 — Cut the 6 status-bar duplicators + set an omp-native default

**Written against commit:** `c74be86` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** native coherence (scope + defaults) · **Effort:** M · **Risk:** LOW · **Do this FIRST**

## Why this matters

omp condenses live state into ONE dense status line. Its status-line segments already include (verified
in the stock source `packages/coding-agent/src/modes/components/status-line/segments.ts` +
`presets.ts`): `model`, `cost`, `context_pct`, `token_rate` (`<N> tok/s`), `token_total`, `subagents`,
`goal` (budget), `git`, `path`, `time`, `usage`, `cache_*`. Six of our animations **re-render a signal
omp already shows there**, as separate stacked editor rows — the opposite of native:

| Cut | Signal it draws | omp status-line segment it duplicates |
|---|---|---|
| `token-tide` | tokens/sec waveform | `token_rate` |
| `cadence-equalizer` | tokens/sec VU meter | `token_rate` |
| `cost-candle` | spend | `cost` |
| `context-weather` | context % barometer | `context_pct` |
| `context-constellation` | context % as stars | `context_pct` |
| `model-weather-vane` | current model | `model` |

Decision (maintainer-confirmed): **keep only animations that show something omp does NOT already
surface.** These six add no new information — only a second, less-dense, non-native rendering. Cutting
them removes the redundancy AND ~40% of the stacked-row footprint in one step.

**The 8 that stay (genuinely additive — no status-line equivalent):** `tool-constellation` (per-tool
activity), `session-bonsai` (branch tree), `todo-meteors` (todos), `diff-bloom` (edit diffs),
`reflection-ripple` (TTSR), `memory-crystals` (compaction events), `breathing-border` (ambient
presence), `prompt-charge` (input length). Plus two **borderline kept for now, flagged for separate
review**: `goal-horizon` (omp shows goal budget only if `goal.statusInFooter`) and `agent-fleet` (omp
shows the subagent *count*; Agent Fleet adds a per-agent viz).

## Special case — Context Weather

`context-weather` is a **standalone package** (`src/context-weather/`) and the shipped Wave-1 flagship,
and it adds a pre-compaction *storm forecast* that omp's plain `context_pct` doesn't — but only on cores
that expose the `tokensUntilCompaction` hook (absent in stock 16.3.12, where it degrades to a pure
context-% barometer = duplicate). So: **UNREGISTER it from the suite (remove from the registrar +
manifest + barrel), but KEEP its `src/context-weather/` code and `test/context-weather*` tests intact**
— it retains standalone value if a future core exposes the hook. Do NOT delete Context Weather.

## Steps

1. **Registrar** (`src/registrar.ts`): remove all 6 entries from the `ANIMATIONS` array
   (`toolConstellation`… list) — the `token-tide`, `cadence-equalizer`, `cost-candle`, `context-weather`,
   `context-constellation`, `model-weather-vane` mount entries. Remove their now-unused imports.
2. **Manifest** (`package.json#omp.settings`): delete the 6 boolean keys (`tokenTide`, `cadenceEqualizer`,
   `costCandle`, `contextWeather`, `contextConstellation`, `modelWeatherVane`) AND Context Weather's 4
   sub-settings (`contextWeatherStyle`, `contextWeatherPlacement`, `contextWeatherStormAtPercent`,
   `contextWeatherNotifyOnImminent`).
3. **Barrel** (`src/index.ts`): remove the 6 `createXExtension` re-exports.
4. **Delete code for the 5 pure-redundant ones** (NOT context-weather): `rm -rf` the module dirs
   `src/{token-tide,cadence-equalizer,cost-candle,context-constellation,model-weather-vane}/` and their
   tests `test/{token-tide,cadence-equalizer,cost-candle,context-constellation,model-weather-vane}.test.ts`.
   (Verified: no kept animation imports any of these, and `cadence-equalizer`↔`token-tide/scale` are both
   cut together, so no dangling imports.) **ESCAPE HATCH:** if you'd rather not delete, move them to a
   `parked/` dir and unregister instead — but do not leave them registered.
5. **Context Weather:** keep `src/context-weather/**` and `test/context-weather*` on disk; it is only
   removed from the registrar/manifest/barrel (steps 1-3). Verify nothing else imports
   `createContextWeatherExtension` after the barrel edit.
6. **Gallery + registrar tests:** update `test/wave2-gallery.test.ts` and `test/registrar.test.ts` to
   mount/expect only the remaining registered set (the 8 + 2 borderline = 10). Remove references to the
   6 cut factories.
7. **Native default for the remainder:** in `package.json#omp.settings`, set `animations.default`
   `"full"` → `"subtle"`. The remaining 10 are all non-redundant, so they may stay `default: true` — but
   note in a `package.json` comment that until Plan 009 consolidates them into one surface, 10 rows still
   stacks; a maintainer may trim further. (Leave `src/registrar.ts` code fallbacks unchanged — see the
   note in the prior Plan 001 about manifest-vs-code defaults.)
8. Update `README.md`: the animation list (18→ the retained set), the "all-on at full" line → the new
   default, and add a short "Not included: signals omp's status line already shows (tok/s, cost, context
   %, model) are intentionally left to the status bar" section explaining the design principle.

## Files in scope
`src/registrar.ts`, `src/index.ts`, `package.json`, `README.md`, `test/wave2-gallery.test.ts`,
`test/registrar.test.ts`, and the deleted `src/`+`test/` for the 5 cut modules.

## Files OUT of scope
`src/context-weather/**` + `test/context-weather*` (retained, only unregistered); the kept animations'
render/controller code (untouched by this plan); `src/kit/**`.

## Test plan
- The suite's total `bun test` count DROPS (removing ~181+ tests: token-tide 45, cadence-equalizer 50,
  cost-candle 43, context-constellation 43, model-weather-vane N). **Do NOT assert the old 807 floor** —
  record the NEW pass count after the cut and assert `0 fail` + that count. Context Weather's ~42 tests
  still pass (code retained).
- `test/registrar.test.ts`: add an assertion that the 6 cut ids are NOT in the registrar's mounted set,
  and that mounting the default set registers exactly the retained animations (zero listeners for the
  cut ones — they don't exist).
- `test/wave2-gallery.test.ts`: mounts only the retained set, still zero leaks on dispose.
- Manifest-default test (from the folded-in default work): assert `animations.default === "subtle"`.

## Done criteria
- `cd /Users/rohit/Documents/oh-my-pi-animations && bun run fix && bun check && bun test` → exit 0, 0 fail
  at the new recorded baseline.
- `grep -rn "token-tide\|cadence-equalizer\|cost-candle\|context-constellation\|model-weather-vane" src/ test/`
  returns nothing (fully removed); `context-weather` code still present but absent from `registrar.ts`,
  `package.json#omp`, and `src/index.ts`.
- README documents the retained set + the "leave status-bar signals to the status bar" principle.

## Maintenance note
This encodes the design law: **an animation earns a surface only if it shows something omp's status line
doesn't.** Apply it to any future animation. The 2 borderline (`goal-horizon`, `agent-fleet`) are a
follow-up decision — a later pass should either justify their added dimension or cut them too. After
Plan 009 consolidates the remainder into one shared surface, revisit whether `subtle` is still the right
default.
