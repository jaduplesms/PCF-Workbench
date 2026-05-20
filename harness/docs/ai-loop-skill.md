---
name: pcf-build-loop
description: "AI-assisted PCF build loop powered by PCF Workbench. Use when iterating on a Power Apps Component Framework control without a Dataverse org. Runs build + headless harness + Playwright drive + structured JSON report + screenshot via one command. TRIGGER: fix this PCF, iterate on this control, make this PCF render, ControlManifest.Input.xml, pcf-harness, PCF Workbench, debug PCF locally."
user-invocable: true
argument-hint: "[fix|iterate|render] <path-to-pcf-control-dir>"
---

# Skill: AI-Assisted PCF Build Loop

> Drop-in skill / system-prompt fragment for Copilot CLI, Claude, or any
> other coding agent. Teaches the agent to drive PCF Workbench's
> `pcf-harness loop` CLI end-to-end and iterate on a PCF control until it
> renders cleanly.

---

## When to use this skill

Trigger on any of these intents:
- "fix this PCF", "iterate on this control", "make this PCF render"
- A user pointing at a directory containing `ControlManifest.Input.xml`
- A failing PCF build the user wants debugged
- Refactoring a PCF and wanting fast feedback without a Dataverse org

---

## What you can run

```bash
# One full loop: build + headless run + report.
npx pcf-harness loop --path <absolute-path-to-pcf-control-dir>

# Reuse an existing build (faster when iterating on harness wiring only).
npx pcf-harness loop --path <dir> --skip-build

# Longer timeout for heavy controls.
npx pcf-harness loop --path <dir> --timeout 120000

# Custom output directory.
npx pcf-harness loop --path <dir> --out ./reports/run-$(date +%s)
```

Exit code: `0` on pass, `1` on warn or fail. Output: `<out>/report.json`
and `<out>/screenshot.png`.

If `pcf-harness` isn't on PATH, run from the workbench checkout:

```bash
cd <pcf-workbench>/harness
npm run harness -- loop --path <dir>
```

---

## How to read the report

**Always check `summary.status` first.** It's one of `pass | warn | fail`.

```jsonc
{
  "summary": {
    "status": "fail",
    "headline": "3 console/page error(s)",
    "errors": 3,
    "leaks": 0
  }
}
```

If `status === 'pass'`: you're done. Tell the user, link the report path,
optionally show the screenshot.

If `status !== 'pass'`, drill into the report in this order:

1. **`build.ok`** — if false, read `build.errors` (max 30 lines of TS /
   pcf-scripts errors). Edit the cited files, re-run.
2. **`harness.ok`** — if false, the control never rendered. Read
   `harness.error` (timeout reason), then `harness.pageErrors` (uncaught
   throws) and `harness.consoleErrors` (browser console).
3. **`harness.report.lifecycle.events`** — Was `init` called? Did
   `updateView` fire? An array with `init` only means the control threw
   during render.
4. **`budget.violations`** — if `budget.status === 'fail'`, a perf
   threshold was exceeded. Each violation has `metric`, `actual`,
   `budget`, `delta` (actual minus budget), and `severity`. **Target the
   `fail`-severity violations first**; `warn`-severity entries are
   advisory. Common causes: `firstUpdateViewMs` spike = async work added
   to `init`; `avgRenderTimeMs` spike = expensive computation moved out
   of `useMemo`; `renderCount` spike = `setState` in `useEffect` without
   deps; `leaks` non-zero = listeners / timers / observers not cleaned
   in `destroy()`.
5. **`harness.report.leaks`** — event listeners / timers / observers
   not cleaned up in `destroy()`. Each leak has `type` and `detail`.
6. **`harness.report.webApi.errorCount`** — OData / WebAPI errors. See
   `harness.report.webApi.calls` for the failing requests.
7. **`harness.report.performance`** — even without a budget,
   `firstUpdateViewMs > 500` or `avgRenderTimeMs > 50` is worth
   investigating.

The full schema is at `harness/docs/ai-loop-report.schema.json`. The
guided playbook is at `harness/docs/ai-build-loop.md`.

---

## The refactor loop you should follow

```
while (true):
    report = run_loop(control_path)
    if report.summary.status == 'pass':
        report_success_to_user()
        break
    diagnose(report)               # use the playbook above
    plan_minimal_fix(report)       # smallest change that flips one signal
    apply_fix()                    # edit PCF sources
    # do NOT change harness/ sources unless the user asked for it
```

Hard rules:

- **Never edit `harness/` sources.** The harness is the fixture; the
  control is the unit under test. If a harness shim is missing
  behaviour (`harness.report.logs.unimplementedCount > 0`), tell the
  user and stop — don't paper over it.
- **One root cause per iteration.** When a report has 5 errors, fix
  the first stack trace, re-run, and re-diagnose. Don't batch fixes.
- **Stop after 5 unsuccessful iterations.** Surface the latest report
  and ask the user for direction.
- **Diff `runId`s when in doubt.** Same sources + same harness should
  produce identical `lifecycle.events.length`, `performance.renderCount`,
  and `webApi.totalCalls`. Drift on any of those is a regression.

---

## Common failure → remediation mapping

| `harness.consoleErrors` / `pageErrors` excerpt | Most likely cause | First fix to try |
| --- | --- | --- |
| `Hooks can only be called inside the body of a function component` | Two React copies. | Ensure manifest declares `<platform-library name="React" version="..."/>` and webpack externals are set. |
| `Cannot read properties of undefined (reading 'gap'\|'tokens'\|'shorthands')` | Mixed Fluent v8 / v9 usage. | Audit imports — `@fluentui/react-components` is v9, `@fluentui/react` is v8. Don't mix in one component. |
| `Invariant failed: A state mutation was detected` | Mutated PCF context inputs. | Treat `context.parameters.*` as read-only. |
| Pure timeout on `__pcfwbHarnessReady` with `lifecycle.events = []` | `init` itself threw or never registered. | Wrap `init` body in try/catch and log to confirm; check default export shape. |
| `lifecycle.events = [{ method: 'init' }]` only | Control rendered nothing in first `updateView`. | Confirm the component actually returns markup; check `container` is used. |
| `harness.report.leaks` populated | Listeners / timers leaked. | Stash subscriptions on `this.*`; clean up in `destroy()`. |

---

## Things to tell the user proactively

- The first run with `--skip-build` is the fastest signal — ~3s end-to-end.
- The first run *with* a build is dominated by `npm run build` (5–15s
  for typical controls).
- `screenshot.png` is full-page 1920×1080. Useful for layout debugging
  but **don't** trust it on a `fail` report — the screenshot may be
  pre-mount.
- Reports are deterministic-ish: control timestamps and the random
  `runId` suffix change, but counts, durations within 5%, and event
  shapes should match across runs. If they don't, that's a finding.

---

## When NOT to use this skill

- The user is asking about model-driven app design (forms / views) —
  use the `form-view-designer` skill.
- The user wants offline / mobile profile analysis — use the
  `field-service-mobile` skill.
- The user has a Dataverse-side issue (security roles, plugins, flows)
  — use the `modeldriven-apps` skill.

This skill is strictly for PCF controls being iterated against the
local workbench.
