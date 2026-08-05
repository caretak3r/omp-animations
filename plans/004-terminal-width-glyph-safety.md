# Plan 004 — Terminal-width glyph safety in grids & bars

**Written against commit:** `31d90c8` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** aesthetics (terminal correctness) · **Effort:** M · **Risk:** LOW

## Why this matters

This is the one **objective, terminal-corrupting** aesthetic class. Several animations compose
fixed-column grids/bars by raw string concatenation, assuming every glyph is 1 display cell — but some
glyphs are **2 cells** (emoji-presentation) or **ambiguous** (1 or 2 by locale). When a 2-wide glyph
lands in a fixed grid/bar, every cell after it shifts one column right, so the grid rows no longer line
up and the widget looks broken.

**The reference for the correct approach already lives in this repo:** `src/context-weather/renderer.ts:2`
imports `{ truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui"` and reserves space with
`visibleWidth(stormPrefix)` (`renderer.ts:117`) precisely to account for its wide `⚡`. The other 16
animations never measure width. That divergence is the finding.

### Confirmed offenders (glyph identities are objective Unicode facts)
- **AESTHETIC-01 — comet in multi-row grids (worst; breaks vertical alignment):**
  - `src/tool-constellation/sky.ts:77` `COMET_GLYPH = "☄"` (U+2604, emoji-eligible) rendered into a
    3-row grid (`src/tool-constellation/widget.ts:52,86,93`, `parts.join(" ")`) among width-1 glyphs.
  - `src/context-constellation/sky.ts:111` `COMET_GLYPH = "☄"` in a 2-row grid
    (`src/context-constellation/widget.ts:64,74,76`).
  - `src/todo-meteors/ember.ts:16` `METEOR_GLYPHS = ["☄", "*", "·"]` in a horizon lane.
  - Compounding: `✦`/`✹` are Neutral (always 1) while `·`/`•` are East-Asian-Ambiguous (1 or 2) — a
    CJK-ambiguous=2 terminal misaligns the grid even with no comet.
- **AESTHETIC-02 — wide glyph in fixed bars (shifts trailing text):**
  - `src/goal-horizon/horizon.ts:87` `FLARE_GLYPHS = [" ", "·", "✦", "✷", "☀"]` — `☀` (U+2600) in a
    fixed 20-cell bar (`src/goal-horizon/widget.ts:70`) followed on the same line by the percentage +
    objective (transient: `☀` is peak-only).
  - `src/prompt-charge/widget.ts:54` prefixes a fixed-width bar with `theme.fg(color, "⚡")` (U+26A1,
    Emoji_Presentation=Yes → **2 cells on any emoji-aware terminal, every frame**).
- **AESTHETIC-03 — false "single-column" invariant:** `src/tool-constellation/categories.ts:49-58`
  comment claims "Narrow single-column glyph per category," but `bash:"⚡"` (U+26A1, 2 cells),
  `read:"⛏"` (U+26CF, emoji-eligible), and `◈`/`◆`/`∘` are Ambiguous. Used in the off-tier tally
  (`src/tool-constellation/widget.ts:101`). Lower severity (a `·`-separated line, not a grid) but the
  stated invariant is false and any `.length`-based padding downstream mis-measures.

## The fix — pick ONE strategy per widget, prefer (A)

**(A) Curated width-1 glyph vocabulary (preferred — keeps grids pure fixed-width strings):**
Replace the wide/ambiguous glyphs in the grid/bar ramps with codepoints that are unambiguously 1 cell:
- `☄` (comet) → a narrow star/spark like `✷` (U+2737) or `✸` (U+2738) as the comet head.
- `☀` (goal-horizon flare peak) → `✸`/`✦`-class width-1 glyph.
- `⚡` in `prompt-charge` bar prefix and in `categories.ts` `bash` → a width-1 dingbat (e.g. `↯`
  U+21AF, or `✦`); OR keep `⚡` but treat it as a **fixed 2-column badge outside the bar's cell
  accounting** (measure it and reserve 2 columns).
- `⛏` (`read`) → a width-1 alternative (e.g. `⌕`/`✎`-class) to honor the comment.
- Prefer swapping the ambiguous `·`/`•` in the star ramps for Neutral width-1 glyphs (`∙` U+2219 is
  Ambiguous too — use `.`/`·`? no) — safest is to make the *entire* grid vocabulary Neutral-width-1
  (`✦ ✧ ✩ ✷ ✸ · `→ note `·` is ambiguous). Validate each chosen codepoint's East_Asian_Width is `N`
  or `Na` (narrow), not `A` (ambiguous) or `W` (wide).

**(B) Measure + pad (use where the glyph is intrinsically meaningful and can't be swapped):**
Route each grid cell / bar prefix through `visibleWidth` from `@oh-my-pi/pi-tui` and pad to a measured
column width, exactly as `context-weather/renderer.ts` does. This keeps the wide glyph but reserves the
right number of columns so trailing content doesn't shift.

Keep the off-tier tally (AESTHETIC-03) honest: either narrow the glyphs to match the comment, or update
the comment to the truth and ensure any consumer measures with `visibleWidth`.

**Do NOT** change colors/theme usage (that's correct already) — only glyph identity/width handling.

## Files in scope
`src/tool-constellation/{sky,categories,widget}.ts`; `src/context-constellation/{sky,widget}.ts`;
`src/todo-meteors/ember.ts` (+ widget); `src/goal-horizon/{horizon,widget}.ts`;
`src/prompt-charge/widget.ts`. Their snapshot test files (expected-output strings **will** change — re-gold).

## Files OUT of scope
All non-listed animations; `src/kit/*`; color/theme code. `context-weather` (already width-safe — it's
the reference, don't touch it).

## Test plan
- Re-gold the affected behavioral snapshots to the new glyph vocabulary. Before re-golding, **eyeball
  each new expected frame string** to confirm columns line up (the whole point).
- Add a width-invariant test for the two grid animations: assert every row of a rendered grid frame has
  equal `visibleWidth` (import `visibleWidth` from `@oh-my-pi/pi-tui` in the test), across a frame that
  includes a comet/flare. This is the regression guard that makes the fix durable — a future wide-glyph
  reintroduction fails this test. Follow the existing snapshot-test harness for frame capture.
- For bars: assert the total `visibleWidth` of the bar line is constant across the flare/charge peak
  frames.

## Done criteria
- `bun run fix && bun check` → exit 0.
- `bun test` → 0 fail; pass ≥ 773 + the new width-invariant tests; affected snapshots re-golded and
  visually column-aligned.
- Review: no grid/bar ramp contains a glyph whose East_Asian_Width is `W`/`A` without going through
  `visibleWidth` accounting; the `categories.ts` comment matches reality.

## Maintenance note
Adopt one rule going forward: **grids/bars use only East_Asian_Width `N`/`Na` glyphs, or measure with
`visibleWidth`.** Add that as a one-line comment near each grid vocabulary constant. The new
equal-`visibleWidth`-per-row test is the enforcement; keep it.
