# Plugin design protocol

Use this seven-stage procedure for an approved plugin change. Each stage requires recorded exit evidence before the next stage starts.

This is a reusable procedure, not recovered historical prose or a record of stages executed today.

## 1. Define the observation and decision

Inputs: the user request, its bead, current product decisions, and the affected user surface.

Action:

1. State what the user needs to observe.
2. State which decision that observation supports.
3. Define the acceptance criteria and non-goals.
4. Record which existing behavior must remain unchanged.
5. Resolve conflicts against current product decisions before implementation.

The canonical product reference is `/Users/rohit/Documents/omp-animations/README.md`. Current bead constraints and the sandbox script take precedence over stale two-widget instructions. Superseded experimental widgets remain excluded unless the user explicitly approves their return.

Exit evidence: an approved scope with observable acceptance criteria, preserved behavior, exclusions, and the owning bead.

Return condition: if the observation has no useful decision, return to the request. If requirements conflict, resolve the conflict before proceeding.

## 2. Inventory host evidence and capability gaps

Inputs: the approved scope, the installed host version, event contracts, and existing state owners.

Action:

1. Map every proposed value to an authoritative host field or event.
2. Record its identity, timing, units, retention, reset boundary, and failure meaning.
3. Identify the existing owner of each fact before adding state.
4. Record missing capabilities separately from missing observations.
5. Label estimates and inferred references explicitly.

An unavailable observation means that this run supplies no usable value. Unsupported means that the host or provider contract lacks the capability. A cold cache does not establish an unsupported provider. A simulation supplies controlled inputs, not evidence that the live host emits them.

Exit evidence: a source map for every displayed fact, with explicit capability gaps and no duplicate authority.

Return condition: if a proposed claim lacks evidence, remove the claim or return to stage 1 for a narrower approved scope. Do not replace missing evidence with zero, success, or a guessed capability.

## 3. Design truthful, bounded states and rendering

Inputs: the source map, the existing controller, the required-row registry, and the approved layout.

Action:

1. Define transitions for active work, successful completion, failure, cancellation, missing evidence, and reset.
2. Separate task completion from result delivery.
3. Preserve identity across delayed, repeated, and out-of-order events.
4. Define retention limits and expiry for recent evidence.
5. Derive each frame from authoritative state through the existing controller.
6. Define narrow-width priorities, omission markers, plain-text fallbacks, and finite motion.
7. Keep required labels and order authoritative in the existing registry.

Task completion means execution ended. Delivery means the result reached its consumer. One event must not imply the other without host evidence. Likewise, observed sequence does not establish causality.

The current product uses one complete Animations Box. Optional signals use no row without meaningful state. Shared fixtures must consume the required-row registry rather than duplicate aggregate row identities or indexes.

Exit evidence: a transition table, bounded retention rules, and representative frames with an explanation for every visible claim.

Return condition: if a state implies an unobserved outcome, return to stage 2. If the layout needs unapproved features, return to stage 1.

## 4. Prototype against adversarial fixtures

Inputs: the transition table, representative frames, and a disposable prototype location.

Action:

1. Exercise empty evidence, active work, errors, cancellation, late delivery, stale events, and reset boundaries.
2. Exercise duplicate events, overlapping agents, long paths, narrow terminals, and motion-disabled output.
3. Include hidden or truncated identities without merging distinct work.
4. Compare frames before and after transitions for width changes, stale labels, and unsupported claims.
5. Prepare a repeatable busy-session prompt with independent subagent work and disposable file activity.
6. Label fixture and replay output as simulation.

Static output means motion is disabled. A settled capture means the probe observed matching synchronization-off metadata around a capture. These are different properties. Neither property means the agent was idle.

Exit evidence: fixture inputs, expected transitions, rendered examples, identified defects, and the reusable busy-session prompt.

Return condition: if fixtures need fake counts or expected-output exceptions, return to stage 3. Do not filter unwanted rows to obtain a passing result.

## 5. Implement in isolated, bounded phases

Inputs: the approved design, prototype evidence, phase ownership, and a rollback point.

Action:

1. Use an isolated checkout for implementation.
2. Bound each phase to at most five files with one coherent behavior change.
3. Assign non-overlapping paths to concurrent workers.
4. Agree on shared interfaces before workers start.
5. Reuse existing state and rendering patterns.
6. Migrate affected callers during the source cutover.
7. Keep static settings order and golden frames pinned until their corresponding source cutover.
8. Remove obsolete paths only after examining their references.
9. Integrate all phase edits before the integration owner runs stage 6.

Concurrent workers do not run formatters, linters, builds, or the full suite against partial integration. Each phase retains a reversible diff. A source edit requires a fresh live session before its behavior counts as live evidence.

Exit evidence: the integrated phase diff, updated affected callers, justified regression coverage, and the rollback point.

Return condition: if implementation requires a second state authority or an unapproved contract change, return to stage 3.

## 6. Run static gates and fresh live capture

Inputs: the integrated phase, its busy-session prompt, approved local runtime access, and an unused sandbox root.

Action:

1. Read the current commands in `/Users/rohit/Documents/omp-animations/package.json`.
2. Run the full gate from the implementation checkout after concurrent edits stop:

```bash
cd /Users/rohit/Documents/omp-animations
bun run fix && bun run check && bun test
```

`fix` applies Biome changes, including unsafe fixes. The integration owner must inspect those changes. `check` runs Biome and the TypeScript checker. `bun test` runs the behavioral suite. A formatting change that affects source requires fresh live evidence too.

3. Read `/Users/rohit/Documents/omp-animations/scripts/sandbox-omp.sh` before preparing the runtime.

Caution: the script copies local skills, rules, settings, and the agent database into the fake HOME. Treat that copy as private. HOME isolation is not an operating-system sandbox. It does not prevent an agent from accessing other paths.

4. Obtain approval for copied private data and any consequential workload actions before those actions occur.
5. Prepare a new fake HOME and session for this source revision:

```bash
export REAL_HOME="$HOME"
export OMP_ANIM_SANDBOX="$(mktemp -d /tmp/omp-anim-protocol.XXXXXX)"
export OMP_ANIM_SANDBOX_SESSION="$(basename "$OMP_ANIM_SANDBOX")"
env -u OMP_PROFILE bash /Users/rohit/Documents/omp-animations/scripts/sandbox-omp.sh prepare &&
env -u OMP_PROFILE bash /Users/rohit/Documents/omp-animations/scripts/sandbox-omp.sh start &&
env -u OMP_PROFILE bash /Users/rohit/Documents/omp-animations/scripts/sandbox-omp.sh status
```

The shell cwd must remain the implementation checkout during preparation. The script derives the plugin source from that cwd. It installs through the fake HOME and checks the resulting link.

The runtime HOME is `$OMP_ANIM_SANDBOX/home`. Its cwd is `$OMP_ANIM_SANDBOX/project`. The plugin link is `$OMP_ANIM_SANDBOX/home/.omp/plugins/node_modules/@oh-my-pi/animations`. Its target must be `/Users/rohit/Documents/omp-animations`.

The script starts a 200-by-50 tmux session with `OMP_ANIMATIONS=full`. It reuses an existing session name without restarting. A new root and session name prevent accidental reuse. Do not use a real-home profile, bare `omp`, or `sandbox-exec` for this procedure.

6. Attach only to the new session:

```bash
tmux attach -t "$OMP_ANIM_SANDBOX_SESSION"
```

7. Run the approved busy-session prompt inside the disposable project.
8. Keep all workload writes inside that project and fake HOME.
9. During active subagent and tool work, capture from a separate shell with the same environment:

```bash
cd /Users/rohit/Documents/omp-animations
CAPTURE_RUN="$(bun run probe -- --session "$OMP_ANIM_SANDBOX_SESSION" --interval 2 --duration 60 --out /Users/rohit/Documents/omp-animations/.frames)"
PROBE_EXIT=$?
printf 'probe exit: %s\ncapture run: %s\n' "$PROBE_EXIT" "$CAPTURE_RUN"
if [ "$PROBE_EXIT" -eq 0 ]; then
  bun run probe:lint -- "$CAPTURE_RUN"
fi
```

The example samples for 60 seconds. This duration is not an acceptance threshold. The command records the probe exit before grading. If the run misses required transitions, extend the workload. Then repeat the capture.

The probe retains raw captures and metadata in `captures.jsonl` inside the reported absolute run directory. It emits graded frame files only from settled captures. Matching metadata is not an atomic snapshot. Unknown metadata or no retained settled frame gives probe exit 2.

The grader reads the explicit run directory. Exit 0 means no detected violations in identifiable frames. Exit 1 means violations. Exit 2 means no identifiable frames. A passing grader does not override an inconclusive probe.

10. Inspect the actual terminal for color, motion, readability, and the requested transitions.
11. Preserve a broken capture before correcting its source.
12. If the capture format can express a rendering defect, add a regression rule for that defect.
13. After each source correction, repeat the gates and capture from a fresh session.

Text captures cannot prove color behavior. Static gates and live behavior establish functional correctness only within the exercised scope. An actual CPU benchmark requires measured CPU use, a defined workload, duration, host version, and comparison conditions. Neither timer-count tests nor screenshots establish CPU performance.

Exit evidence: gate commands and exits, source revision, sandbox identity, plugin target, workload, raw capture directory, grading output, and visual observations.

Return condition: if a gate fails, return to stage 5. If evidence is inconclusive, repeat this stage. If live behavior contradicts the design, return to stage 3.

## 7. Reconcile decisions, beads, and rollback

Inputs: acceptance evidence, the integrated diff, product decisions, and the affected beads.

Action:

1. Compare each acceptance criterion with its evidence.
2. Record remaining capability gaps without claiming unsupported behavior.
3. Update `/Users/rohit/Documents/omp-animations/README.md` for an approved product contract change.
4. Update `/Users/rohit/Documents/omp-animations/CHANGELOG.md` for the shipped behavior.
5. Remove disposable implementation artifacts after preserving useful evidence.
6. Reconcile completed beads and their parent epic against actual git state.
7. Record the rollback commit or reversible diff and the private evidence location.
8. Distinguish local completion, integration, result delivery, and release in the handoff.

This procedure does not authorize a push, migration, deployment, or destructive cleanup. Obtain explicit approval for each consequential action. The sandbox `reset` command deletes its entire root and kills its session. Preserve evidence and obtain deletion approval before using it.

Exit evidence: criterion-by-criterion results, accurate bead status, current product documentation, an explicit delivery state, and an executable rollback description.

Return condition: if any acceptance criterion lacks evidence, return to its responsible stage. Do not close incomplete work or describe a local change as released.

## Scope note on the originating request

`omp-animations-x7r` asked for "append-only signed entries, invariants, Rust reference implementation text, and differential fuzzer record." This repository is a TypeScript/Bun terminal-UI plugin with no Rust toolchain, no cryptographic-signing infrastructure, and no differential fuzzer. Producing those artifacts here would require inventing tooling that does not exist and content that has no source of truth, which this protocol's stage 2 (`Label estimates and inferred references explicitly`) and stage 4 (`Label fixture and replay output as simulation`) both forbid.

This document substitutes the actual reusable need behind that request: a repeatable, evidence-gated procedure for taking a plugin change from an approved decision through implementation to a truthful live capture and bead reconciliation, using this repository's real tools (`bd`, `bun test`, `biome`, `scripts/sandbox-omp.sh`, `scripts/frame-probe.ts`). It has no signed entries, no Rust text, and no fuzzer record, because none of those exist in this codebase. Each stage's numbered actions are its "invariants" in a form this repository can actually enforce and verify.
