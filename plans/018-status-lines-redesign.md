# Plan 018 — Status-Lines Redesign of the Animations Box (detailed mode)

**Status:** approved direction, not started.
**Supersedes:** the detailed-mode column grammar of [017](017-animations-box.md) (Decision 5's
`glyph · label · bar · primary · secondary · trailing` mock). Simple mode, rows mode, the box
chrome (breathing border), placement/height plumbing, and the settings channel are all untouched.
**Baseline:** `bun check` green; `bun test` 1217 pass / 0 fail / 37 files.
**Verification gate:** `bun run fix && bun check && bun test` — no test-count regression.

## 1. Problem (field report, 2026-08-10)

Live session screenshot, `gpt-oss:120b` (local model), detailed box:

```
▤  cache    [          ]   0.0%   0/47        r 0 · w 0 · miss 2.9M
   cadence                  --    peak  0
▣  audit                 1‰ 3⁂    15.read.log reads 12 · writes 10 · amp 5.0×
◗  limits   [          ] —
↖  tools                 54 calls read        ↖20 read · ‰10 write · ⚡18 bash · ◈5 search · ·1 other
▓  files                   —
○  reflect                 —
```

The maintainer's verdict: *"none of this is intuitive… I don't understand the icons or what I
am seeing easily."* Root causes, each verified against `segments.ts`:

1. **The glyph column is decorative.** `▤ ▣ ◗ ▓ ○` are per-widget badges that encode nothing;
   they cannot be learned because there is nothing to learn.
2. **One column, seven meanings.** `primary` is a percentage (cache), a rate (cadence),
   `<count><status-glyph>` pairs (audit), a percentage (limits), a call count (tools), a
   basename (files). No header, no shared unit.
3. **Glyph-as-vocabulary.** Audit risk statuses (`poisoned/dirty/redundant/cold/fresh`) and
   tool categories render as invented symbols. The Legend overlay (jj7.14) exists precisely
   because the display doesn't self-explain — and the maintainer never found it. A display
   that needs a legend has already failed.
4. **No undefined-vs-zero distinction.** A provider with no prompt caching renders an
   alarming dense `0.0% · 0/47 · miss 2.9M` row about a metric that cannot exist there.
5. **Internals, not answers.** `amp 5.0×`, `peak 0`, `miss 2.9M` answer questions nobody
   asked. The glanceable questions are: *am I saving money? near a limit? is anything risky
   happening to files? what is the agent doing?*
6. **Redundancy.** The tools row said "read" three times (badge icon, `secondary`, tally head).

## 2. Decisions

**D1 — Status lines.** Each detailed-mode row is `dot · label · phrase`: a semantic status
dot, a fixed-width lowercase label, and one human-readable phrase built from words. No column
grammar beyond the label gutter; no glyph vocabulary anywhere in the phrase.

**D2 — The dot is the only glyph, and it is semantic.** Vocabulary (total, fixed):

| dot | tone | meaning |
|---|---|---|
| `○` | dim | idle / no signal yet / metric undefined here |
| `●` | segment accent (Okabe-Ito, jj7.8) | live, healthy |
| `◐` | amber | notable — worth a glance |
| `●` | red, bold, dashed-underlined where supported (jj7.13) | alert — act |

Per the CLI-output rule: small Unicode + semantic color, never emoji.

**D3 — Words over symbols, translations fixed here.**
- Audit statuses: `poisoned` → **"changed on disk"**, `dirty` → **"edited"**; `redundant/cold/fresh`
  are non-risk bookkeeping and never surface in the phrase.
- Tool categories render as their plain names (`read`, `write`, `bash`, `search`, `other`) with
  counts in parentheses — category icons are gone from the box.
- `amp N×` (write amplification) is cut entirely. `r/w/miss` token triple is cut; uncached
  volume survives only as an optional wide-width tail (`2.9M uncached`).

**D4 — Undefined ≠ zero.** Each builder distinguishes three resting shapes:
- *idle* — nothing yet this session → `○ label   —` (today's behavior, kept);
- *n/a* — metric structurally absent (heuristic below) → `○ cache   no caching on this provider` (dim words, no numbers);
- *live* — the phrase.
Cache n/a heuristic: `requestCount ≥ 8 && cacheReadTokens === 0 && cacheWriteTokens === 0`.
Latch it per session-model; a single later cache hit un-latches permanently.

**D5 — No proportional bars in detailed mode.** The gradient mini-bars (jj7.4) leave the
detailed rows; the percentage itself carries the gradient color instead (`up-good`/`down-good`
ramps reused from `progress-bar.ts` at the same tier gating). Bars remain in simple-mode
variants and rows mode, so jj7.4's renderer is untouched — detailed mode just stops calling it.

**D6 — Change-flash: motion means "this changed".** The maintainer asked for "colorful
effects / bolding / highlighting for different events / changes". Mechanic:
- Every phrase is a list of **spans** with stable keys (e.g. `cache.pct`, `tools.total`,
  `audit.writes`). The widget diffs span values frame-to-frame; a changed span renders
  **bold + segment accent**, then decays back to its resting tone.
- Decay by motion tier: `off` → no flash; `subtle` → bold for one repaint; `full` → bold+accent
  fading over ~800 ms (2–3 frames at the box's cadence). Reduced-motion (jj7.7) forces `off`-tier
  flash behavior regardless of setting.
- Flash is for *changes*; **alerts persist** (no blinking): poisoned count > 0 → red bold span +
  red dot; limits ≤ 20% → amber pct + `◐` dot; ≤ 10% → red + `●` alert dot.

**D7 — Cadence and reflect leave the box.** Approved cuts. They stay in `BOX_SEGMENT_IDS`
(rows mode and per-animation enable booleans unchanged) but the box gains a per-segment
default-visibility map where `cadenceEqualizer: false`, `reflectionRipple: false`. An explicit
per-animation `true` in plugin settings still opts a cut row back in. Five default rows:
`cache · audit · limits · tools · files`.

**D8 — Legend shrinks to the dot table.** jj7.14's overlay stops documenting per-segment
glyph mnemonics (there are none left) and instead prints D2's four-row dot table plus the five
row labels with their one-line descriptions. `SEGMENT_REGISTRY` keeps `label`/`description`;
`glyphKey` fields become unused by the legend and are dropped from the registry entries
(rows-mode widgets still own their glyph keys internally).

## 3. Target rendering (spec, 78-col inner width)

```
●  cache    82% hit · saved $1.24                              2.9M uncached
●  audit    12 reads · 10 writes                                     read.log
◐  audit    12 reads · 10 writes · 1 changed on disk                 read.log   ← notable form
●  limits   74% left · resets 3m · anthropic
●  tools    54 calls — read (20) · bash (18)
●  files    route.py ×6 · 3 hot files
○  cache    no caching on this provider                                        ← n/a form
○  files    —                                                                  ← idle form
```

Width behavior: phrase spans carry a `priority`; the line drops lowest-priority spans (the
wide-width tail first, then trailing `·` groups right-to-left) until it fits — same
narrowing philosophy as the simple-mode variant ladder, applied span-wise. Label gutter stays
7 cols + 2 spaces; dot column 1 + 2.

Per-segment phrase spec (span key → content, in priority order, `[w]` = wide-only tail):

| segment | spans |
|---|---|
| cache | `pct` "82% hit" (gradient color) · `saved` "saved $1.24" (falls back to `hits` "12/47") · `[w] uncached` "2.9M uncached" |
| audit | `reads` "12 reads" · `writes` "10 writes" · `poisoned` "1 changed on disk" (alert) · `dirty` "2 edited" (notable) · `[w] last` basename right-aligned |
| limits | `pct` "74% left" (gradient, down-good) · `reset` "resets 3m" · `provider` "anthropic" |
| tools | `total` "54 calls" · `top` "— read (20) · bash (18)" (top 2 categories, dominant never repeated elsewhere) |
| files | `hot` "route.py ×6" · `count` "3 hot files" |

## 4. Implementation stages (bead-shaped, one commit each)

Ownership contract identical to Wave 4: shared files split per-stage; goldens owned solely by S5.

- **S1 — span model + renderer.** `SegmentDetail` → `SegmentLine { dot: StatusDot; label: string; spans: PhraseSpan[] }`
  (`PhraseSpan { key, text, tone, priority, wideOnly? }`; `StatusDot = "idle" | "live" | "notable" | "alert"`).
  `widget.ts`: replace `detailRowText` fixed columns with span layout + width-drop; add the
  flash engine (per-`(segmentId, key)` last-value map + decay clock on the existing
  `FrameScheduler` — no new timers). Coloring moves INTO the widget (dot tone, span tone,
  flash) — builders emit plain text spans; this inverts today's "segments pre-color, widget
  never colors" contract and is the one deliberate contract change of the plan.
- **S2 — cache + limits builders.** n/a latch (D4), gradient-colored pct spans (D5), bar
  removal from detailed mode. Targeted tests: n/a heuristic latch/unlatch, pct tone ramps,
  span priorities.
- **S3 — audit + tools + files builders.** Word translations (D3), alert/notable dot
  escalation, top-2 tools tally with no dominant duplication.
- **S4 — default segment cut (D7).** Box-scope visibility defaults in `settings.ts`
  (`BOX_SEGMENT_DEFAULT_VISIBLE`), `resolveAnimationsBoxConfig` honors explicit per-animation
  overrides; controller composes only visible segments. Rows mode untouched.
- **S5 — goldens + legend (sole goldens owner).** Rewrite `animations-box-goldens.test.ts`
  for the five-row status-line layout incl. n/a, notable, alert, and flash-frame fixtures;
  legend overlay shrinks to the dot table (D8); `/animations doctor` gains one line naming
  the active detail grammar ("status-lines").

Each stage: `bun test <its own files>` only; full gate once after S5.

## 5. Non-goals

- Simple mode (single-line box), rows display mode, `both` debug mode — unchanged.
- Standalone widgets (cache-meter, audit-trail, tidepool, …) keep their own renderers; this
  plan touches only `animations-box/segments.ts`, `widget.ts`, `settings.ts`, controller
  composition, the legend, and the goldens.
- No new settings keys (D7 reuses per-animation enables; visibility defaults are code).
- No blinking, no marquee, no persistent animation in detailed rows — flash decays and stops.
