# Plan 024: Core-row registry + deterministic event fan-out

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e2e78cd..HEAD -- src/animations-box src/registrar.ts test/registrar.test.ts AGENTS.md`
> This plan is a behavior-preserving refactor — its acceptance is ZERO golden
> movement. Excerpts cite files as on disk at `e2e78cd` (dirty tree); any
> mismatch is a STOP. **Internal ordering: the P3 half (Phase C) depends on
> the P5 half (Phase A) — do not reorder.**

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touches the render assembly of every core row and the
  fan-out of every tool event; mitigated by the zero-re-golden gate)
- **Depends on**: land after 020–023 (020 changes the tidepool builder
  signature this registry wraps; 023 fences the imports this file adds)
- **Category**: architecture
- **Planned at**: commit `e2e78cd`, 2026-09-12

## Why this matters

**P5**: adding a core Audit Box row is today a six-file contract enforced
only by documentation (AGENTS.md:121-134). Nothing machine-checks that a new
`BoxSegmentId` gets a builder, a metadata entry, and a `#buildAuditSampleGroups`
line — you find out from a missing row at runtime. An exhaustive
`Record<BoxSegmentId, spec>` makes the compiler walk the author through every
required piece.

**P3**: three `tool_execution_*` events and the session lifecycle fan out to
up to four sinks per event inside ad-hoc closures. The order is load-bearing —
`activityProbe?.startTool` must precede `controller.onToolExecutionStart` so
the roster snapshot the controller's frame reads already contains the tool —
and no test asserts it. A well-meaning reorder silently breaks first-frame
correctness.

## Current state

### P5 — the six-file contract and its hand-built center

`src/animations-box/settings.ts:18-25`:

```ts
export const BOX_REQUIRED_SEGMENT_IDS = [
	"contextGauge",
	"cacheMeter",
	"auditTrailBox",
	"rateLimitTidepool",
	"toolActivity",
	"filesLive",
] as const;
```

(Confirm the sibling export the controller uses at `controller.ts:389`
(`BOX_SEGMENT_IDS`) and the `BoxSegmentId` type derivation in the same file
when editing — both live in `src/animations-box/settings.ts:12-30`.)

`src/animations-box/segments.ts:546-554` — display metadata, hand-ordered:

```ts
/** Audit Box summary metadata in immutable row order. */
export const SEGMENT_REGISTRY = [
	CONTEXT_GAUGE_SEGMENT,
	CACHE_METER_SEGMENT,
	AUDIT_TRAIL_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	TOOL_ACTIVITY_SEGMENT,
	LIVE_FILES_SEGMENT,
] as const;
```

`src/animations-box/controller.ts:377-392` — the hand-built assembly with
heterogeneous builder signatures and one special case:

```ts
		const required: SegmentSample[] = [
			buildContextGaugeSegment(this.#contextGaugeState, now, theme, this.#glyphPreset),
			buildCacheMeterSegment(this.#cacheMeterState, now, theme, undefined, this.#glyphPreset),
			buildAuditTrailBoxSegment(this.#auditTrailState, now, theme, undefined, this.#glyphPreset),
			buildRateLimitTidepoolSegment(this.#tidepoolState, now, theme, undefined, this.#glyphPreset),
			buildToolActivitySegment(this.#toolActivityState, now, theme, this.#glyphPreset),
		];
		if (this.#extrasConfig.liveFiles) {
			required.push(
				buildActivityFilesSegment(
					activityRoster,
					this.#liveFilesState.snapshot(),
					BOX_SEGMENT_IDS.indexOf("filesLive") + 1,
				),
			);
		}
```

`AGENTS.md:121-134` — the documentation-enforced contract this plan
mechanizes ("A new core row is a six-file contract. Change all six files in
one change." … "Re-check the `LADDER` after every core-row change.").

### P3 — the fan-out closures (`src/registrar.ts:446-490`)

```ts
	api.on("tool_execution_start", (event, ctx) => {
		ensureActivity(ctx);
		activityProbe?.startTool({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
		controller.onToolExecutionStart(event, ctx);
	});
	api.on("tool_execution_update", (event, ctx) => {
		ensureActivity(ctx);
		activityProbe?.updateTool({ ... });
		agentBonsai?.onToolExecutionUpdate(event);
		controller.onToolExecutionUpdate(event, ctx);
	});
	api.on("tool_execution_end", (event, ctx) => {
		ensureActivity(ctx);
		activityProbe?.endTool({ ... });
		agentBonsai?.onToolExecutionEnd(event);
		controller.onToolExecutionEnd(event, ctx);
	});
	api.on("turn_start", (event, ctx) => {
		agentBonsai?.noteMainModel(ctx.model?.id);
		controller.onTurnStart(event, ctx);
	});
	...
	api.on("agent_start", (event, ctx) => {
		ensureActivity(ctx);
		agentBonsai?.onAgentStart();
		if (ctx.hasUI) activityProbe?.beginRequest();
		controller.onAgentStart(event, ctx);
	});
	api.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI && event.willContinue !== true) completeActivity();
		agentBonsai?.onAgentEnd(event.willContinue === true);
		controller.onAgentEnd(event, ctx);
	});
```

The test harness that will drive the characterization
(`test/registrar.test.ts:50-81`) records subscription *names* only — its
`on: (event) => { events.push(event) }` discards handlers, so it cannot
currently dispatch.

### Design invariants to preserve

ONE widget on ONE `AnimationHost`; identical render order and identical
frames (zero re-goldens); required rows always render (no new conditionality
beyond the existing `liveFiles` gate); one per-frame deps object, no
per-row/per-cell allocation; settings at wire time; test conventions (no
`mock.module`/`any`/`ReturnType`; assert observable behavior — here, sink
call order IS the observable contract).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | exit 0; baseline 51 files / 1213 pass / 0 fail + new tests |
| Ladder re-check | `bun test test/animations-box-goldens.test.ts test/screenshot-regression.test.ts` | pass with ZERO recaptures |
| Focused | `bun test test/registrar.test.ts test/animations-box-settings.test.ts` | pass |
| Sandbox | `./scripts/sandbox-omp.sh prepare` → restart tmux session `omp-anim-sandbox` → `bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5` → `bun run probe:lint` | 0 violations; frames identical to a pre-change capture |

## Scope

**In scope**:

- `src/animations-box/row-registry.ts` (create)
- `src/animations-box/controller.ts`
- `src/registrar.ts`
- `test/animations-box-settings.test.ts`
- `test/registrar.test.ts`
- `AGENTS.md` (the "Add a core Audit Box row" section only)
- `plans/README.md` (status row)

**Out of scope**:

- `src/animations-box/segments.ts` — builders and `SEGMENT_REGISTRY` stay
  put; the registry references them (a derivation would create an import
  cycle; a consistency test bridges instead).
- Any renderer, any golden, any row content (020/025 territory).
- The single-sink subscriptions (`turn_end`, `message_*`, `session_*`,
  `context`, retry/auth events) — they stay inline in the registrar; only
  the six multi-sink events move into the fan-out seam.
- `src/animations-box/tool-activity.ts` (bead `omp-animations-747`).

## Git workflow

Branch `advisor/024-row-registry-fanout-order`; one Conventional Commit per
phase (`refactor(animations-box): …`, `test(registrar): …`); no push/PR
unless the operator says so.

## Steps

### Phase A — P5: the registry

Files (3): `src/animations-box/row-registry.ts`, `src/animations-box/controller.ts`, `test/animations-box-settings.test.ts`.

1. Create `src/animations-box/row-registry.ts` (imports: types from
   `./settings`, builders + `*_SEGMENT` metadata consts from `./segments`,
   `buildActivityFilesSegment` from `../live-files` (confirm the specifier
   `controller.ts` uses), state types from their modules — via `../host/*`
   only where host types are needed, per 023's fence):

   ```ts
   /** Everything a core row may read, built once per frame. */
   export interface CoreRowDeps {
   	readonly now: number;
   	readonly theme: BoxTheme;
   	readonly glyphPreset: GlyphPreset;
   	readonly contextGauge: ContextGaugeState;
   	readonly cacheMeter: CacheMeterState;
   	readonly auditTrail: AuditTrailBoxState;
   	readonly tidepool: RateLimitTidepoolState;
   	readonly providerHealth: ProviderHealthSnapshot | undefined; // if plan 020 landed
   	readonly toolActivity: ToolActivityState;
   	readonly roster: ActivityRosterSnapshot | undefined;
   	readonly liveFiles: LiveFilesSnapshot;
   	readonly extrasConfig: SignalExtrasConfig;
   }

   export interface CoreRowSpec {
   	readonly meta: { readonly id: BoxSegmentId; readonly label: string; readonly description: string };
   	/** Absent = always rendered (required rows). */
   	readonly enabled?: (deps: CoreRowDeps) => boolean;
   	readonly build: (deps: CoreRowDeps) => SegmentSample;
   }

   /** Exhaustive: adding a BoxSegmentId without a spec is a compile error. */
   export const CORE_ROWS: Readonly<Record<BoxSegmentId, CoreRowSpec>> = {
   	contextGauge: {
   		meta: CONTEXT_GAUGE_SEGMENT,
   		build: d => buildContextGaugeSegment(d.contextGauge, d.now, d.theme, d.glyphPreset),
   	},
   	...
   	filesLive: {
   		meta: LIVE_FILES_SEGMENT,
   		enabled: d => d.extrasConfig.liveFiles,
   		build: d => buildActivityFilesSegment(d.roster, d.liveFiles, CORE_ROW_ORDER.indexOf("filesLive") + 1),
   	},
   };

   export const CORE_ROW_ORDER: readonly BoxSegmentId[] = BOX_REQUIRED_SEGMENT_IDS;
   ```

   The lambdas absorb the heterogeneous builder signatures verbatim from
   `controller.ts:378-390` (including each `undefined` width argument — copy
   them exactly; do not "clean up" builder signatures in this plan).
2. `src/animations-box/controller.ts` — replace `:377-392` with the loop:

   ```ts
   		const deps: CoreRowDeps = {
   			now, theme, glyphPreset: this.#glyphPreset,
   			contextGauge: this.#contextGaugeState, cacheMeter: this.#cacheMeterState,
   			auditTrail: this.#auditTrailState, tidepool: this.#tidepoolState,
   			toolActivity: this.#toolActivityState, roster: activityRoster,
   			liveFiles: this.#liveFilesState.snapshot(), extrasConfig: this.#extrasConfig,
   		};
   		const required: SegmentSample[] = [];
   		for (const id of CORE_ROW_ORDER) {
   			const spec = CORE_ROWS[id];
   			if (spec.enabled !== undefined && !spec.enabled(deps)) continue;
   			required.push(spec.build(deps));
   		}
   ```

   One deps object per frame; nothing per row. Remove the now-unused direct
   builder imports from the controller.
3. `test/animations-box-settings.test.ts` — registry-consistency assertions
   (this file already pins the id arrays, AGENTS.md:128):
   - `CORE_ROW_ORDER` equals `BOX_REQUIRED_SEGMENT_IDS`;
   - `SEGMENT_REGISTRY.map(m => m.id)` equals
     `CORE_ROW_ORDER.map(id => CORE_ROWS[id].meta.id)` — the no-cycle bridge
     between display metadata and the registry;
   - every `CORE_ROWS[id].meta.id === id` (no copy-paste cross-wiring).

**Verify**: `bun run fix && bun run check && bun test` → exit 0 with ZERO
golden or screenshot recaptures — this is the phase's entire claim. Then the
ladder re-check command (45/69/120 widths are exercised by the goldens/
screenshot suites per AGENTS.md:129) — again zero diffs.

### Phase B — AGENTS.md contract rewrite

Files (1): `AGENTS.md`.

Rewrite the "Add a core Audit Box row" section (`:121-134`) to describe the
post-registry contract. Keep the section heading and the LADDER warning
(`:132-134`) verbatim; replace the numbered list with the new reality:

1. `src/animations-box/settings.ts` — add the id to
   `BOX_REQUIRED_SEGMENT_IDS` in render order. The compiler now fails until:
2. `src/animations-box/row-registry.ts` — add the row's `CoreRowSpec`
   (metadata reference, optional `enabled` gate, build lambda). Extend
   `CoreRowDeps` and the controller's deps literal if the row needs new
   state.
3. `src/animations-box/segments.ts` — add the metadata const, the builder,
   and the `SEGMENT_REGISTRY` line (the consistency test in
   `test/animations-box-settings.test.ts` fails if you forget).
4. Tests 4–6 unchanged from the old list (settings pins, goldens + LADDER,
   screenshot indexes) — renumber accordingly.

**Verify**: repo gate → exit 0 (docs don't compile, but `bun run fix`
formats markdown if configured — run the gate regardless).

### Phase C — P3: fan-out seam + order characterization (depends on Phase A)

Files (2): `src/registrar.ts`, `test/registrar.test.ts`.

1. `src/registrar.ts`: extract the six multi-sink closures (`:446-490`:
   `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
   `turn_start`, `agent_start`, `agent_end`) into an exported function in the
   same file:

   ```ts
   /** The order inside each handler is load-bearing: probe before bonsai before controller — the roster/bonsai state a frame reads must be written before the controller schedules that frame. Asserted by the fan-out characterization test. */
   export interface FanoutSinks {
   	ensureActivity(ctx: ExtensionContext): void;
   	completeActivity(): void;
   	probe(): ActivityProbe | undefined;
   	bonsai(): AgentBonsaiController | undefined;
   	controller: Pick<AnimationsBoxController,
   		"onToolExecutionStart" | "onToolExecutionUpdate" | "onToolExecutionEnd" |
   		"onTurnStart" | "onAgentStart" | "onAgentEnd">;
   }
   export function wireEventFanout(api: ExtensionAPI, sinks: FanoutSinks): void { … }
   ```

   Move the closure bodies verbatim, substituting `sinks.probe()?.startTool`
   for `activityProbe?.startTool` etc. (`activityProbe` and `agentBonsai` are
   mutable closure variables in the factory — the thunk accessors preserve
   late binding exactly). The factory then calls
   `wireEventFanout(api, { ensureActivity, completeActivity, probe: () => activityProbe, bonsai: () => agentBonsai, controller });`
   at the same position in the wiring sequence, so subscription order (which
   `test/registrar.test.ts`'s `events` array pins) is unchanged.
2. `test/registrar.test.ts`: add a fan-out characterization suite driving
   `wireEventFanout` directly (no registrar mount needed):
   - Build a fake api whose `on` stores handlers:
     `handlers.set(event, handler)` (extend the `makeApi` pattern at
     `:50-81` locally; do not change `makeApi` itself — the existing suite
     asserts subscription names through it).
   - Recording sinks push labels into one shared `calls: string[]`
     (`"ensureActivity"`, `"probe.startTool"`, `"bonsai.onAgentStart"`,
     `"controller.onAgentStart"`, …). `probe()`/`bonsai()` return recording
     objects; a second variant returns `undefined` from both.
   - Dispatch each event with a minimal ctx (`hasUI: true`) and assert the
     EXACT sequence (from `registrar.ts:446-490`):
     - `tool_execution_start` → `["ensureActivity", "probe.startTool", "controller.onToolExecutionStart"]`
     - `tool_execution_update` → `["ensureActivity", "probe.updateTool", "bonsai.onToolExecutionUpdate", "controller.onToolExecutionUpdate"]`
     - `tool_execution_end` → `["ensureActivity", "probe.endTool", "bonsai.onToolExecutionEnd", "controller.onToolExecutionEnd"]`
     - `turn_start` → `["bonsai.noteMainModel", "controller.onTurnStart"]`
     - `agent_start` (hasUI) → `["ensureActivity", "bonsai.onAgentStart", "probe.beginRequest", "controller.onAgentStart"]`
     - `agent_start` (hasUI false) → `["ensureActivity", "bonsai.onAgentStart", "controller.onAgentStart"]`
     - `agent_end` (hasUI, willContinue false) → `["bonsai.onAgentEnd", "controller.onAgentEnd"]`
     - `agent_end` (hasUI false, willContinue false) → `["completeActivity", "bonsai.onAgentEnd", "controller.onAgentEnd"]`
     - `agent_end` (hasUI false, willContinue true) → `["bonsai.onAgentEnd", "controller.onAgentEnd"]`
   - With `probe()`/`bonsai()` returning `undefined`: every sequence keeps
     only `ensureActivity`/`completeActivity`/`controller.*` entries and
     throws nothing.
   - These are order CONTRACTS, not wording pins — the sequence is the
     consumer-observable behavior this test exists to defend.

**Verify**: repo gate → exit 0; zero golden movement; the pre-existing
registrar suite (subscription-name pins) passes untouched.

## Test plan

- **Re-run unchanged**: everything. The entire plan's claim is behavior
  preservation: all goldens, screenshots, controller, segments, widget,
  bonsai, roster suites pass without a single recapture.
- **Deliberate re-goldens**: none. Any golden diff at any phase is a STOP.
- **New behavioral tests**: registry consistency (3 assertions, Phase A);
  fan-out order characterization (10 sequences + undefined-sink variant,
  Phase C).

## Sandbox verification

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

Compare the new run's frames to a pre-change capture: row set, row order,
and row content identical (the 45/69/120 ladder produces the same
degradation). Any difference is a STOP.

## Done criteria

- [ ] Repo gate exits 0 after every phase.
- [ ] Zero golden/screenshot recaptures across the whole plan.
- [ ] `CORE_ROWS` is exhaustive over `BoxSegmentId` (tsc proves it — spot-check
      by temporarily adding a fake id to `BOX_REQUIRED_SEGMENT_IDS` → compile
      error → revert the probe).
- [ ] Fan-out characterization pins all ten sequences.
- [ ] AGENTS.md "Add a core Audit Box row" describes the registry contract.
- [ ] `bun run probe:lint`: 0 violations.
- [ ] `git status` clean outside the in-scope list; `plans/README.md` row updated.

## STOP conditions

- Any golden or screenshot moves at any phase — this plan has no legitimate
  visual delta.
- `controller.ts:377-392` or `registrar.ts:446-490` no longer match the
  excerpts (plans 020-022 or bead `omp-animations-747` landed changes) —
  re-ground: fold 020's `providerHealth` deps entry and 022's unchanged
  wiring in; if 747 deleted the `toolActivity` row, the registry must be
  built against the post-747 `BOX_REQUIRED_SEGMENT_IDS`, and the AGENTS.md
  rewrite must not resurrect it.
- The exhaustive `Record` forces a change to `src/animations-box/segments.ts`
  beyond what Phase A scopes (an import cycle appears) — STOP; the
  metadata-reference design above exists precisely to avoid this.
- Extracting `wireEventFanout` changes the subscription-name order the
  existing registrar suite pins — the extraction was not order-preserving;
  fix the call position, do not edit the pre-existing assertion.
- A step's verification fails twice after a reasonable fix attempt.

## Rollback

One commit per phase; `git revert <phase-sha>`. Phase C is independent of
Phase B; reverting Phase A alone requires reverting C first (C's sinks
signature does not depend on the registry, but land/revert order should
mirror the dependency stated at the top).

## Beads

- `omp-animations-747` — tools row; the registry entry for `toolActivity`
  transcribes today's builder call and will be deleted by 747's change like
  any other registry line. Check `bd show omp-animations-747` at each phase
  boundary.

## Maintenance notes

- Future per-row ingest hooks (the P3(b) idea: rows declaring which events
  feed them) hang off `CoreRowSpec` — add an optional `ingest` field then,
  not now.
- The fan-out order comment in `FanoutSinks` is the canonical statement of
  WHY probe-before-controller matters; keep it next to the type, not in
  AGENTS.md.
