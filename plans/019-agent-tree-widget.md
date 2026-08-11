# Plan 019 — Agent Tree: a live main+subagent tree widget

**Status:** approved direction (maintainer request, 2026-08-10), not started.
**Relation to prior plans:** re-scopes the *idea* behind [012](012-agent-fleet-live-legend.md)
(agent-fleet live legend — the `agent-fleet` module is not in this package's curated keep-set)
into a new standalone animation. Independent of [018](018-status-lines-redesign.md): no shared
files except `src/registrar.ts` + `package.json#omp.settings` (018 touches neither after S4).
**Baseline:** the full gate as of the previous landed plan — `bun check` green, `bun test`
0 fail (018's S5 raises the floor; this plan may not lower whatever count it lands on).
**Verification gate:** `bun run fix && bun check && bun test` — no test-count regression.

## 1. The request (maintainer, verbatim scope)

A real-time UI element showing **which agent is currently being used** in the main session,
including subagents, **as a tree** (like omp's nested todos). Per node:

1. agent name,
2. model,
3. a short (≤ 200 chars) gist of its current message / CoT / thoughts,
4. the task it is working on.

Configurable like the other widgets: position, flashing.

## 2. Feasibility (verified against installed `dist/types`, omp 16.x)

Every claim below was read from `node_modules/@oh-my-pi/pi-coding-agent/dist/types/`.

| need | API | verdict |
|---|---|---|
| agent roster + tree | `AgentRegistry.global().list()` → `AgentRef { id, displayName, kind, parentId?, status, session, createdAt, lastActivity, activity? }` (`registry/agent-registry.d.ts`) | **CONFIRMED** — `parentId` gives the tree; `kind: "main"\|"sub"\|"advisor"` |
| reach the registry without a value import | `ExtensionAPI.pi: typeof PiCodingAgent` (`extensibility/extensions/types.d.ts:746`); root index star-exports `sdk.js`, which exports `AgentRegistry`/`AgentRef`/`MAIN_AGENT_ID` (`sdk.d.ts:290`) | **CONFIRMED** — `api.pi.AgentRegistry.global()`. This matters: every module in this package stays on `import type` for pi-coding-agent internals (value imports pull the theme singleton at module load and crash on darwin-arm64 — see `src/cache-meter/index.ts` doc comment). The injected `api.pi` sidesteps that entirely |
| structural change events | `registry.onChange(listener)` → `registered` / `status_changed` / `removed` | **CONFIRMED** — event-driven for mount/status/unmount |
| live activity gist | `AgentRef.activity` — harness-maintained, normalized to one bounded line (`oneLineLabel`), explicitly display-safe ("can neither break the roster nor smuggle terminal escapes") | **CONFIRMED (with the plan-012 caveat)** — `setActivity` emits **no event** (deliberately off the listener path, `agent-registry.d.ts:77-90`), and only `running` agents receive heartbeats. Live activity therefore needs a frame-tick `registry.list()` poll |
| model per node | `ref.session?.model` (`AgentSession.get model(): Model \| undefined`) | **CONFIRMED (cached)** — `session` is null exactly when parked/aborted, so the controller caches last-seen model per agent id, evicted on `removed` |
| task per node | no `task` field on `AgentRef` | **DERIVED** — priority: live session's first `user` message (`ref.session.messages`) → one bounded line; fallback `displayName`. Honest limitation: a parked agent whose task line was never captured shows only its name |
| richer streaming CoT | `ref.session.subscribe(listener)` (`agent-session.d.ts:183`) fires per-token `message_update` | **CONFIRMED but rate-hostile** — deliberately **out of the MVP**; see Non-goals. The harness already feeds `activity` from the model's own intent/tool stream, which is the ≤200-char gist the request asks for |

## 3. Decisions

**D1 — Standalone animation, not a box segment.** A tree is inherently multi-row; box detailed
rows are one status line each (018 D1). New feature dir `src/agent-tree/`, registered in
`ANIMATIONS` as `agentTree`, default placement `belowEditor`.

**D2 — Registry access only via `api.pi`.** No `import` (type-only excepted) of
`@oh-my-pi/pi-coding-agent` value modules anywhere in the feature. The controller takes an
`AgentRegistryLike` seam (`list()`, `onChange()`) so tests inject a plain fake and never touch
the process-global singleton.

**D3 — Event-driven skeleton, polled flesh.** `onChange` drives row add/remove and status dots.
`activity`, `lastActivity`, model, and task lines refresh from one `registry.list()` per frame
tick on the kit's existing scheduler (backpressure-wired per plan 002; ~1–2 Hz is plenty). No
new timers, no per-agent subscriptions.

**D4 — Row grammar** (dot vocabulary shared with 018 D2; preset-aware connectors via
`theme.symbol()` / `glyph-presets.ts`, never raw box-drawing literals):

```
●  Main        opus-4-2      reading src/registrar.ts wiring
├─ ●  AuthLoader  sonnet-4-5    grepping token refresh paths      · port credential store
├─ ○  DocsScout   haiku-4-5     (idle)                            · survey API docs
└─ ◐  Reviewer    (parked)                                        · review auth diff
```

- dot: `●` accent = running · `○` dim = idle · `◐` dim = parked · `●` red = aborted.
- name: `displayName`, left gutter fixed-width per depth.
- model: last-seen `model.id` tail (after the provider `/`), dim; `(parked)` when only status remains.
- gist: `ref.activity` capped at 200 chars **before** width fitting, `replaceTabs` +
  `truncateToWidth`; running rows only (the registry drops heartbeats for any other status).
- task: derived line (D2 table), dim, `·`-separated tail; first span dropped under width pressure.
- Width ladder: drop task tail → shorten gist → drop model, span-wise, same narrowing
  philosophy as the box's status lines.

**D5 — Scope and self-elision.** Rendered set: `Main` + descendants (`parentId` chain), kinds
`main`/`sub` only — `advisor` refs are observability transcripts, never peers, and stay hidden.
Parked refs restored from disk (Agent Hub scans) that were never live this session are excluded
via the same reachability rule. Row cap 8 with a dim `… +N more` tail. **When the tree is Main
alone, the widget elides entirely** (no dead row — the plan-010/017 principle); it appears when
the first subagent registers.

**D6 — Flash means "this changed".** Reuse the span-flash mechanic of 018 D6, locally: per
`(agentId, spanKey)` last-value map; a changed span (new activity, status flip, new row)
renders bold + segment accent and decays by motion tier (`off` → none, `subtle` → one repaint,
`full` → ~800 ms fade). Alerts persist without blinking: `aborted` keeps the red dot until the
ref is removed.

**D7 — Settings, strictly the existing channels.** Manifest gains `agentTree` (boolean enable,
default **false** — opt-in until field-proven) and `agentTreePlacement` (enum, same values as
every other `<id>Placement`). Accent comes from the generic `<id>Accent` appearance slot;
flashing is governed by the shared `animations` motion tier. **No bespoke keys** ("flashing"
configurability *is* the tier — same posture as 018).

**D8 — Main-row events come free.** The extension already receives `agent_start`/`agent_end`/
`message_update` for the session it is mounted on; the Main row's gist may use the streamed
assistant text head (≤200 chars) instead of polling, but the registry poll remains the single
source for subagents so both paths render through one state model.

## 4. Implementation stages (bead-shaped, one commit each)

- **S1 — pure state model.** `src/agent-tree/state.ts`: `AgentNode` snapshot type
  (id, name, depth, status, modelTail, gist, task), `buildAgentTree(refs, caches)` — pure,
  wall-clock-free (elapsed is an input) — reachability filter, ordering (createdAt within a
  parent), row cap, span-key emission for flash diffing. Tests: tree shapes, orphan/parked
  filtering, cap, advisor exclusion, 200-char gist cap.
- **S2 — widget renderer.** `src/agent-tree/widget.ts`: rows from `AgentNode[]`, preset-aware
  connectors, dot tones, width ladder, local flash engine (S1 span keys + injected clock).
  Hermetic render tests with a fixed theme/glyph-preset context; save/restore `CI`/`NO_COLOR`/
  `TERM`/`isTTY` per repo convention.
- **S3 — controller + seam.** `src/agent-tree/controller.ts`: `AgentRegistryLike` seam,
  `onChange` wiring, frame-tick `list()` poll, model/task caches with `removed` eviction,
  self-elision (D5), dispose on `session_shutdown`/`session_switch`. Tests: fake registry
  drives register → running → idle → parked → removed; cache eviction; elision transitions.
- **S4 — factory + registrar + manifest.** `src/agent-tree/index.ts`
  (`createAgentTreeExtension`, options `{ motionSetting, placement, accentColor }` like every
  sibling), `ANIMATIONS` entry, `package.json#omp.settings` keys (D7), README row. Full gate:
  `bun run fix && bun check && bun test`.

Each stage runs only its own test files; the full gate once after S4.

## 5. Non-goals

- **No per-token subagent taps in this plan.** `session.subscribe` on every live subagent is
  confirmed API but fires at token rate across N agents; the harness's own `activity` gist
  already satisfies the ≤200-char requirement. If the maintainer wants raw CoT text later, it
  ships as a follow-up with a mandatory ≥250 ms throttle and running-only lifecycle.
- No interaction: no focus, keyboard, expand/collapse — ambient display only (Agent Hub is the
  interactive surface).
- No hub/IRC integration, no messaging, no revival controls.
- No advisor rows, no cross-process agents.
- Does not touch `animations-box/**`, the legend, or any 018 file.
