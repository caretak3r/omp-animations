# Plan 007 — Ship an omp-native default (curated subset + `subtle` tier)

**Written against commit:** `c74be86` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** native coherence (defaults) · **Effort:** S · **Risk:** LOW · **Do this FIRST**

## Why this matters

The shipped default is the maximal-footprint configuration. `package.json#omp.settings` sets the tier
`animations` default to `"full"` and **all 17 animation booleans default `true`** (verified). Combined
with the fact that each animation self-mounts its own editor row (see Plan 009), the *first-run install*
produces ~18-20 persistent rows stacked around a single input editor — exactly the state a live test in
stock omp 16.3.12 called "horrible / breaking the terminal structure."

omp's own aesthetic is **restraint**: one dense self-eliding status line; ambient info in `dim`/`muted`.
Shipping every animation maxed on first mount is anti-native regardless of per-animation polish. The
knobs to fix this already exist (Plan 001 made settings actually work) — this is a pure default-value
change, no code.

## The fix — change defaults in `package.json#omp.settings`

Set the tier default to `subtle` and enable **only a curated, low-footprint, semantically-native subset**
out of the box; everything else defaults `false` (still user-enableable).

**Recommended on-by-default set** (the single-line, native-feeling ones): `contextWeather`, `tokenTide`,
`costCandle`. Everything else (`toolConstellation`, `contextConstellation`, `sessionBonsai`,
`todoMeteors`, `breathingBorder`, `agentFleet`, `reflectionRipple`, `memoryCrystals`, `diffBloom`,
`cadenceEqualizer`, `goalHorizon`, `modelWeatherVane`, `promptCharge`) → `default: false`.

> **This subset is a maintainer call.** If you disagree with the three, pick a different low-footprint
> set — but keep it small (≤4) and prefer single-line animations over the multi-row grids
> (`toolConstellation` 3 rows, `contextConstellation` 2 rows) and unbounded ones (`sessionBonsai`).
> If Plan 009 (consolidation) lands later, "all-on" becomes survivable and this softens to just the
> `subtle` tier default — leave a comment in `package.json` noting that.

### Steps
1. In `package.json`, `omp.settings.animations.default`: `"full"` → `"subtle"`.
2. For each animation boolean NOT in the on-by-default set, change `"default": true` → `"default": false`.
   Leave `contextWeather`, `tokenTide`, `costCandle` (or your chosen set) at `true`.
3. **Do NOT change `resolveAnimationsConfig`'s code defaults in `src/registrar.ts`** — that fallback
   (enabled=true, tier=full) is the *code* default used when a key is entirely absent from both settings
   and env; the manifest default is what a fresh omp install writes/ё shows. Keep them intentionally
   distinct, and add a one-line comment in `registrar.ts` near `DEFAULT_TIER`/`resolveBoolean` noting
   "manifest ships a curated subset at `subtle` (package.json#omp.settings); the code fallback stays
   all-on/full for direct programmatic use." (If you find this split confusing, ALSO set the code
   fallback tier to `subtle` — but the enable-map code fallback must stay `true` or disabled-by-omission
   animations would never mount when a user enables just one. Prefer leaving code as-is + the comment.)
4. Update `README.md`: the "Defaults are all-on at tier full" line (and the settings table's Default
   column) → the new curated default. State the on-by-default set and that any animation is one
   `omp plugin config set … true` away.

## Files in scope
`package.json`, `README.md`, and a one-line comment in `src/registrar.ts` (no logic change there).

## Files OUT of scope
Any animation render/controller/widget code; `src/registrar.ts` LOGIC (only a comment); the settings
schema *keys* (only their `default` values change).

## Test plan (behavioral)
- Add/extend a test in `test/registrar.test.ts` that reads the actual `package.json#omp.settings` defaults
  and asserts: tier default is `subtle`; exactly the curated set defaults `true`; the rest default
  `false`. (Read `package.json` in the test via `Bun.file`/import — this is behavioral, asserting the
  shipped manifest, not source-grepping logic.) This locks the native default against regression.
- Confirm existing `resolveAnimationsConfig` tests still pass unchanged (code fallback is untouched).

## Done criteria
- `cd /Users/rohit/Documents/oh-my-pi-animations && bun run fix && bun check && bun test` → exit 0, 0 fail,
  pass ≥ 807 + the new manifest-default test.
- `package.json` ships `animations: subtle` and only the curated subset `true`; README matches.

## Maintenance note
This is the interim native-default fix. Once Plan 009 consolidates all animations into one shared ambient
surface, revisit: "all-on" may become acceptable (one row regardless of count), at which point this
narrows to just the `subtle` tier default. Keep the manifest-default test as the guard.
