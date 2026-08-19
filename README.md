# @oh-my-pi/animations

`@oh-my-pi/animations` is one [oh-my-pi](https://omp.sh) plugin.
The plugin adds optional session signals without an omp core change.
One controller owns one `AnimationHost`, an Audit Box, and a signal sidecar.
The package uses a vendored `pi-animation` kit (`src/kit/`).
Every widget uses the same motion tier.
Motion stops on a non-TTY terminal, in CI, under `NO_COLOR`, or under render pressure.

## The animations

**Agent Bonsai.** Shows Main and its reachable subagents inside the Animations
Box. Each compact row shows a stable cohort ID, lifecycle state, model,
syntax-colored activity, and task context when space permits. An active skill
appears as a terminal hyperlink beside the model. Opening it shows a local
disclosure with every loaded skill name and source path. If the terminal does
not support hyperlinks, the chip stays as plain text. Set `PI_NO_HYPERLINKS=1`
to always keep it as plain text, or `PI_FORCE_HYPERLINKS=1` to always emit the
link. A row that reaches `delivered`, `parked`, or `aborted` stays visible
until you send the next request. A backgrounded task keeps its running row
until the job settles. The complete `agents` group and its separator stay
hidden until a subagent exists.

**Audit Trail Box.** Shows which files the agent still trusts. It marks every
file the agent has touched as FRESH, DIRTY, POISONED, REDUNDANT, or COLD. Run
`/audit-trail` to open the full list. Run `/audit-trail remedy` to re-read
every file the agent can no longer trust, and to see which files are safe to
drop.

**Breathing Border.** Shows a soft pulse along the top of the editor while the
agent works. The pulse speeds up or slows down with the pace of the last turn.
It winds down and goes still when the agent finishes.

**Cache Meter.** Shows how much of each request the LLM provider served from
its prompt cache. Run `/cache` to see the full breakdown by provider and
model, with cost, savings, and the count of detected cache invalidations.

**Cadence Equalizer.** Shows live token throughput as a multi-band meter.
Each band tracks the same throughput signal, but at a different speed, so the
bars move at different rates instead of in lockstep. Each band also keeps a
peak marker that decays slowly after a burst.

**Live Files.** Shows paths that active edit and write calls currently own.
The row includes work from Main and streamed task-agent progress.
Each path disappears when its matching call ends.
The row does not preserve edit history or re-edit heat.

**Rate-Limit Tidepool.** Shows how much rate-limit headroom the last response
reported. A full pool reads as calm water. Falling headroom exposes pebbles,
then wet sand near empty. The gauge refills over time, driven by the
provider's own reset header. It reads only Anthropic and OpenAI rate-limit
headers; every other provider stays invisible.

**Reflection Ripple.** Shows a ripple each time the agent's TTSR check
interrupts generation to apply a matched rule. The ripple expands outward and
the row dims briefly, then the widget disappears once the ripple settles.

## Signal extras

The signal sidecar mounts above the editor. It shows a row only when that signal has meaningful state.

- **Recurrence Strip** separates heading progress from a repeated tool orbit.
- **Context Rewrite Shadow** compares estimated transcript tokens with provider-context tokens.
- **Compaction Scar** shows cut tokens and immediate file re-reads.
- **Consent Lock** shows a pending tool approval.
- **Session Phylogeny** shows the active node, branch depth, and sibling count.
- **Think/Act Lissajous** shows the balance between thinking text and answer text.
- **Error Isotope** appears when the same normalized tool error occurs more than once.
- **Queue Fog** shows that a queued follow-up will continue the session.
- **Skill Chromatograph** shows skills that the current turn used.
- **Retry Radar** shows an active automatic retry and model fallback.
- **Goal Heading** shows the active goal, status, and token budget.
- **TTFT Split** shows the delay from turn start to the first assistant message.
- **Memory Backend Tide** shows backend status, working-memory writes, and recall activity.

**Darkroom Title** writes critical state to the terminal title. It does not use a widget row.

## The Animations Box

The plugin mounts the Audit Box below the editor by default.
The box holds these rows in order:

1. `files` — active edit and write paths
2. `context` — context-window fill and turn headroom
3. `cache` — prompt-cache use and saved cost
4. `audit` — file trust
5. `limits` — provider rate-limit headroom
6. `tools` — tool-call totals

Agent Bonsai, Cadence Equalizer, and Reflection Ripple are optional groups in the Audit Box.
Breathing Border colors the Audit Box border.

The signal sidecar is a second `AnimationsBoxWidget` on the same `AnimationHost`.
It mounts above the editor.
If no enabled signal has meaningful state, the sidecar returns zero rows and uses zero height.

The old `display` setting (`rows` / `box` / `both`) is ignored.
A stale `rows` or `both` value logs one warning and still mounts the two named widgets.
A stale `box` value does not log a warning.

These settings shape the surfaces:

- `animationsBoxDetail` — `detailed` shows one labeled row per enabled signal. `simple` composes active status signals into one row.
- `animationsBoxPlacement` — places the Audit Box at `aboveEditor` or `belowEditor`. The default is `belowEditor`.
- `animationsContextQuota` — sets the context quota from `5` through `100`. The default is `80`.
- `agentBonsai` — shows the `agents` group when a subagent exists. The default is `true`.
- `cadenceEqualizer` and `reflectionRipple` — control their Audit Box rows. The default is `false`.
- `liveFiles` and each signal-extra setting — control one approved extra. The default is `true`.
- `darkroomTitle` — controls terminal-title projection. The default is `true`.

The five core Audit Box summaries have no enable setting.
`liveFiles` is optional because it is part of the approved extra set.

Each legacy `Placement` setting, such as `cacheMeterPlacement`, does not select a surface.
`animationsBoxPlacement` controls the Audit Box.
The signal sidecar stays above the editor.

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
It mounts the Audit Box and signal sidecar through one controller.

## Turn animations on and off

Four kinds of settings control the plugin. The plugin reads all settings
through the omp plugin settings channel. Each setting also has an `OMP_*`
environment fallback for scripts and CI:

- `animations` controls the shared motion tier: `off`, `subtle`, or `full`.
  The default is `subtle`. The environment fallback is `OMP_ANIMATIONS`.
- `agentBonsai` and `breathingBorder` default to `true`.
  `cadenceEqualizer` and `reflectionRipple` default to `false`.
- `liveFiles` and the signal extras in [Signal extras](#signal-extras) default
  to `true`. Each environment fallback follows the pattern
  `OMP_ANIMATIONS_<ID>`.
- Three settings control [the Animations Box](#the-animations-box):
  `animationsBoxDetail` (`simple` or `detailed`, default `detailed`),
  `animationsBoxPlacement` (`aboveEditor` or `belowEditor`, default
  `belowEditor`), and `animationsContextQuota` (`5` through `100`, default
  `80`).

Use `omp plugin config` to read and change these settings:

```bash
omp plugin config set @oh-my-pi/animations animations subtle
omp plugin config set @oh-my-pi/animations cadenceEqualizer false
omp plugin config list @oh-my-pi/animations
```

An optional setting controls only its row or title projection.
The shared controller and its two widget registrations remain mounted.

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

`probe` writes each distinct box state to `.frames/run-<timestamp>/`. Sample while the
session is busy: an idle box hides every bug worth finding.

`probe:lint` grades those frames against the render invariants in
`scripts/frame-lint.ts` — empty value columns, ASCII placeholders where the box uses
an em-dash, absolute paths, raw prompt text, mismatched separators, unaligned tails,
a chip repeated on every row. Each rule cites the issue that paid for it and stays
after that issue closes, so the next run cannot regress past it. Exit code is 1 when
anything fires.

## License

MIT — see [LICENSE](LICENSE).
