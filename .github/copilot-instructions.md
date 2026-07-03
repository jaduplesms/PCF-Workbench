# PCF Workbench — Copilot Instructions

PCF Workbench is a local development harness that replaces `pcf-scripts start` for Power Apps Component Framework (PCF) controls. It loads a user's compiled `out/controls/<Name>/bundle.js`, runs it against shimmed `ComponentFramework.Context` APIs, and adds gallery, device emulation, network conditioning, WebAPI mocking, scenarios, and lifecycle/leak monitoring.

## Working directory

All source, configs, and scripts live under `harness/`. Always `cd harness` first. The repo root only contains README and LICENSE.

## Commands (run from `harness/`)

- `npm install` — install deps (no separate build step needed for dev; Vite transpiles TS on the fly)
- `npm run dev` — start Vite on port 8181
- `npm run typecheck` — `tsc --noEmit`; this is the canonical pre-PR check (there is no test suite or linter configured)
- `npm run build` — `tsc -b && vite build` (production bundle of the harness itself)
- `npm run harness` — runs `bin/pcfworkbench.ts` via tsx (CLI entry exposed as `pcfworkbench` bin on npm install)

Launching against a target control workspace is driven by env vars, not CLI args:

- Gallery mode: `PCF_WORKSPACE_ROOT=<dir-with-many-controls> npx vite --port 8181`
- Single-control mode: `PCF_CONTROL_PATH=<path-to-control-dir> npx vite --port 8181`
- PowerShell uses `$env:PCF_WORKSPACE_ROOT = "..."` etc.

The harness loads the **compiled** `bundle.js` from `out/controls/<Name>/`, never the user's TS source. Users must run `npm run build` in their PCF project before the control is loadable.

## Architecture (the parts that need cross-file reading)

The harness has two halves that meet at the Vite plugin:

1. **Server side — `src/vite-plugin/pcf-plugin.ts`**
   Single Vite plugin owns: workspace/control discovery, `ControlManifest.Input.xml` parsing (via `parser/manifest-parser.ts` + `fast-xml-parser`), serving `bundle.js` and resources from the user's `out/` dir, the gallery JSON API, and a watcher on `out/` that triggers HMR when `bundle.js` changes. There is no separate Express/Node server.

2. **Client side — React + Zustand**
   - `App.tsx` routes between `ui/gallery/Gallery.tsx` (workspace mode) and `ui/HarnessShell.tsx` (single-control mode).
   - `loader/control-host.ts` is the PCF lifecycle manager — it calls `init`, `updateView`, `getOutputs`, `destroy` on the user control and feeds it the shimmed context. Also wires the form state: after `preloadBundleResources` it calls `seedFormState` → `setFormContextLogger` → `buildFormContext` → `bindXrmPageToFormContext`, then `fireOnLoad(buildExecutionContext('form.load', null))` after the first `updateView`.
   - `loader/bundle-loader.ts` injects the compiled bundle as a script and reads the registered control class off the global namespace.
   - `loader/platform-libs.ts` exposes React/ReactDOM as globals for virtual controls and installs Fluent UI v8/v9 Proxy stubs (functional component impls of Stack/TextField/Dropdown/etc.). Treat these stubs as the API contract for virtual controls — extend them when a control needs a missing Fluent component.
   - `loader/resource-tracker.ts` monkey-patches `addEventListener`, `setInterval`, `setTimeout`, and the three Observer constructors before `init` runs and diffs after `destroy` to report leaks.

3. **Context shims — `src/shim/`**
   `context-factory.ts` composes a full `ComponentFramework.Context` by pulling one shim per concern: `web-api.ts`, `resources.ts`, `client.ts`, `device.ts`, `mode.ts`, `navigation.ts`, `formatting.ts`, `user-settings.ts`, `utils.ts`, `fluent-design.ts`. **One file per `context.*` namespace** is the convention — add new context surface area as a new shim file rather than expanding `context-factory.ts`.
   - `web-api.ts` mirrors the real Dynamics 365 routing model: `context.webAPI` auto-routes online/offline based on network state, while `webAPI.online` and `webAPI.offline` always target a specific store. OData support covers `$filter` (eq/ne/gt/ge/lt/le, `contains`/`startswith`/`endswith`, `and`/`or`, null), `$select`, `$orderby`, `$top`, `maxPageSize`.
   - `resources.ts` preloads images/fonts/RESX synchronously at startup so `getResource()` and `getString()` return cached base64/strings the same tick — matching real Dynamics timing. Don't make these async.
   - `xrm-global.ts` installs the global `Xrm.*` namespaces (`WebApi`, `Navigation`, `Utility`, `Encoding`, `Device`, `App`, `Panel`) with best-practice warning wrappers. **One block per Xrm namespace** — add new ones following the same `if (!w.Xrm.X) { w.Xrm.X = {…} }` pattern.
   - `xrm-form.ts` owns the legacy `Xrm.Page` notification banner *and* the `bindXrmPageToFormContext(formContext)` proxy that makes `Xrm.Page` an alias of the live formContext. **The proxy's `mergedUi` must keep the original `setFormNotification`/`clearFormNotification` from this file at top priority** — preferring `formContext.ui.setFormNotification` causes infinite recursion (it delegates back to `Xrm.Page.ui.setFormNotification`).
   - `form-context.ts` is the modern `formContext` facade: `getAttribute`, `getControl`, `data.entity`, `ui.tabs`/`ui.sections`, plus `executionContext` builder. State lives in `store/form-store.ts` and is seeded from `data.json` + manifest bound properties. All stub calls are **log-only** (no throws) by user preference.
   - `dialog-bus.ts` is a tiny pub-sub for shim-driven dialogs (alert/confirm/lookup/openForm). The harness's `<DialogHost />` subscribes and renders Fluent dialogs.

4. **State — `src/store/`**
   - `harness-store.ts` is the single Zustand store: property values, page context, network mode, device preset, disabled state, render timeline (last 50), WebAPI log (last 100), lifecycle events. No providers — components read directly with `useHarnessStore`.
   - `data-store.ts` holds the in-memory entity table loaded from the user's `data.json`. Both the WebAPI shim and the dataset shim read from here, so changes to entity shape must be reflected in both.
   - `form-store.ts` is a **non-Zustand** pub-sub store backing the `formContext` shim (Zustand's immutable-snapshot model doesn't fit attribute/control objects with mutating handler `Set`s). Subscribers use `useSyncExternalStore(subscribeFormState, getSnapshot)` with a cached snapshot keyed by `getFormStateVersion()` — see Conventions.

5. **CSS isolation**
   Control CSS is injected into `@layer pcf-control`; harness Fluent UI CSS is unlayered and therefore wins by cascade. `@media (width …)` rules in control CSS are rewritten to `@container pcf-viewport (…)` so device emulation reflects the emulated viewport, not the browser window. Don't replace the layer/container approach without understanding both pieces.

## Conventions

- **TypeScript strict mode is on**, but `noUnusedLocals` / `noUnusedParameters` are intentionally off. Don't enable them in PRs.
- **No test runner, no linter, no formatter** is configured for the harness. `npm run typecheck` is the gate. (Playwright is configured under `harness/tests/` for *acceptance* runs against sample controls, not unit tests of harness internals.)
- **Zustand 5, no providers.** Read state via the store hook directly; don't introduce React Context for harness state.
- **Fluent UI v9** for harness UI. Fluent v8/v9 stubs in `loader/platform-libs.ts` are for *virtual user controls only* — don't import them into harness UI code.
- **Fluent v9 `<Button>` and `<Badge>` strip `data-*` props.** Wrap them in `<span data-test-id="…">` whenever a stable Playwright/test selector is needed. Don't put `data-test-id` directly on the Fluent component.
- **`useSyncExternalStore` requires a stable snapshot reference.** Every store backed by `useSyncExternalStore` (e.g. `form-store.ts`) must expose a version counter incremented on every notify, and the React subscriber must cache the snapshot keyed by that version. Returning a fresh object every call (e.g. with `Date.now()`) makes React silently bail and the panel renders blank. See `form-store.ts` `getFormStateVersion()` + `FormPanel.tsx` `getSnapshot()`.
- **JSDoc terminator gotcha.** `*/` anywhere inside a block comment closes it early. Avoid sequences like `addOption*/clearOptions` (use `addOption/clearOptions` instead) — the harness ate 30+ TS errors from this once.
- **The PCF mounts directly in the harness page** (no iframe). Playwright tests target top-level `page.locator`, not `frameLocator`.
- **Discovery is filesystem-driven**: a control is anything with a `ControlManifest.Input.xml`; `out/controls/<Name>/bundle.js` must exist to load it; `.pcf-private` marker hides from gallery; `data.json`, `test-scenarios.json`, and `thumbnail.{jpg,png,gif}` are picked up from the control directory or its parent project root.
- **PCF runtime fidelity matters.** When extending shims, match real Dynamics 365 behavior (sync vs async, error shapes, online/offline routing) — these are the bugs the harness exists to surface.
- **Hot reload key**: the Vite plugin watches `out/` in the *user's* project, not `src/`. Editing harness source uses Vite's normal HMR.
- **No Microsoft SDK source is bundled.** Keep it that way (see README licensing notes) — shims must be original implementations.

## In-tree samples (`samples/`)

The repo ships real PCFs under `samples/` built with `pac pcf init` + `pcf-scripts`. Sources are committed; `samples/**/{out,obj,bin,node_modules,generated}/` is gitignored.

- **`samples/ConformanceTester/`** — field-bound Fluent v9 React PCF whose UI is a 30-row test grid (Context.* / Xrm.* / formContext.* / executionContext.*). One row per shim member, each with stable `data-test-id`. Used as the per-phase Playwright acceptance gate for M1.
  - Build: `cd samples\ConformanceTester && npm run build` → `out/controls/ConformanceTester/bundle.js`
  - Load: `cd harness; $env:PCF_CONTROL_PATH="..\samples\ConformanceTester\ConformanceTester"; npx vite --port 8181`
  - Eslint is intentionally relaxed in `samples/ConformanceTester/eslint.config.mjs` (typescript-eslint type-checked rules off) so the conformance harness can probe APIs untyped without lint noise.
  - Adding new conformance rows: append to the `TESTS` array in `ConformanceGrid.tsx`. Each row has `id`, `category` ("Context"|"Xrm"|"formContext"|"executionContext"), `name`, and a `run(ctx)` function that returns a result string or throws on fail. Rows that depend on a not-yet-implemented shim should return `"N/A (P2)"` (or whichever phase) so the runner classifies them as `na`.

When adding a new sample: `cd samples; pac pcf init --namespace PcfWorkbench --name <Name> --template field|dataset --framework react --run-npm-install`. Commit only sources.

## Roadmap

The authoritative roadmap lives in `harness/docs/showcase.html` (Roadmap view). M0 (Core Workbench) is shipped. Active/later milestones, in priority order:

- **M1 — UCI Fidelity & API Coverage** *(XL, in planning)*. Reproduce the full Unified Client Interface so any production control behaves identically locally. Close `ComponentFramework.Context` gaps to 100%; complete `Xrm.WebApi` / `Xrm.Navigation` / `Xrm.Utility`; full form-level API (`Xrm.Page` + modern `formContext` with `getAttribute`, `getControl`, `data`, `ui.tabs`, `ui.sections`, `addOnSave`/`addOnChange`/`addOnLoad`); `executionContext` on every handler; UCI form chrome (header, command bar, tab strip, footer); `Xrm.Device`/`Encoding`/`App`/`Panel` shims; conformance suite diffed against `@types/xrm` and `@types/powerapps-component-framework`; coverage panel flagging unimplemented shim calls; versioned shim profiles (Dataverse 9.x / 9.2 / latest).
- **M2 — Live Dataverse Bridge** *(L, shipped)*. Optional connected mode replacing `data.json` with a real org via `pac auth`; explicit per-call confirmation for live writes; on-disk response cache for offline-fast reruns; one-click snapshot live→mock; visual LIVE indicator; per-scenario mock/live pinning.
- **M3 — Scenario Runner + Playwright** *(L, shipped)*. Headless runner across saved scenarios (`pcfworkbench batch`) with per-scenario artifacts and aggregated reporting; visual regression via pixel-diff baselines; performance budget status in loop reports; CI-ready workflow examples.
- **M4 — Diagnostics & Linting** *(M, shipped)*. New "Audit" tab: axe-core a11y audit; banned-API check (`localStorage`, `sessionStorage`, cookies); manifest validation (bound property must be `value`, version-bump check); CSS scoping check (warn on unprefixed selectors); bundle-size budget warning; per-rule ignore via `.pcf-audit.json`.
- **M5 — Field Service Mobile / Offline Profiles** *(M, later)*. Configurable mobile offline profile (which entities & views are synced); warn when control hits an entity outside the profile; simulate aggressive bundle caching; Field Service form-factor preset; offline-first checklist runner.
- **M6 — Add-in Framework** *(L, later)*. Plug-in system so the workbench is extensible without forking. Add-in manifest + lifecycle hooks (`onLoad`, `onControlInit`, `onScenarioRun`, `onPanelMount`); UI extension slots (sidebar tab, toolbar button, viewport overlay, panel section); add-in API (read state, invoke shims, inspect manifest, read/write artifacts); sandboxing with per-add-in permission scopes; discovery + install UI.
- **M7 — First-party Add-ins** *(L, later; depends on M6)*. AI Code Review (provider-agnostic: Anthropic / OpenAI / Azure / Ollama / WebLLM / no-AI fallback) for PCF best practices, perf, a11y; GitHub add-in (browse org, clone PCF repo, build, load into gallery); Solution Push (push control + test data via PAC CLI); Schema-aware Data Generator (auto-fill `data.json` from Dataverse schema); Telemetry capture & replay (App Insights / Dataverse).
- **M8 — Polish** *(L, later, batched)*. Auto-generate sample `data.json` & `test-scenarios.json` during scaffolding; scenario diff view; bundle analyzer treemap of `bundle.js`; source-map debugging (TS breakpoints); theme / RTL / high-contrast preview toggles; recording mode (capture interactions, replay as scenario); VS Code extension wrapper for one-click launch; side-by-side control-version comparison.
- **M13 — Modern Theming Overrides Parity** *(M, later)*. Add Dynamics 365 modern theme override fidelity: ingest exported override payloads, project them into `context.fluentDesignLanguage.tokenTheme` + `context.theming`, support per-scenario theme pinning, and validate token parity against UCI.

When picking up roadmap work, re-read the matching milestone card in `harness/docs/showcase.html` for the latest checklist — that file is updated more often than this one.

## Validation workflow — Playwright MCP

A Playwright MCP server is configured for this repo, plus `@playwright/test` is installed under `harness/` with `playwright.config.ts` and specs under `harness/tests/`. Treat Playwright as the **acceptance gate** for any change that touches harness UI or shim wiring, and as the long-term shape of the standard PCF end-to-end build loop:

1. Build the target sample: `cd samples\ConformanceTester && npm run build` (or whichever sample exercises the changed surface)
2. Start the harness against it: `cd harness; $env:PCF_CONTROL_PATH="..\samples\ConformanceTester\ConformanceTester"; npx vite --port 8181 --host 127.0.0.1` (background; if port 8181 is busy Vite picks the next free one — capture the actual URL)
3. Run the spec: `cd harness; $env:HARNESS_URL="http://127.0.0.1:<port>"; npx playwright test --reporter=list`. Or drive interactively via the Playwright MCP tool.
4. The spec writes a JSON report + screenshot to `harness/__visual__/conformance-<phase>.{json,png}`. Diff against the previous-phase baseline.
5. Only mark a phase / sub-todo `done` once Playwright is green.

**Last green baseline (M1.P1):** 27 pass / 0 fail / 3 n/a in `harness/__visual__/conformance-p1.json` (the 3 n/a are P2-deferred shim rows).

**Playwright config notes:**
- Viewport must be ≥ 1920×1080 — the harness side panels at default size clip the conformance grid offscreen at 1440×900.
- The PCF renders directly in the page (no iframe) — use top-level `page.locator`, not `frameLocator`.
- `data-test-id` on Fluent v9 components is dropped — wrap in a `<span data-test-id="…">` (see Conventions above).

This loop is also the seed for M3 (Scenario Runner + Playwright): the same drive-the-harness pattern will eventually run headlessly across every saved scenario in CI.

## Resumption (where to start a fresh session)

Read these in order before making changes:

1. The **session plan.md** under `~/.copilot/session-state/<session-id>/plan.md` — it has the authoritative phase status, the "Resume here" step list for the current phase, and the latest deferred-discussion items.
2. The most recent **session checkpoint** in the same folder under `checkpoints/` — captures prior decisions, file changes, and gotchas hit since last reset.
3. This file (Conventions + Architecture sections) for stable, codebase-wide rules.
4. `harness/__visual__/conformance-<phase>.json` for the last green Playwright baseline.

**Current state at last checkpoint:** M1.P1 (formContext skeleton) is shipped and Playwright-green (27/0/3). M1.P2 (Xrm namespace completion) is staged in `harness/src/shim/xrm-global.ts` (Utility extras / Encoding / Device / App / Panel) — typecheck green, **not yet validated by Playwright**. Next action is to add real Conformance grid rows for the new surface, rebuild ConformanceTester, and run the Playwright spec until ≥35 pass / 0 fail / 0 n/a. See the session plan.md "Resume P2 here" section for the exact step list.

**Outstanding tech debt:** `m1-p1-formpanel-layout` — FormPanel renders horizontal + vertical scrollbars at default side-panel width even with small content. Pending.

**Deferred discussion items (do not implement without asking):** see plan.md "Deferred / discussion-only". Currently: `harness-authoring-mode-toggle` (stub `context.mode.isAuthoringMode` for InfoCard-style designer-preview support).
