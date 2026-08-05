# Plan 001 — Registrar honors stored plugin settings (+ label + docs)

**Written against commit:** `31d90c8` · **Repo:** `/Users/rohit/Documents/oh-my-pi-animations`
**Axis:** oh-my-pi setup & compatibility · **Effort:** M · **Risk:** MED

## Why this matters

This package's entire premise (README, `package.json#omp.settings`) is "oh-my-pi config decides
which animations mount and at what motion tier." **That promise is currently inert through the
settings UI/CLI.** Two independent audits + a firsthand read confirmed:

- `src/registrar.ts:234` — the production entry is `export default createAnimationsPlugin()`, called
  at module load with `options = {}`.
- `src/registrar.ts:220-222` — so `resolveAnimationsConfig(options.settings ?? {}, env)` resolves the
  enable-map + tier from **`{}` + `Bun.env` only**.
- The async store reader (`getPluginSettings`, imported at `registrar.ts:23`) is threaded **only** to
  Context Weather (`registrar.ts:158`, `223`). The 15 Wave 2 toggles and the shared `animations` tier
  never consult stored settings.
- Stock oh-my-pi persists `omp plugin` settings to a lockfile readable only via **async**
  `getPluginSettings(name, cwd)` — nothing copies them into `process.env`; the manifest `env` keys are
  display-only. (Source: `/Users/rohit/Documents/oh-my-pi/packages/coding-agent/src/extensibility/plugins/loader.ts` around the `getPluginSettings` definition, and `.../plugins/manager.ts` write side.)

**User-visible bug:** a user who sets `animations: "subtle"` or `toolConstellation: false` in the omp
plugin settings UI sees *no effect* — every Wave 2 animation still mounts at `full`. Only manually
exporting `OMP_ANIMATIONS_*` shell env vars works. Context Weather alone honors the tier (it re-reads
async), producing the incoherent state "Context Weather subtle + 15 others full."

Also fixed here (same file / same concern):
- **Label collision (`DX-01`):** `registrar.ts:226` sets label `"oh-my-pi animations"`, then Context
  Weather's mount calls `pi.setLabel("Context Weather")` (`src/context-weather/extension.ts:93`);
  `setLabel` is last-write-wins on the shared extension, so `/status` shows the whole suite as
  "Context Weather".
- **README (`DOCS-01`, `DOCS-02`):** the install/settings section advertises the broken settings path
  as primary and misstates the core-version requirement (see step 4).

## The zero-leak constraint (read before designing the fix)

`registrar.ts:225-231` mounts each enabled animation by invoking its factory synchronously at wire
time; a disabled animation's factory is never called, so it registers zero `api.on(...)` listeners.
This "zero listeners for disabled animations" contract must be preserved — the enable decision must
still be made **before** subscribing, i.e. synchronously in the factory body. That is why you cannot
simply `await getPluginSettings(...)` inside the factory (it is `(api) => void`, synchronous, and no
`cwd` is passed to it).

## The fix — a synchronous mirror of `getPluginSettings`

Add `readPluginSettingsSync(cwd)` that reproduces what `getPluginSettings(PLUGIN_NAME, cwd)` returns,
using synchronous file reads, and feed its result into `resolveAnimationsConfig` as the default for
`options.settings`. Precedence stays exactly as documented: **stored setting > `OMP_*` env > default**.

### Step 1 — Study the real reader (do this first, it defines correctness)

Read the stock implementation so your sync mirror matches byte-for-byte semantics:
```
/Users/rohit/Documents/oh-my-pi/packages/coding-agent/src/extensibility/plugins/loader.ts
```
Find `getPluginSettings` (around line 520-540) and whatever it calls to locate + merge settings
(e.g. a global plugins lockfile via a `getPluginsLockfile()`/config-dir helper, unioned with a
project-level `plugin-overrides.json`). Note: the file path helpers, the merge order (project
overrides win over global), and the exact JSON shape (`config.settings[pluginName]`).

**ESCAPE HATCH:** if `getPluginSettings` does anything a synchronous file read cannot faithfully
reproduce (network/IPC, async-only decryption, a value only the host holds in memory), STOP and
report back — the correct fix then becomes an upstream host change (pass resolved settings into the
factory), which is out of scope for this repo. Do not guess at semantics.

### Step 2 — Implement the sync reader

In `src/registrar.ts` (or a new `src/plugin-settings.ts` re-exported from the barrel, your call —
match the star-barrel convention), add:

```ts
/** Synchronous mirror of getPluginSettings(PLUGIN_NAME, cwd): global lockfile ∪ project overrides. */
export function readPluginSettingsSync(cwd: string = process.cwd()): Record<string, unknown> { … }
```

- Use Bun/Node sync file APIs (`readFileSync` / `Bun.file(...).text()` is async — prefer
  `node:fs` `readFileSync` wrapped so a missing file → `{}`). Never throw: any read/parse error
  returns `{}` (the plugin must never crash the host over a missing config).
- Key by `PLUGIN_NAME` (`@oh-my-pi/animations`), exactly as the async path does.
- Reproduce the global-∪-project merge order you found in Step 1. For the project scope, use `cwd`
  (default `process.cwd()`, which is the omp project dir at load time).

### Step 3 — Wire it into the production factory

- `createAnimationsPlugin(options = {})`: default `options.settings` to `readPluginSettingsSync()`
  when not injected:
  ```ts
  const settings = options.settings ?? readPluginSettingsSync(options.cwd);
  const config = resolveAnimationsConfig(settings, env);
  ```
  (Add an optional `cwd?: string` to `AnimationsPluginOptions` for testability; default undefined →
  `process.cwd()` inside the reader.)
- Keep the injected-`settings` seam working (tests rely on it — `test/registrar.test.ts:32`).
- Leave Context Weather's own async reader (`registrar.ts:158`) as-is; it is additive and correct.

### Step 4 — Fix the label and the docs

- **Label:** set `api.setLabel("oh-my-pi animations")` **after** the mount loop (so Context Weather's
  inner `setLabel` doesn't win), OR stop calling `setLabel` inside `createContextWeatherExtension`
  when it is mounted under the registrar (add an option to suppress it). Prefer setting the registrar
  label last — smallest change. Verify the intended label survives (see Done criteria).
- **README** (`README.md:29-61`):
  - Rewrite the install/enable section so the settings UI/CLI path is described as the **working**
    primary channel (true after this plan), with `OMP_ANIMATIONS_*` env vars as the fallback.
  - Add one concrete local-install command. The stock loader supports `omp plugin install ./path`
    (verify the exact command in `/Users/rohit/Documents/oh-my-pi/packages/coding-agent/src/extensibility/plugins/plugin-cli.ts`); document that verbatim.
  - Fix the version claim: installed `@oh-my-pi/pi-coding-agent@16.3.12` / `pi-tui@16.3.12` **do**
    expose `tokensUntilCompaction` / `renderUnderPressure` (verified present in `node_modules`). Change
    "stock @16 does not expose" to name the first minor that ships them (they exist at `16.3.x`); keep
    the graceful-degradation note framed as "on older cores."

## Files in scope
- `src/registrar.ts` (+ optional `src/plugin-settings.ts`, `src/index.ts` barrel if you add a module)
- `src/context-weather/extension.ts` — only if you choose the "suppress inner setLabel" label fix
- `README.md`
- `test/registrar.test.ts` (+ a new fixture-driven test)

## Files explicitly OUT of scope
- Any file under `/Users/rohit/Documents/oh-my-pi` (the source monorepo) — READ-ONLY reference only.
- The 18 animation render/state/widget modules — untouched by this plan.
- `package.json#omp.settings` — the schema is already correct; do not change keys.

## Test plan (behavioral only — no source-grep, no mock.module)
1. **New fixture test** in `test/registrar.test.ts`: write a temp dir with a fake plugins lockfile +
   project overrides containing `{"@oh-my-pi/animations": {"animations": "subtle", "toolConstellation": false}}`
   in the same shape/paths the real store uses; call the **real default export** (not the injected
   seam) with `cwd` pointed at the fixture; assert (a) the resolved tier is `subtle`, (b)
   `toolConstellation` did NOT mount (zero listeners for it — assert via the existing "counts mounted
   animations / listeners" helper the current registrar test already uses), (c) an un-set animation
   defaults to enabled. Follow the existing `test/registrar.test.ts` structure and the kit's
   subscription-counting harness.
2. **Precedence test:** stored `false` beats env `true`; env fills when stored is absent; default when
   both absent. (Extend `resolveAnimationsConfig` tests — that function is already unit-tested.)
3. **Label test:** mount the registrar with Context Weather enabled; assert the extension's final label
   is `"oh-my-pi animations"`, not `"Context Weather"` (use whatever `setLabel` observation the TUI
   test harness exposes; if none exists, assert on the registrar's mount ordering behaviorally).
4. Re-gold any snapshot that legitimately changed (none of the *animation* snapshots should move —
   only registrar behavior).

## Done criteria (machine-checkable)
- `cd /Users/rohit/Documents/oh-my-pi-animations && bun run fix && bun check` → exit 0, zero biome/tsgo errors.
- `bun test` → 0 fail; total pass ≥ 773 + your new tests.
- The new fixture test proves a stored `toolConstellation:false` prevents that animation from
  subscribing, and stored `animations:"subtle"` sets the tier — via the **real default export**.
- Grep confirms the production path no longer resolves gating from `{}`: `resolveAnimationsConfig` is
  fed `readPluginSettingsSync(...)` in `createAnimationsPlugin` (this is a review check, not a test).

## Maintenance note
The sync reader duplicates omp's settings-path logic and is therefore coupled to it (the R2 caveat in
spirit): if a future oh-my-pi changes where/how plugin settings are stored, this mirror must track it.
Add a code comment pointing at the stock `getPluginSettings` as the canonical source, and keep the
fixture test's lockfile shape matching the real one. If oh-my-pi ever adds a seam to pass resolved
settings into an extension factory, delete the sync mirror and use it.
