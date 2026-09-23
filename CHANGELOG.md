# Changelog

All notable changes to `@oh-my-pi/animations` are documented here.

## [Unreleased]

### Fixed
- Uncaught `RangeError: Temporal evidence snapshot time must be finite and
  monotonic` thrown from the frame timer, taking the whole omp session down.
  The shared clock is `Date.now()` (wall-clock epoch ms, required for
  provider `resetAt` instants), which steps backward on NTP correction or
  sleep/wake; the evidence store asserted monotonic time on it. It now
  rebases every stored entry by the step so ages are preserved, and only
  throws on a non-finite or negative time.
- A throw from the Audit Box's frame loop or paint no longer escapes into
  the host's timer as an uncaught exception. `AnimatedWidget` now detaches
  from the frame clock and the motion policy, reports the error once
  through `api.logger.error`, and renders a single
  `✕ animations box disabled · <error>` line for the rest of the session
  instead of freezing on stale telemetry.
- Extension load failure on host v18 (`export 'splitPathAndSel' not found in
  'omp-legacy-pi-bundled:@oh-my-pi/pi-coding-agent/tools/path-utils'`):
  `splitInternalUrlSel`/`splitPathAndSel` moved to
  `@oh-my-pi/pi-tui/tools/read`, and `getContextUsageLevel`/
  `getContextUsageThemeColor`/`ContextUsageLevel`/`SymbolPreset`/`Theme`/
  `ThemeColor` moved to `@oh-my-pi/pi-tui/chrome/context-thresholds` and
  `@oh-my-pi/pi-tui/theme/theme` between host v17 and v18. Repointed both
  fence files (`src/host/runtime.ts`, `src/host/types.ts`) and bumped the
  `@oh-my-pi/pi-coding-agent`/`@oh-my-pi/pi-tui` pins to the v18 line so a
  fresh install works against the currently-shipping host.

### Changed
- Agent Bonsai's activity and provenance rows now render plain-language
  phrases (`read review skill ✓`, `recalled memory ✓`) instead of
  letter-code bracket chains (`[S review ✓]`, `[M recall ✓]`); the row no
  longer prefixes each agent's provenance with its own name. `simple` and
  `readable` both keep Agent Bonsai to one line per agent; only `detailed`
  adds the activity/provenance sub-rows. `animationsBoxDetail` gains this
  new `readable` value and becomes the default in place of `detailed`.
- Agent Bonsai's model chip (`provider/id[:thinkingLevel]`) now leads each
  row right after the agent name, in bold accent, instead of trailing in
  dim after the skill chip and task description — the model and effort an
  agent is running are the first thing a reader sees.

### Docs
- Rewrote `README.md` with a table of contents, a captured VHS demo GIF
  (`.media/demo.tape` records three parallel scout subagents against a live
  Audit Box), and settings/signal-extra tables in place of prose. Fixed
  three factual bugs the rewrite surfaced: the `verify`, `authBeacon`, and
  `asyncJobHarbor` signal extras were shipped but never documented, and
  `agentRosterDetail` had no settings-table entry.
- Documented the `display.shimmer` / Agent Bonsai boundary in `README.md`
  and `AGENTS.md`: the transcript's name-shimmer is host UI the plugin
  cannot see or suppress; pair `omp config set display.shimmer disabled`
  with `agentBonsai: true` instead.

### Added
- `verify` row shows writes newer than the last successful bash; it
  disappears when the count reaches zero and never claims positive verification.
- `package.json` now declares `repository`, `homepage`, `bugs`, and `author`,
  and ships `LICENSE` in the published `files` allowlist. The README documents
  a git-spec install (`omp plugin install git+ssh://…`) alongside the existing
  local-path install, and notes that a local install needs one `bun install`
  the source checkout does not run for you.
- `authBeacon` row names credentials the host disabled this session;
  the error row lists truncated replies, dropped features, and provider
  reroutes, and a retry fallback shows as `fallback <from>→<to>` until it
  succeeds. The box border holds the error palette while a beacon is up.
- Agent Bonsai now distinguishes a completed agent from a pending one, flashes
  once through the shared status span, then settles to a dim grey row and
  evicts after `animationsBonsaiSettleSeconds` (default `300`). The sweep runs
  on render, so eviction still happens with `animations: off`. A running
  agent is never evicted; over the row cap, settled agents hide before
  running ones. Failed and aborted agents keep their error color through the
  grey phase instead of dimming into a false success look.
- The phylogeny row shows `off-path $X.XX` when the session tree has spent at
  least half a cent on entries outside the current branch. The figure is the
  host's tree total minus the branch total and is never eased.
- The `files` row marks a path that two or more agents are writing at once
  with the alert tone and appends `N writers`; each colliding agent's Bonsai
  row carries a `write-clash` chip. Both derive from active roster
  operations and clear the moment one writer finishes.
- Agent Bonsai joins the roster on the exact allocated agent name; the
  fallback-name lookup that could attach a second agent's progress to the
  wrong row is gone.

### Changed
- Agent Bonsai bounds its own height instead of expanding without limit: at
  most 8 nodes render per frame, and of those, at most 3 keep their
  activity/provenance sub-rows — running and aborted agents claim both
  budgets before idle or completed ones. Simple detail mode drops every
  activity/provenance sub-row outright. Whatever the box still can't show,
  from either cap, is named by display name in the trailing `… +N more`
  line, so a failed agent past the visible edge is never silently dropped.
- The Breathing Border's `subtle` motion tier now softens the perimeter's
  perceived motion, not only its frame rate: the breath pulse's brightness
  swing is scaled to 60% of `full`'s, the clockwise gloss head dims to 70%
  of `full`'s peak, and the gloss trail widens from a short wrapped band to
  a longer, gentler falloff. The moving head stays visible at `subtle`'s
  breath peak; `full` is unchanged; `off` and reduced motion remain static.
- A corner cell now flashes to the border's peak color when the moving gloss
  head's own trail falloff passes close enough, instead of always sharing
  every other non-head cell's demoted token. The flash uses only the
  existing three-token palette and is gated on the gloss trail itself, so
  high ambient breathing brightness alone never triggers it from across the
  perimeter.
- The `limits` row leads with provider response health read from the HTTP
  status of each `after_provider_response`: `http 200 · N ok` while healthy,
  per-class non-2xx counts worst-first plus the newest failure's status and
  age once anything went wrong. The header-derived headroom is a wide-only
  tail. The row stays idle until the first response instead of for the whole
  session on providers that send no rate-limit headers.
- The context row drops the `configured budget` span and hides a turns
  forecast above 99; the turns span survives 45 columns before the used span.
- The context row's wide-only tail restates fill as tokens left of the quota
  ceiling (`40K left of 160K`) instead of raw tokens against the model window.
- The rewrite row activates only once the host stripped 512 tokens or more,
  measures `sent` from the latest assistant `message_end` usage, and no longer
  paints `stripped ~0`. Audit read/write spans appear only above zero, and
  memory readiness that is merely stale by age renders muted.
- Agent Bonsai suppresses a sibling's task tail and model chip when they
  repeat the previous row at the same depth; `(completed)` still renders.
- The `jobs` row is on by default and appends `oldest Ns`/`Nm` from the
  longest-running background job's start time.
- Every host subpath import now routes through `src/host/types.ts` or
  `src/host/runtime.ts`; a Biome `noRestrictedImports` override rejects any
  other `@oh-my-pi/pi-coding-agent/*` import under `src/`. A differential
  test spawns the installed host resolver against fixture homes and asserts
  the plugin's settings mirror matches it, including the corrupt-lockfile
  divergence where the host throws and the mirror falls through to project
  overrides.
- Agent Bonsai extracts short task summaries before truncation. Line breaks
  retain spaces, and roster projection preserves literal text in summaries.
- Narrow context rows keep each bar whole or omit it. The percentage takes
  precedence over the bar when both cannot fit.
- Frame grading rejects context bars with missing brackets, incorrect cell
  counts, or ellipsis truncation. Agent activity cells remain separate.
- Frame probes retain raw synchronization evidence in unique run directories.
  Captures taken during synchronized output no longer count as completed frames.
- Frame grading distinguishes Audit Boxes from tool output. Separate agents
  can share model labels and assignment text without duplicate-chip errors.
  Incomplete borders and malformed settled frames still fail.
- Cache summaries distinguish recent token reuse from session requests with
  reuse. Cold workloads no longer imply that a provider cannot cache.
- Context labels distinguish the configured budget from the model window.
  Rewrite token estimates carry `~`; compaction counts describe ordinary reads.
- Narrow agent rows preserve current work before model metadata. Compact
  resource trails name their owner once and retain outcomes and omission cues.
- Context quota fill now uses the standard progress bar as its only visual.
  Unicode and Nerd presets retain the existing whole-cell rendering contract.
- Audit Box details now stay in one evenly spaced, middle-dot-separated phrase
  instead of jumping to a distant tail column. The `tools` summary leads with
  the active tool and elapsed time, then settles to total calls and the busiest
  categories. Internal latency and work-phase diagnostics no longer compete
  with the operator signal.
- Full motion now pulses the Audit Box's whole square perimeter through a
  heavier crest. Active status markers pulse while agent names and resource
  labels stay steady. Actual fact changes retain a short flash, and failed
  or aborted status markers keep their error emphasis.
- Repeated tool sequences now appear only after a real repeat and say
  `same tools as previous turn`; the opaque loop/orbit vocabulary is gone.
- Agent Bonsai now renders recent tool, skill, and file activity as an
  indented chain beneath the owning agent. The primary row keeps agent context
  separate. Active status markers pulse in place; completed and failed cells keep
  stable success and error colors. Settled activity expires after eight
  seconds, and narrow layouts discard the oldest cells first.
- The `skills` and `memory` summaries distinguish successful reads, active
  attempts, and failures from catalog availability and backend readiness.
  Counts describe retained recent observations, not lifetime use.
  Failed outcomes take precedence when narrow layouts omit details.
- The `seen-skill` label identifies an inferred reference, not proof of
  application. Selector-bearing reads preserve resource ownership, including
  literal filenames that resemble selectors.
- Signal extras now use one fixed-capacity, caller-clocked evidence store.
  Each frame uses one immutable snapshot. Strict adapters retain only
  allowlisted scalar facts and keep unsupported effects hidden.
- Memory Backend Tide now labels count changes as observed deltas. It keeps
  the last good observation after a poll failure and does not claim writes.
- Goal Heading no longer keeps goal text. Session Phylogeny no longer keeps
  labels or session identifiers. Error Isotope now reports only an aggregate
  count of tool failures.
- Live-frame grading now selects the plugin-owned box and ignores unrelated
  bordered tool output. Burn forecasts stop at `>99 turns left`, detail rows
  use one separator, and wide tails start in one column.
- Default Unicode progress bars now round to whole cells, avoiding intermittent
  font fallback and width seams from fractional eighth-block boundary glyphs.
  The Nerd glyph preset retains sub-cell resolution as an explicit opt-in.
- Kept the curated animations in one plugin package. The registrar owns one
  controller, one scheduler, and one `AnimationHost`.
- Grouped the Audit Box into six ordered summaries (`files`, `context`,
  `cache`, `audit`, `limits`, `tools`) plus independently optional groups.
  Live Files replaced the historical Palimpsest row and reports current edit
  and write ownership only. It does not preserve edit history or heat.
  Reflection Ripple renders after one conditional blank separator.
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
- Reworked the test suite for the curated set. Removed assertions and fixtures
  for excluded animations and derived expected counts from `ANIMATIONS`.
- The plugin accepts older v17 hosts defensively for rendering backpressure,
  compaction forecasts, and session-resource metadata. Current hosts provide
  exact discovered skills and context-file metadata through the public
  extension context.

### Removed
- **The `tools` row (`toolActivity`).** Deleted the row's state, builder,
  metadata, and settings/registry wiring, along with its direct tests,
  goldens, and screenshot fixtures. The Audit Box now holds five core rows:
  `contextGauge`, `cacheMeter`, `auditTrailBox`, `rateLimitTidepool`,
  `filesLive`. The `verify` signal extra already owns the "writes newer than
  the last successful bash" fact this row used to carry.

### Added
- **Optional operational signals.** Added Live Files, Recurrence Strip,
  Context Rewrite Shadow, Compaction Scar, Consent Lock, Session Phylogeny,
  Think/Act Lissajous, Error Isotope, Skill Chromatograph, Retry Radar, Goal
  Heading, TTFT Split, Memory Backend Tide, and Darkroom Title. Together with
  Agent Bonsai, these are the 15 approved signals. Each signal has an
  independent setting. The curated defaults keep Think/Act Lissajous, Goal
  Heading, and Darkroom Title disabled.
  The signal rows use the existing `AnimationsBoxWidget` and use zero rows
  when they have no meaningful state. Darkroom Title uses the terminal title
  instead of a widget row. No second package is required.
- **Bounded evidence replay and effect kernels.** Added deterministic replay,
  strict payload normalization, finite lifecycle kernels, and capability
  fixtures for Unicode, ASCII, color, no-color, reduced motion, and pane
  width. Effects stay hidden when the host does not supply exact evidence.
- **Collision diffraction.** Two or more live evidence classes can add one
  finite diffraction token to the existing top border. The token uses the
  same immutable frame snapshot and does not replace a signal row.
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
- **T3 — Wave 2 (14).** Tool Constellation, Token Tide, Session Bonsai, Todo Meteors,
  Breathing Border, Agent Fleet, Cost Candle, Reflection Ripple, Memory Crystals,
  Context Constellation, Diff Bloom, Goal Horizon, Model Weather Vane, and
  Prompt Charge. These animations use mechanical import rewrites and an
  injected `motionSetting` tier.
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
- `bun.lock` had pinned exact versions (`17.3.4`) for deps that `package.json`
  declares as ranges (`^17`), so a fresh `bun install` silently rewrote the
  lockfile on every clean checkout. Regenerated it to match `package.json`.

### Removed
- **Cadence Equalizer.** Deleted the token-throughput row, its settings and
  environment keys, package exports, and tests. The Audit Box no longer
  subscribes to message updates for this display.
- Removed the rejected quota-metaphor branch, including the
  `animationsContextStyle` setting and the `lightning`, `storm`, and `arc`
  renderers.
- **Tool Constellation.** Deleted the standalone animation, its settings key
  (`toolConstellation`), its glyph-preset keys, and its tests. The star map,
  comet, per-tool particles, and the seven-way category rainbow are gone.
- The Box's `tools` row is now a box-owned tally with no animation behind it.
  It reports the total call count and the two busiest tool categories. It
  never names reads or writes, because the `audit` row owns the file metrics
  from the ledger, and one number must have one owner.
- **The `display` setting, with its `rows` and `both` modes.** The plugin now
  mounts one complete Animations Box through one controller. A stale `display`
  value of `rows` or `both` logs one migration warning at wire time and still
  mounts the box. A `display` value of `box` stays silent. No removed value
  throws.
- The legacy `auditTrailBox`, `cacheMeter`, `palimpsest`, and
  `rateLimitTidepool` booleans. Audit, cache, and rate-limit summaries are
  structural parts of the box. Live Files replaces Palimpsest and has the new
  `liveFiles` setting. `agentBonsai`, `breathingBorder`, and
  `reflectionRipple` keep their existing booleans.
- **Every standalone widget and controller behind the curated animations.**
  Animation directories contain pure state and renderers. The headless Audit
  Trail service retains its ledger and probe. The shared controller owns one
  widget registration, host, and scheduler. `/cache` uses the controller's
  cache ledger.

### Validation
- `bun run fix && bun run check && bun run lint && bun test && bun run probe:lint`
  passes with 1201 tests, 4367 assertions, and 0 failures across 52 files.
