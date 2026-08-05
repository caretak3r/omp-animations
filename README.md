# @oh-my-pi/animations

The **oh-my-pi animation plugin suite** — a single, config-driven package bundling
both waves of ambient animated terminal-UI plugins for
[oh-my-pi](https://omp.sh), built on the shared `pi-animation` kit
(vendored here under `src/kit/`).

One package exposes every animation as part of one oh-my-pi *external plugin*. The
plugin's own settings decide which animations mount and at what motion tier
(`off` · `subtle` · `full`); each animation additionally self-gates through the kit's
`MotionPolicy` (disabled on non-TTY / `NO_COLOR` / CI / render backpressure).

## The 18 animations

**Wave 2 (15):** Tool Constellation · Token Tide · Session Bonsai · Todo Meteors ·
Breathing Border · Agent Fleet · Cost Candle · Reflection Ripple · Memory Crystals ·
Context Constellation · Diff Bloom · Cadence Equalizer · Goal Horizon ·
Model Weather Vane · Prompt Charge.

**Wave 1 (3):** Context Weather · Spinner Packs · Compaction Vacuum.
*(Retry Radar is tracked separately — it is still being finished upstream.)*

Of the 18 (plus Palimpsest, Audit Trail Box, Cache Meter, Drift Buoy, Session
Strata, Rate-Limit Tidepool, and Four Hands — seven later additions not part of either
wave, see below), **13 are registrar-mounted extensions**: Session Bonsai, Agent Fleet, Memory
Crystals, Audit Trail Box, Diff Bloom, Palimpsest, Goal Horizon, Prompt Charge,
Session Strata, Cache Meter, Drift Buoy, Rate-Limit Tidepool, Four Hands. **Spinner Packs** (a
spinner catalog + color utility) and
**Compaction Vacuum** (an `AnimatedWidget` + helpers, driven by a core compaction hook
in-tree) are library modules with no extension factory — they are exported by the
package but not mounted by the registrar.

**Not included: signals omp's status line already shows.** Six animations were cut from
the registrar (Plan 007) because each re-renders a signal omp's own status line already
surfaces as a segment — Token Tide and Cadence Equalizer both duplicate `token_rate`
(`<N> tok/s`), Cost Candle duplicates `cost`, Context Weather and Context Constellation
both duplicate `context_pct`, and Model Weather Vane duplicates `model`. The design law:
**an animation earns a surface only if it shows something omp's status line does not.**
Their source and tests stay in the repo (unregistered, not deleted) in case a future core
exposes a hook that makes one of them genuinely additive again — see
`plans/007-cut-status-bar-duplicators.md` and `plans/PROGRESS.md` for the evidence. They
are not exported from `src/index.ts`'s barrel either; import them directly from their
module path (e.g. `./token-tide`, `./context-weather/extension`) if you need them.

**Also dropped for scope.** Four more of the originally-retained animations — **Tool
Constellation**, **Todo Meteors**, **Breathing Border**, and **Reflection Ripple** — were
later unregistered to ship a deliberately niche capability set. Unlike the six above these
are not status-line duplicates; they were simply cut from the shipped surface. Same
treatment: source and per-feature tests stay on disk, unregistered and unexported,
importable by module path (e.g. `./tool-constellation`).

**Palimpsest.** A thrash detector, added after the two cuts above and shipped
directly — not part of either historical wave. It glows only the file regions
the agent keeps re-editing (a per-file ledger of overlap-counted line spans,
parsed from `EditToolDetails.diff`'s hunk headers with zero file I/O): a faint
underline at 2 re-touches, amber at 3, a slow ember pulse at 4+. Invisible
during healthy forward progress — no repeated touch, no row — and a region
fades out of the ledger on its own after a few turns without a re-touch.

**Rate-Limit Tidepool.** A `belowEditor` gauge reading how much rate-limit
headroom the *last response* reported — the before-the-429 view, where Retry
Radar is the after view. It whitelists exactly two header families
(Anthropic's `anthropic-ratelimit-{resource}-{field}`, OpenAI's
`x-ratelimit-{field}-{resource}`), keyed on `AssistantMessage.provider` never
`model` or the upstream-routed provider an aggregator reports; a gateway
outside the whitelist (e.g. OpenRouter, whose header shape varies by
deployment) stays invisible rather than guessed at. A full pool reads calm;
receding headroom exposes pebbles, then wet sand near-empty; the response's
own `*-reset` header drives a slow refill back toward full between requests.
Deliberately memoryless — the latest response's own numbers, no
request/response pairing by correlation ID (that approach, Provider Aurora,
died in Round 1 for lack of one).

**Four Hands.** A `belowEditor` two-voice staff, one column per turn: the
lower voice ticks on every agent `tool_execution_start`; the upper voice
strikes on every human `user_bash`/`user_python` — solid for the in-context
`!`/`$` prefix, hollow for the context-excluded `!!`/`$$` one, bash and python
each their own glyph shape. Silent through a fully-autonomous session —
nothing mounts until the first human strike — and each strike decay-scrolls
out of view over a handful of quiet turns, tearing the widget back down once
none remain visible. Dense clusters on the upper voice are the signal this
widget exists to surface: a run of human interventions in a short span reads
as trust breaking down, visible as a pattern rather than buried in scrollback.

## How oh-my-pi installs and enables it

The package ships one plugin entry declared in `package.json#omp`
(`extensions: ["./src/registrar.ts"]`). Install it as a local oh-my-pi plugin:

```bash
omp plugin install ./path/to/oh-my-pi-animations
```

Then control it through the plugin's **settings UI/CLI** — this is the primary,
working channel; every setting also has an `OMP_*` env var as a fallback for
scripted/CI setups (stored setting > env var > default):

```bash
omp plugin config set @oh-my-pi/animations animations subtle
omp plugin config set @oh-my-pi/animations toolConstellation false
omp plugin config list @oh-my-pi/animations
```

| Setting | Type | Default | `OMP_*` env fallback |
|---------|------|---------|--------|
| `animations` | `off`\|`subtle`\|`full` | `subtle` | `OMP_ANIMATIONS` |
| `sessionBonsai`, `agentFleet`, … `fourHands` (13 shipped) | boolean | `true` | `OMP_ANIMATIONS_<ID>` (e.g. `OMP_ANIMATIONS_DIFF_BLOOM`) |
| `<id>Placement` (×13, e.g. `diffBloomPlacement`) | `aboveEditor`\|`belowEditor` | per animation (5 above / 8 below) | `OMP_ANIMATIONS_<ID>_PLACEMENT` |
| `<id>AccentColor` (×13, e.g. `diffBloomAccentColor`) | `default` + 11 curated theme colors | `default` | `OMP_ANIMATIONS_<ID>_ACCENT_COLOR` |

Placement and accent resolve once at plugin wire time (restart to apply). `AccentColor`
recolors only the animation's primary accent slot (active-path glow, working firefly, landing
sparkle, added-side bloom, milestone flare, full-charge flash respectively); semantic
multi-color maps stay fixed. `default` keeps the built-in palette.

The registrar mounts **only the enabled animations** — a disabled animation's factory is
never invoked, so it registers zero event listeners. The manifest ships a curated native
default: all 13 shipped animations on, at tier `subtle` (Plan 007) — quieter than the
prior all-on-at-`full` default, and free of the 6 status-bar duplicators and the 4
scope-dropped animations (see "Not included" above). Any shipped animation is one
`omp plugin config set @oh-my-pi/animations <id> false` away from being turned off.
`createAnimationsPlugin()`'s code fallback (used only when a key is absent from both
stored settings and env — e.g. direct programmatic use outside the omp host) stays
`full`/all-registered-enabled — see the comment above `DEFAULT_TIER` in `src/registrar.ts`.

## Requirements

- **Bun** ≥ 1.3.14
- **oh-my-pi ≥ 16** — the plugin imports real agent signals from
  `@oh-my-pi/pi-coding-agent` via its `./*` subpath export.
  **R2 caveat — pin the major:** those internal subpaths are not a semver-stable
  contract; an oh-my-pi major that reshuffles them can break the imports.
- **Optional core hooks (graceful degradation).** Two signals are optional oh-my-pi
  core extensions that stock `@oh-my-pi/pi-coding-agent@16` / `pi-tui@16` do not expose;
  the plugin builds and runs without them and simply degrades:
  - `TUI.renderUnderPressure` — render-backpressure frame-shedding. Absent ⇒ animations
    never self-throttle on render cost (they still gate on TTY/CI/`NO_COLOR`/tier).
  - `ContextUsage.tokensUntilCompaction` / `compactionThresholdTokens` — Context
    Weather's pre-compaction storm forecast. Absent ⇒ the barometer falls back to its
    `contextWeatherStormAtPercent` percentage threshold.
  A core that exposes these hooks lights up the richer behavior automatically.

## Security posture

Like every oh-my-pi extension, this plugin's code runs **in-process, unsandboxed**,
once installed and enabled — `omp` does not isolate extension code from the host
process (see `docs/extension-loading.md` in the oh-my-pi monorepo: "Extensions are
not sandboxed, same process/runtime"). Installing this plugin grants it the same
trust as any other extension: access to the shared event bus, session runtime, and
whatever the `ExtensionAPI` surface exposes. There is no additional sandboxing or
capability restriction specific to this package.

This is not a defect unique to this plugin — it's the current oh-my-pi extension
trust model, and applies identically to every built-in and third-party extension.
If you only install plugins from sources you trust, this is no different from
running any other local dev tool. A "workspace trust" consent boundary for
project-local executable code has been proposed upstream (scored 720-750/1000 by
independent cross-model review, not yet built) — see the oh-my-pi monorepo's
`DUELING_WIZARDS_REPORT_R2.md` for the finding this note is based on. If that
lands, it would apply here too, but this plugin does not depend on it.

## Layout

```
src/kit/            vendored pi-animation kit (AnimationHost, MotionPolicy, AnimatedWidget, backpressureFromTui)
src/<animation>/    one dir per animation (star-barrel index.ts)
src/registrar.ts    the single config-driven omp plugin entry
src/index.ts        package barrel (kit + registrar + the 13 shipped createXExtension factories)
test/               behavioral tests (per-animation, wave2-gallery, kit, registrar, context-weather/*)
```

## Develop

```bash
bun install      # resolves pi-coding-agent / pi-tui / pi-utils from npm
bun run fix      # biome check --write --unsafe (tab / indent-width 3)
bun check        # biome + tsgo type-check — green
bun test         # behavioral suite — green
```

### Validation status

`bun check` is green (biome + tsgo, zero errors) across the vendored kit, all 25
animation modules (the 13 registrar-mounted plus the 10 unregistered-but-retained plus
Spinner Packs and Compaction Vacuum), and the registrar. `bun test` is green — see
`plans/PROGRESS.md` for the current pass/fail/assertion tally. The 10 unregistered
animations' per-feature test files (including Context Weather's suite) still run and
pass unchanged, since only the registrar/manifest/barrel wiring was cut, not their
source. `wave2-gallery` exercises the original 6 shipped controllers together (predates
Palimpsest); `registrar` covers enablement/tier resolution, the synchronous
stored-settings reader, and the dropped-list + manifest-default regression guards.

### Manual acceptance: Context Weather

Context Weather's visual acceptance criteria — "renders the current pressure level",
"the storm pulse", "reads as smooth" — aren't machine-checkable. `bun test` covers
byte-stable frame determinism (`test/context-weather/harness.test.ts`,
`test/goal-horizon-harness.test.ts`) and boot/dispose leak-safety
(`test/boot-smoke.test.ts`); this is the human check for the rest. Since Context Weather
is unregistered (see "Not included" above), dev-load it directly:

1. Temporarily add `"./src/context-weather/extension.ts"` to `package.json#omp.extensions`.
2. `OMP_CONTEXT_WEATHER_ANIMATIONS=full OMP_CONTEXT_WEATHER_STORM_AT_PERCENT=20 omp plugin install ./path/to/this/repo`
   (Context Weather's own `animations` setting defaults `off`; the lowered storm
   threshold makes it reachable without burning a huge context window).
3. Run `omp`. The barometer widget mounts above the editor.
4. Send a few large messages/tool calls to grow context usage — confirm the barometer's
   level and color transition at each of the core's 50/70/90% thresholds (normal →
   warning → purple → error) and that the animation stays smooth (no jump/tear) through
   each level.
5. Keep growing usage past the 20% storm threshold set above — confirm the barometer
   switches to its storm variant (faster pulse) and the one-shot "storm building —
   auto-compaction is near" notification fires exactly once.
6. Revert the `package.json#omp.extensions` edit and reinstall to restore the normal
   registrar-only plugin.

## License

MIT — see [LICENSE](LICENSE). Matches the upstream oh-my-pi packages this plugin
depends on.

## Installing from outside this machine

Distributed via a public git remote, not npm (`package.json` stays `"private":
true` deliberately — this package is not intended to be `npm publish`ed):

```
omp plugin install github:<owner>/oh-my-pi-animations
```

Until the remote is actually created and pushed, use the local path form for
development: `omp plugin install ./path/to/oh-my-pi-animations` (see "How
oh-my-pi installs and enables it" above).
