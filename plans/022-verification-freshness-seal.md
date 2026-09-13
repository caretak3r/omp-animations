# Plan 022: Verification Freshness Seal + tools-row doc truth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e2e78cd..HEAD -- src/animations-box/tool-activity.ts src/signal-extras src/animations-box/controller.ts AGENTS.md package.json`
> **AND** check bead `omp-animations-747`'s state (`bd show omp-animations-747`
> read-only): this plan MUST land its Phase A+B **before** 747 deletes the
> tools row. Excerpts cite files as on disk at `e2e78cd` (dirty tree); any
> mismatch is a STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (one new conditional row; doc reconciliation)
- **Depends on**: MUST complete before bead `omp-animations-747`'s deletion phase (the counters move first, then the row can die)
- **Category**: fix + doc truth
- **Planned at**: commit `e2e78cd`, 2026-09-12

## Why this matters

**A1**: The tools row's most valuable fact — "there are writes newer than the
last successful bash" — is computed today (`#mutationGeneration` /
`#verifiedGeneration`) and rendered never. When bead `omp-animations-747`
deletes the aggregate tools row, the counters become homeless and the fact
dies with them. This plan gives the fact its own home in signal-extras as a
new `verify` sidecar row before that happens.

**S6**: AGENTS.md promises row behavior the renderer deliberately cut
(p50, phase rail, `verify ↩ BUILD`) — the next row author will code against
documentation that describes a renderer that no longer exists.

## Current state

### A1 — the counters and their only consumer

`src/animations-box/tool-activity.ts:138-150` (inside `end(...)` and `settle()`):

```ts
		const category = categorizeTool(toolName);
		if (category === "bash" && isError) this.#verifiedGeneration = -1;
		if (isError) return;
		if (category === "write") this.#mutationGeneration++;
		if (category === "bash") this.#verifiedGeneration = this.#mutationGeneration;
	}

	/** Settle to handoff only after a successful bash covered the latest successful write. */
	settle(): void {
		if (this.#active.size > 0 || this.#verifiedGeneration !== this.#mutationGeneration) return;
		this.#phase = "handoff";
		this.#phaseRewound = false;
	}
```

The counters feed ONLY the internal phase rail — and the renderer
(`buildToolActivitySegment`, `src/animations-box/segments.ts:488-537`) emits
neither `summary.phase` nor `summary.p50Ms`; it renders total calls, active
category + elapsed, and top categories. Verified by reading the whole builder:
the spans are `active`/`elapsed`/`total`/`cat:*` only (`:505-520`).

Feed path that already exists (`src/animations-box/controller.ts:590-595`):

```ts
	onToolExecutionEnd(event: ToolExecutionEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		this.#toolActivityState.end(event.toolCallId, event.toolName, event.isError, this.#scheduler.now());
		this.#liveFilesState.onTaskEnd(event.toolCallId, event.result, ctx.cwd);
		this.#changed();
	}
```

`ToolActivityState` is request-scoped: `reset()` is called from `onAgentStart`
(`src/animations-box/controller.ts:597-603`) and zeroes the counters
(`tool-activity.ts:161-162`).

### The sidecar pattern the new row follows

`src/signal-extras/settings.ts:12-17,32-37` — `SIGNAL_EXTRA_IDS` +
`DEFAULT_SIGNAL_EXTRAS_CONFIG` (the `retryRadar`/`asyncJobHarbor` pattern).
`src/signal-extras/segments.ts:24-30` — the sidecar row order list.
`package.json:172-177` — the manifest entry shape:

```json
			"retryRadar": {
				"type": "boolean",
				"description": "Show active automatic retry and fallback progress.",
				"default": true,
				"env": "OMP_ANIMATIONS_RETRY_RADAR"
			},
```

### S6 — the doc/code divergence

`AGENTS.md:51-54`:

```
`toolActivity` counts `tool_call` and measures exact `tool_execution_start`/`tool_execution_end` boundaries.
It shows p50 only after five completed samples and keeps the newest 32 samples.
Its phase rail advances by tool class and reaches handoff only after fresh successful verification.
A write after verification records `verify ↩ BUILD`; incidental reads do not regress the phase.
```

`src/animations-box/segments.ts:477-481`:

```ts
export const TOOL_ACTIVITY_SEGMENT = {
	id: "toolActivity" as const,
	label: "tools",
	description: "Tool call volume, active category, and exact execution time",
} satisfies { id: BoxSegmentId; label: string; description: string };
```

The cut was deliberate — `CHANGELOG.md:36-40`: "The `tools` summary leads with
the active tool and elapsed time, then settles to total calls and the busiest
categories. Internal latency and work-phase diagnostics no longer compete
with the operator signal."

### Decisions this plan makes

1. **Row semantics — unverified-count only, never "verified"** (per triage):
   the predicate `category === "bash" && !isError` means `echo hi` counts as
   a green bash, so a positive "verified ✓" claim would be fabricated
   confidence. The row renders ONLY while writes are newer than the last
   green bash (`N writes since green bash`, dot `notable`) and disappears
   otherwise. Absence is not a verification claim; it is silence.
2. **Scope — session, not request** (deviation from the old counters'
   request scope, on purpose): the old counters reset every `agent_start`
   because they drove a per-request phase narrative; "writes newer than the
   last green bash" is a session integrity fact — a write in turn 3 stays
   unverified in turn 4 until a bash actually runs. Cleared by
   `resetSession()` only.
3. **Classifier — self-owned, two branches**: signal-extras does NOT import
   `categorizeTool` from `src/animations-box/tool-activity.ts` — that module
   is condemned (747); an import would chain the seal to the corpse. The
   state gets a private `sealKind(toolName): "write" | "bash" | "other"`
   built on the host's `normalizeToolName` (same source
   `tool-activity.ts:8` uses), replicating only the two branches the seal
   needs. Plan 023's import-fence sweep will repoint the
   `normalizeToolName` import to `src/host/runtime.ts` — leave a
   `// repointed by plan 023` breadcrumb comment off; just use the direct
   host import that is today's convention.
4. **Old counters stay untouched**: during the window before 747 lands, both
   the phase rail's counters and the seal's counters observe the same
   events. That is two consumers of one event stream, not duplicated
   rendered state — only the seal renders. Do not refactor
   `tool-activity.ts`; do not delete the tools row.

### Design invariants to preserve

ONE widget, ONE host/scheduler; no fabricated telemetry (no "verified ✓");
no eased/blinking figures; settings at wire time; 45/69/120 ladder; sidecar
returns zero rows when nothing meaningful (AGENTS.md:43-44); test
conventions (no `mock.module`/`any`/`ReturnType`/wording pins).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | exit 0; baseline 51 files / 1213 pass / 0 fail + new tests |
| Focused | `bun test test/signal-extras.test.ts test/animations-box-controller.test.ts` | pass |
| Sandbox | `./scripts/sandbox-omp.sh prepare` → restart tmux session `omp-anim-sandbox` → `bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5` → `bun run probe:lint` | 0 violations |

## Scope

**In scope**:

- `src/signal-extras/settings.ts`
- `src/signal-extras/state.ts`
- `src/signal-extras/segments.ts`
- `src/animations-box/controller.ts`
- `package.json` (`omp.settings` block only)
- `AGENTS.md` (lines 51-54 region only)
- `src/animations-box/segments.ts` (`TOOL_ACTIVITY_SEGMENT.description` only)
- `test/signal-extras.test.ts`
- `test/animations-box-controller.test.ts`
- `test/animations-box-legend.test.ts` (only if it pins the description)
- `plans/README.md` (status row)

**Out of scope**:

- `src/animations-box/tool-activity.ts` — 747's territory; not one line.
- Deleting or altering the rendered tools row — 747's territory.
- `CHANGELOG.md` history rewriting (add a new entry only if the repo's
  convention is to log every user-visible row addition — it is; add one line
  for the `verify` row at the top, matching existing entry style).

## Git workflow

Branch `advisor/022-verification-freshness-seal`; one Conventional Commit per
phase; no push/PR unless the operator says so.

## Steps

### Phase A — the `verify` row: state + settings + renderer

Files (5): `src/signal-extras/settings.ts`, `src/signal-extras/state.ts`, `src/signal-extras/segments.ts`, `package.json`, `test/signal-extras.test.ts`.

1. `src/signal-extras/settings.ts`: add `"verify"` to `SIGNAL_EXTRA_IDS`
   (after `"retryRadar"`) and `verify: true` to
   `DEFAULT_SIGNAL_EXTRAS_CONFIG` — default on: the row is conditional and
   silent in a verified session.
2. `package.json` `omp.settings`, after `retryRadar` (`:172-177`), same shape:

   ```json
   			"verify": {
   				"type": "boolean",
   				"description": "Show how many writes have landed since the last successful bash.",
   				"default": true,
   				"env": "OMP_ANIMATIONS_VERIFY"
   			},
   ```

3. `src/signal-extras/state.ts`:
   - Private fields `#sealMutationGen = 0`, `#sealVerifiedGen = -1`
     (semantics copied from `tool-activity.ts:138-142`: green bash seals the
     current generation; failed bash invalidates; failed write ignored).
   - Private `sealKind(toolName: string): "write" | "bash" | "other"` via
     the host's `normalizeToolName` (import from
     `@oh-my-pi/pi-coding-agent/tools/builtin-names`, the exact specifier
     `tool-activity.ts:8` uses). Mirror `categorizeTool`'s mapping for the
     two kinds only (read `tool-activity.ts:20-38` while editing to copy the
     normalized names it maps to `"write"` and `"bash"`).
   - `noteToolSettled(toolName: string, isError: boolean): void` —
     transcribe the four lines of `tool-activity.ts:138-142` against the new
     fields.
   - Snapshot: `unverifiedWrites: number` =
     `#sealMutationGen - Math.max(#sealVerifiedGen, 0)` when positive, else 0.
   - `resetSession()` zeroes both (decision 2: NOT touched by turn/agent
     lifecycle).
4. `src/signal-extras/segments.ts`: add `"verify"` to the row order list
   (`:24-30`) and build the row: absent when `unverifiedWrites === 0`; else
   `sample("verify", "notable", "verify", "warning", [{ key: "count", text: "<N> write<s> since green bash", tone: "notable" }])`
   — follow the retryRadar `sample(...)` call shape at `:508-514`. No
   motion, no easing; the count changes only on events.
5. `test/signal-extras.test.ts` (behavioral, no wording pins — assert
   snapshot numbers and span presence/tone):
   - fresh state → no row;
   - write settles → `unverifiedWrites === 1`, row present;
   - green bash settles → 0, row gone;
   - failed bash after write → still unverified (and a later green bash
     clears);
   - failed write → not counted;
   - `resetSession()` → cleared;
   - `onTurnStart`/`onTurnEnd` do NOT clear it (decision 2's contract).

**Verify**: `bun run fix && bun run check && bun test` → exit 0. Zero golden
movement (state is never fed yet). If `test/animations-box-settings.test.ts`
or `test/signal-extras.test.ts` has a count/list assertion over
`SIGNAL_EXTRA_IDS`, update the expected list — that is a registry-consistency
assertion, not a pin.

### Phase B — wiring

Files (2): `src/animations-box/controller.ts`, `test/animations-box-controller.test.ts`.

1. `onToolExecutionEnd` (`controller.ts:590-595`): after the
   `#toolActivityState.end(...)` line, add
   `this.#signalState.noteToolSettled(event.toolName, event.isError);`.
   Do NOT add a reset call in `onAgentStart` (decision 2).
2. `test/animations-box-controller.test.ts`: extend an existing
   `onToolExecutionEnd` fixture — a write-tool end followed by a snapshot
   shows `unverifiedWrites === 1`; a bash end (isError false) returns it
   to 0; survives `onAgentStart` (assert against whatever reset fixture the
   suite already has for `toolActivityState`).

**Verify**: repo gate → exit 0. Goldens: only frames whose fixture actually
settles a write without a bash may change — expected NONE in the existing
suites (goldens capture idle or verified sessions); any golden diff is a STOP.

### Phase C — S6 doc truth

Files (3): `AGENTS.md`, `src/animations-box/segments.ts`, `test/animations-box-legend.test.ts`.

1. `AGENTS.md:51-54`: replace the four lines with what the code does:

   ```
   `toolActivity` counts `tool_call` and measures exact `tool_execution_start`/`tool_execution_end` boundaries.
   While a tool runs the row leads with the active category and elapsed time; at rest it shows total calls and the busiest categories.
   Internal p50 latency and the work-phase rail are computed but deliberately not rendered (see CHANGELOG "Internal latency and work-phase diagnostics").
   The `verify` sidecar row shows writes newer than the last successful bash; its absence is silence, not a verification claim.
   ```

   Keep line 56's "An idle `○ —` on cache, tools, or files is not a fault."
   untouched (plan 020 edits that sentence for `limits`; if 020 already
   landed, merge, don't duplicate).
2. `src/animations-box/segments.ts:480`: description becomes
   `"Tool call volume, active category, and elapsed execution time"` —
   "exact" promised a precision the row does not show.
3. `test/animations-box-legend.test.ts`: run it. If it pins the old
   description string, that pin violates the repo's no-wording-pin rule —
   update it to the structural assertion the rest of the file uses, or the
   new string if the file's convention is literal legend text (match the
   file's existing convention; do not invent a new one).

**Verify**: repo gate → exit 0.

## Test plan

- **Re-run unchanged**: `test/animations-box-tool-activity.test.ts` (the old
  counters are untouched), all goldens/screenshots (`verify` never renders in
  their fixtures), `test/registrar.test.ts` (no new subscriptions — the row
  feeds off an already-subscribed event).
- **Deliberate re-goldens**: none. Zero golden movement is an acceptance
  criterion.
- **New behavioral tests**: Phase A state lifecycle (7 cases), Phase B
  controller feed (3 cases). No wording/glyph/default pins.

## Sandbox verification

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

Corpus check (row regex `^│ [○◐●✗]  verify `): in a sandbox run where the
agent edited a file and has not run bash since,
`grep -hE '^│ [○◐●✗]  verify ' .frames/run-<new>/*.txt` shows
`N write(s) since green bash`; after the agent's next successful bash the row
disappears from subsequent frames. In a read-only run: 0 matches.

## Done criteria

- [ ] Repo gate exits 0.
- [ ] Zero golden/screenshot diffs.
- [ ] `verify` row appears/disappears in the sandbox per the corpus check.
- [ ] AGENTS.md:51-54 region describes the shipped renderer; description
      string updated.
- [ ] `bun run probe:lint`: 0 violations.
- [ ] `git status` clean outside the in-scope list; `plans/README.md` row updated.

## STOP conditions

- **`omp-animations-747` has already deleted the tools row and the
  generation counters are gone — STOP and re-plan the counter home** (the
  transcription source `tool-activity.ts:138-142` no longer exists; the
  semantics must then be recovered from this plan's excerpt, but the
  coordination with 747's replacement surface must be re-decided).
- 747 lands mid-execution (check `bd show omp-animations-747` at each phase
  boundary) — pause and reconcile before continuing.
- Any "Current state" excerpt no longer matches the live file.
- Any golden or screenshot moves.
- `normalizeToolName` is not importable from
  `@oh-my-pi/pi-coding-agent/tools/builtin-names` (host drift) — report.
- A step's verification fails twice after a reasonable fix attempt.

## Rollback

One commit per phase; `git revert <phase-sha>`. The row is additive and
default-on but conditional — reverting Phase B alone silences it (state never
fed) without breaking the gate.

## Beads

- `omp-animations-747` — owns tools-row deletion; this plan is its
  prerequisite. After landing, note on the bead (read-only courtesy if the
  workflow allows) that the counters now live in signal-extras and
  `tool-activity.ts` is fully deletable.

## Maintenance notes

- When 747 lands, `sealKind` becomes the only classifier left for
  write/bash; if 747 preserves `categorizeTool` somewhere, consider
  re-unifying — one classifier is the end state, this plan just refuses to
  couple to a condemned file in the interim.
- Plan 023 will repoint the `normalizeToolName` import into `src/host/runtime.ts`.
- Plan 024's registry will absorb the sidecar row-order list; the `verify`
  row rides along.
