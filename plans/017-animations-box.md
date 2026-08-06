# Plan 017 — Animations Box: one consolidated widget for the keeper set

**Written against commit:** `7ffdaa6` · **Repo:** `/Users/rohit/Documents/omp-animations`
**Axis:** native coherence (footprint) · **Effort:** L · **Risk:** MED · **Status:** SPEC — awaiting maintainer sign-off (bead `oh-my-pi-dxi.1`) · **Supersedes:** Plan 009's spike question · **Depends on:** none (keeper extraction is done)

## Why

The maintainer's 2026-08-06 decision, from a busy-terminal screenshot: even with per-animation
icons, 8 stacked ambient rows are too cluttered. He wants ONE dedicated box directly above or
below the editor, adjacent to the status bar, that carries the plugin's signals. Quality bar,
verbatim: "that needs to be perfect."

Plan 009 asked which surface is most native: `setStatus` text or a `setWidget` row. The
maintainer's directive answers it: he wants a real bordered box, so `setWidget` wins. The host
(17.2.9) offers exactly two placements — `aboveEditor | belowEditor`
(`extensibility/extensions/types.ts:207`). There is no true status-bar slot. `belowEditor` is
the closest an extension can mount, so it is the default.

The Phase-1 prototype (`/tmp/anim-livebox`, branch `relay/animations-live-box-phase1`,
uncommitted) proved the architecture but built 5 of its 6 segments on animations that were cut.
Its kit (`Segment`/`composeSegments`), box chrome, settings machinery, and controller shape are
clean. This plan rebuilds the segment layer on the 8 keepers and keeps everything else.

## Decision 1 — Segment set and priorities

The box hosts 7 row segments plus the border. There is NO context% segment: its source was the
cut `context-weather`, and it duplicates the host status line — duplication is the exact
complaint this box answers.

Priority: lower number = survives longest when width gets tight (`composeSegments` drops from
the high end).

| Pri | Segment | id | Active when (mirrors real mount policy) | Simple-mode variants (widest first) | Detail columns (glyph · label · primary · secondary · trailing) |
|---|---|---|---|---|---|
| 1 | Cache Meter | `cacheMeter` | `snapshot().promptTokens > 0` | `renderCacheMeterRow` at budgets 999/40/18/3 | ▤ badge · `cache` · warmth % · saved $ or hit/req · `r <read> · w <write>` |
| 2 | Cadence Equalizer | `cadenceEqualizer` | first assistant `message_start` seen | `renderEqualizerRow` → `renderCompactEqualizer` → `renderEqualizerText` | compact eq · `cadence` · tok/s · peak · band bar |
| 3 | Audit Trail | `auditTrailBox` | first tracked tool event | `renderAuditMeterRow` at budgets 999/40/18 | risk badge · `audit` · status counts · last path (basename) · turn metrics |
| 4 | Rate-Limit Tidepool | `rateLimitTidepool` | `snapshot() !== undefined` (whitelisted provider header) | `renderTidepoolRow` at budgets 999/30/12 | ◗ water · `limits` · level % · provider/family · reset ETA |
| 5 | Tool Constellation | `toolConstellation` | first `tool_call` | `renderConstellationTally` (full → truncated) | dominant category icon · `tools` · total calls · dominant category · tally |
| 6 | Palimpsest | `palimpsest` | ≥1 visible row (overlap ≥ 2) | hottest-file text: `path ×N` → `basename ×N` → `×N` | ember glyph · `files` · hottest basename · `×<overlap>` · visible-row count |
| 7 | Reflection Ripple | `reflectionRipple` | ripple in flight (removed on settle) | `renderReflectionRippleRow` at budgets 999/40/12 | ring glyph · `reflect` · rule names · trigger count · — |

Rules that bind every builder:

- Reuse each animation's own exported pure renderers and `*State` classes. Never reinvent text.
  The two exceptions are stated in the table: Tool Constellation's 3-row grid (`GRID_ROWS=3`)
  does not fit a one-row segment, so its segment uses the exported tally; Palimpsest's
  `renderPalimpsestRows` is multi-row and width-blind, so its segment derives a one-line form
  from `snapshot().rows` (reusing `spans.ts` exports where they exist).
- Three keeper renderers take no width parameter (cadence, palimpsest grid path,
  constellation). The box widget already hard-truncates every content line to the inner budget
  (`cell()` in `widget.ts`) — that safety net is mandatory, not optional, for these three.
- `dedupe()` adjacent-equal variants, exactly as Phase-1 did.
- Tool Constellation keeps its 7-way `CATEGORY_THEME_COLOR` rainbow. It has no single accent
  slot. This asymmetry is intentional — do not "fix" it.

## Decision 2 — Breathing Border becomes the box border

Breathing Border contributes no row. In box mode, the box's own `╭─╮ │ │ ╰─╯` chrome breathes:
brightness follows the exported breath envelope (`breath.ts`) through the same
`BreathingBorderState` phases (idle → active → exhaling), with peak brightness taking the
existing `breathingBorderAccentColor` setting. Motion tier `off`, or `breathingBorder: false`,
renders a static plain border. The standalone row renderer (`renderBreathingBorderRow`) is not
used in box mode — only the envelope math is shared.

## Decision 3 — Settings contract (3 new keys, 0 removed, 0 inert)

Flat manifest keys, generic renderer types only (`string|number|boolean|enum`), stored > env >
default precedence — identical to `appearance.ts`.

| Key | Type | Values | Default | Env |
|---|---|---|---|---|
| `display` | enum | `rows` \| `box` \| `both` | `box` | `OMP_ANIMATIONS_DISPLAY` |
| `animationsBoxDetail` | enum | `simple` \| `detailed` | `detailed` | `OMP_ANIMATIONS_BOX_DETAIL` |
| `animationsBoxPlacement` | enum | `aboveEditor` \| `belowEditor` | `belowEditor` | `OMP_ANIMATIONS_BOX_PLACEMENT` |

- `display=rows` is exactly today's behavior: 8 standalone widgets, box absent.
- `display=box` mounts ONE widget. Every box-owned animation stops mounting its standalone row
  (Phase-1's `BOX_MIGRATED_ANIMATION_IDS` mechanism, now covering all 8).
- `display=both` is a debug/compare mode: rows and box together.
- Default is `box`: the box is the product decision this plan implements. Rows remain one
  setting away.
- Existing per-animation **boolean** keys now govern participation in the active display mode:
  row mounted (rows) / segment enabled (box). Existing per-animation **Placement** keys apply in
  rows mode only; the box owns placement in box mode. Existing **AccentColor** keys color the
  same slots inside the box (each builder passes the animation's resolved accent to the same
  renderer parameter the standalone widget uses).
- There is deliberately NO `animationsBoxOnly` subset key (Phase-1 had one): the per-animation
  booleans already express it. There is NO new box accent key: the border reuses
  `breathingBorderAccentColor`. There is NO `off` value on `animationsBoxDetail`: `display=rows`
  already expresses "no box". Redundant states are how settings pages rot.
- Motion: the shared `animations` tier + `MotionPolicy` gate the box exactly as they gate rows.
  Tier `off` → static box (no breathing, no shimmer/pulse phases; static renders only).
- No keyboard shortcuts. Configuration is the settings page (and env vars) only.

Manifest grows 24 → 27 keys. Restart-to-apply, like every other placement/accent key.

## Decision 4 — One clock, stated once

The survey found the real trap: keeper renderers take **host-elapsed** `elapsedMs` (phase math
against `PULSE_PERIOD_MS=1200`, `EMBER_PULSE_PERIOD_MS=2600`, `SHIMMER_PERIOD_MS=900`,
`INVALIDATION_BLINK_PERIOD_MS=600`, `RIPPLE_DURATION_MS=1600`, breath 4000–12000ms), while
`refillLevel(...)` and `renderCacheMeterPanel(..., {now})` take **epoch ms**. Mixing bases
silently freezes ripples/refills.

The box rule: the controller stamps all state timestamps AND feeds all renderers from ONE
source — the box `FrameScheduler`'s wall clock (epoch ms), the same seam Phase-1 used. The host
`AnimatedWidget`'s mount-relative `elapsedMs` is never passed to a builder. Phase anchors
(ripple trigger time, invalidation time, breath start) are stamped with that same clock, so
`now - anchor` is a correct elapsed value for the phase math and a correct epoch value for
`refillLevel`. A ripple triggered before the box repaints renders at the correct phase.

## Decision 5 — Geometry, fixed height, degradation

Chrome accounting (unchanged from Phase-1 `widget.ts`): border costs 2 rows and 4 columns
(`│ ` + ` │`). At the maintainer's real pane width of 69: inner budget = 65.

**Simple mode** — exactly 3 rows (top border, one composed row, bottom border).
`composeSegments(active segments, 65)`: drop lowest-priority until narrowest variants fit,
then upgrade widest-affordable in priority order. Mock at 69 columns:

```
╭─────────────────────────────────────────────────────────────────────╮
│ ▤ 62.4% cache · ▂▄▆▅▃ 41 t/s · ✓4 ▲1 ✗0 · ◗ 78% anthropic          │
╰─────────────────────────────────────────────────────────────────────╯
```

**Detailed mode** — one row per ENABLED segment, top-to-bottom in priority order, plus the
2 border rows. Fixed columns (Phase-1 `detailRowText`): glyph 6 · label 8 · primary 8 ·
secondary 12 · 4 gutters → trailing gets `inner − 38` = 27 at width 69. Trailing truncates
first; the whole row hard-truncates as the safety net. Mock at 69 columns, all 7 enabled,
5 active:

```
╭─────────────────────────────────────────────────────────────────────╮
│ ▤      cache    62.4%    saved $0.41  r 12.3k · w 2.1k              │
│ ▂▄▆▅▃  cadence  41 t/s   peak 96      ▂▄▆▅▃                         │
│ ●      audit    ✓4 ▲1    widget.ts    2 tools · 1 edit              │
│ ◗      limits   78%      anthropic    resets 12m                    │
│ ✎      tools    9 calls  write        ✎4 ↯3 ◆2                      │
│ ▓      files    —                                                   │
│ ○      reflect —                                                    │
╰─────────────────────────────────────────────────────────────────────╯
```

**Height stability:** height is a function of the ENABLED set and detail level only — never of
runtime activation. An enabled-but-inactive segment renders a dim resting row (glyph + label +
`—`) in detailed mode and contributes nothing in simple mode (simple stays 3 rows regardless).
Toggling a boolean in settings changes height; session activity never does. No reflow jitter.

**Width tests are literal:** golden frames at 69 (the real pane), 45 (narrow), 120 (wide), in
both modes, asserting exact rendered strings — no magic numbers, tier boundaries are
data-dependent. Segment count and iteration order derive from the exported segment-id list,
which itself derives from `ANIMATIONS` in `src/registrar.ts`. Nothing hardcodes a 7 or an 8.

## Decision 6 — What the controller owns

Same architecture Phase-1 proved (its module doc explains why controllers are not reused: they
construct widgets inside `setWidget` factories the box must never invoke):

- One box controller owns a fresh instance of each keeper's exported `*State` class and
  subscribes to the union of the events each keeper's own extension wires (each keeper's
  `index.ts` is the source of truth for its event list — dxi.2 enumerates the union; this spec
  deliberately does not, to avoid drift).
- Widget key: `oh-my-pi-animations-box` — namespaced, per the native-vs-plugin key-collision
  memory. No keeper `WIDGET_KEY` is reused (only 2 of 8 even export theirs).
- Audit Trail's second surface (`setStatus`, alarm-gated) is NOT a row and does not add
  clutter; it stays active in box mode unchanged.
- Cache Meter's session_switch → `dispose()` wiring (deliberate, per its `index.ts`) is
  mirrored: the box resets cache state on session switch, same as standalone.
- Cadence sampling: the box tracks the in-flight assistant message and calls
  `calculateTokensPerSecond` from `@oh-my-pi/pi-coding-agent/utils/token-rate` (the 17.x path)
  exactly as `CadenceEqualizerController.sampleRate` does.

## Execution order (beads)

`oh-my-pi-dxi.1` (this spec, maintainer sign-off) → `dxi.2` port scaffolding + cache-meter
segment → `dxi.3` segments A (audit, constellation, palimpsest) ∥ `dxi.4` segments B (cadence,
tidepool, ripple) ∥ `dxi.5` breathing border → `dxi.6` composition + width goldens → `dxi.7`
manifest + registrar + README → `dxi.8` gates + live validation in the `anim-keepset` sandbox
at 69×42.

## Hazards (carried from the epic — they bind every bead)

- `/tmp/anim-livebox/node_modules` is a SYMLINK into `/Users/rohit/Documents/oh-my-pi-animations`
  and the `.gitignore` trailing slash does not cover it. Never run `git add` in
  `/tmp/anim-livebox`. COPY files out; never move; never commit there.
- Never push. Conventional commits, no AI attribution trailers.
- Gates per bead: `bun test`, `bun run check:types`, `biome check .` — all clean before any
  completion claim.

## Done criteria (plan level)

1. `display=box` mounts exactly one widget; the 8 standalone rows are absent; `rows` restores
   today's behavior byte-for-byte; `both` shows both.
2. All 7 segments activate per their table row's policy in a live session; the border breathes.
3. Golden frames pass at 69/45/120 in both modes; height stable per enabled set.
4. Manifest: 27 keys, zero inert; settings page renders and applies each.
5. Full gate clean; maintainer accepts in the sandbox at 69 columns.
