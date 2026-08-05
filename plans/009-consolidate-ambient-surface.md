# Plan 009 — SPIKE: consolidate the retained animations onto one omp-native ambient surface

**Written against commit:** `c74be86` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** native coherence (footprint) · **Effort:** L · **Risk:** MED · **Status:** OPTIONAL SPIKE · **Depends on:** 007

## Why this is a spike, not a build

Even after Plan 007 cuts the 6 duplicators, the ~10 retained animations **each self-mount their own
editor row** via `ctx.setWidget(WIDGET_KEY, …, {placement})` (verified: 15 distinct `WIDGET_OPTIONS`
declarations pre-cut; several multi-row — `tool-constellation/sky.ts:3` `GRID_ROWS=3`,
`context-constellation` [cut] was 2, `session-bonsai/widget.ts:59` one row per branch node). With the
retained set on, that's still ~10+ stacked rows framing one editor. omp's native model is the opposite:
**one dense self-eliding status line folded into the editor's top border — zero extra rows** (stock
`packages/coding-agent/src/modes/components/status-line/component.ts:1286` renders the HUD AS the border,
`render()` returns `[]` for extra rows). The two in-house natives obey this: spinner-packs rides the
existing Loader (no row); Context Weather uses a single self-eliding line.

The fix is architectural and touches every retained controller + its tests, so **measure the surface
options and prototype before committing to the full refactor.**

## Spike deliverables (produce a decision + design, not necessarily the full refactor)

1. **Determine the most-native surface.** The extension API (installed
   `.../extensibility/extensions/types.ts`) exposes exactly: `setStatus(key, text)` (a status-TEXT
   surface — likely a single line near the status bar) and `setWidget(key, content, {placement})` (a full
   editor row). There is **NO** status-line-segment registration API (grep confirmed: no
   `registerStatusLine`/`registerSegment`). So the native options are:
   - **(a) `setStatus`** — investigate what surface `setStatus(key, text)` actually renders to (read its
     handling in the omp source `extensibility/` loader/host). If it's a compact single-line status area,
     THIS is the native home for ambient text and the whole suite should push compact segments here
     instead of `setWidget` rows.
   - **(b) One consolidated `setWidget` row** rendered status-line-style — a single `aboveEditor` (and at
     most one `belowEditor`) row that composites all active animations as dense space-separated segments
     (glyph + tiny sparkline per animation), mimicking omp's segment+separator status line.
   Compare (a) vs (b) for fidelity to omp's density and report which to build.
2. **Prototype a kit `AmbientSurface`** behind the existing interfaces: one owner of a single row/status
   key that accepts registered segment-renderers; each controller pushes a compact segment string instead
   of owning its own widget key. One shared `AnimationHost` drives the composite (today each controller
   has its own host — see Plan 002; consolidation collapses backpressure wiring to one place too).
3. **Report** go/no-go + a full implementation plan if go (it touches all retained controllers + tests).

## Design constraints (from omp's native spec — honor these)
- **Self-elide:** a segment with nothing to show renders NOTHING (no `(no open todos)` row) — this
  subsumes Plan 010. omp segments return `{visible:false}` when data is absent.
- **Truncate, never wrap:** the composite line truncates at width with a priority order; it never spills
  to a second row.
- **One host, correct lifecycle:** the shared host must not stop when one animation idles; dispose becomes
  unsubscribe. The retained-set gallery test is the leak oracle — zero leaked timers/subs after teardown.
- **Preset-aware + theme roles:** segments use `theme.symbol()` (Plan 008) and `theme.fg(muted|dim|…)`.

## Escape hatches
- If `setStatus` turns out to render a compact status area, prefer it and STOP designing a custom widget
  row — using the host's own status surface is maximally native. Report that and scope the build to
  "port each animation to a `setStatus` segment."
- If neither surface can host N animated segments without exceeding one row at realistic widths, cap the
  visible segments (priority order) and `log()` what was dropped — do NOT silently overflow to stacked
  rows (that reintroduces the original problem).
- If the shared-host lifecycle can't be made leak-free against the gallery test, STOP and report — do not
  ship a leaking or dying clock.

## Files in scope (if the spike goes to build)
New `src/kit/ambient-surface.ts` (+ barrel); every retained controller (`src/*/controller.ts`) to push a
segment instead of `setWidget`; the registrar (`src/registrar.ts`) to own/inject the shared surface;
all affected tests.

## Files OUT of scope
The pure render/state modules' internal logic (a consolidated surface changes WHERE a segment paints, not
its per-frame math); `src/spinner-packs/**`; cut animations.

## Test plan (if built)
- Retained-set gallery test: all animations active → assert the total ambient footprint is ≤1-2 rows (not
  N), and zero leaked timers/subs after dispose.
- Self-elide test: an animation with empty state contributes an empty segment (no placeholder text).
- Truncation test: at a narrow width the composite line truncates to one row, dropping lowest-priority
  segments, never wrapping.
- Per-animation segment output tests (behavioral, deterministic over injected clock).

## Done criteria
- Spike report (surface decision + go/no-go) written to `plans/PROGRESS.md` or `plans/009-notes.md`.
- If go: `bun run fix && bun check && bun test` exit 0, 0 fail; footprint-≤2-rows test + leak test green.
- If no-go: the reason is recorded, and the fallback (Plan 007's curated default + Plan 010's idle-unmount)
  stands as the pragmatic native-enough posture.

## Maintenance note
This is the change that makes "many animations on" actually native (one surface regardless of count). It
subsumes Plan 010 and softens Plan 007's default. Until it lands, keep the animation count low by default.
