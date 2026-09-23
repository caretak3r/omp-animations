# AGENTS.md

This file is the agent contract for `@oh-my-pi/animations`.
`CLAUDE.md` is a symbolic link to this file. Do not write a second copy.

This package is one oh-my-pi (omp) plugin. It draws the Audit Box.
Do not change omp core source.

---

## Product contract

The plugin mounts one Audit Box widget on one `AnimationHost`.
The default placement is below the editor.

The Audit Box holds five core rows in this order:

1. `contextGauge` — context fill against the quota
2. `cacheMeter` — prompt-cache hit rate and cost
3. `auditTrailBox` — file trust
4. `rateLimitTidepool` — provider response health, then rate-limit headroom
5. `filesLive` — paths that an edit or write call currently owns

Agent Bonsai is an optional group in the Audit Box.
Agent Bonsai caps at 8 visible nodes (`MAX_BONSAI_ROWS`) and, of those, at most 3 keep their activity/provenance sub-rows (`MAX_BONSAI_DETAIL_ROWS`) — running and aborted agents claim both budgets first. Simple detail mode drops all activity/provenance sub-rows regardless of node count. Any node the box cannot show, whether from the node cap or the detail-row cap, is named by its display name in the trailing `… +N more (...)` line — an aborted agent never disappears without a name.
Breathing Border is not a row. It colors the Audit Box border.

Signal extras are optional groups below the core rows.
A signal extra group appears only when its setting is on and the signal has meaningful state.
The signal extra ids are the keys in `SIGNAL_EXTRA_IDS`:

- `liveFiles` — enables the `filesLive` core row
- `recurrenceStrip`
- `contextRewriteShadow`
- `compactionScar`
- `consentLock`
- `sessionPhylogeny`
- `thinkActLissajous` (default off)
- `errorIsotope`
- `skillChromatograph`
- `retryRadar`
- `verify`
- `authBeacon`
- `asyncJobHarbor`
- `goalHeading` (default off)
- `ttftSplit`
- `memoryBackendTide`
- `darkroomTitle` (default off)

When no enabled signal extra has meaningful state, the box shows the core rows only.
Do not add an idle placeholder or a leading separator for the extras.

Darkroom Title writes critical state to the terminal title. It does not use a widget row.

`contextGauge` is the only Audit Box row that can show numbers on the first paint.
It reads `ctx.getContextUsage()` on every render and uses the standard progress bar.
`cacheMeter` waits for `message_end`.
`rateLimitTidepool` waits for the first `after_provider_response`, then leads with the HTTP status class counts; the header-derived headroom is a wide-only tail that needs a whitelisted provider.
The `verify` row shows writes newer than the last successful bash; its absence is silence, not a verification claim.
`filesLive` starts on `tool_call` and clears on the matching result.
An idle `○ —` on cache, limits, or files before the first response is not a fault.

Do not add a second widget for the same signal.
Do not ease a money figure or a risk figure toward a target.
Do not blink an alarm that reports money or risk.

Do not decorate agent roles.
Instrument state that the session cannot see without these surfaces.

---

## Architecture

Each animation directory is pure state plus a pure renderer.
Nothing in those directories subscribes to the host.
Nothing in those directories mounts a widget.

`src/registrar.ts` is the one extension in `package.json#omp.extensions`.
It reads settings at wire time, before any event.
It mounts one `AnimationsBoxController` and one headless Audit Trail service.

`AnimationsBoxController` is the one subscriber.
It owns one `AnimationsBoxWidget` on one `AnimationHost`.
It adapts host events into the `*State` objects.
`#buildAuditSampleGroups` builds the core rows, the Agent Bonsai group, and the signal-extra groups.

`#onTick` is the one per-frame mutation seam.
The breathing border settles through this seam. Retry Radar and evidence expiry read `now` at render time.
All signals read `now` from the shared scheduler.
Do not add a second clock.
That clock is `Date.now()` and can step backward on NTP correction or sleep/wake.
State must tolerate a backward step. Do not assert monotonic time on it.

A throw from `renderFrame` or `onFrame` never reaches the host.
`AnimatedWidget` detaches from the clock, reports the error once through `api.logger`, and renders one `✕ animations box disabled · <error>` line for the rest of the session.
Do not catch render errors lower down to keep the box alive on stale numbers.

Reuse each animation's exported renderer and `*State` class.
Do not invent a second string for the same fact.

`legend.ts` derives from the segment registries.
Do not edit `legend.ts` when you add a row.

---

## Settings

Settings are flat keys in `package.json#omp.settings`.
Precedence is stored settings, then `OMP_*` environment, then the default.

Use these names and no others:

- `animations` — motion tier: `off`, `subtle`, `full`. Default `subtle`.
- `animationsBoxDetail` — `simple`, `readable`, or `detailed`. Default `readable`. `simple` and `readable` render one line per agent in Agent Bonsai; `detailed` adds activity/provenance sub-rows.
- `animationsBoxPlacement` — `aboveEditor` or `belowEditor`. Default `belowEditor`.
- `animationsContextQuota` — quota percent, `5` to `100`. Default `80`.
- `agentBonsai`, `breathingBorder` — default `true`.
- `liveFiles` and all keys in `SIGNAL_EXTRA_IDS` — default `true`.

The removed `display` key (`rows` / `box` / `both`) must not select a surface.
A stale `rows` or `both` value logs one warning and still mounts the complete box.

The five core Audit Box summaries have no enable setting.
`liveFiles` is an optional Audit Box row.

Settings apply at wire time.
Restart omp after you change a setting or plugin source.

---

## Add a core Audit Box row

A new core row is a six-file contract. Change all six files in one change.

1. `/Users/rohit/Documents/omp-animations/src/animations-box/settings.ts` — add the id to `BOX_REQUIRED_SEGMENT_IDS` in render order. The type check fails until step 2 is done.
2. `/Users/rohit/Documents/omp-animations/src/animations-box/row-registry.ts` — add the row's `CoreRowSpec`: its metadata, an optional `enabled` gate, and the build lambda. Extend `CoreRowDeps` and the controller's deps literal if the row needs new state.
3. `/Users/rohit/Documents/omp-animations/src/animations-box/segments.ts` — add the metadata const, the builder, and the `SEGMENT_REGISTRY` line. The consistency test in `test/animations-box-settings.test.ts` fails if you forget.
4. `/Users/rohit/Documents/omp-animations/test/animations-box-settings.test.ts` — pin the new id arrays.
5. `/Users/rohit/Documents/omp-animations/test/animations-box-goldens.test.ts` — recapture frames and re-check the degradation `LADDER` at widths 45, 69, and 120.
6. `/Users/rohit/Documents/omp-animations/test/screenshot-regression.test.ts` — update labels, `rows[N]` indexes, and optional-tail slices.

Keep Audit Box rows out of `ANIMATIONS` and out of migration lists.
A new core row changes which optional groups drop at 45 and 69.
Re-check the `LADDER` after every core-row change.

---

## Host limits from a plugin

A plugin loads a second copy of every host module singleton.

`AgentRegistry.global()` is empty from a plugin.
Read subagent progress from `tool_execution_update` / `tool_execution_end`.

`ctx.ui.setHeader` exists on the type and is a no-op in interactive mode.

`WidgetPlacement` is only `aboveEditor` or `belowEditor`.
The plugin cannot pin chrome to the true top of the omp viewport.
A pulsing header as the first TUI child sits in scrollback and re-anchors every frame.

The main transcript's shimmer on a running subagent's name is `display.shimmer`,
a host setting the plugin cannot see or suppress — a plugin mounts widgets, it has
no hook into the host's own text rendering. Point users at
`omp config set display.shimmer disabled` paired with `agentBonsai: true` instead
of building a plugin-side override.

Do not change omp core to remove these limits.

---

## Verification

The gate from the repo root is:

```bash
cd /Users/rohit/Documents/omp-animations
bun run fix && bun run check && bun test
```

`bun run check` is Biome plus `tsgo`.
`bun test` is the behavioral suite.

Do not report a task complete when this gate fails.
Do not edit a test to match broken output.
Re-golden a frame only when the row contract changed on purpose.

This repo has no LSP.
Rename by hand, then run the type check.

Do not use `ReturnType<>`.
Do not add a local `isRecord` guard.
Do not use `async` as an identifier.

Use `bd` for task tracking.
Do not use markdown TODO lists for work.

---

## Live sandbox

### Required post-change refresh

Every repository change MUST end with a freshly started sandbox before completion is reported.
The sandbox MUST install the current worktree and copy the existing agents, skills, managed skills, rules, commands, model configuration, and authentication snapshot.
The sandbox MUST use `/tmp/omp-anim-sandbox/home` as `HOME` and `/tmp/omp-anim-sandbox/project` as `--cwd`.
The sandbox MAY read plugin source through its worktree link; it MUST NEVER use the repository as its working directory or write runtime state to the real OMP setup.

After every change:

1. Run `./scripts/sandbox-omp.sh prepare` from the current worktree.
2. Restart only the sandbox OMP process so `session_start` mounts the latest module graph.
3. Start the sandbox when none exists.
4. Verify the plugin link resolves to the current worktree.
5. Capture the live pane and confirm the changed behavior.

Tests alone are insufficient. A task MUST NOT be reported complete until this live sandbox verification passes.

Unit tests prove the box paints what the code says.
A live omp session is the only proof that the box is right.

Do not use the real `~/.omp` tree for that session.
Do not use `omp --profile`.
A named profile still lives under `/Users/rohit/.omp/profiles/` and shares the real tree.

Isolate the session with a fake `HOME`.
Copy skills, agents, and rules into that `HOME`.
Install the plugin from the current git worktree, not from the real plugin link.

### What the sandbox is

Default root: `/tmp/omp-anim-sandbox`.

| Path | Role |
|---|---|
| `/tmp/omp-anim-sandbox/home` | Fake `HOME`. omp writes `.omp` only here. |
| `/tmp/omp-anim-sandbox/project` | Throwaway `--cwd`. Not a real repo of Rohit. |

The real home stays at `/Users/rohit`.
The sandbox must not write to `/Users/rohit/.omp` or `/Users/rohit/.omp/profiles`.

### What to copy

Copy from the real home into the fake home.
Do not symlink these trees back to the real home.

From `/Users/rohit/.omp/agent` into `$SANDBOX_HOME/.omp/agent`:

- `AGENTS.md`
- `agents/`
- `skills/`
- `managed-skills/`
- `config.yml`
- `models.yml`
- `agent.db` through `sqlite3 .backup` (auth and models live here)

From `/Users/rohit/.agents` into `$SANDBOX_HOME/.agents`:

- `rules/`
- `skills/`
- `commands/`

Do not copy:

- `sessions/`
- `history.db*`
- `memories/`
- `plugins/`
- `logs/`
- `~/.omp/profiles/`
- the real `~/.omp/plugins` tree

`config.yml` on this machine sets `skills.enableClaudeUser: false`.
The sandbox uses the copied omp skills, not `~/.claude/skills`.

### How to install the plugin

A local `omp plugin install <path>` is a symlink.
It is the same as `omp plugin link <path>`.

Resolve the repo root of the branch that you edit:

```bash
REPO=$(git rev-parse --show-toplevel)
```

On `main` that path is `/Users/rohit/Documents/omp-animations`.
In a treehouse worktree that path is the worktree, not `Documents`.

Then, with the fake `HOME` only:

```bash
HOME=/tmp/omp-anim-sandbox/home omp plugin install "$REPO"
```

Make sure that the link is the current branch:

```bash
HOME=/tmp/omp-anim-sandbox/home readlink \
  /tmp/omp-anim-sandbox/home/.omp/plugins/node_modules/@oh-my-pi/animations
```

The printed path must be `$REPO`.
If the link points at `/Users/rohit/Documents/omp-animations` while you edit a worktree, uninstall and install again from the worktree.

### How to start

The script `/Users/rohit/Documents/omp-animations/scripts/sandbox-omp.sh` does the copy and the install.

```bash
cd /Users/rohit/Documents/omp-animations   # or the worktree
./scripts/sandbox-omp.sh prepare
./scripts/sandbox-omp.sh start
```

`prepare` builds the fake home, copies the harness files, and installs `$REPO`.
`start` opens tmux session `omp-anim-sandbox` with `HOME` set to the fake home.

Manual start, if you do not use the script:

```bash
HOME=/tmp/omp-anim-sandbox/home \
OMP_ANIMATIONS=full \
tmux new-session -d -s omp-anim-sandbox \
  -c /tmp/omp-anim-sandbox/project -x 200 -y 50 \
  "env HOME=/tmp/omp-anim-sandbox/home OMP_ANIMATIONS=full omp --cwd /tmp/omp-anim-sandbox/project"
```

Do not pass `--no-session` to the sandbox omp.
Without a session file the host leases each subagent into `/tmp/omp-task-*`, outside the roster scope.
The roster then drops every subagent tool call.
The Bonsai still names the agents, but `filesLive` never shows `N writers` and no `write-clash` chip appears.

Make sure that the live process has the fake `HOME`:

```bash
ps eww -p "$(tmux list-panes -t omp-anim-sandbox -F '#{pane_pid}')" | tr ' ' '\n' | grep '^HOME='
```

### Hard rules

CAUTION: Do not wrap the omp TUI in `sandbox-exec`.
The seatbelt profile drops Bun file descriptors and the TUI dies.

CAUTION: Do not send keys into a session that does Rohit's real work.
The real session is `omp-anim` and uses `/Users/rohit/.omp`.
The sandbox session is `omp-anim-sandbox`.

After a source edit, restart the sandbox session.
The box mounts once on `session_start`.
Bun keeps the plugin module graph for the life of the process.
A symlink to new source does not remount a running process.

Do not point `OMP_PROFILE` or `--profile` at a name under `/Users/rohit/.omp/profiles`.

---

## Frame loop

Grade a busy sandbox session. An idle box hides every defect.

```bash
cd /Users/rohit/Documents/omp-animations
bun run probe -- --session omp-anim-sandbox --interval 2
bun run probe:lint
```

`probe` writes distinct box states to `.frames/run-<timestamp>/`.
`probe:lint` grades the newest run against `scripts/frame-lint.ts`.
Exit code `1` means a rule fired.

Sample while the session works: tools fire, subagents run, cache warms.
Reuse one prompt across runs so two captures compare.

If you find a defect by eye, add a rule in `scripts/frame-lint.ts` before you fix the source.
The rule stays after the fix.

Capture is read-only and is always safe.

---

## Delivery

Commits use Conventional Commits: `feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `docs`, `style`, `perf`, `test`.

Do not add AI session URLs or attribution trailers to a commit message.

Do not commit `/Users/rohit/Documents/omp-animations/.beads/`.
Do not commit `flocka`, `query`, `rust-scraper/`, or the idea-dump HTML files.

Do not push unless Rohit asks.
Do not use the real `~/.omp` as a write target for a test.
