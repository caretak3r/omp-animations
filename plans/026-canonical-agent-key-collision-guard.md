# Plan 026: Canonical agent join key + in-session multi-writer collision guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> any excerpt below no longer matches the file on disk, STOP and report the
> drift instead of adapting silently.
>
> Drift check before Phase A: confirm HEAD is `e2e78cd` (`git rev-parse
> --short HEAD`). The working tree is intentionally dirty; this plan cites
> files as they are on disk. If any cited line range below differs from what
> you read, STOP.

## Status

- **Priority**: P5 — execute LAST (after 020–025)
- **Effort**: M (P2) + M (A8)
- **Risk**: Medium
- **Planned at**: `e2e78cd` (2026-09-12, intentionally dirty tree)
- **Bundle**: P2 + A8 (Round 5 triage, plan 026)
- **Hard internal dependency**: the A8 phases (D–E) MUST NOT start until the
  P2 phases (A–C) are merged and green — an alert row computed over a lossy
  join cries wolf.

## Why this matters

**P2**: agent identity is joined across two stores with a lossy triple-key
guess. The Bonsai keys its entries by `${toolCallId}:${row.id}`; the roster
keys agents by bare allocated name; the projection bridges them by trying
full id, post-`:` suffix, and display name in order. Both sources already
share one canonical token — the allocated agent name — so the guess is pure
liability: name shadowing, suffix collisions, and stale-node mis-attachment
are all reachable.

**A8**: the Multi-Writer Collision Guard (qmc idea #4). The out-of-process
half (`poisoned` fs-probe) already shipped in `/audit`. The in-session half —
two live agents holding active write-class operations on the same path — is
observable today from exact roster operations and rendered nowhere. It only
becomes honest once P2 makes the agent join exact.

## Current state

### P2 — the triple-keyed join

The Bonsai controller keys agents by toolCallId-prefixed composite —
`src/agent-bonsai/controller.ts:215-227`:

```ts
	#applyProgress(toolCallId: string, row: TaskAgentProgress): void {
		const id = `${toolCallId}:${row.id}`;
		let entry = this.#agents.get(id);
		if (entry === undefined) {
			entry = {
				id,
				name: row.id,
				cohort: this.#nextCohort++,
				createdAt: this.#now(),
				status: row.status,
				skills: new Set<string>(),
			};
			this.#agents.set(id, entry);
		}
```

and settles by prefix scan — `src/agent-bonsai/controller.ts:201-211`:

```ts
		if (extractTaskAsyncState(event.result) !== "running") {
			const prefix = `${event.toolCallId}:`;
			for (const entry of this.#agents.values()) {
				if (!entry.id.startsWith(prefix)) continue;
				if (entry.status !== "running" && entry.status !== "pending") continue;
				entry.status = event.isError === true ? "failed" : "completed";
				entry.completedAt = this.#now();
```

The host's progress row `id` IS the allocated agent name —
`src/agent-bonsai/progress.ts:13-18`:

```ts
/**
 * Progress row streamed by the host's `task` tool for one subagent — the fields
 * the Bonsai reads out of the host's own `AgentProgress` (`src/task/types.ts`).
 * `id` is the allocated agent name (`SkillProbe`), `agent` its type (`scout`).
```

The projection guesses across the key mismatch —
`src/activity-roster/projection.ts:26-42`:

```ts
function fallbackAgentKeys(node: AgentBonsaiNode): readonly string[] {
	const separator = node.id.lastIndexOf(":");
	const suffix = separator < 0 ? node.id : node.id.slice(separator + 1);
	return [...new Set([node.id, suffix, node.name])];
}

function fallbackAgents(snapshot: AgentBonsaiSnapshot | undefined): FallbackAgentIndex {
	const nodes = snapshot?.nodes ?? [];
	const byKey = new Map<string, AgentBonsaiNode>();
	for (const node of nodes) {
		if (node.depth === 0) continue;
		for (const key of fallbackAgentKeys(node)) {
			if (!byKey.has(key)) byKey.set(key, node);
		}
	}
```

consumed at `src/activity-roster/projection.ts:66-69` (exact-agent metadata
lookup) and `:112` (retired-id check runs over all three key variants):

```ts
		const metadata =
			agent.id === "main" ? inferred.nodes.find(node => node.depth === 0) : inferred.byKey.get(agent.id);
```

The mismatch is pinned in tests today — `test/agent-bonsai.test.ts:1148-1155`:

```ts
		expect(controller.snapshot().nodes.map(node => node.id)).toEqual(["Main", "request:worker"]);
		expect(projectActivityAgents(root.snapshot(), controller.snapshot()).nodes.map(node => node.id)).toEqual([
			"main",
		]);
		controller.onAgentStart();
		…
		expect(root.snapshot().retiredAgentIds).toEqual(["worker"]);
```

— the roster retires bare `"worker"` while the Bonsai node id is
`"request:worker"`; only the suffix/name fallback makes retirement reach the
node. First-wins indexing (`if (!byKey.has(key))`, `:38`) means a name
shadowing an earlier node's suffix silently mis-attaches.

Unconsumed inferred nodes are appended as streamed-only rows
(`src/activity-roster/projection.ts:110-133`) — that behavior stays.

### A8 — collision facts already exist, unrendered

Operations are write-class by construction: the bus only records them when
`normalizeMutationTargets` yields targets — `src/activity-roster/bus.ts:730-733`:

```ts
		this.#observeProvenance(binding.agent, tool);
		if (normalizeMutationTargets(event.toolName, event.args, binding.agent.cwd).length > 0) {
			this.#replaceOperations(binding, event);
		}
```

Snapshot shape — `src/activity-roster/bus.ts:36-45` (`ActivityOperationSnapshot`:
`id`, `agentId`, `tool`, path, `line?`, `phase: "active" | "completing"`,
`startedAt`, `isError`). The projection already filters and maps them —
`src/activity-roster/projection.ts:169-177`:

```ts
	const exact =
		roster?.operations
			.filter(operation => operation.phase === "active")
			.map(operation => ({
				owner: operation.agentId,
				path: operation.path,
				tool: operation.tool,
				startedAt: operation.startedAt,
			})) ?? [];
```

The `filesLive` renderer draws paths with no owner awareness —
`src/live-files/render.ts:15-44` (spans are `path-N` texts; dot `live`/`idle`;
`LiveFileSnapshot` is just `{ entries }`, `src/live-files/state.ts:4-13`).
Prior art for multi-writer language exists: `liveWriterCount`
(`src/activity-roster/bus.ts:954`) counts distinct owner sessions and feeds
the `1 writer` title (`test/registrar.test.ts:558`), but nothing is
per-path.

**Collision predicate (this plan's definition)**: among
`roster.operations` with `phase === "active"`, a path held by ≥ 2 distinct
`agentId` values. Fallback (legacy event-backed) entries are excluded — they
attribute everything to `"main"` (`src/live-files/state.ts:29-36`) and would
fabricate or mask collisions.

### Design invariants to preserve

ONE Audit Box widget on ONE `AnimationHost`/shared scheduler; no fabricated
telemetry — the collision alert derives only from exact roster operations;
D6: the alert persists steadily while the condition holds and never blinks
(it clears when the operations complete and age out of the snapshot,
`src/activity-roster/bus.ts:903-907`); D4: no collision data → no marker,
never a reassuring "no collisions" claim; 45/69/120-col ladder unchanged —
the collision chip must survive narrow widths (an alert must not be
wideOnly); settings at wire time; finite motion (no new animation). Test
conventions: no `mock.module`, no `any`, no `ReturnType`, no
wording/glyph/default pins — assert consumer-observable behavior.

**The P2 proof is zero visual diff.** Rendered Bonsai rows, goldens, and
screenshots must be byte-identical after Phases A–C. Node *ids* change
(`request:worker` → `worker`) — that is the point — so non-visual id
assertions in tests are updated deliberately; anything a user sees must not
move.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | Biome + tsgo clean; baseline 51 files / 1213 pass / 0 fail (counts grow) |
| Visual-diff gate (P2) | `bun test test/agent-bonsai.test.ts test/activity-roster-bus.test.ts test/animations-box-goldens.test.ts test/screenshot-regression.test.ts` | 0 fail with ZERO golden/screenshot recaptures |
| Scoped A8 run | `bun test test/live-files.test.ts test/registrar.test.ts test/agent-bonsai.test.ts` | 0 fail |
| Sandbox capture | see Sandbox verification | probe:lint 0 violations |

## Scope

**In scope** (10 files):

- `src/agent-bonsai/controller.ts` (Phase A)
- `test/agent-bonsai.test.ts` (Phases A, B, E)
- `src/activity-roster/projection.ts` (Phases B, D, E)
- `test/registrar.test.ts` (Phases B, D)
- `test/activity-roster-bus.test.ts` (Phase B)
- `src/live-files/state.ts` (Phase D)
- `src/live-files/render.ts` (Phase D)
- `test/live-files.test.ts` (Phase D)
- `src/agent-bonsai/state.ts` + `src/agent-bonsai/widget.ts` (Phase E)

**Out of scope**: Bonsai geometry (beads mg5.4/mg5.6); tools row (bead 747);
`src/activity-roster/bus.ts` (the collision predicate is computed from its
existing snapshot — the bus is not modified); the out-of-process `poisoned`
half of the collision guard (already shipped in `/audit`); host sources
under `node_modules`; plans 020–025 surfaces except where 025's Phase A
already landed in `src/agent-bonsai/widget.ts` (rebase on it, do not revert
it).

## Git workflow

Branch `advisor/026-canonical-agent-key-collision-guard`; one Conventional
Commit per phase (`refactor(agent-bonsai): …`, `refactor(activity-roster): …`,
`feat(live-files): …`); no push, no PR unless the maintainer asks.

## Steps

### Phase A — P2: canonical key in the Bonsai controller

Files (2): `src/agent-bonsai/controller.ts`, `test/agent-bonsai.test.ts`.

1. `AgentEntry` (`:50-58`) gains `toolCallId: string` (mutable).
2. `#applyProgress` (`:215-246`): key `#agents` by `row.id` alone
   (`id: row.id`, `name: row.id`); store `toolCallId`. On an existing entry
   whose `toolCallId` differs from the incoming one:
   - **settled** (`completedAt !== undefined`) → name reuse across task
     calls: delete the old entry and create a fresh one (new cohort, new
     `createdAt`) — no metadata (model/task/skills/completedAt) may leak
     from the retired incarnation;
   - **unsettled** → the host guarantees live-name uniqueness, so treat as
     ownership transfer: update `entry.toolCallId` in place and continue
     merging. This choice is pinned by a named adversarial test (below).
3. `onToolExecutionEnd` settle scan (`:201-211`): replace the
   `entry.id.startsWith(`${toolCallId}:`)` prefix match with
   `entry.toolCallId === event.toolCallId`.
4. `snapshot()`'s retired check (`:289`,
   `retiredAgentIds?.has(entry.id) || retiredAgentIds?.has(entry.name)`)
   collapses to the single `entry.id` check — id and name are now the same
   token.
5. Update existing id assertions that pin the prefixed composite — known
   sites in `test/agent-bonsai.test.ts`: `:1101-1103` / `:1107-1119`
   (`"cohort:fallback-only"`, `"cohort:pending"` → bare names),
   `:1148` (`"request:worker"` → `"worker"`). These are join-key contract
   updates, not wording re-pins. Rendered-row assertions must NOT change —
   cohort labels, names, statuses, and text are unaffected because
   `name: row.id` and cohort assignment order are unchanged.
6. Gate: `bun run fix && bun run check && bun test`.

### Phase B — P2: exact-equality lookup in the projection + adversarial matrix

Files (4): `src/activity-roster/projection.ts`, `test/agent-bonsai.test.ts`,
`test/registrar.test.ts`, `test/activity-roster-bus.test.ts`.

1. Delete `fallbackAgentKeys` (`:26-30`). `fallbackAgents` (`:32-42`)
   indexes each depth>0 node by `node.id` only; first-wins dedupe logic
   disappears with the multi-key loop.
2. Retired check at `:112`:
   `fallbackAgentKeys(node).some(key => retiredIds.has(key))` →
   `retiredIds.has(node.id)`.
3. The `main` depth-0 special case (`:67-68`) and the streamed-only
   leftover-append (`:110-133`) stay byte-identical.
4. **Adversarial matrix** — add as named test cases (they span the exact
   snapshot path end-to-end via `projectActivityAgents`, following the
   existing harness patterns at `test/agent-bonsai.test.ts:997-1005` and
   `test/registrar.test.ts:600-604`):
   - `"late registration"`: task progress rows for name `East` arrive before
     the roster registers agent `East`; after registration the roster agent
     must consume the Bonsai node's metadata (model/task/skill) by exact id
     equality — one node, not two.
   - `"name reuse within one retention window"`: `East` completes and is
     retained; a second task call spawns a new `East`. The projected tree
     shows the new incarnation running with fresh cohort/metadata; nothing
     (completedAt, model, skills) leaks from the settled incarnation.
   - `"aborted-before-register"`: a task call errors before any roster
     registration; the terminal streamed row renders as a streamed-only
     aborted node; no fallback mis-attachment to an unrelated roster agent
     with a similar suffix.
5. **Zero-visual-diff gate**: run
   `bun test test/agent-bonsai.test.ts test/activity-roster-bus.test.ts test/animations-box-goldens.test.ts test/screenshot-regression.test.ts`
   with zero golden or screenshot recaptures. Any rendered-row byte
   difference is a STOP, not a re-golden.
6. Gate: `bun run fix && bun run check && bun test`.

### Phase C — P2: sandbox proof

Files (0) — verification only.

Run the sandbox capture (below) with a real multi-sibling `task` fan-out.
Confirm agents attach (model/skill chips present on roster-joined rows),
retire on new request, and that frame content for the agents block matches a
pre-branch capture of the same scenario. Only after this phase may D/E begin.

### Phase D — A8: collision detection + filesLive alert variant

Files (5): `src/activity-roster/projection.ts`, `src/live-files/state.ts`,
`src/live-files/render.ts`, `test/live-files.test.ts`, `test/registrar.test.ts`.

1. `src/live-files/state.ts:11-13`: `LiveFileSnapshot` gains
   `readonly collidingPaths?: readonly string[]`. Legacy producers
   (`LiveFilesState.snapshot()`) never set it — absent means "no exact
   collision data", and the renderer treats absent exactly like today (D4).
2. `src/activity-roster/projection.ts`: add
   `collidingPaths(roster): readonly string[]` — paths appearing with ≥ 2
   distinct `agentId` values among `roster.operations` filtered to
   `phase === "active"` (reuse the `:169-177` filter shape). Thread it
   through `buildActivityFilesSegment` (`:193-199`) into the snapshot it
   builds. Fallback entries contribute nothing to the predicate.
3. `src/live-files/render.ts` `buildLiveFilesSnapshotSegment` (`:15-44`):
   when a rendered path is in `collidingPaths`, its span carries
   `tone: "alert"`, and the row's dot escalates `"live"` → `"alert"`; append
   one span `{ key: "clash", text: `${count} writers` }` where `count` is
   the number of distinct writers on the worst colliding path. No collision →
   output byte-identical to today (assert this).
4. Tests:
   - `test/live-files.test.ts`: snapshot without `collidingPaths` → segment
     deep-equals today's output; with a colliding path → alert dot, alert
     tone on that path's span only, `N writers` span present; collision
     clears → back to the plain variant (D6: steady state both sides, no
     oscillation from render alone).
   - `test/registrar.test.ts`: extend the existing roster-driven files
     assertion (`:533-536` builds `buildActivityFilesSegment` from a real
     roster snapshot) with a two-agent same-path active-ops scenario →
     segment shows the alert variant; single-writer scenario stays plain.
5. Gate: `bun run fix && bun run check && bun test`.

### Phase E — A8: Bonsai collision chip

Files (4): `src/agent-bonsai/state.ts`, `src/agent-bonsai/widget.ts`,
`src/activity-roster/projection.ts`, `test/agent-bonsai.test.ts`.

1. `src/agent-bonsai/state.ts`: build caches (`:44-53`) gain
   `readonly collisions?: ReadonlySet<string>`; `AgentBonsaiNode` gains
   `readonly collision?: boolean`, set when `caches.collisions?.has(ref.id)`.
   The Bonsai controller's own `buildAgentBonsai` call
   (`src/agent-bonsai/controller.ts:318`) never supplies collisions —
   streamed-only trees cannot claim one (this is why A8 gates on P2).
2. `src/activity-roster/projection.ts` `exactAgentSnapshot`: pass
   `collisions` — the set of `agentId`s holding an active operation on a
   colliding path (from Phase D's predicate) — into its `buildAgentBonsai`
   call (`:134-143`).
3. `src/agent-bonsai/widget.ts`: `AgentBonsaiRowSpans` (`:65-72`) gains a
   `collision` span (`text: "write-clash"` when `node.collision`, else
   `""`); include it in `observeRows`' span list (`:140`) so appearance
   flashes like any other span change; render it in `assemble`
   (`:484-503`) directly after the name, error-toned, present in every
   width candidate (`:506-512`) — an alert survives narrow degradation.
4. Tests (`test/agent-bonsai.test.ts`): colliding node's rendered row
   differs from its non-colliding render by exactly the chip; chip present
   at the narrowest assembled candidate; collision cleared → row returns to
   its plain form; streamed-only (controller-built) snapshots never render
   the chip.
5. Gate: `bun run fix && bun run check && bun test`.

## Test plan

- **Re-run unchanged**: all suites; Phases A–C additionally demand zero
  golden/screenshot recaptures (visual-diff gate above).
- **Deliberate non-visual updates (Phase A/B)**: node-id assertions listed
  in Phase A step 5 — join-key contract, not wording.
- **New behavioral tests**: the three named adversarial cases (Phase B);
  filesLive collision variants (Phase D); Bonsai chip lifecycle (Phase E).
- **Expected re-goldens**: none in any phase. A8's alert variants only
  render in scenes that stage a collision, which no existing golden does.

## Sandbox verification

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
# (fake HOME /tmp/omp-anim-sandbox/home, cwd /tmp/omp-anim-sandbox/project)
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

- **Phase C**: multi-sibling fan-out; agents block frames match a pre-branch
  capture of the same scenario (row regex `^│ [├└]─ [○◐●✗] A\d`); a second
  user request retires settled rows exactly as before.
- **Phase D/E**: stage two subagents editing one file; the `files` row
  (row regex `^│ [○◐●✗]  files `) shows the alert variant with `2 writers`,
  and both agents' Bonsai rows carry the chip; after both writes complete
  the alert clears within the completion-flash window and does not
  reappear. A single-writer session must never show either marker.

## Done criteria

- [ ] Repo gate exits 0 after every phase.
- [ ] `#agents` keyed by allocated name; settle-scoping via stored `toolCallId`.
- [ ] `fallbackAgentKeys` deleted; projection joins by exact id equality only.
- [ ] Three adversarial cases pass as named tests.
- [ ] ZERO golden/screenshot recaptures across the whole plan.
- [ ] filesLive alert variant + Bonsai chip render only under a genuine
      ≥2-distinct-agent active write on one path, and clear when it ends.
- [ ] Streamed-only snapshots can never render a collision marker.
- [ ] Sandbox probe + probe:lint clean; collision scenario verified live.

## STOP conditions

- Any cited excerpt above mismatches the file on disk at execution time.
- Any golden, screenshot, or rendered-row byte diff during Phases A–C — the
  P2 proof is zero visual diff; a diff means the canonical-key premise or
  the cohort-order preservation is wrong. Re-plan, do not re-golden.
- Sandbox shows a host `task` progress row whose `id` is NOT the roster's
  agent id (the `progress.ts:13-18` premise broken by host drift from the
  `^17` pin) — the canonical key does not exist; STOP.
- Sandbox shows two simultaneously live agents sharing one allocated name —
  the ownership-transfer rule in Phase A step 2 is unsound; STOP.
- Phase D/E: the collision marker appears in a single-writer sandbox
  session — false positive in the predicate; STOP.
- Bead `omp-animations-mg5.4`/`mg5.6` has landed a Bonsai geometry change
  conflicting with Phase E's row assembly edit — coordinate, do not merge
  blind.
- Plan 025 has not landed and its Phase A widget edits conflict — rebase
  this plan's Phase E on 025's merged state first.

## Rollback

One commit per phase. E depends on D (predicate) and on A/B (exact join);
D depends on A/B semantically (honesty of the alert) though it compiles
without them. Revert order when unwinding fully: E, D, then B, then A.
Reverting A alone while B remains would resurrect the prefix keys against an
exact-only projection — never leave that state on the branch.

## Beads

- Record qmc #4 status change: with this plan, the Multi-Writer Collision
  Guard's in-session half ships (out-of-process `poisoned` half already in
  `/audit`) — Main will `bd update --notes`.
- `omp-animations-mg5.4` / `omp-animations-mg5.6` — Bonsai geometry owners;
  Phase E touches row content only.
- `omp-animations-747` — tools row; untouched.

## Maintenance notes

- After P2, `AgentEntry.id === AgentEntry.name`; keep both fields anyway —
  `name` is the outward-reported outcome key (`#reportOutcome`, `:248-251`)
  and collapsing them into one field would ripple through the outcome
  callback signature for no behavioral gain.
- If the host ever changes session-file naming so an agent's roster id
  diverges from the allocated name, rows degrade to streamed-only instead
  of mis-attaching — that is the designed failure mode; do not reintroduce
  fuzzy fallbacks to "fix" it.
- The collision predicate deliberately lives in the projection, not the
  bus: the bus snapshot already carries everything needed, and keeping the
  bus write-path untouched keeps 026 revertible without touching telemetry
  capture.
