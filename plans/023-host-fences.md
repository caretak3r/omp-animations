# Plan 023: Host fences — differential settings test + import adapter

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e2e78cd..HEAD -- src biome.json`
> and confirm the installed host version:
> `grep '"version"' node_modules/@oh-my-pi/pi-coding-agent/package.json`
> must print `17.3.4` (the devDependency pin at `package.json:36`). Excerpts
> cite files as on disk at `e2e78cd` (dirty tree); any mismatch is a STOP.

## Status

- **Priority**: P2
- **Effort**: S (P4, test-only) + M (P1, mechanical repoint)
- **Risk**: LOW — zero behavior change; zero re-goldens is the proof
- **Depends on**: none. Land after 022 (022 adds one more host import this plan's sweep repoints).
- **Category**: architecture (fence a host dependency)
- **Planned at**: commit `e2e78cd`, 2026-09-12

## Why this matters

The plugin consumes the host (`@oh-my-pi/pi-coding-agent` 17.3.4) through two
unfenced channels:

- **P4**: `src/registrar.ts` carries a synchronous shadow copy of the host's
  private settings resolver. It is currently *faithful* — verified line by
  line below — but nothing catches future drift. A host that adds an override
  dir or changes merge semantics silently changes which settings this plugin
  wires.
- **P1**: 21 `src/` files import host deep subpaths (23 grep hits; 2 are
  comment-only mentions). All are export-map-sanctioned
  (`node_modules/@oh-my-pi/pi-coding-agent/package.json:279-282,459-462,479-482,504-507,544-547`)
  but carry no semver commitment. A host bump that moves a module breaks 21
  files at once with no single place to absorb it.

Both fixes are the same pattern — *fence a host dependency with a test
against the installed copy* — and MUST share one harness helper; two
harnesses would be a second convention (repo rule).

## Current state

### P4 — the mirror and its canonical source

Plugin mirror (`src/registrar.ts:150,176-192`):

```ts
const PROJECT_OVERRIDE_DIRS: readonly string[] = [CONFIG_DIR_NAME, ".claude", ".codex", ".gemini"];
...
export function readPluginSettingsSync(cwd: string = process.cwd(), home?: string): Record<string, unknown> {
	const globalConfig = readJsonFileSync(getPluginsLockfile(home));
	const globalSettings = globalConfig?.settings as Record<string, Record<string, unknown>> | undefined;
	const global = globalSettings?.[PLUGIN_NAME] ?? {};

	let project: Record<string, unknown> = {};
	for (const dir of PROJECT_OVERRIDE_DIRS) {
		const overrides = readJsonFileSync(path.join(cwd, dir, "plugin-overrides.json"));
		if (overrides !== undefined) {
			const projectSettings = overrides.settings as Record<string, Record<string, unknown>> | undefined;
			project = projectSettings?.[PLUGIN_NAME] ?? {};
			break;
		}
	}

	return { ...global, ...project };
}
```

Host canonical (`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/loader.ts:527-535`):

```ts
export async function getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
```

Host override-dir priority (`node_modules/@oh-my-pi/pi-coding-agent/src/config.ts:10-15`):

```ts
const priorityList = [
	{ dir: CONFIG_DIR_NAME, globalAgentDir: getConfigAgentDirName },
	{ dir: ".claude" },
	{ dir: ".codex" },
	{ dir: ".gemini" },
];
```

Documented divergence (deliberate): a corrupt global lockfile makes the host
**rethrow** (`loader.ts:49-54`: `if (isEnoent(err)) return …; throw err;`)
while the mirror degrades to `{}` (`registrar.ts:166-168`: "a corrupt global
lockfile never throws here — it degrades to `{}`").

**The `DirResolver`/`RESOLVER_HOME` wrinkle** — why the differential test must
be subprocess-shaped: the host's `getPluginSettings` takes no `home`
parameter; its global half calls `loadRuntimeConfig()` → `getPluginsLockfile()`
→ `getPluginsDir()`, which binds to the XDG-aware resolver captured at module
init (`node_modules/@oh-my-pi/pi-utils/src/dirs.ts:385,534-539`):

```ts
const RESOLVER_HOME = os.homedir();
...
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}
```

An in-process import of the host resolver can never see a fixture HOME — the
resolver already latched the real one. The host half of the differential test
therefore runs in a `Bun.spawn` child with `HOME` pointed at the fixture tree
(and `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME` scrubbed, so the
resolver derives `<home>/.omp/plugins` and not an XDG override). The mirror
half runs in-process via its existing test seam
(`readPluginSettingsSync(cwd, home)` — `registrar.ts:172-174`).

### P1 — the import census (verified by `grep -rn '@oh-my-pi/pi-coding-agent/' src/`)

**Runtime VALUE imports — exactly 3 host modules, 7 named values:**

- `src/animations-box/segments.ts:22-26`: `getContextUsageLevel`,
  `getContextUsageThemeColor` (+ type `ContextUsageLevel`) from
  `modes/components/status-line/context-thresholds`
- `src/activity-roster/bus.ts:3-8`: `expandPath`, `resolveReadPath`,
  `splitInternalUrlSel`, `splitPathAndSel` from `tools/path-utils`
- `src/animations-box/tool-activity.ts:8`: `normalizeToolName` from
  `tools/builtin-names`

**Type-only subpath imports** (18 more files): `appearance.ts:12-13`,
`glyph-presets.ts:19`, `progress-bar.ts:14`, `agent-bonsai/widget.ts:1`,
`animations-box/context-gauge.ts:37`, `animations-box/controller.ts:15,37-40`,
`animations-box/legend.ts:7`, `animations-box/settings.ts:11`,
`animations-box/status-line.ts:20`, `animations-box/widget.ts:26`,
`audit-trail-box/index.ts:18,25`, `audit-trail-box/render.ts:14`,
`breathing-border/colors.ts:8`, `cache-meter/render.ts:39`,
`palimpsest/colors.ts:1`, `rate-limit-tidepool/render.ts:11`,
`registrar.ts:28-29`, `signal-extras/segments.ts:1-2`.

**Comment-only mentions (do NOT repoint, they are prose):**
`agent-bonsai/hyperlinks.ts:6,9` and `agent-bonsai/progress.ts:6` — these
document *why* the plugin cannot use certain host modules (duplicate-singleton
trap). They complete the 23-hit census.

**The one structural exception**: the module augmentation at
`src/registrar.ts:56-60` must name the literal host module:

```ts
declare module "@oh-my-pi/pi-coding-agent/extensibility/extensions" {
	interface ExtensionContext {
		readonly sessionResources: ActivitySessionResources;
	}
}
```

This is a `declare module` statement, not an import declaration — Biome's
`noRestrictedImports` checks import/export clauses, so it should not trigger.
If it does trigger (STOP condition below has the fallback), exclude
`src/registrar.ts` from the override.

**Bare root imports stay**: `registrar.ts:22` and `audit-trail-box/index.ts:17`
import from `@oh-my-pi/pi-coding-agent` (no subpath) — the root export is the
host's stable surface; the fence pattern `@oh-my-pi/pi-coding-agent/**` does
not match the bare specifier, by design.

### The Biome fence — installed-schema-verified shape

`@biomejs/biome` `^2.4.16` (`package.json:35`). Its configuration schema
supports gitignore-style `patterns` on `noRestrictedImports`
(`node_modules/@biomejs/biome/configuration_schema.json:5298-5313` — `paths`
+ `patterns`; `:7425-7447` — `PatternOptions {group, importNamePattern, invertImportNamePattern, message}`).
Current `biome.json` has no `overrides` key (whole file read; 63 lines).

### Design invariants to preserve

Zero behavior change; zero re-goldens; one harness (P1+P4 share it); the
`declare module` stays put; wire-time settings resolution untouched; no new
runtime dependency on the host beyond what exists.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Repo gate | `cd /Users/rohit/Documents/omp-animations && bun run fix && bun run check && bun test` | exit 0; baseline 51 files / 1213 pass / 0 fail + new tests |
| Fence proof | `bun run lint` after Phase G | 0 errors; then temporarily add `import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme"` to any `src/animations-box/*.ts` file → lint MUST fail → revert the probe line |
| Focused | `bun test test/host-settings-differential.test.ts test/host-contract.test.ts` | pass |
| Sandbox | `./scripts/sandbox-omp.sh prepare` → restart tmux session `omp-anim-sandbox` → `bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5` → `bun run probe:lint` | 0 violations; frames visually identical to a pre-change capture |

## Scope

**In scope**:

- `test/installed-host-harness.ts` (create — the ONE shared helper)
- `test/host-settings-differential.test.ts` (create)
- `test/host-contract.test.ts` (create)
- `src/host/types.ts` (create)
- `src/host/runtime.ts` (create)
- The 19 repoint files listed in the census (18 type-import files + the 3
  value-import files overlap: 21 distinct files, incl. `registrar.ts`)
- `biome.json`
- `plans/README.md` (status row)

**Out of scope**:

- `agent-bonsai/hyperlinks.ts` / `agent-bonsai/progress.ts` comment prose.
- Bare-root imports (`registrar.ts:22`, `audit-trail-box/index.ts:17`).
- `@oh-my-pi/pi-utils` and `@oh-my-pi/pi-tui` imports — different packages,
  regular published deps, not part of this fence.
- Any behavior, any renderer, any golden.
- Vendoring host helpers locally (rejected: trades a loud compile break for
  silent semantic drift).

## Git workflow

Branch `advisor/023-host-fences`; one Conventional Commit per phase
(`test(host): …`, `refactor(host): …`); no push/PR unless the operator says so.

## Steps

### Phase A — shared harness + P4 differential test

Files (2): `test/installed-host-harness.ts`, `test/host-settings-differential.test.ts`.

1. `test/installed-host-harness.ts` (plain module, NOT `.test.ts` — bun must
   not collect it as a suite):
   - `installedHostVersion(): string` — reads
     `node_modules/@oh-my-pi/pi-coding-agent/package.json` version.
   - `writeGlobalLockfile(home: string, settings: Record<string, unknown>): void`
     — creates `<home>/.omp/plugins/omp-plugins.lock.json` with
     `{ settings: { "@oh-my-pi/animations": settings } }` (the path shape
     `getPluginsDir` derives for a non-resolver home,
     `dirs.ts:536`; confirm the dir name via `getConfigDirName()` from
     `@oh-my-pi/pi-utils` rather than hardcoding `.omp`).
   - `writeProjectOverride(cwd: string, dir: string, settings: Record<string, unknown>): void`
     — creates `<cwd>/<dir>/plugin-overrides.json` with
     `{ settings: { "@oh-my-pi/animations": settings } }`.
   - `runHostResolver(opts: { home: string; cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>`
     — `Bun.spawn` of `[process.execPath, "run", <inline script path>]` where
     the script (a fixture `.ts` written into the temp dir) imports
     `getPluginSettings` from
     `@oh-my-pi/pi-coding-agent/extensibility/plugins/loader`, calls it with
     `("@oh-my-pi/animations", process.cwd())`, and prints
     `JSON.stringify(result)`. Env for the child: inherit, then
     `HOME: opts.home`, and DELETE `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
     `XDG_STATE_HOME` (the resolver wrinkle above); `cwd: opts.cwd`.
   - Everything under `fs.mkdtempSync(path.join(os.tmpdir(), …))`; clean up
     in `afterEach`.
2. `test/host-settings-differential.test.ts` — for each fixture, assert
   `JSON.parse(host stdout)` deep-equals
   `readPluginSettingsSync(cwd, home)` (import from `../src/registrar`):
   - global only; project only (each of `.omp`, `.claude`, `.codex`,
     `.gemini`); global+project per-key merge (project wins);
   - two override dirs present → first dir in priority order wins
     (host: `loadProjectOverrides` returns the first parseable file,
     `loader.ts:60-68`; mirror: `break` at `registrar.ts:187`);
   - unparseable project override file → host falls through to the next dir
     (`loader.ts:64-67` swallows and continues) vs mirror's identical
     fall-through (`readJsonFileSync` → `undefined` → loop continues) —
     assert equality;
   - **documented divergence**: corrupt global lockfile → mirror returns the
     project-only result; host child exits non-zero (rethrow,
     `loader.ts:53`). Assert BOTH behaviors explicitly with a comment naming
     `registrar.ts:166-168` — this test is the tripwire that fires if either
     side changes.

**Verify**: `bun run fix && bun run check && bun test` → exit 0. This phase
touches zero `src/` files.

### Phase B — P1 adapter modules + contract test

Files (3): `src/host/types.ts`, `src/host/runtime.ts`, `test/host-contract.test.ts`.

1. `src/host/types.ts` — explicit named type re-exports, one block per host
   module, covering exactly the names in the census (enumerate from the
   import sites listed in "Current state"; e.g.
   `export type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";`,
   the event types + `ExtensionContext`/`ExtensionFactory`/
   `ExtensionCommandContext`/`WidgetPlacement`/`ContextUsage` from
   `extensibility/extensions` and `extensibility/extensions/types`,
   `GoalUpdatedEvent` (plus plan 021's `RetryFallbackAppliedEvent`/
   `RetryFallbackSucceededEvent`/`CredentialDisabledEvent` if 021 landed)
   from `extensibility/shared-events`, `AsyncJobSnapshot` from
   `session/agent-session-types`, `ContextUsageLevel` from
   `modes/components/status-line/context-thresholds`, and the
   `*ToolResultEvent` types from `extensibility/extensions/types` used by
   `audit-trail-box/index.ts:19-25`). Do NOT use `export type *` — star
   re-exports silently drop colliding names.
2. `src/host/runtime.ts` — the 7 values:

   ```ts
   export {
   	getContextUsageLevel,
   	getContextUsageThemeColor,
   } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/context-thresholds";
   export {
   	expandPath,
   	resolveReadPath,
   	splitInternalUrlSel,
   	splitPathAndSel,
   } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
   export { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
   ```

3. `test/host-contract.test.ts` — imports the 7 functions **directly from the
   installed host subpaths** (this file sits outside the fence on purpose)
   and asserts sample semantics so a host upgrade that changes behavior
   fails loudly, not silently:
   - `normalizeToolName` on known builtin aliases (pick 3 from
     `node_modules/@oh-my-pi/pi-coding-agent/src/tools/builtin-names.ts` by
     reading it at execution time);
   - `getContextUsageLevel`/`getContextUsageThemeColor` at threshold
     boundaries (read the thresholds from the host module source and assert
     the level flips exactly there);
   - `splitPathAndSel` round-trips (`"a/b.ts:5-10"` → path + selector;
     plain path → no selector); `splitInternalUrlSel` on an internal URL;
     `expandPath` tilde expansion against `os.homedir()`.
   - Also assert `installedHostVersion()` from the shared harness starts
     with `17.` — the loud tripwire for an accidental major bump.

**Verify**: repo gate → exit 0.

### Phases C–F — mechanical repoint (≤5 files each)

For each file: replace every `@oh-my-pi/pi-coding-agent/<subpath>` import
with the same names from `../host/types` / `../host/runtime` (relative depth
as appropriate). No other edits — the diff for each file must touch only
import statements.

- **Phase C** (5): `src/activity-roster/bus.ts`, `src/animations-box/segments.ts`,
  `src/animations-box/tool-activity.ts`, `src/animations-box/controller.ts`,
  `src/signal-extras/segments.ts` (the three value sites + the two biggest
  type sites).
- **Phase D** (5): `src/appearance.ts`, `src/glyph-presets.ts`,
  `src/progress-bar.ts`, `src/agent-bonsai/widget.ts`,
  `src/animations-box/context-gauge.ts`.
- **Phase E** (5): `src/animations-box/legend.ts`, `src/animations-box/settings.ts`,
  `src/animations-box/status-line.ts`, `src/animations-box/widget.ts`,
  `src/audit-trail-box/index.ts` (subpath imports only; the bare-root import
  at `:17` stays).
- **Phase F** (5): `src/audit-trail-box/render.ts`, `src/breathing-border/colors.ts`,
  `src/cache-meter/render.ts`, `src/palimpsest/colors.ts`,
  `src/rate-limit-tidepool/render.ts`.

**Verify after EACH phase**: repo gate → exit 0; zero golden movement.

### Phase G — registrar repoint + the fence

Files (2): `src/registrar.ts`, `biome.json`.

1. `src/registrar.ts`: repoint the type imports at `:23-29`
   (`ExtensionCommandContext`, `ExtensionContext`, `ExtensionFactory`,
   `WidgetPlacement`, `SymbolPreset`) to `./host/types`. Keep `:22`
   (bare root `ExtensionAPI`) and the `declare module` block at `:56-60`
   byte-identical.
2. `biome.json`: add at top level (schema-verified shape above):

   ```json
   	"overrides": [
   		{
   			"includes": ["src/**", "!src/host/**"],
   			"linter": {
   				"rules": {
   					"style": {
   						"noRestrictedImports": {
   							"level": "error",
   							"options": {
   								"patterns": [
   									{
   										"group": ["@oh-my-pi/pi-coding-agent/**"],
   										"message": "Host subpaths carry no semver commitment. Import via src/host/types.ts or src/host/runtime.ts (plan 023)."
   									}
   								]
   							}
   						}
   					}
   				}
   			}
   		}
   	]
   ```

3. **Fence proof** (both directions):
   - `bun run lint` → 0 errors.
   - Negative probe: temporarily add
     `import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";`
     to `src/glyph-presets.ts` → `bun run lint` MUST report the fence
     message → remove the probe line. (Throwaway verification, not a test
     file.)

**Verify**: repo gate → exit 0.

## Test plan

- **Re-run unchanged**: all 51 baseline test files — this plan's acceptance
  is that none of them change behavior. `test/animations-box-goldens.test.ts`
  and `test/screenshot-regression.test.ts` byte-identical.
- **Deliberate re-goldens**: none. Any golden diff is a STOP.
- **New tests**: `test/host-settings-differential.test.ts` (8 fixtures + the
  documented-divergence case), `test/host-contract.test.ts` (7 function
  contracts + version tripwire). Both depend on the installed host being
  present — true of the whole repo already (`devDependencies` pin).
- **No pins**: the contract tests assert host function *behavior* at chosen
  inputs, not host source text.

## Sandbox verification

```bash
./scripts/sandbox-omp.sh prepare
# restart the sandbox tmux session `omp-anim-sandbox`
bun run probe -- --session omp-anim-sandbox --interval 1 --duration 5
bun run probe:lint   # expected: 0 violations
```

The capture is a smoke test that the repointed imports load in the real host
process (resolution, not just types). Any row rendering differently from a
pre-change capture is a STOP.

## Done criteria

- [ ] Repo gate exits 0 after every phase.
- [ ] Zero golden/screenshot diffs across the whole plan.
- [ ] `grep -rn '@oh-my-pi/pi-coding-agent/' src/ | grep -v '^src/host/' | grep -v 'declare module' | grep -vE '^\S+:\s*[0-9]+:\s*\*'` → only the two comment-prose files (`agent-bonsai/hyperlinks.ts`, `agent-bonsai/progress.ts`).
- [ ] Fence proven in both directions (lint clean + negative probe fails).
- [ ] Differential test passes including the corrupt-lockfile divergence case.
- [ ] `bun run probe:lint`: 0 violations.
- [ ] `git status` clean outside the in-scope list; `plans/README.md` row updated.

## STOP conditions

- **The host copy under `node_modules` is not 17.x** (`^17`) — the excerpted
  resolver/exports may not exist; re-ground everything.
- Any "Current state" excerpt no longer matches the live file.
- Any golden or screenshot moves at any phase.
- Biome flags the `declare module` at `registrar.ts:56` — add
  `"!src/registrar.ts"` to the override's `includes` and note it in the
  commit message; if that still fails, STOP.
- `bun run lint` rejects the `overrides`/`patterns` config (schema drift from
  the shape verified against `configuration_schema.json:5298-5313,7425-7447`)
  — STOP; do not downgrade to `paths` guessing.
- The host subprocess in Phase A cannot resolve
  `extensibility/plugins/loader` (not in the export map — it IS covered by
  `./extensibility/*`, `package.json:279-282`, but verify) — STOP and report.
- A step's verification fails twice after a reasonable fix attempt.

## Rollback

One commit per phase; every phase is independently revertable
(`git revert <phase-sha>`). Phases C–F are import-only diffs; reverting the
fence (Phase G) alone restores the unfenced-but-working state.

## Beads

- None own this work. Coordinate timing only: 022 adds a
  `normalizeToolName` import to `src/signal-extras/state.ts` — if 022 landed
  first, add that file to Phase C's repoint list (keeping the phase ≤5 files
  by moving `src/signal-extras/segments.ts` to Phase D, which has room).

## Maintenance notes

- When the host ships a stable plugin-settings seam, delete
  `readPluginSettingsSync` and `test/host-settings-differential.test.ts`
  together (see `registrar.ts:169-170`'s own note).
- On every host version bump: `bun test test/host-contract.test.ts
  test/host-settings-differential.test.ts` is the first thing to run.
- New host imports go through `src/host/` — the fence enforces this; the
  error message tells the author where.
