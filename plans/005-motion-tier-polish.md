# Plan 005 — Motion-tier ladder + off-badge polish

**Written against commit:** `31d90c8` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** aesthetics · **Effort:** S · **Risk:** LOW

## Why this matters

The suite's design makes the off/subtle/full **motion-tier ladder** a headline feature (the
`breathing-border` bead calls the ladder itself the point). Most animations honor it well — e.g.
`breathing-border` breathes only the corners in subtle (`widget.ts:41-46`), `cadence-equalizer` drops
peak caps + spacers (`widget.ts:55-57`), `token-tide` has a dedicated compact pulse,
`tool-constellation` collapses to a binary `•`/`·` dot (`widget.ts:25-27`). Two do not, and the static
`off` badges are inconsistent across the suite.

### AESTHETIC-04 — degenerate `subtle` (payload identical to `full`)
- `src/prompt-charge/widget.ts:46-60` — `full` and `subtle` compute the **same** `⚡`+`▰/▱` bar; subtle
  returns `${glyph} ${coloredBar}`, full merely appends ` ${pct}`. No reduction in animated content.
- `src/model-weather-vane/widget.ts:60-66` — both tiers call `currentEmblem(snapshot, elapsedMs)` (same
  spin math); subtle (`:63`) only drops the trailing `(provider)` suffix.
Against the rest of the suite these read as "full minus a static text suffix" — the only real reduction
is host cadence, but the frame *content* is identical, which looks half-considered.

### AESTHETIC-05 — inconsistent `off` badges (the baseline a NO_COLOR/CI/dumb-term user sees)
`MotionPolicy` forces `off` on NO_COLOR/CI/TERM=dumb (`src/kit/motion-policy.ts:45-47`), so the static
off one-liners are what low-capability users actually get. They currently mix: 2-wide emoji badges
`🌅` (`goal-horizon/widget.ts:122-123`), `🧭` (`model-weather-vane/widget.ts:71-73`), `⚡`
(`prompt-charge/widget.ts:73-77`); an ambiguous `◆` (`memory-crystals/widget.ts:53`); a narrow `✦`
(`context-constellation/widget.ts:95-96`); and plain ASCII with no badge
(`cadence-equalizer/widget.ts:61-62`). No shared convention, and the emoji ones mis-measure by a column
under `.length` layout.

## The fix

### AESTHETIC-04 — make `subtle` a real reduction
In the `subtle` branch of `prompt-charge` and `model-weather-vane`, **suppress per-frame motion** rather
than trimming trailing text — matching the reduction the other 14 use:
- `prompt-charge` subtle: hold the bar at a static fill (e.g. the settled charge level) with no
  per-frame decay/charge animation — a single steady indicator, not the live-animating bar. Keep it
  legible and distinct from both full (animated) and off (plain text).
- `model-weather-vane` subtle: drop the spin **interpolation** — show a static emblem for the current
  model (no per-frame `elapsedMs`-driven rotation), swapping only when the model actually changes.
Keep both renderers PURE of wall-clock: "static" means the render output does not depend on `elapsedMs`
in the subtle branch (elapsed is simply unused there), not that it reads a clock.

### AESTHETIC-05 — standardize off badges
Pick ONE convention and apply it to every animation's `off` one-liner. Recommended: a **width-1
dingbat** badge (or no badge) consistent across the suite, so every static fallback measures predictably
and reads as one family. Concretely: replace `🌅`/`🧭`/`⚡`/`◆` in off-text with width-1 glyphs (or drop
the leading badge entirely and lead with the label). Align with whatever Plan 004 chose for these same
glyphs if 004 ran first — do not fight it. Coordinate: if 004 already narrowed `⚡`/`◆`, reuse those.

## Files in scope
`src/prompt-charge/widget.ts`; `src/model-weather-vane/widget.ts`; and the `off`-text of
`goal-horizon/widget.ts`, `model-weather-vane/widget.ts`, `prompt-charge/widget.ts`,
`memory-crystals/widget.ts` (+ any other animation whose off badge you standardize for consistency).
Their snapshot tests (expected strings change — re-gold).

## Files OUT of scope
`src/kit/*`; the animations whose ladders are already good (do not "improve" them); color/theme code.

## Dependency
If running alongside Plan 004, do **004 first** where glyphs overlap (`prompt-charge` `⚡`,
`memory-crystals` `◆`) so this plan inherits 004's chosen width-1 glyphs instead of picking conflicting
ones. If 004 is not in this batch, choose width-1 glyphs here and note them for 004 later.

## Test plan
- `prompt-charge` / `model-weather-vane`: add a behavioral assertion that the `subtle` frame output is
  **invariant across `elapsedMs`** for a fixed state (proves motion is suppressed), while the `full`
  frame **does** vary across `elapsedMs` (proves the tiers are now genuinely different). This is the
  precise, non-subjective check for "subtle is a real reduction."
- Re-gold the changed subtle/off snapshots.
- Assert every animation's `off` output is non-empty and single-line (already true; keep it) and — if
  you standardized badges — that the off badge is width-1 (`visibleWidth` from `@oh-my-pi/pi-tui`).

## Done criteria
- `bun run fix && bun check` → exit 0.
- `bun test` → 0 fail; pass ≥ 773 + new tier-distinctness tests.
- Review: `prompt-charge` and `model-weather-vane` subtle frames no longer depend on `elapsedMs`; off
  badges follow one convention.

## Maintenance note
The "subtle must be `elapsedMs`-invariant while full is not" test encodes the ladder contract for these
two — reuse that shape if a new animation is added. Keep off-tier badges on the shared convention.
