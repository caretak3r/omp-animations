# @oh-my-pi/animations

`@oh-my-pi/animations` is one [oh-my-pi](https://omp.sh) plugin.
The plugin adds optional session signals without an omp core change.
One controller owns one `AnimationHost` and one complete Animations Box.
The package uses a vendored `pi-animation` kit (`src/kit/`).
The widget uses one motion tier.
Motion stops on a non-TTY terminal, in CI, under `NO_COLOR`, or under render pressure.

## The animations

**Agent Bonsai.** Shows Main and its reachable subagents inside the Animations
Box. Each primary row shows a stable cohort ID, lifecycle state, model, current
context, and task when space permits. A separate indented row shows that
agent's recent tool, skill, and file activity in observed time order. Arrows
mean sequence, not inferred causality. Active cells pulse without changing
width. Completed cells use the success color. Failed cells use the error color.
Settled activity expires after a short display trail. An active skill appears
as a terminal hyperlink beside the model. Opening it shows a local disclosure
with every loaded skill name and source path. If the terminal does not support
hyperlinks, the chip stays as plain text. Set `PI_NO_HYPERLINKS=1` to always
keep it as plain text, or `PI_FORCE_HYPERLINKS=1` to always emit the link.
Completed agents announce once, then dim until their retention time expires.
Failed or aborted agents keep their error color until removal. The next request
removes terminal rows immediately, but preserves running and pending agents.
A backgrounded task keeps its running row until the job settles.
The complete `agents` group and its separator stay hidden until a subagent exists.

At narrow widths, current work takes priority over model metadata.
Resource evidence names its owning cohort once and retains observed order.
A compact cell keeps its resource kind and outcome. An omission marker
shows when older evidence does not fit.

Names and resource labels stay steady between actual fact changes.
Periodic emphasis belongs to active status markers. Changed facts can flash briefly;
errors remain visible. The perimeter animation does not change.

The `seen-skill` chip identifies an inferred skill reference, not proof of application
or a successful load. Resource summaries distinguish successful reads, active attempts,
and failures. Their counts cover retained recent observations, not lifetime use.

Agent Bonsai bounds its own height. At most 8 nodes are visible at once,
regardless of how many agents actually ran; running and aborted agents keep
their seats over idle or completed ones when the roster is over that limit.
Of the visible nodes, at most 3 keep their activity/provenance sub-rows —
running and aborted agents again claim that budget first. Simple detail mode
drops every activity and provenance sub-row, keeping one line per agent.
Whatever the box cannot show — whether cut by the node cap or the detail-row
cap — is still named, by display name, in the trailing `… +N more (...)` line,
so a failed agent past the visible edge is never silently dropped.

**Audit Trail Box.** Shows which files the agent still trusts. It marks every
file the agent has touched as FRESH, DIRTY, POISONED, REDUNDANT, or COLD. Run
`/audit-trail` to open the full list. Run `/audit-trail remedy` to re-read
every file the agent can no longer trust, and to see which files are safe to
drop.

**Breathing Border.** Shows a soft pulse along the top of the editor while the
agent works. The pulse speeds up or slows down with the pace of the last turn.
It winds down and goes still when the agent finishes.

**Cache Meter.** Shows recent token reuse separately from the session count
of requests with reuse. The percentage averages the last ten requests'
individual reuse fractions. A cold workload reports no observed reuse,
not a provider limitation. Run `/cache` for the provider and model breakdown,
cost, savings, and detected cache invalidations.


**Live Files.** Shows paths that active edit and write calls currently own.
The row includes work from Main and streamed task-agent progress.
Each path disappears when its matching call ends.
The row does not preserve edit history or re-edit heat.

**Rate-Limit Tidepool.** Shows how much rate-limit headroom the last response
reported. A full pool reads as calm water. Falling headroom exposes pebbles,
then wet sand near empty. The gauge refills over time, driven by the
provider's own reset header. It reads only Anthropic and OpenAI rate-limit
headers; every other provider stays invisible.

## Signal extras

Signal extras render inside the Animations Box. A signal row appears only while that signal has meaningful state.

- **Repeat** appears only when the current turn uses the same tool sequence as the previous turn.
- **Context Rewrite Shadow** compares estimated transcript and provider-context token counts. Each estimate has a `~` marker.
- **Compaction Scar** shows cut tokens and reads since compaction.
- **Consent Lock** shows a pending tool approval.
- **Session Phylogeny** shows branch depth and sibling count.
- **Think/Act Lissajous** shows the balance between thinking text and answer text.
- **Error Isotope** shows a content-free count after multiple tool failures.
- **Skill Chromatograph** distinguishes recent skill-read outcomes from catalog availability.
- **Retry Radar** shows the retry attempt, maximum attempts, and authoritative delay.
- **Goal Heading** shows the goal status and token budget. It does not show the goal text.
- **TTFT Split** shows the reported TTFT and completion time with bounded history.
- **Memory Backend Tide** shows backend state and recent memory, context-file, and QMD outcomes.

**Darkroom Title** writes critical state to the terminal title. It does not use a widget row.

The controller keeps temporal evidence in a fixed-capacity store. The store uses the shared frame clock and has no timers.
It retains only allowlisted scalar facts. One immutable evidence snapshot supplies all signal rows in each frame.
Two or more live evidence classes can add one finite diffraction token to the existing top border.
Missing host data keeps causal, cancellation, cache-disposition, and subagent-skill effects hidden.

## The Animations Box

The plugin mounts the complete Animations Box below the editor by default.
The box holds these required rows in order:

1. `context` — configured budget fill, model-window usage, and turn headroom
2. `cache` — prompt-cache use and saved cost
3. `audit` — file trust
4. `limits` — provider rate-limit headroom
5. `files` — active edit and write paths

Agent Bonsai and the signal extras are optional groups in the box.
Breathing Border pulses the full square perimeter. At the crest, the complete border changes color and line weight.

One `AnimationsBoxWidget` renders the required rows and active optional rows.
If no optional signal has meaningful state, that signal uses no row.

The old `display` setting (`rows` / `box` / `both`) is ignored.
A stale `rows` or `both` value logs one warning and still mounts the complete box.
A stale `box` value does not log a warning.

These settings shape the box:

- `animationsBoxDetail` — `detailed` shows one labeled row per enabled signal. `simple` composes active status signals into one row.
- `animationsBoxPlacement` — places the Audit Box at `aboveEditor` or `belowEditor`. The default is `belowEditor`.
- `animationsContextQuota` — sets the context quota from `5` through `100`. The default is `80`. The `context` row uses the standard progress bar.
- `agentBonsai` — shows the `agents` group when a subagent exists. The default is `true`.
- `liveFiles` and each signal-extra setting — control one approved extra. The default is `true`.
- `darkroomTitle` — controls terminal-title projection. The default is `true`.

The five core Audit Box summaries have no enable setting.
`liveFiles` is optional because it is part of the approved extra set.

Each legacy `Placement` setting, such as `cacheMeterPlacement`, does not select a separate surface.
`animationsBoxPlacement` controls the complete box. The default is `belowEditor`.
Set it to `aboveEditor` to move all rows above the editor.

Audit Trail uses one authoritative ledger.
Probe alarms update the `audit` row.
The plugin does not mount a duplicate Audit Trail row or footer status.

## Install

Install the plugin into an oh-my-pi profile from a local path:

```bash
omp plugin install ./path/to/omp-animations
```

The package declares one plugin entry (`package.json#omp.extensions`, pointing
at `src/registrar.ts`). The registrar reads the plugin settings synchronously.
It mounts the complete Animations Box through one controller.

## Turn animations on and off

Four kinds of settings control the plugin. The plugin reads all settings
through the omp plugin settings channel. Each setting also has an `OMP_*`
environment fallback for scripts and CI:

- `animations` controls the shared motion tier: `off`, `subtle`, or `full`.
  The default is `subtle`. The environment fallback is `OMP_ANIMATIONS`.
- `agentBonsai` and `breathingBorder` default to `true`.
- `liveFiles` and the signal extras in [Signal extras](#signal-extras) default
  to `true`. Each environment fallback follows the pattern
  `OMP_ANIMATIONS_<ID>`.
- Three settings control [the Animations Box](#the-animations-box):
  `animationsBoxDetail` (`simple` or `detailed`, default `detailed`),
  `animationsBoxPlacement` (`aboveEditor` or `belowEditor`, default
  `belowEditor`), and `animationsContextQuota` (`5` through `100`, default
  `80`).
- `animationsBonsaiSettleSeconds` sets agent retention from `0` through `86400`
  seconds. The default is `300`. Its environment fallback is
  `OMP_ANIMATIONS_BONSAI_SETTLE_SECONDS`; a stored value takes precedence.
  Exact roster and task-progress agents use the same retention time.
  The minimum announcement window is `800ms`, even at `0` seconds and with
  `animations: off` or `subtle`. Terminal rows expire without frame updates.

Use `omp plugin config` to read and change these settings:

```bash
omp plugin config set @oh-my-pi/animations animations subtle
omp plugin config set @oh-my-pi/animations animationsContextQuota 80
omp plugin config list @oh-my-pi/animations
```

An optional setting controls only its row or title projection.
The shared controller and its widget registration remain mounted.

## Requirements

- Bun 1.3.14 or later.
- oh-my-pi 17 or later. The plugin imports agent signals from
  `@oh-my-pi/pi-coding-agent` through its internal subpath export, which is
  not a stable contract across oh-my-pi major versions. Pin the major version.

## Develop

```bash
bun install      # resolves pi-coding-agent / pi-tui / pi-utils from npm
bun run fix      # biome check --write --unsafe
bun run check    # biome + tsgo type-check
bun test         # behavioral test suite
```

### Grading a live box

Unit tests prove the box renders what the code says. They cannot tell you the box
is *wrong* — that only shows when a real session drives it. Two scripts close that
loop against a running `omp` in tmux:

```bash
bun run probe -- --session omp-anim --interval 2   # sample until you stop it
bun run probe -- --once                            # one snapshot
bun run probe:lint                                 # grade the newest run
```

`probe` creates a unique `.frames/run-<timestamp>-<suffix>/` directory.
It records every raw capture and its synchronization metadata in `captures.jsonl`.
Sample while the session is busy, with subagents and tool activity.

The probe checks synchronization, cursor position, and viewport size before and after
each capture. Matching sync-off observations permit grading. These observations are
not an atomic snapshot. In-flight captures remain in the evidence archive but do
not become graded frame files. Unknown metadata or no settled frames causes exit 2.

`probe:lint` grades identifiable Audit Boxes, not unrelated tool output. It checks
paths, values, separators, alignment, duplicate status chips, and complete borders.
Each agent can retain its own model field, even when several models match.
A malformed frame outside a known synchronized update still fails.
Exit codes are 0 for a clean graded run, 1 for violations, and 2 when no Audit Box
can be identified.

## License

MIT — see [LICENSE](LICENSE).
