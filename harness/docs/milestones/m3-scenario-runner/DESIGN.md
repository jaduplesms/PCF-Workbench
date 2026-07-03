# M3 — Scenario Runner + Playwright — Design

> **Status:** Closed / shipped scope · **Author:** AI-coauthored (Copilot + jaduples) · **Last updated:** 2026-07-01

Promote `pcfworkbench loop` from a **single-render headless gate** into a **batch runner** that exercises every saved scenario for a control with visual + perf regression detection, producing a single aggregated report that CI can post back to a PR. Reuses M2's scenario store, M11's Vitest infra, and M12's CLI shell — no new framework choices.

---

## 1. Purpose & non-goals

**Purpose**
- Make scenario coverage cheap: once a user authors scenarios in the harness (M2), running them all in CI is one command.
- Catch visual regressions (pixel-diff) and perf regressions (per-scenario budget) automatically; surface them in PRs.
- Stay framework-consistent: Playwright (already in `harness/tests/`), pixelmatch (already a Playwright transitive), `pcf-loop.yml` evolution (not replacement).

**Non-goals**
- A scenario authoring UI overhaul — M2 already owns scenario CRUD.
- Cross-browser matrix — Chromium only, mirroring M12's choice. Firefox / WebKit deferred to M8.
- Coverage of *user PCF source code* (line/branch) — that's the user's own Jest/Vitest setup, not the harness's job.
- Replacing `loop` — `loop` stays as the single-scenario fast gate; `batch` is the additive new command.
- Recording / authoring scenarios from a CI run — recording stays in the interactive harness (M8 candidate).

---

## 2. Locked decisions (signed off 2026-06-23)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | **Baseline storage** | `baseline/<scenario>.png` committed to user's PCF repo, opt-in via `--update-baselines` | Diffable in PRs, no extra infra; opt-in keeps repo clean if you don't want it |
| 2 | **Pixel-diff lib** | `pixelmatch` (+ `pngjs`) | Zero native deps → no libsecret-style Linux CI surprise; tiny; same lib Playwright uses internally |
| 3 | **Scenario inclusion** | All scenarios in `test-scenarios.json` by default; opt-out via `"skipInBatch": true` on the scenario | Discoverability wins; per-scenario opt-out for slow/external-call ones |
| 4 | **PR comment format** | Only regressions / failures + one-line green status (`✅ all 12 scenarios passed`) | Signal-to-noise; full table available in the uploaded artifact for those who want detail |
| 5 | **Phase order** | P1 → P6 sequential (no parallelism) | Each phase Playwright-gated; simpler resume on partial completion |

---

## 3. Architecture

### 3.1 New CLI surface

```
pcfworkbench batch [path]
  [--out <dir>]                  default: ./pcf-loop-reports
  [--scenarios <a,b,c>]          filter to a subset; default = all (minus skipInBatch)
  [--baseline <dir>]             default: <controlDir>/baseline
  [--update-baselines]           write/overwrite baseline pngs instead of diffing
  [--diff-threshold <0..1>]      pixelmatch tolerance per scenario; default 0.005 (0.5%)
  [--perf-baseline <file>]       JSON of per-scenario perf baselines; default <controlDir>/perf-baseline.json
  [--perf-tolerance <pct>]       allow renders to be this much slower; default 25
  [--fail-on regression|any]     gate: regression = pixel/perf diff exceeds threshold; any = + render errors; default regression
  [--skip-build]                 reuse existing out/<...>/bundle.js
  [--timeout <ms>]               per-scenario; default 180000
  [--headed]                     debug only
```

`start` and `loop` are unchanged. `batch` is additive.

### 3.2 New code

| Module | Responsibility | Notes |
|---|---|---|
| `bin/pcfworkbench.ts` | `batch` subcommand | Same positional `[path]` + auto-detect from M12 (issue #36). Rejects workspace targets; batch is single-control. |
| `src/cli/batch-runner.ts` | Orchestrator: build → start vite once → iterate scenarios | Reuses `runLoop()`'s internals (extract to `src/cli/render-once.ts`). |
| `src/cli/render-once.ts` | Single scenario → `{ report, screenshotPath }` | Refactor of current `runLoop` body so both `loop` and `batch` use it. |
| `src/cli/pixel-diff.ts` | pixelmatch wrapper: `{ diffPct, diffPngBuffer }` | Pure; deterministic; unit-testable. |
| `src/cli/perf-diff.ts` | Compare scenario perf against baseline JSON | Pure; reuses `actualForMetric` from existing budget code. |
| `src/cli/batch-report.ts` | Aggregate per-scenario results → `batch-report.json` + Markdown summary | Markdown is the PR-comment payload. |
| `src/cli/batch-runner.test.ts` | Unit tests of the orchestrator (mocked render) | Lives in same dir; keytar-free per the M11+ lesson. |
| `src/cli/pixel-diff.test.ts` | Locked-input PNG fixtures | Tiny PNGs committed in `__fixtures__/`. |

### 3.3 New artifact layout (per `batch` run)

```
pcf-loop-reports/
├── batch-report.json           # aggregated: scenario list + pass/fail + diffs
├── batch-summary.md            # PR-comment-ready Markdown
├── <scenario>/                 # per-scenario dir
│   ├── report.json             # same shape as today's loop report
│   ├── screenshot.png          # current run
│   ├── diff.png                # only if pixel-diff exceeded threshold
│   └── perf-diff.json          # only if perf regressed
```

### 3.4 Reusable GitHub Action (P5)

Published as **`jaduplesms/pcf-batch-action@v1`** (separate small repo, fetched via `uses:`). Wraps:
```yaml
uses: jaduplesms/pcf-batch-action@v1
with:
  control-dir: ./MyControl
  baseline-source: 'main'        # 'main' | 'none' | 'commit:<sha>'
  comment-on-pr: true
  fail-on: regression
```
Internally: checkout main into a tmp dir, copy baseline pngs into the control's `baseline/`, run `pcfworkbench batch`, upload artifact, post comment. Logic stays in the action; `batch` itself is dumb-and-deterministic.

---

## 4. Scenario format change (additive, back-compat)

```jsonc
{
  "name": "Empty state",
  "properties": { /* unchanged */ },
  // ⇩ new optional fields, all default false / undefined
  "skipInBatch": false,           // opt out of batch runs
  "perfBudget": {                 // overrides --perf-baseline for this scenario
    "firstUpdateViewMs": { "warn": 200, "fail": 500 }
  }
}
```

No migration needed; existing scenarios just run.

---

## 5. Acceptance criteria (the M3 gate)

A PR can be merged to ship M3 when **all** of these are true:

- [ ] `pcfworkbench batch ./samples/ConformanceTester/ConformanceTester` runs every scenario, exits 0 on clean main, produces `batch-report.json` + `batch-summary.md`.
- [ ] Deliberately mutating one scenario property (changing a default value) → `batch` exits non-zero with a pixel diff > threshold; `diff.png` written.
- [ ] Deliberately slowing a render (artificial delay in shim) → `batch` exits non-zero with perf-diff entry.
- [ ] `pcfworkbench loop` still works unchanged (no behaviour regression).
- [ ] `pcf-batch-action@v1` reusable workflow runs end-to-end against ConformanceTester in `.github/workflows/m3-batch-selftest.yml`, posts a comment on a test PR.
- [ ] Unit tests: pixel-diff + perf-diff + batch-runner orchestrator all covered, suite still 0 fail on Windows + Linux.
- [ ] README + showcase updated; new `harness/docs/examples/pcf-batch.yml` shipped.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pixel-diff false positives from font / subpixel rendering across OSes | Force `font-family: 'Segoe UI'` in harness Playwright setup (we already do for loop). Mention in baseline docs: "regenerate `baseline/` from CI's Linux runner, not local Windows". |
| Repo bloat from committed baseline PNGs | Document `git lfs` opt-in; PNGs at 1920×1080 are typically 50–150 KB each, ~50 scenarios = ~5 MB worst case → tolerable. |
| Slow CI for projects with many scenarios | Vite stays warm across scenarios (one boot per batch); aim for ~5s per scenario after first. |
| PR comment spam on every push | Action posts ONE comment per PR and edits in place via GH comment-id reuse pattern. |
| User confusion: when to use `loop` vs `batch` | Doc one-liner: "`loop` = one scenario, fast gate. `batch` = all scenarios + visual + perf regression." |

---

## 7. Out of scope (revisit in later milestones)

- **Cross-browser matrix** — Firefox/WebKit. M8 candidate.
- **Recording mode** — generate scenarios by capturing user interactions. M8 candidate.
- **Side-by-side version diff** (`baseline-source: 'commit:<sha>'` of a *different* control build). M8 candidate.
- **Coverage tab in the harness UI showing which manifest properties each scenario touches.** Could be a small M4 follow-up.
