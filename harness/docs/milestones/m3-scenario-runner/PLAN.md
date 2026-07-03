# M3 — Scenario Runner + Playwright — Plan

> Companion to `DESIGN.md`. Each phase has a Playwright acceptance gate; a phase isn't done until it's green. Resume by reading this file + the latest checkpoint.

**Status:** ✅ closed (shipped) — milestone accepted and closed on 2026-07-01.

---

## Phase map

| Phase | Title | Size | Outputs | Gate |
|---|---|---|---|---|
| **P0** | Refactor: extract `render-once.ts` from `runLoop` | S | shared single-render entrypoint | `loop` still green for ConformanceTester |
| **P1** | `batch` subcommand: iterate scenarios | M | per-scenario `report.json` + screenshot under `pcf-loop-reports/<scenario>/` | batch run produces N reports for N scenarios |
| **P2** | Pixel-diff (visual regression) | M | `--update-baselines`, `diff.png`, threshold | mutate a scenario → batch exits non-zero with diff |
| **P3** | Perf regression vs baseline JSON | S | `perf-diff.json`, `--perf-tolerance` | slow a render → batch exits non-zero with perf-diff |
| **P4** | Aggregated `batch-report.json` + `batch-summary.md` | S | Markdown ready for PR comment | report file shape locked + snapshot-tested |
| **P5** | Reusable GitHub Action (`jaduplesms/pcf-batch-action@v1`) | M | New tiny repo + `pcf-batch.yml` sample | self-test workflow runs on this repo's PRs |
| **P6** | Docs + showcase + README + skill update | S | shipped writing | README leads with `batch`, showcase card updated, skill mentions `batch` |

**Total:** 7 phases. P0–P4 land in `harness/`. P5 needs a new tiny repo (action wrapper). P6 is the close.

### Closeout snapshot

- ✅ `pcfworkbench batch` shipped (single-control, scenario iteration, per-scenario artifacts)
- ✅ Visual regression shipped (`--update-baselines`, `--diff-threshold`, `diff.png` emission)
- ✅ Aggregated outputs shipped (`batch-report.json`, `batch-summary.md`)
- ✅ Batch command documented in CLI help and milestone docs
- 📌 Remaining stretch ideas (render-once refactor, reusable action hardening) are tracked as follow-on roadmap work, not blockers for M3 closeout

---

## Resume rules (when picking up mid-milestone)

1. Read this file + `DESIGN.md`.
2. `sql SELECT * FROM todos WHERE id LIKE 'm3-%'` to see live status.
3. Latest green Playwright baseline lives at `harness/__visual__/conformance-m3-p<N>.json`.
4. Only mark a phase `done` once its acceptance gate is green.

---

## Phase detail

### P0 — Refactor `runLoop` → `render-once`
- Extract render+report-emit core out of `runLoop()` into `src/cli/render-once.ts`: input `{ controlPath, scenario?, timeoutMs, browser }`, output `{ report, screenshotBuffer, errors }`.
- `runLoop` becomes a thin wrapper that boots vite, calls `renderOnce` once, writes the report.
- No CLI change. No new tests yet — relies on existing Playwright loop test for regression.
- Gate: `pcfworkbench loop` against ConformanceTester still produces an identical report (snapshot the current report.json *before* refactor as the baseline).

### P1 — `batch` subcommand
- Add `batch [path]` to `bin/pcfworkbench.ts` (positional + auto-detect; reject workspace targets).
- New `src/cli/batch-runner.ts`: boot vite once, instantiate one Playwright browser, iterate scenarios via `renderOnce`, write per-scenario dirs.
- Filter: `--scenarios a,b,c` flag; skip scenarios with `"skipInBatch": true`.
- Unit tests for batch-runner: mock `renderOnce`, assert iteration + skip semantics + output paths.
- Gate: run against ConformanceTester (which has multi-scenario coverage from M2) → N reports written.

### P2 — Pixel-diff
- New `src/cli/pixel-diff.ts`: pure `diffPng(a: Buffer, b: Buffer, threshold: number) → { diffPct, diffBuffer }` using `pixelmatch` + `pngjs`.
- Unit tests with tiny committed fixture PNGs (`__fixtures__/red.png`, `red-with-pixel.png`).
- Wire into batch-runner: if `baseline/<scenario>.png` exists → diff, else → first run hint.
- `--update-baselines` writes current run as baseline (no diff).
- `--diff-threshold` configurable per run.
- Gate: mutate one scenario property → batch exits non-zero with `diff.png`.

### P3 — Perf regression
- New `src/cli/perf-diff.ts`: compare per-scenario perf metrics against `perf-baseline.json`. Reuse `actualForMetric` from `pcfworkbench.ts`.
- `--perf-tolerance <pct>` flag (default 25).
- Per-scenario override via `scenario.perfBudget`.
- Unit tests for the comparator.
- Gate: inject artificial delay → perf-diff entry; exit code reflects regression.

### P4 — Aggregated report
- New `src/cli/batch-report.ts`: rollup per-scenario results into `batch-report.json` + `batch-summary.md`.
- Markdown format: one-line status, then table of regressions only (none if all green).
- Snapshot test of summary.md against a known input.
- Gate: report shape stable across runs (sort scenarios alphabetically).

### P5 — Reusable GitHub Action
- New repo `jaduplesms/pcf-batch-action` (action.yml + composite shell steps).
- Inputs: `control-dir`, `baseline-source` (main|none|commit:sha), `comment-on-pr`, `fail-on`.
- Composite: checkout baseline source → copy PNGs → `npx @pcfworkbench/cli batch` → upload artifact → post/edit PR comment.
- Self-test in this repo: `.github/workflows/m3-batch-selftest.yml` runs the action against ConformanceTester on every PR.
- Gate: PR self-test posts a comment on a throwaway PR.

### P6 — Docs + skill + showcase
- README: new "Batch + visual regression" section, leads with `pcfworkbench batch`.
- `harness/docs/examples/pcf-batch.yml`: full workflow example.
- showcase.html: M3 card flipped from "Roadmap" → "Shipped".
- `~/.copilot/skills/pcf-workbench/SKILL.md`: add `batch` to Launch Modes.
- Plan.md updated with shipped status, version bump to `1.2.0`, npm publish.

---

## Tracking — see `todos` table

Filter with `SELECT id, status, title FROM todos WHERE id LIKE 'm3-%' ORDER BY id`.
