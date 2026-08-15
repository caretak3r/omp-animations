# Changelog

All notable changes to `@oh-my-pi/animations` are documented here.

## [Unreleased]

### Changed
- **T6 — Curated to seven standalone animations plus Agent Bonsai.** Reduced
  the registrar to Audit Trail Box, Breathing Border, Cache Meter, Cadence
  Equalizer, Palimpsest, Rate-Limit Tidepool, and Reflection Ripple. Agent
  Bonsai is a Box-owned group, not a standalone animation. Every excluded
  animation below is absent from this repository. Pruned
  `package.json#omp.settings`, `src/index.ts`, and `src/registrar.ts` to
  match.
- Grouped the Audit Box into five fixed summaries (`cache`, `audit`, `limits`,
  `tools`, `files`) and independently toggleable optional animations. Cadence
  and Reflection now render after one conditional blank separator.
- Consolidated Audit Trail into the Box. One headless service now owns the
  ledger, disk probe, and remedy command. Probe alarms render in the Box's
  `audit` summary; the duplicate standalone row and footer status are absent.
- Merged the complete cache analytics into the Box's `cache` summary. One row
  now carries hit percentage, saved cost, hits/requests, and the read, write,
  and uncached token totals, all from a single ledger snapshot per frame. The
  token totals ride a trailing detail group that sheds one metric at a time
  from the right as the pane narrows, so the uncached total stays beside the
  counts instead of drifting to the border, and a compact pane keeps the hit
  state. `formatCost` is now shared with `/cache`, so both surfaces print one
  money format.
- Vendored Cadence Equalizer's own copy of the tok/s bucket classification
  and color-ramp module it used to share with Token Tide, since Token Tide is
  no longer part of this package.
- Reworked the test suite for the curated set. Removed assertions and fixtures
  for excluded animations and derived expected counts from `ANIMATIONS`.
- Adapted to stock oh-my-pi API surface: dropped core edits are read defensively so the
  plugin builds against `@oh-my-pi/pi-coding-agent@16` / `pi-tui@16` and degrades
  gracefully (`renderUnderPressure` backpressure; Context Weather compaction forecast).

### Added
- **Agent Bonsai.** Replaced Agent Tree with a Box-owned `agents` group.
  Rows show stable cohort IDs, semantic lifecycle states, model, highlighted
  activity, task context, and an active-skill link with the loaded skill list.
  The group and separator stay hidden while only Main exists.
  - Rows come from the `task` tool's streamed progress, which is the only
    subagent data a plugin can read. The in-process `AgentRegistry` singleton
    belongs to the host bundle, so a plugin always gets an empty second copy.
  - Settled rows are pruned per user request, not per provider turn. An
    `agent_end` event with `willContinue` keeps the rows. A backgrounded task
    keeps its running row until its async state leaves `running`.
  - Loaded skill names accumulate across updates, because the host caps
    `recentTools` at five entries. The plugin resolves each `skill://` name to
    a `SKILL.md` path with a memoized lookup over the known skill roots.
  - The skill chip emits its own OSC 8 hyperlink. The host's `uriHyperlink`
    gate reads a `Settings` singleton from the host bundle's module graph,
    which a plugin can never initialize, so it strips every link. The plugin
    gate uses `PI_NO_HYPERLINKS`, `PI_FORCE_HYPERLINKS`, `NO_COLOR`, the TTY
    state, and the terminal's reported capability instead.
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

### Fixed
- Kept wide cache and audit details beside their row indicators instead of
  pushing uncached-token counts and filenames to the far box edge.

### Removed
- **Tool Constellation.** Deleted the standalone animation, its settings key
  (`toolConstellation`), its glyph-preset keys, and its tests. The star map,
  comet, per-tool particles, and the seven-way category rainbow are gone.
- The Box's `tools` row is now a box-owned tally with no animation behind it.
  It reports the total call count and the two busiest tool categories. It
  never names reads or writes, because the `audit` row owns the file metrics
  from the ledger, and one number must have one owner.

### Validation
- `bun run fix && bun check && bun test` green; 1186 pass / 0 fail across
  37 files.
