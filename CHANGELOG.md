# Changelog

All notable changes to `@oh-my-pi/animations` are documented here.

## [Unreleased]

### Changed
- Default Unicode progress bars now round to whole cells, avoiding intermittent
  font fallback and width seams from fractional eighth-block boundary glyphs.
  The Nerd glyph preset retains sub-cell resolution as an explicit opt-in.
- Kept the curated animations in one plugin package. The registrar owns one
  controller, one scheduler, and one `AnimationHost`.
- Grouped the Audit Box into six ordered summaries (`files`, `context`,
  `cache`, `audit`, `limits`, `tools`) plus independently optional groups.
  Live Files replaced the historical Palimpsest row and reports current edit
  and write ownership only. It does not preserve edit history or heat.
  Cadence and Reflection render after one conditional blank separator.
- Consolidated Audit Trail into the Box. One headless service now owns the
  ledger, disk probe, and remedy command. Probe alarms render in the Box's
  `audit` summary; the duplicate standalone row and footer status are absent.
- Merged the complete cache analytics into the Box's `cache` summary. One row
  now carries hit percentage, saved cost, hits/requests, and the uncached,
  reused, and stored token totals from one ledger snapshot per frame. The
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
- **Optional operational signals.** Added Live Files, Recurrence Strip,
  Context Rewrite Shadow, Compaction Scar, Consent Lock, Session Phylogeny,
  Think/Act Lissajous, Error Isotope, Queue Fog, Skill Chromatograph, Retry
  Radar, Goal Heading, TTFT Split, Memory Backend Tide, and Darkroom Title.
  Together with Agent Bonsai, these are the 16 approved signals. Each signal
  has an independent setting. The row settings default to enabled.
  The sidecar uses a second widget on the existing `AnimationHost` and returns
  zero rows when it has no meaningful state. Darkroom Title uses the terminal
  title instead of a widget row. No second package or omp-core change is
  required.
- **Live-frame grading loop.** `bun run probe` samples the Audit Box out of a
  running tmux session into `.frames/run-<timestamp>/`, keeping one file per
  distinct box state; `bun run probe:lint` grades those captures against the
  render invariants in `scripts/frame-lint.ts` and exits non-zero on any
  violation. Each rule cites the issue that paid for it and outlives that
  issue as a regression ratchet, so a defect found by eye in one session
  becomes a check the next session cannot pass through. `test/frame-lint.test.ts`
  pins both directions — a broken capture fires the expected rule set, a fixed
  box fires nothing — so the linter cannot quietly stop detecting.
- **Context Quota Gauge.** The first required summary in the Audit Box: a fill
  bar for the context window measured against the compaction quota, the
  used/total token counts, and the turns of headroom left at the current burn
  rate.
  - `animationsContextQuota` (default `80`, clamped to `5`–`100`,
    `OMP_ANIMATIONS_CONTEXT_QUOTA`) sets the percentage of the window that
    counts as full, because compaction fires before the window is. The bar
    pins at full past the quota instead of overflowing.
  - The bar's gradient and the row's dot follow the *window* percentage, using
    the host's own `getContextUsageLevel` bands, so the color means the same
    thing here as it does in the status line. `warning` and `purple` both read
    as `notable`; only `error` escalates to `alert`. Nothing flashes.
  - The forecast needs two consecutive growing turns before it publishes a
    rate, and a shrinking or flat turn re-baselines instead of sampling. A
    compaction drops the forecast; a session switch resets the whole row.
  - The reading is read fresh per render from `ExtensionContext.getContextUsage()`,
    not from the frame tick, so the top row is correct with `animations: off`.
    A host that does not expose the method, or reports a zero window, leaves
    the row resting on its placeholder and never throws.
- **Agent Bonsai and activity roster.** Replaced Agent Tree with a Box-owned
  `agents` group backed by a plugin-local telemetry bus. Root and headless
  plugin sessions publish exact agent, tool, and file-mutation activity
  without any `omp` core change. Rows show stable cohort IDs, semantic
  lifecycle states, model, highlighted activity, task context, and an
  active-skill link with the loaded skill list. The group and separator stay
  hidden while only Main exists.
  - Authoritative telemetry suppresses the streamed `task` fallback entirely.
    The fallback is used only before an authoritative roster snapshot exists,
    so incomparable source IDs cannot duplicate the tree.
  - Completing agents transition to a recent state, then expire through one
    cancellable per-root timer. `agentRosterRetentionSeconds` defaults to 300
    seconds and accepts `0`–`86400`.
  - The fallback still accumulates loaded skill names across updates because
    the host caps `recentTools` at five entries.
  - The skill chip emits its own OSC 8 hyperlink. The plugin gate uses
    `PI_NO_HYPERLINKS`, `PI_FORCE_HYPERLINKS`, `NO_COLOR`, the TTY state, and
    the terminal's reported capability.
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
- Rate-limit ETAs on real sessions. The default frame scheduler read
  `performance.now()`, a process-relative clock, while a provider's
  `…-ratelimit-…-reset` header parses to absolute epoch ms, so the `limits`
  row printed the epoch as an ETA (`resets 29779368m`). Both now share one
  wall-clock base. Tests never saw it, because an injected scheduler puts the
  fixture reset and the frame clock in the same fabricated time base.

### Removed
- **Tool Constellation.** Deleted the standalone animation, its settings key
  (`toolConstellation`), its glyph-preset keys, and its tests. The star map,
  comet, per-tool particles, and the seven-way category rainbow are gone.
- The Box's `tools` row is now a box-owned tally with no animation behind it.
  It reports the total call count and the two busiest tool categories. It
  never names reads or writes, because the `audit` row owns the file metrics
  from the ledger, and one number must have one owner.
- **The `display` setting, with its `rows` and `both` modes.** The plugin now
  mounts the Audit Box and signal sidecar through one controller. A stale
  `display` of `rows` or `both`, in a settings file or as
  `OMP_ANIMATIONS_DISPLAY` in a shell profile, logs one migration warning at
  wire time and mounts both widgets anyway. A `display` of `box` stays silent.
  No removed value throws.
- The legacy `auditTrailBox`, `cacheMeter`, `palimpsest`, and
  `rateLimitTidepool` booleans. Audit, cache, and rate-limit summaries are
  structural parts of the box. Live Files replaces Palimpsest and has the new
  `liveFiles` setting. `agentBonsai`, `breathingBorder`, `cadenceEqualizer`,
  and `reflectionRipple` keep their existing booleans.
- **Every standalone widget and controller behind the curated animations.**
  Animation directories are pure state plus renderers. The headless Audit
  Trail service retains its ledger and probe. The shared controller owns two
  widget registrations on one host and scheduler. `/cache` is registered by
  the registrar against the controller's cache ledger.

### Validation
- `bun run fix && bun run lint && bun run check && bun test` passed with
  1041 tests, 3607 assertions, and 0 failures across 40 files.
- The isolated `/tmp/omp-anim-sandbox` live TUI showed the signal sidecar
  above the editor and the Audit Box below it. Live Files showed
  `live-signal-smoke.txt` only while the write was active, then returned to
  idle. Darkroom Title projected `omp ctx 3`.
- `bun run probe:lint` passed the stable live frame with 0 violations.
