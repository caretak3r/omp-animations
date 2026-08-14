# @oh-my-pi/animations

`@oh-my-pi/animations` is one [oh-my-pi](https://omp.sh) plugin. It offers
eight animation signals plus Agent Bonsai from the current agent session.
The signals share one consolidated [Animations Box](#the-animations-box) by
default. The eight animation signals can also use separate ambient widgets.
The plugin uses a vendored `pi-animation` kit (`src/kit/`). Every widget
respects a shared motion tier. Motion turns off on a non-TTY terminal, under
`NO_COLOR`, in CI, or when the terminal falls behind on rendering.

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

**Palimpsest.** Shows which regions of code the agent keeps re-editing. A
region gets a faint underline at two touches, amber at three touches, and a
slow pulse at four or more touches. The widget stays hidden while the agent
makes steady forward progress, and a region fades from the widget on its own
after a few turns without a re-touch.

**Rate-Limit Tidepool.** Shows how much rate-limit headroom the last response
reported. A full pool reads as calm water. Falling headroom exposes pebbles,
then wet sand near empty. The gauge refills over time, driven by the
provider's own reset header. It reads only Anthropic and OpenAI rate-limit
headers; every other provider stays invisible.

**Reflection Ripple.** Shows a ripple each time the agent's TTSR check
interrupts generation to apply a matched rule. The ripple expands outward and
the row dims briefly, then the widget disappears once the ripple settles.

**Tool Constellation.** Shows the session's tool use as a star map. Each tool
type is a fixed star. A tool call lights up its star and draws a line from the
star of the previously used tool, so the shape of a session's work builds up
over time.

## The Animations Box

By default, the plugin draws its signals as one bordered box instead of
separate rows. The box sits above or below the editor, next to the status
bar. It shows five fixed summaries for cache use, file trust, rate-limit
headroom, tool use, and edit hotspots. Cadence, Reflection, and Agent Bonsai
are optional groups. The border breathes with the agent's work rhythm.

The `display` setting picks how the plugin shows its signals:

- `box` (default) — one consolidated box.
- `rows` — separate rows for the eight standalone animations. Agent Bonsai
  does not render in this mode.
- `both` — standalone rows and the box together. Use this to compare them.

Each standalone animation's enable setting (`auditTrailBox`, `cacheMeter`,
and more) controls its row. In `box` mode, those settings control the matching
Box summary or optional status row. The `agentBonsai` setting controls its
Box-only group.

Three more settings shape the box:

- `animationsBoxDetail` — `detailed` (default) shows one labeled row per
  enabled status signal. An idle fixed summary keeps a dim resting row, so
  the base box height does not change while you work. `simple` composes active
  status signals into one line. Agent Bonsai remains a separate `agents` group
  in both modes.
- `animationsBoxPlacement` — which side of the editor the box mounts on:
  `aboveEditor` or `belowEditor` (default).
- `agentBonsai` — shows the `agents` group when a subagent exists. The default
  is `true`.

Each box-managed animation's own `Placement` setting (for example
`cacheMeterPlacement`) applies only to its standalone row. In `box` mode, the
box placement applies to every signal it holds. Each animation's own
`AccentColor` setting still colors its signal inside the box. Breathing Border
has no row of its own inside the box. Its motion becomes the box border, and
`breathingBorderAccentColor` colors the border.

Audit Trail uses one authoritative ledger in Box mode. Its probe alarms update
the `audit` summary inside the box. It does not mount a duplicate standalone
row or footer status.

## Install

Install the plugin into an oh-my-pi profile from a local path:

```bash
omp plugin install ./path/to/omp-animations
```

The package declares one plugin entry (`package.json#omp.extensions`,
pointing at `src/registrar.ts`). The registrar reads the plugin's settings and
mounts only the animations that are enabled.

## Turn animations on and off

Four kinds of settings control the plugin. The plugin reads all settings
through the omp plugin settings channel. Each setting also has an `OMP_*`
environment fallback for scripts and CI:

- `animations` — the shared motion tier for every animation: `off`, `subtle`,
  or `full`. The default is `subtle`. The environment fallback is
  `OMP_ANIMATIONS`.
- One boolean per standalone animation — `auditTrailBox`, `breathingBorder`,
  `cacheMeter`, `cadenceEqualizer`, `palimpsest`, `rateLimitTidepool`,
  `reflectionRipple`, and `toolConstellation`. Each defaults to `true`. Each
  environment fallback follows the pattern `OMP_ANIMATIONS_<ID>`.
- Three settings for [the Animations Box](#the-animations-box): `display`
  (`rows` / `box` / `both`, default `box`, environment fallback
  `OMP_ANIMATIONS_DISPLAY`), `animationsBoxDetail` (`simple` / `detailed`,
  default `detailed`, environment fallback `OMP_ANIMATIONS_BOX_DETAIL`), and
  `animationsBoxPlacement` (`aboveEditor` / `belowEditor`, default
  `belowEditor`, environment fallback `OMP_ANIMATIONS_BOX_PLACEMENT`).
- `agentBonsai` — enables the Box-only subagent group. It defaults to `true`.
  Its environment fallback is `OMP_ANIMATIONS_AGENT_BONSAI`.

Use `omp plugin config` to read and change these settings:

```bash
omp plugin config set @oh-my-pi/animations animations subtle
omp plugin config set @oh-my-pi/animations toolConstellation false
omp plugin config list @oh-my-pi/animations
```

A disabled animation never mounts. Its factory does not run, so it registers
no event listeners.

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

## License

MIT — see [LICENSE](LICENSE).
