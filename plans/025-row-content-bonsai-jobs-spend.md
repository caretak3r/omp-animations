# Plan 025: Row content — Bonsai sibling dedupe, async-job age, off-path spend

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> any excerpt below no longer matches the file on disk, STOP and report the
> drift instead of adapting silently.
>
> Drift check before Phase A: confirm HEAD is `e2e78cd` (`git rev-parse
> --short HEAD`). The working tree is intentionally dirty; this plan cites
> files as they are on disk, not as committed. If any cited line range below
> differs from what you read, STOP.

## Status

- **Priority**: P4
- **Effort**: S (S5) + S (A6) + M (A5)
- **Risk**: Low
- **Planned at**: `e2e78cd` (2026-09-12, intentionally dirty tree)
- **Bundle**: S5 + A6 + A5 (Round 5 triage, plan 025)
- **Execution order**: after 020–024, before 026. 026's zero-visual-diff
  Bonsai golden gate is taken against the goldens as they stand *after* this
  plan's Phase A re-goldens.

## Why this matters

Three rows already earn their line but say less than they know:

- **S5**: when one `task` tool call fans out N siblings with the same brief,
  the Bonsai prints the identical task text N times — the one part of the row
  that distinguishes nothing (evidence below: 4 identical ~110-char tails in
  one captured frame).
- **A6**: the `asyncJobHarbor` row reads only bucket counts. `running[].
  startTime` is delivered in the snapshot and never read, so "2 running"
  cannot distinguish "just started" from "wedged for 20 minutes".
- **A5**: the host's `getUsageStatistics()` accumulates cost over EVERY
  session entry including abandoned branches, while every cost figure the
  user currently sees is current-branch-only. The difference — real dollars
  spent on rewinds and dead branches — is invisible.

## Current state

### S5 — Bonsai repeats identical sibling task text

Captured frame `.frames/run-2026-09-11T00-16-32-350Z-WmUUtl/f0001-t0000010.txt:17-20`:

```
│ ├─ ○ A2 East   (completed)  openai-codex/gpt-6-astra:medium  · Independently list directory entries using read; if package.json exists, read it. Do not edit anything or run validation.             │
│ ├─ ○ A1 North  (completed)  openai-codex/gpt-6-astra:medium  · Independently list directory entries using read; if package.json exists, read it. Do not edit anything or run validation.             │
│ ├─ ○ A3 South  (completed)  openai-codex/gpt-6-astra:medium  · Independently list directory entries using read; if package.json exists, read it. Do not edit anything or run validation.             │
│ └─ ○ A4 West   (completed)  openai-codex/gpt-6-astra:medium  · Independently list directory entries using read; if package.json exists, read it. Do not edit anything or run validation.             │
```

The task tail is appended unconditionally whenever a gist occupies the gist
slot — `src/agent-bonsai/widget.ts:501-503`:

```ts
		if (includeTask && task.length > 0)
			row += `  ${ctx.theme.fg("dim", "·")} ${renderPlainSpan(node, "task", task, ctx)}`;
		return row.trimEnd();
```

fed by `src/agent-bonsai/widget.ts:478-479`:

```ts
	const gist = spans.gist.text || spans.task.text;
	const task = spans.gist.text.length > 0 ? spans.task.text : "";
```

The render loop iterates nodes independently — no cross-row comparison —
`src/agent-bonsai/widget.ts:531-543`:

```ts
	const showModel = sharedBonsaiModel(snapshot.nodes) === undefined;
	const rows: string[] = [];
	for (const node of snapshot.nodes) {
		rows.push(
			renderNode(
				node,
				spansById.get(node.id) as AgentBonsaiRowSpans,
				width,
				widths.get(node.depth) ?? 0,
				ctx,
				showModel,
			),
		);
```

There is already a dedupe precedent in this exact codebase:
`sharedBonsaiModel` (`src/agent-bonsai/widget.ts:455-461`) suppresses
per-row model chips when *every* visible node shares one model, and the Box
widget hoists it into the `agents` header (`src/animations-box/widget.ts:313-316`):

```ts
		// Every visible agent on one model: state it once here rather than on
		// each row, where it would repeat without distinguishing anything.
		const sharedModel = sharedBonsaiModel(bonsaiSnapshot.nodes);
		const bonsaiHeader = sharedModel === undefined ? "agents" : `agents · ${sharedModel}`;
```

In the frame above the model chips still repeat because `sharedBonsaiModel`
compares ALL nodes including Main (`gpt-6-astra`) against the subs
(`openai-codex/gpt-6-astra:medium`) — the all-or-nothing rule misses the
sibling-level share.

**Corrected triage premise — keep `(completed)`.** Triage claimed
"`(completed)` restates the dot". It does not, fully: completed and idle
share the same dot glyph `box.dot.idle` (`src/agent-bonsai/widget.ts:24-31`),
and after the flash window a completed row's color dims to match idle
(`src/agent-bonsai/widget.ts:199-202`). The `(completed)` literal
(`gistLabel`, `src/agent-bonsai/widget.ts:112-117`) is the only remaining
completed-vs-idle discriminator on a gistless row. This plan does NOT remove
it.

Task text originates once per agent in
`src/agent-bonsai/controller.ts:239-240` (`row.description ?? row.task`,
summarized) and reaches the node via `caches.task`
(`src/agent-bonsai/state.ts:221`), so identical sibling text is byte-identical
after normalization — plain string equality is a sound dedupe key.

### A6 — asyncJobHarbor ignores `startTime`

Builder `src/signal-extras/segments.ts:91-128` reads `running.length` and
`recent` statuses only; the single `label` read is the `last …` span for a
failed/cancelled latest (`:114-122`). `startTime` is never read.

The host delivers it: `node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session-types.ts:64-71`:

```ts
/** Public summary of an asynchronous job. */
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;
```

and it is epoch milliseconds — the host itself computes ages as
`Date.now() - job.startTime`
(`node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:1920`).

The plugin's shared clock is ALSO wall-clock epoch ms by contract —
`src/kit/animation-host.ts:15-23`:

```ts
	/** Wall-clock milliseconds since the Unix epoch. */
	now(): number;
	…
/** Default scheduler backed by `Date.now` + `setInterval`/`clearInterval`. */
export const DEFAULT_FRAME_SCHEDULER: FrameScheduler = {
	now: () => Date.now(),
```

so `now - startTime` is a valid age with no new clock plumbing. `now` is
already a parameter of `buildSignalExtraSegments`
(`src/signal-extras/segments.ts:347-355`); the harbor builder just doesn't
receive it yet (call site `src/signal-extras/segments.ts:517`).

Default is off — `src/signal-extras/settings.ts:34`: `asyncJobHarbor: false`
— and the builder already has a zero-height idle contract: with no running,
ready, failed, cancelled, or unknown jobs it returns `undefined`
(`src/signal-extras/segments.ts:104-106`), so an enabled harbor row costs
zero lines in an idle session.

One existing test pins the default: `test/signal-extras.test.ts:673-675`
(`expect(DEFAULT_SIGNAL_EXTRAS_CONFIG.asyncJobHarbor).toBeFalse()`).

### A5 — tree-wide cost exists, branch-only cost is all the user sees

The host accumulates usage over EVERY entry ever inserted into the session
tree — abandoned branches included. `node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:221-235`:

```ts
	insert(entry: SessionEntry): void {
		this.#entriesById.set(entry.id, entry);
		…
		addUsage(this.#usage, entryUsage(entry));
	}
```

Which entries carry usage (`:145-151`):

```ts
function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}
```

Cost accumulation (`:164`): `target.cost += usage.cost.total;` —
`Usage.cost.total` is a number
(`node_modules/@oh-my-pi/pi-catalog/src/types.ts:144-150`).

`getUsageStatistics()` exposes the tree-wide total (`session-manager.ts:1854-1856`)
and IS on the `ReadonlySessionManager` pick a plugin receives
(`session-manager.ts:327-350`, member list includes `"getUsageStatistics"`).

The plugin already walks the current branch each turn — `src/registrar.ts:288-291`:

```ts
function readSessionTopology(ctx: ExtensionContext): PhylogenySignal {
	const roots = ctx.sessionManager.getTree();
	const leafId = ctx.sessionManager.getLeafId();
	const branch = ctx.sessionManager.getBranch();
```

and a `getBranch()` message-walk precedent exists at `src/registrar.ts:331-333`.
Topology lands in state once per turn (`src/animations-box/controller.ts:686-688`)
via `notePhylogeny` (`src/signal-extras/state.ts:209-213`, clamped), and is
rendered as the `tree` row (`src/signal-extras/segments.ts:432-440`):

```ts
			: sample("sessionPhylogeny", "notable", "tree", "syntaxType", [
					{ key: "depth", text: `depth ${tree.depth}` },
					{ key: "siblings", text: `${tree.siblings} siblings` },
				]),
```

**Definitions this plan fixes precisely:**

- **Branch cost** = sum over `ctx.sessionManager.getBranch()` entries of the
  same usage the host would count for that entry — assistant `message.usage.cost.total`
  plus task-toolResult `details.usage.cost.total` — i.e. a plugin-side mirror
  of `entryUsage` (`session-manager.ts:145-151`) restricted to the current path.
- **Tree cost** = `ctx.sessionManager.getUsageStatistics().cost` (every entry,
  all branches).
- **Off-path spend** = `treeCost − branchCost`, clamped to ≥ 0. Mirroring
  `entryUsage`'s entry classes on both sides is what makes the subtraction
  sound.

### Design invariants to preserve

ONE Audit Box widget on ONE `AnimationHost`/shared scheduler; no fabricated
telemetry — every figure traces to a host-delivered value; D4: `undefined`
is missing, never rendered as zero (`startTime` absent → no age span;
no branch data yet → no off-path span, not `$0.00`); money rule: spend renders
as plain digits, no easing, no blinking, no gradient; 45/69/120-col
degradation ladder unchanged; settings apply at wire time; finite motion
untouched (this plan adds zero animated content). Test conventions: no
`mock.module`, no `any`, no `ReturnType`, no wording/glyph/default pins —
assert consumer-observable behavior.

**Geometry fence (S5)**: this plan changes row *content* only. Bonsai
height, compact mode, and row-count budgeting belong to beads
`omp-animations-mg5.4` / `omp-animations-mg5.6` and are out of scope. Do not
add, remove, or reorder rows.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | Biome + tsgo clean; baseline 51 files / 1213 pass / 0 fail (counts grow as tests are added) |
| Scoped Bonsai run | `bun test test/agent-bonsai.test.ts` | 0 fail |
| Scoped extras run | `bun test test/signal-extras.test.ts test/registrar.test.ts` | 0 fail |
| Sandbox capture | see Sandbox verification | probe:lint 0 violations |

## Scope

**In scope** (10 files):

- `src/agent-bonsai/widget.ts` (Phase A)
- `test/agent-bonsai.test.ts` (Phase A)
- `test/screenshot-regression.test.ts` (Phase A, only if its scenes render duplicate sibling tails)
- `test/animations-box-goldens.test.ts` (Phase A, only if its scenes render duplicate sibling tails)
- `src/signal-extras/segments.ts` (Phases B and C)
- `src/signal-extras/settings.ts` (Phase B)
- `test/signal-extras.test.ts` (Phases B and C)
- `src/signal-extras/state.ts` (Phase C)
- `src/registrar.ts` (Phase C)
- `test/registrar.test.ts` (Phase C)

**Out of scope**: Bonsai geometry/height/compact (beads mg5.4/mg5.6); tools
row (bead 747); `src/agent-bonsai/controller.ts` and `state.ts` node shape
(untouched — dedupe is render-time); `src/activity-roster/**` (plan 026);
host sources under `node_modules` (read-only evidence); every other plan
020–024/026 surface.

## Git workflow

Branch `advisor/025-row-content-bonsai-jobs-spend`; one Conventional Commit
per phase (`fix(agent-bonsai): …`, `feat(signal-extras): …`); no push, no PR
unless the maintainer asks.

## Steps

### Phase A — S5: render-time sibling dedupe

Files (2–4): `src/agent-bonsai/widget.ts`, `test/agent-bonsai.test.ts`,
plus `test/screenshot-regression.test.ts` / `test/animations-box-goldens.test.ts`
only if their captured scenes contain duplicate sibling tails.

1. In `renderAgentBonsaiRows` (`src/agent-bonsai/widget.ts:523-552`), track
   the previously rendered node per depth (`prevTaskByDepth: Map<number,
   string>`, `prevModelByDepth: Map<number, string>` — or previous-node
   locals, since nodes arrive grouped). For each node with `depth > 0`:
   - if `spans.task.text` is non-empty and equals the previous visible
     sibling's task text at the same depth → suppress the task tail for this
     node (pass a `dedupedTask: true` flag into `renderNode`, which forces
     the `task` argument at `:479` to `""`).
   - if `showModel` is true and `spans.model.text` equals the previous
     visible sibling's model at the same depth → suppress the model chip the
     same way. (This closes the gap the frame shows: `sharedBonsaiModel` is
     all-nodes-or-nothing at `:531`; the sibling-run rule catches
     Main-differs-from-subs.)
   - depth changes or text differs → reset tracking; the first row of every
     run always keeps its full text. Rows at depth 0 (Main) never dedupe.
2. Per-row gist echo: in `renderNode` (`:478-479`), when `spans.gist.text ===
   spans.task.text` drop the task tail — the tail would repeat the gist
   byte-for-byte.
3. Do NOT touch `gistLabel` (`:112-119`) — `(completed)` stays, per the
   corrected premise above.
4. Keep `observeRows`/flash observation (`:132-148`) exactly as is: dedupe is
   applied at assembly time, not to the observed span set, so flash behavior
   and `seenIds` are unchanged.
5. Tests (new, behavioral — assert rendered strings a consumer sees):
   - two siblings, identical task → first rendered row contains the task
     text, second does not; both keep name/status.
   - two siblings, different tasks → both rows contain their own task text.
   - identical tasks at different depths → no cross-depth suppression.
   - Main + siblings all one model vs Main differing → sibling model chip
     appears at most once per sibling run.
   - single sibling → unchanged (guards the existing single-node assertions,
     e.g. `test/agent-bonsai.test.ts:443-446`).
6. Survey existing assertions that render multi-sibling scenes with shared
   text and update the *expected strings only where the dedupe rule predicts
   the change*. Same for `test/screenshot-regression.test.ts` /
   `test/animations-box-goldens.test.ts`: recapture only frames whose scenes
   contain ≥2 siblings sharing task or model text.
7. Gate: `bun run fix && bun run check && bun test`.

### Phase B — A6: harbor age span + default flip

Files (3): `src/signal-extras/segments.ts`, `src/signal-extras/settings.ts`,
`test/signal-extras.test.ts`.

1. `buildAsyncJobHarborSample` (`src/signal-extras/segments.ts:91`) gains a
   `now: number` parameter; call site `:517` passes the `now` already in
   scope in `buildSignalExtraSegments` (`:347-355`).
2. When `running.length > 0`: compute `oldest = min(running.map(job =>
   job.startTime))` considering only entries where `Number.isFinite(job.startTime)`;
   if none qualify, render no age span (D4 — missing measurement, not zero).
   Age = `Math.max(0, now - oldest)`. Append span
   `{ key: "oldest", text: `oldest ${fmt}`, tone: "dim", wideOnly: true }`
   immediately after the `running` span. Format follows the existing
   minutes/seconds precedent at `src/animations-box/segments.ts:388-391`:
   `${minutes}m` when ≥ 1 minute, else `${seconds}s`.
3. Flip the default: `src/signal-extras/settings.ts:34` `asyncJobHarbor:
   false` → `true`. Justification recorded here: the builder's zero-height
   idle contract (`segments.ts:104-106`) means the enabled row renders
   nothing until jobs actually exist, so default-on costs zero idle lines —
   earn-the-line is satisfied by construction.
4. Delete `test/signal-extras.test.ts:673-675` ("is disabled by default") —
   it is a default pin, banned by repo test conventions; do not re-pin the
   new default.
5. Tests (new, in the existing `describe("Async Job Harbor")` block, which
   already enables the row explicitly at `:656`):
   - running job with finite `startTime` 5 minutes before `now` → row text
     includes an age reading; advancing `now` grows it.
   - running job with non-finite `startTime` → no age span, other spans
     intact.
   - no running jobs (only ready/failed) → no age span.
6. Golden check: `bun test test/animations-box-goldens.test.ts
   test/screenshot-regression.test.ts` — expected zero diffs (golden scenes
   pass no `asyncJobSnapshot`, so the builder returns `undefined` regardless
   of the default). If any diff appears, STOP.
7. Gate: `bun run fix && bun run check && bun test`.

### Phase C — A5: off-path spend on the `tree` row

Files (5): `src/signal-extras/state.ts`, `src/signal-extras/segments.ts`,
`src/registrar.ts`, `test/signal-extras.test.ts`, `test/registrar.test.ts`.

1. `src/signal-extras/state.ts`: extend `PhylogenySignal` (`:32-35`) with
   `readonly offPathCostUsd?: number`. In `notePhylogeny` (`:209-213`),
   store it only when `Number.isFinite(value) && value > 0`; otherwise leave
   `undefined`. (A genuine zero renders as an absent span — no waste to
   report — and never as a fabricated `$0.00`.)
2. `src/registrar.ts` `readSessionTopology` (`:288+`): compute
   - `treeCost = ctx.sessionManager.getUsageStatistics().cost` inside a
     `try { … } catch { /* leave undefined */ }` (mirror the defensive shape
     of `getAsyncJobSnapshot` at `:338-343`);
   - `branchCost` = walk `ctx.sessionManager.getBranch()` (precedent
     `:331-333`) summing, per entry of `type === "message"`:
     assistant → `message.usage.cost.total`; toolResult with
     `toolName === "task"` → `details.usage.cost.total` when `details.usage`
     is an object (mirror `entryUsage`, `session-manager.ts:139-151`,
     including its `taskUsageFrom` narrowing). Treat non-finite addends as 0.
   - return `{ depth, siblings, offPathCostUsd: Math.max(0, treeCost - branchCost) }`
     only when both sides were computable; otherwise omit the field.
3. `src/signal-extras/segments.ts` `sessionPhylogeny` sample (`:432-440`):
   when `tree.offPathCostUsd !== undefined && tree.offPathCostUsd >= 0.005`
   append span `{ key: "off-path", text: `off-path $${tree.offPathCostUsd.toFixed(2)}` }`
   — plain digits, default tone, no motion (money rule). Below half a cent
   the span is absent (rounding would print `$0.00`).
4. Tests:
   - `test/signal-extras.test.ts`: `notePhylogeny` with
     `offPathCostUsd: 0.42` → rendered `tree` row includes `$0.42`; with
     `0.001` → no off-path text; with the field omitted → row unchanged from
     today; `resetSession()` clears it (existing `#phylogeny = undefined`
     at `state.ts:332-333` already covers this — assert it).
   - `test/registrar.test.ts`: extend the fake `sessionManager` the harness
     already builds with `getUsageStatistics` (tree cost) and a `getBranch`
     returning a mix of assistant messages, a task toolResult with
     `details.usage`, and a non-message entry; assert the topology delivered
     to the controller carries the expected delta, and that an on-path-only
     history (tree === branch) yields no `offPathCostUsd`.
5. Golden check: goldens drive no phylogeny cost, so expected zero diffs.
   Any diff → STOP.
6. Gate: `bun run fix && bun run check && bun test`.

## Test plan

- **Re-run unchanged**: all suites outside the deliberate set below —
  controller, segments (non-harbor/non-phylogeny rows), registrar fan-out,
  activity roster, live-files.
- **Deliberate re-goldens (Phase A only)**: Bonsai-rendering assertions and
  captured frames whose scenes contain ≥2 siblings sharing identical task or
  model text. The predicted diff is strictly *removal* of repeated tails/
  chips on non-first run members. Nothing else may move.
- **Deliberately deleted**: `test/signal-extras.test.ts:673-675` (default
  pin, banned by conventions).
- **New behavioral tests**: listed per phase above. No wording pins beyond
  the minimal presence/absence of the distinguishing text; no glyph pins; no
  default pins.
- **Expected zero re-goldens**: Phases B and C.

## Sandbox verification

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
# (fake HOME /tmp/omp-anim-sandbox/home, cwd /tmp/omp-anim-sandbox/project)
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

In the captured frames (`.frames/run-<new>/*.txt`):

- Drive a multi-sibling `task` fan-out with one brief; grep the agents block —
  the shared task text must appear exactly once per sibling run:
  `grep -c 'Independently list' .frames/run-<new>/*.txt`-style counts drop
  from N-per-frame to 1-per-frame for an N-sibling batch.
- With a background job running, the `jobs` row (row regex
  `^│ [○◐●✗]  jobs `) shows `N running` plus an `oldest …` reading at 120
  cols.
- After a rewind + continue, the `tree` row (row regex `^│ [○◐●✗]  tree `)
  shows `off-path $…`; in a straight-line session it must NOT.

## Done criteria

- [ ] Repo gate exits 0 after every phase.
- [ ] Duplicate sibling task tails render once per run; first row keeps full text.
- [ ] `(completed)` literal still present on gistless completed rows.
- [ ] `jobs` row shows an age for running jobs and none when `startTime` is missing.
- [ ] `asyncJobHarbor` defaults on; idle sessions still render zero harbor lines.
- [ ] `tree` row shows `off-path $X.XX` only when tree cost exceeds branch cost by ≥ half a cent.
- [ ] Zero golden diffs in Phases B and C; Phase A diffs limited to dedupe removals.
- [ ] Sandbox probe + probe:lint clean.

## STOP conditions

- Any cited excerpt above mismatches the file on disk at execution time.
- Phase A golden/screenshot diff touches a row that is not a non-first
  member of a duplicate sibling run — the dedupe rule predicts removals
  only; anything else moving means the seam is wrong.
- Phase B or C produces ANY golden/screenshot diff.
- `getUsageStatistics` is absent from the `ReadonlySessionManager` the
  sandbox host actually passes (host drift from the `^17` pin) — re-verify
  `node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:327-350`
  and STOP if the pick no longer includes it.
- The scheduler feeding `buildSignalExtraSegments` is no longer wall-clock
  epoch ms (`src/kit/animation-host.ts:15-23` contract changed) — the age
  math is invalid; STOP.
- Bead `omp-animations-mg5.4`/`mg5.6` has landed a Bonsai geometry change
  that conflicts with Phase A's render-loop edit — coordinate, do not merge
  blind.

## Rollback

One commit per phase; phases are independent — `git revert <phase-sha>`
individually in any order. No settings migration: the A6 default flip
reverts cleanly because resolution reads the default map at wire time.

## Beads

- `omp-animations-mg5.4` / `omp-animations-mg5.6` — own Bonsai
  height/compact geometry; this plan is content-only and must not touch
  geometry.
- `omp-animations-747` — tools row; untouched here.

## Maintenance notes

- The sibling-run dedupe is deliberately render-time and order-local
  (previous-sibling equality), not a global grouping pass — it costs O(rows)
  and cannot reorder or drop rows, which keeps the mg5.4 geometry fence
  clean.
- If a later change gives `sharedBonsaiModel` sibling-group granularity,
  Phase A's model-chip rule becomes redundant and should be deleted in the
  same change.
- The branch-cost mirror in `readSessionTopology` intentionally duplicates
  `entryUsage`'s two entry classes; if the host adds a third usage-bearing
  entry class, both sides of the subtraction shift together only if the
  mirror is updated — note kept beside the code comment.
