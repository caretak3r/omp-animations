# Changelog

All notable changes to `@oh-my-pi/animations` are documented here.

## [Unreleased]

### Changed
- **T6 — Curated to the 8-animation keep-set.** Reduced the registrar and the
  shipped animation set to eight animations: Audit Trail Box, Breathing
  Border, Cache Meter, Cadence Equalizer, Palimpsest, Rate-Limit Tidepool,
  Reflection Ripple, and Tool Constellation. Every other animation described
  below (the rest of Wave 1 and Wave 2, plus the later additions) is no
  longer part of this package; its source is not in this repository. Pruned
  `package.json#omp.settings`, `src/index.ts`, and `src/registrar.ts` to
  match, and registered the four keepers whose factories predate the
  per-animation placement/accent settings (`breathingBorder`,
  `cadenceEqualizer`, `reflectionRipple`, `toolConstellation`) at the
  placement their widgets already hardcode.
- Vendored Cadence Equalizer's own copy of the tok/s bucket classification
  and color-ramp module it used to share with Token Tide, since Token Tide is
  no longer part of this package.
- Reworked the test suite for the 8-animation keep-set: removed assertions
  and fixtures for excluded animations, and derived expected counts from
  `ANIMATIONS` itself instead of hardcoding them.
- Adapted to stock oh-my-pi API surface: dropped core edits are read defensively so the
  plugin builds against `@oh-my-pi/pi-coding-agent@16` / `pi-tui@16` and degrades
  gracefully (`renderUnderPressure` backpressure; Context Weather compaction forecast).

### Added
- **T1 — Scaffold.** Initial standalone single-package repo: Bun/TypeScript project,
  `biome` + `tsgo` tooling matching oh-my-pi conventions, npm dependencies on
  `@oh-my-pi/pi-coding-agent`/`pi-tui`/`pi-utils` (`^16`), and the asset type shim.
- **T2 — Vendored kit.** The `pi-animation` kit (`AnimationHost`, `MotionPolicy`,
  `AnimatedWidget`, `backpressureFromTui`) vendored under `src/kit/`, consumed via a
  repo-internal relative path — never as an external `@oh-my-pi/pi-animation` dependency.
- **T3 — Wave 2 (15).** Tool Constellation, Token Tide, Session Bonsai, Todo Meteors,
  Breathing Border, Agent Fleet, Cost Candle, Reflection Ripple, Memory Crystals,
  Context Constellation, Diff Bloom, Cadence Equalizer, Goal Horizon, Model Weather Vane,
  Prompt Charge — extracted with a mechanical import rewrite and a uniform factory
  refactor to an injected `motionSetting` tier.
- **T4 — Wave 1 (3).** Context Weather (mountable extension), Spinner Packs and
  Compaction Vacuum (library modules). Retry Radar excluded.
- **T5 — Registrar.** One config-driven plugin entry (`src/registrar.ts`, declared in
  `package.json#omp`): a per-animation enable map + shared `animations` tier that mounts
  only enabled animations, with zero subscriptions left for disabled ones.

### Validation
- `bun check` green; `bun test` 688 pass / 0 fail / 2322 expect() calls across 18 files
  (the current 8-animation keep-set).
