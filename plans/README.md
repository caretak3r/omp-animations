# Improvement plans — @oh-my-pi/animations

Advisor audit against **`31d90c8`** (branch `main`), scoped to two axes the maintainer asked
about: **(1) oh-my-pi setup & plugin-loader compatibility** and **(2) animation speed &
aesthetics**. Read-only audit by four parallel agents; every finding below was re-verified
against the code by the advisor before it made this list.

**Baseline (all plans must preserve):** `bun check` green (biome + tsgo, 131 files);
`bun test` 773 pass / 0 fail / 3497 assertions / 26 files.
**Verification gate for every plan:** `cd /Users/rohit/Documents/oh-my-pi-animations && bun run fix && bun check && bun test` — biome+tsgo clean, test count ≥ 773 pass / 0 fail (a plan that adds tests raises the floor; none may lower it).

**Conventions (source of truth `/Users/rohit/Documents/oh-my-pi/AGENTS.md`):** `logger` not
`console.*`; Bun APIs; `bun check` not `tsc`; ES `#private` fields; star-barrel `index.ts`;
behavioral tests ONLY (no source-grep, never `mock.module()`); render/state fns PURE of
wall-clock (elapsed/phase is an input). These modules already follow it — do not regress it.

## The loader verdict (context for everything below)

Stock oh-my-pi **does** discover and load this package: its loader reads `package.json#omp.extensions`,
mounts the `.ts` `src/registrar.ts` natively, supports one extension registering 16 sub-extensions,
and keys `getPluginSettings` under the npm name `@oh-my-pi/animations` — matching the registrar.
Local `omp plugin install ./path` works (`private:true`/`0.1.0`/`files` do **not** block it).
So install is sound. The defect is that the registrar never **reads** the stored settings for
gating (Plan 001).

## Priority order & dependencies

| Plan | Title | Axis | Effort | Risk | Leverage |
|------|-------|------|--------|------|----------|
| [001](001-registrar-reads-stored-settings.md) | Registrar honors stored plugin settings (+ label + docs) | setup/compat | M | MED | **top** — the config-driven package's central promise is currently inert via the settings UI/CLI |
| [002](002-backpressure-every-host.md) | Wire render-backpressure into all animated hosts | speed | S | LOW | high — ~12 always-on widgets ignore the tested backpressure path |
| [003](003-per-frame-allocation.md) | Kill per-frame allocation in always-on hot paths | speed | M | LOW | high — ~1000 throwaway allocs/sec on the heaviest widget |
| [004](004-terminal-width-glyph-safety.md) | Terminal-width glyph safety in grids & bars | aesthetics | M | LOW | high — objective, terminal-corrupting misalignment |
| [005](005-motion-tier-polish.md) | Motion-tier ladder + off-badge polish | aesthetics | S | LOW | med — two degenerate `subtle` tiers; inconsistent off badges |
| [006](006-shared-frame-clock.md) | **SPIKE** — one shared frame clock for the family | speed (arch) | L | MED | measure-first — up to 16 timers vs. the documented one |

**Dependency notes:**
- **001 is independent** and the highest-value (setup axis). Do it first or in parallel.
- **002 should land before 006** — 002 wires backpressure per-host (small, safe, immediately effective); 006 (if pursued) later collapses all hosts into one, inheriting 002's wiring in one place. Doing 006 first would make 002 redundant, but 006 is a risky measure-first spike, so 002 is the safe near-term win.
- **002 subsumes PERF-05** (breathing-border/diff-bloom/reflection-ripple per-frame `policy.refresh()`): once those hosts take a real backpressure signal, the per-frame env re-resolution is dropped in the same plan.
- **004 and 005 are independent** of each other and of the perf plans (different files/concerns), but both re-gold behavioral snapshot tests, so run each to green before starting the next to keep test diffs legible.
- **003 and 002 touch the same controller files** in places — sequence 002 then 003 (or one executor does both) to avoid merge churn.

## Recommended GNHF scope

Safe, high-leverage set: **001 + 002 + 003 + 004 + 005**. Treat **006 as an optional spike**
(architectural, MED risk, measure the paint-batching payoff before committing to the refactor).

## Considered and rejected (do not re-audit)

- **Hardcoded ANSI palettes / theme bypass** — NOT a finding. Every widget colors through
  `theme.fg(<ThemeColor>)`; the only raw-RGB module (`spinner-packs`) is by-design custom gradients
  that degrade correctly (xterm-256 → identity under NO_COLOR/CI/non-TTY). `NO_COLOR` honored throughout.
- **Single-row sparklines "can't show dynamic range"** — NOT a finding. `token-tide`/`cadence-equalizer`
  use the standard 8-step partial-block ramp `▁▂▃▄▅▆▇█`, encoding amplitude as glyph height in one row.
- **Dispose/subscription leaks** — NOT a finding. Widgets unsubscribe host+policy; controllers call
  `host.dispose()`; the 18-mount gallery test exercises the teardown path with zero leaks.
- **`rowsEqual` redraw waste** — already handled; the kit dirty-checks and suppresses identical repaints.
- **`license: UNLICENSED` / `private: true`** — intentional per the maintainer's "keep local" decision;
  a placeholder to resolve only at publish time, not a defect to fix now. (Local `file:` install is
  unaffected.) Noted, not planned.
- **Diff Bloom `isEditToolResult` reimplementation** — runtime-equivalent to the still-present core
  helper and correct as shipped; only the docstring premise is slightly off. Too low-value to plan;
  the one-line docstring correction is folded into Plan 001's doc pass if convenient.

---

# Round 2 — native coherence with omp (plans 007–010)

A second audit (written against `c74be86`) asked one question: **do these animations match omp's own
aesthetic and design choices, or do they feel bolted-on?** Grounded in the stock omp source
(`/Users/rohit/Documents/oh-my-pi`) + a live install into stock omp 16.3.12. The omp-native yardstick:
preset-aware glyphs via `theme.symbol()`; semantic `theme.fg(muted|dim|…)`; **one** self-eliding status
line folded into existing chrome; event-driven. The two in-house natives (context-weather, spinner-packs)
already hit all of it.

**The defining principle (maintainer-confirmed):** an animation earns an ambient surface only if it shows
something omp's status line does NOT already surface. omp's status line already shows `token_rate` (tok/s),
`cost`, `context_pct`, `model`, `subagents`, `goal` budget, etc.

| Plan | Title | Effort | Risk | Leverage |
|------|-------|--------|------|----------|
| [007](007-cut-status-bar-duplicators.md) | Cut the 6 status-bar duplicators + native default | M | LOW | **top** — removes redundancy (tok/s×2, cost, context%×2, model) + ~40% of the row footprint; `subtle` default |
| [008](008-preset-aware-glyphs.md) | Route glyphs through `theme.symbol()` preset system | M | LOW-MED | high — 0 preset usage today; `ascii`/`nerd` users get mojibake |
| [009](009-consolidate-ambient-surface.md) | **SPIKE** — consolidate retained animations onto one ambient surface | L | MED | the true "match omp" fix — N stacked rows → 1 self-eliding line; subsumes 010 |
| [010](010-unmount-idle-rows.md) | Unmount idle/empty widgets instead of dead rows | M | LOW | med — kills `(no open todos)`-style dead rows; **subsumed by 009** |
| [017](017-animations-box.md) | Animations Box — one consolidated `setWidget` box for the keeper set | L | MED | **resolves 009's spike** (maintainer chose a dedicated box, 2026-08-06) and **supersedes 010** (box mode suppresses standalone rows entirely) |

**Cut list (007):** `token-tide`, `cadence-equalizer`, `cost-candle`, `context-weather` (unregister only —
code retained), `context-constellation`, `model-weather-vane`. **Retained (10, maintainer-confirmed
2026-07-13 — the borderline `goal-horizon`/`agent-fleet` decision is now settled, not deferred):**
tool-constellation, session-bonsai, todo-meteors, diff-bloom, reflection-ripple, memory-crystals,
breathing-border, prompt-charge, goal-horizon, agent-fleet.

**Round-2 sequencing:** 007 first (headline: cut + default; changes the baseline). 008 needs a
**preset-parameterized frame test** first (CI tests only one preset today, so the glyph bug is invisible).
009 is a measure-first spike (investigate `setStatus` vs one consolidated `setWidget` row) that **subsumes
010** — do 010 only if 009 is deferred. 008 and 010 are independent of each other.

## Considered and rejected — Round 2 (do not re-audit)

- **Theme color-role rework** — NOT worth doing. A role tally (`dim` 78 / `muted` / `borderMuted`
  dominant; `accent` 11 as a defensible "active" highlight; zero hardcoded hex) shows the color layer is
  the MOST native part of the suite. Verified and passed.
- **Width-safety** — handled in Round 1 (Plan 004). Round 2 is about native visual coherence, not width.

---

# Round 3 — product-direction improvements to the 6 shipped animations (plans 011–016)

A `/improve plan` pass (written against `bdad3c8`) turning the 6 pre-decided ideas in
`.demo/IDEA_WIZARD_IDEAS.md` into one self-contained plan per animation. Each was
feasibility-checked against the **installed** extension API
(`node_modules/@oh-my-pi/pi-coding-agent/dist/types/...`) before writing — several ideas
depend on data the API does not surface, so those are scoped honestly (spike / dropped
sub-scope) rather than assumed.

**Feasibility verdict per plan:**

| Plan | Title | Effort | Risk | Verdict |
|------|-------|--------|------|---------|
| [011](011-diff-bloom-git-work-effort.md) | Diff Bloom → git-backed cumulative `+adds/−dels · N files`, resets on `agent_end` | L | MED | **CONFIRMED** — `ctx.cwd`+`api.exec` for `git diff --numstat`; `agent_start`/`agent_end` events exist. Git I/O behind an injected controller seam (pure state/render preserved) |
| [012](012-agent-fleet-live-legend.md) | Agent Fleet → live legend `displayName · activity/status`, keep `+N` | M | LOW | **CONFIRMED (with caveat)** — name+status event-driven; `AgentRef.activity` exists but `setActivity` emits **no event**, so live activity needs a frame-tick `registry.list()` poll (or degrade to name+status) |
| [013](013-memory-crystals-retrieval-spike.md) | **SPIKE** — Memory Crystals → memory retrieval, not compaction | M/L | MED | **MEASURE-FIRST** — `ctx.memory` exposes only `status()`/`search()`/`save()`; backends are **mutually exclusive** (no per-source enumeration), **no recall event**, **no invoked/retained counters**. Measure `status()` fields first |
| [014](014-session-bonsai-labeled-branches.md) | Session Bonsai → label branches by entry type + resolved label | M | LOW | **CONFIRMED (re-scoped)** — `SessionTreeNode` exposes `entry.type` + `label?`; rewind/fork derivable. **`subagent:` label dropped** (subagents aren't in the session tree) |
| [015](015-goal-horizon-generic-budget.md) | Goal Horizon → pluggable bounded-budget bar (goal + context %) | M | LOW | **CONFIRMED (partial)** — goal-tokens (existing) + context-% (`getContextUsage()`) built; **time (`--max-time`) & cost ceiling UNCONFIRMED** — no API, designed behind the seam but not built |
| [016](016-prompt-charge-between-turn-signals.md) | Prompt Charge → between-turn signals (thinking effort + context pressure) | M | LOW | **CONFIRMED (partial)** — `api.getThinkingLevel()` + `getContextUsage()` built; **approval-countdown UNCONFIRMED** — approval events carry no timeout duration, out of scope |

**Confirmed-buildable (full impl plans):** 011, 012, 014, 015, 016.
**Measure-first spike:** 013 (Memory Crystals) — missing API: no memory-recall event, no
invoked/retained telemetry, no multi-source enumeration.

**Dependency notes (Round 3):**
- **All six are independent** of each other — each touches only its own `src/<feature>/`
  directory + `test/<feature>.test.ts`, and none change `src/kit/**` or `src/registrar.ts`.
  Execute in any order or fully in parallel.
- No dependency on plans 001–010. Plan 001 (registrar reads settings) is already DONE, so
  every animation is gated/mounted correctly regardless.
- 013 is a spike: its Phase A (measure) is read-only and must gate its Phase B (build).

## Considered and re-scoped — Round 3 (do not re-audit)
- **Memory Crystals "one crystal per source (MEMORY.md/.qmd/wiki/brain)"** — not deliverable;
  the memory runtime exposes a single mutually-exclusive backend, not enumerable sources.
- **Session Bonsai "subagent: <name>" branch label** — category error; subagents are separate
  `AgentRegistry` sessions, not nodes in `getTree()`. Dropped, documented in Plan 014.
- **Goal Horizon time/cost sources, Prompt Charge approval-countdown** — no backing API found;
  designed behind their plugin seams as future work, explicitly not built (Plans 015/016).

---

## Status

| Plan | Status |
|------|--------|
| 001 | DONE — see `plans/PROGRESS.md` |
| 002 | DONE — see `plans/PROGRESS.md` |
| 003 | DONE (partial: cadence-equalizer snapshot copies kept) — see `plans/PROGRESS.md` |
| 004 | DONE (partial: only the genuinely wide `⚡` swapped; `☄`/`☀`/`⛏` measured narrow, left as-is, evidence-backed) — see `plans/PROGRESS.md` |
| 005 | DONE — see `plans/PROGRESS.md` |
| 006 | STOPPED-escape-hatch (no-go: paint-batching win measured negligible) — see `plans/PROGRESS.md` |
| 007 | DONE — see `plans/PROGRESS.md` (executed `007-cut-status-bar-duplicators.md`; the maintainer's fixed retain-10/cut-6 list applied; `007-native-default-posture.md` superseded — its on-by-default trio is entirely inside the cut set) |
| 008 | TODO — preset-aware glyphs (retained set) |
| 009 | RESOLVED by 017 — the spike's `setStatus`-vs-`setWidget` question was answered by maintainer directive (2026-08-06): a dedicated box |
| 010 | SUPERSEDED by 017 — box mode suppresses standalone rows; enabled-but-idle segments render dim resting rows |
| 011 | TODO — Diff Bloom git-backed work-effort meter |
| 012 | TODO — Agent Fleet live legend (name+status confirmed; activity needs frame poll) |
| 013 | TODO (measure-first spike) — Memory Crystals → retrieval |
| 014 | TODO — Session Bonsai labeled branches (subagent label dropped) |
| 015 | DONE — executed + reviewed (advisor `execute`, 2026-07-17); worktree `/tmp/wt-015`, branch `advisor/015-goal-horizon-generic-budget` @ `e6c9c04`, gate 825/0/3638; awaiting maintainer merge |
| 016 | TODO — Prompt Charge between-turn signals (thinking + context; approval deferred) |
| 017 | SPEC — Animations Box (bead `oh-my-pi-dxi.1`); awaiting maintainer sign-off before implementation |
