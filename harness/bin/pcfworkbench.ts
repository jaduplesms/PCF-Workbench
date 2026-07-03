#!/usr/bin/env node

// CLI entry point for PCF Workbench.
//
// Two modes:
//   pcfworkbench start --path <dir>      Launch the interactive harness UI.
//   pcfworkbench loop  --path <dir> ...  Run one build→render→report cycle
//                                        headlessly and write a JSON report.
//
// In both modes the control must have been built (`npm run build` in the PCF
// project) so that out/controls/{Name}/bundle.js exists.

import { Command } from 'commander';
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { explainError } from '../src/loader/error-diagnostics';
import { pcfPlugin } from '../src/vite-plugin/pcf-plugin';
import { dataverseSecurity } from '../src/vite-plugin/dataverse-security';
import { dataverseProxy } from '../src/vite-plugin/dataverse-proxy';
import { fluentCdnPlugin } from '../src/vite-plugin/fluent-cdn';
import { resolvePcfTarget, ResolveTargetError } from '../src/cli/resolve-target';
import { assertDiffThreshold, diffPngBuffers } from '../src/cli/pixel-diff';
import {
  buildBatchReport,
  toBatchSummaryMarkdown,
  type BatchScenarioResult,
} from '../src/cli/batch-report';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(__dirname, '..');

/**
 * Vite plugins we always run. Bundled into this CLI by esbuild at publish
 * time so the user's npm install doesn't have to resolve the harness
 * plugins separately. The dev-mode `vite.config.ts` declares the same set;
 * we duplicate inline to keep the CLI self-contained.
 */
function harnessPlugins(): Plugin[] {
  return [
    react(),
    // Security gate must run before the proxy so /__pcf/dv/* requests are
    // checked before they reach the token-acquiring code.
    dataverseSecurity(),
    dataverseProxy(),
    // Fluent UMD on-demand bundler — serves real Fluent v8/v9 to deployed
    // controls whose manifests declare a Fluent platform-library.
    fluentCdnPlugin(),
    pcfPlugin(),
  ] as Plugin[];
}

/** Read the package version dynamically so a single-source-of-truth bump in
 *  package.json flows into `pcfworkbench --version` automatically. */
function readVersion(): string {
  try {
    const pkgPath = path.join(harnessRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('pcfworkbench')
  .description('PCF Workbench — local dev harness + AI build loop for Power Apps Component Framework controls')
  .version(readVersion());

/* ---------------------------------------------------------------- */
/* `start` — launch the interactive harness in your browser.        */
/* ---------------------------------------------------------------- */
program
  .command('start', { isDefault: true })
  .description('Launch the interactive harness UI in your browser.')
  .argument(
    '[path]',
    'Path to a PCF control directory OR a workspace of controls. Auto-detected. Defaults to the current directory.',
  )
  .option('--path <dir>', '(Legacy) Path to a single PCF control directory. Prefer the positional [path] argument.')
  .option('--workspace <dir>', '(Legacy) Path to a directory of controls — gallery mode. Prefer the positional [path] argument.')
  .option('--port <number>', 'Port to bind the dev server to', '8181')
  .option('--host <name>', 'Host to bind to', '127.0.0.1')
  .option('--no-open', 'Do not open the browser automatically')
  .option('--no-watch', 'Do not auto-spawn the build watcher (M9)')
  .action(async (positional: string | undefined, opts) => {
    const hasPath = typeof opts.path === 'string' && opts.path.length > 0;
    const hasWorkspace = typeof opts.workspace === 'string' && opts.workspace.length > 0;
    const hasPositional = typeof positional === 'string' && positional.length > 0;

    // Mutual exclusion guards.
    if (hasPath && hasWorkspace) {
      console.error('Error: --path and --workspace are mutually exclusive.');
      process.exit(2);
    }
    if (hasPositional && (hasPath || hasWorkspace)) {
      console.error('Error: positional [path] cannot be combined with --path or --workspace.');
      process.exit(2);
    }

    // Legacy flags first (back-compat — no auto-detect, behaves exactly as before).
    if (hasPath) {
      const controlPath = path.resolve(opts.path);
      assertControlDir(controlPath);
      process.env.PCF_CONTROL_PATH = controlPath;
      console.log(`\n  PCF Workbench`);
      console.log(`  Control: ${controlPath}`);
    } else if (hasWorkspace) {
      const workspaceRoot = path.resolve(opts.workspace);
      if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
        console.error(`Error: workspace not found or not a directory: ${workspaceRoot}`);
        process.exit(2);
      }
      process.env.PCF_WORKSPACE_ROOT = workspaceRoot;
      console.log(`\n  PCF Workbench`);
      console.log(`  Workspace: ${workspaceRoot} (gallery mode)`);
    } else {
      // New default UX (issue #36): positional or cwd → auto-detect.
      const input = hasPositional ? positional! : process.cwd();
      try {
        const target = resolvePcfTarget(input);
        if (target.kind === 'control') {
          process.env.PCF_CONTROL_PATH = target.path;
          console.log(`\n  PCF Workbench`);
          console.log(`  Control: ${target.path}  (auto-detected)`);
        } else {
          process.env.PCF_WORKSPACE_ROOT = target.path;
          console.log(`\n  PCF Workbench`);
          console.log(
            `  Workspace: ${target.path}  (auto-detected, ${target.controls.length} control${target.controls.length === 1 ? '' : 's'}: ${target.controls.join(', ')})`,
          );
        }
      } catch (e: any) {
        if (e instanceof ResolveTargetError) {
          console.error(`\n  Error: ${e.message}\n`);
          console.error(`  Tip: cd into a PCF control directory and re-run, or pass a path explicitly:`);
          console.error(`       pcfworkbench start ./MyControl\n`);
          process.exit(1);
        }
        throw e;
      }
    }

    if (opts.watch === false) process.env.PCF_NO_WATCH = '1';

    const port = parseInt(opts.port, 10);
    const host = opts.host;
    console.log(`  Port:    ${port}`);
    console.log(`  Host:    ${host}\n`);

    try {
      const server = await createServer({
        root: harnessRoot,
        configFile: false,
        plugins: harnessPlugins(),
        server: {
          port,
          host,
          open: opts.open !== false,
        },
      });

      await server.listen();
      server.printUrls();
      console.log('\n  Press Ctrl+C to stop.\n');
    } catch (err: any) {
      console.error('Failed to start harness:', err.message);
      process.exit(1);
    }
  });

/* ---------------------------------------------------------------- */
/* `loop` subcommand — one headless build→render→report cycle.       */
/* ---------------------------------------------------------------- */
program
  .command('loop')
  .description('Run one build→render→report cycle and emit a JSON report.')
  .argument('[path]', 'Path to the PCF control directory. Defaults to the current directory.')
  .option('--path <dir>', '(Legacy) Path to the PCF control directory. Prefer the positional [path] argument.')
  .option('--out <dir>', 'Directory to write report.json + screenshot.png', './pcf-loop-reports')
  .option('--skip-build', 'Skip the npm run build step (use existing out/ bundle)', false)
  .option('--timeout <ms>', 'Max ms to wait for the control to render. Default 180000ms (3 min) — the first run on a fresh install downloads Fluent UI (~60–80s) on top of normal render time; subsequent runs are fast (~5–15s).', '180000')
  .option('--headed', 'Run Playwright in headed mode for debugging', false)
  .option('--scenario <name>', 'Load this saved test scenario before rendering (must exist in test-scenarios.json). Default: render with manifest defaults.')
  .action(async (positional: string | undefined, opts) => {
    const hasPath = typeof opts.path === 'string' && opts.path.length > 0;
    const hasPositional = typeof positional === 'string' && positional.length > 0;

    if (hasPositional && hasPath) {
      console.error('Error: positional [path] cannot be combined with --path.');
      process.exit(2);
    }

    let controlPath: string;
    if (hasPath) {
      controlPath = path.resolve(opts.path);
      assertControlDir(controlPath);
    } else {
      const input = hasPositional ? positional! : process.cwd();
      try {
        const target = resolvePcfTarget(input);
        if (target.kind !== 'control') {
          console.error(
            `\n  Error: ${target.path} looks like a workspace (${target.controls.length} controls). ` +
              `'loop' targets a single control — pass the control directory explicitly:\n` +
              `       pcfworkbench loop ./${target.controls[0] ?? 'MyControl'}\n`,
          );
          process.exit(2);
        }
        controlPath = target.path;
        if (hasPositional || input !== process.cwd()) {
          console.log(`[pcfworkbench loop] control: ${controlPath}`);
        } else {
          console.log(`[pcfworkbench loop] control: ${controlPath}  (auto-detected from cwd)`);
        }
      } catch (e: any) {
        if (e instanceof ResolveTargetError) {
          console.error(`\n  Error: ${e.message}\n`);
          console.error(`  Tip: cd into a PCF control directory and re-run, or pass a path explicitly:`);
          console.error(`       pcfworkbench loop ./MyControl\n`);
          process.exit(1);
        }
        throw e;
      }
    }
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });

    const exitCode = await runLoop({
      controlPath,
      outDir,
      skipBuild: !!opts.skipBuild,
      timeoutMs: parseInt(opts.timeout, 10),
      headed: !!opts.headed,
      scenario: opts.scenario,
    });
    process.exit(exitCode);
  });

/* ---------------------------------------------------------------- */
/* `batch` subcommand — run loop across all saved scenarios + diff. */
/* ---------------------------------------------------------------- */
program
  .command('batch')
  .description('Run loop across saved scenarios and detect visual regressions.')
  .argument('[path]', 'Path to the PCF control directory. Defaults to the current directory.')
  .option('--path <dir>', '(Legacy) Path to the PCF control directory. Prefer the positional [path] argument.')
  .option('--out <dir>', 'Directory to write batch-report.json + per-scenario artifacts', './pcf-loop-reports')
  .option('--baseline <dir>', 'Directory containing per-scenario baseline PNGs. Defaults to <controlDir>/baseline')
  .option('--scenarios <list>', 'Comma-separated scenario names to run. Default: all discovered scenarios')
  .option('--skip-build', 'Skip npm run build for all runs (reuse existing out/ bundle)', false)
  .option('--timeout <ms>', 'Max ms per scenario render. Default 180000', '180000')
  .option('--headed', 'Run Playwright in headed mode for debugging', false)
  .option('--update-baselines', 'Write/overwrite baseline PNGs instead of diffing', false)
  .option('--diff-threshold <0..1>', 'Pixel-diff ratio threshold. Default 0.005 (0.5%)', '0.005')
  .action(async (positional: string | undefined, opts) => {
    const hasPath = typeof opts.path === 'string' && opts.path.length > 0;
    const hasPositional = typeof positional === 'string' && positional.length > 0;
    if (hasPositional && hasPath) {
      console.error('Error: positional [path] cannot be combined with --path.');
      process.exit(2);
    }

    const controlPath = resolveLoopControlPath(hasPath ? opts.path : (hasPositional ? positional : undefined));
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });

    const diffThreshold = Number(opts.diffThreshold);
    try {
      assertDiffThreshold(diffThreshold);
    } catch (error: any) {
      console.error(`Error: ${error?.message ?? String(error)}`);
      process.exit(2);
    }

    const baselineDir = opts.baseline
      ? path.resolve(opts.baseline)
      : path.join(controlPath, 'baseline');
    fs.mkdirSync(baselineDir, { recursive: true });

    const selectedScenarios = parseScenarioFilter(opts.scenarios);
    const scenarioNames = loadScenarioNamesForBatch(controlPath, findProjectRoot(controlPath), selectedScenarios);
    const runs = scenarioNames.length > 0 ? scenarioNames : [null];

    console.log(`\n  pcfworkbench batch`);
    console.log(`  Control:   ${controlPath}`);
    console.log(`  Out:       ${outDir}`);
    console.log(`  Baseline:  ${baselineDir}`);
    console.log(`  Scenarios: ${runs.length}${scenarioNames.length === 0 ? ' (default no-scenario render)' : ''}\n`);

    const scenarioResults: BatchScenarioResult[] = [];
    const usedSlugs = new Map<string, number>();
    for (let i = 0; i < runs.length; i++) {
      const scenarioName = runs[i];
      const scenarioLabel = scenarioName ?? 'default';
      const baseSlug = slugifyFileName(scenarioLabel);
      const seen = usedSlugs.get(baseSlug) ?? 0;
      usedSlugs.set(baseSlug, seen + 1);
      const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;
      const scenarioOutDir = path.join(outDir, slug);
      fs.mkdirSync(scenarioOutDir, { recursive: true });

      const exitCode = await runLoop({
        controlPath,
        outDir: scenarioOutDir,
        skipBuild: !!opts.skipBuild || i > 0,
        timeoutMs: parseInt(opts.timeout, 10),
        headed: !!opts.headed,
        scenario: scenarioName ?? undefined,
      });

      const reportPath = path.join(scenarioOutDir, 'report.json');
      const screenshotPath = path.join(scenarioOutDir, 'screenshot.png');
      const report = safeReadJson(reportPath);
      const runtimeStatus = (report?.summary?.status === 'pass' || report?.summary?.status === 'warn' || report?.summary?.status === 'fail')
        ? report.summary.status as 'pass' | 'warn' | 'fail'
        : exitCode === 0 ? 'pass' : 'fail';
      const headline = typeof report?.summary?.headline === 'string'
        ? report.summary.headline
        : 'loop run completed';

      const baselinePath = path.join(baselineDir, `${slug}.png`);
      let compared = false;
      let updatedBaseline = false;
      let diffRatio: number | null = null;
      let diffPath: string | null = null;
      let regression = false;
      let visualError: string | null = null;

      if (fs.existsSync(screenshotPath)) {
        if (opts.updateBaselines) {
          fs.copyFileSync(screenshotPath, baselinePath);
          updatedBaseline = true;
        } else if (fs.existsSync(baselinePath)) {
          compared = true;
          try {
            const diff = diffPngBuffers(
              fs.readFileSync(baselinePath),
              fs.readFileSync(screenshotPath),
            );
            diffRatio = diff.diffRatio;
            if (diff.diffRatio > diffThreshold) {
              regression = true;
              diffPath = path.join(scenarioOutDir, 'diff.png');
              fs.writeFileSync(diffPath, diff.diffPng);
            }
          } catch (error: any) {
            visualError = error?.message ?? String(error);
            regression = true;
          }
        } else {
          visualError = `baseline missing: ${baselinePath}`;
        }
      } else {
        visualError = `screenshot missing: ${screenshotPath}`;
        regression = true;
      }

      scenarioResults.push({
        scenario: scenarioLabel,
        outputDir: scenarioOutDir,
        reportPath,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
        status: runtimeStatus,
        headline,
        visual: {
          baselinePath: fs.existsSync(baselinePath) ? baselinePath : null,
          compared,
          updatedBaseline,
          diffRatio,
          threshold: compared ? diffThreshold : null,
          diffPath,
          regression,
          error: visualError,
        },
      });
    }

    const batchReport = buildBatchReport({
      controlPath,
      outDir,
      baselineDir,
      thresholds: { diffThreshold },
      scenarios: scenarioResults,
    });
    fs.writeFileSync(path.join(outDir, 'batch-report.json'), JSON.stringify(batchReport, null, 2));
    fs.writeFileSync(path.join(outDir, 'batch-summary.md'), toBatchSummaryMarkdown(batchReport));

    const failed = batchReport.summary.failed > 0;
    console.log(`  [summary] ${failed ? 'FAIL' : 'PASS'} — ${batchReport.summary.passed}/${batchReport.summary.total} passed, ${batchReport.summary.visualRegressions} visual regression(s)`);
    console.log(`  [report]  ${path.join(outDir, 'batch-report.json')}`);
    console.log(`  [summary] ${path.join(outDir, 'batch-summary.md')}\n`);

    process.exit(failed ? 1 : 0);
  });

program.parse();

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */

/* ---- Perf budgets (M3.P2.C) ------------------------------------ */

/** Supported metrics for perfBudget. Keep in sync with schema + docs. */
const BUDGET_METRICS = [
  'firstUpdateViewMs',
  'avgRenderTimeMs',
  'lastRenderTimeMs',
  'renderCount',
  'leaks',
  'unimplementedCount',
] as const;
type BudgetMetric = (typeof BUDGET_METRICS)[number];

/** Per-metric budget. A bare number is a hard `fail` limit; an object lets
 * the user supply soft + hard thresholds independently. */
type BudgetLimit = number | { warn?: number; fail?: number };
type PerfBudget = Partial<Record<BudgetMetric, BudgetLimit>>;

interface BudgetViolation {
  metric: BudgetMetric;
  actual: number;
  budget: number;
  delta: number;
  severity: 'warn' | 'fail';
}

interface BudgetReport {
  status: 'pass' | 'warn' | 'fail';
  source: string | null;
  budget: PerfBudget;
  violations: BudgetViolation[];
}

/** Walks the same order the Vite plugin uses (control dir, then project
 * root) and returns the first `data.json` it finds. */
function locateDataJson(controlPath: string, projectRoot: string): string | null {
  for (const candidate of [
    path.join(controlPath, 'data.json'),
    path.join(projectRoot, 'data.json'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadPerfBudget(controlPath: string, projectRoot: string):
  { budget: PerfBudget; source: string | null } {
  const file = locateDataJson(controlPath, projectRoot);
  if (!file) return { budget: {}, source: null };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const json = JSON.parse(raw);
    const budget = json?.perfBudget ?? {};
    if (typeof budget !== 'object' || Array.isArray(budget)) return { budget: {}, source: file };
    return { budget, source: file };
  } catch {
    return { budget: {}, source: file };
  }
}

function actualForMetric(metric: BudgetMetric, harnessReport: any): number | null {
  if (!harnessReport) return null;
  switch (metric) {
    case 'firstUpdateViewMs':
      return harnessReport.lifecycle?.firstUpdateViewMs ?? null;
    case 'avgRenderTimeMs':
      return harnessReport.performance?.avgRenderTimeMs ?? null;
    case 'lastRenderTimeMs':
      return harnessReport.performance?.lastRenderTimeMs ?? null;
    case 'renderCount':
      return harnessReport.performance?.renderCount ?? null;
    case 'leaks':
      return Array.isArray(harnessReport.leaks) ? harnessReport.leaks.length : null;
    case 'unimplementedCount':
      return harnessReport.logs?.unimplementedCount ?? null;
  }
}

function normaliseLimit(limit: BudgetLimit): { warn?: number; fail?: number } {
  if (typeof limit === 'number') return { fail: limit };
  return {
    warn: typeof limit?.warn === 'number' ? limit.warn : undefined,
    fail: typeof limit?.fail === 'number' ? limit.fail : undefined,
  };
}

function evaluateBudget(harnessReport: any, budget: PerfBudget, source: string | null): BudgetReport {
  const violations: BudgetViolation[] = [];
  for (const metric of BUDGET_METRICS) {
    if (!(metric in budget)) continue;
    const raw = budget[metric];
    if (raw === undefined || raw === null) continue;
    const { warn, fail } = normaliseLimit(raw as BudgetLimit);
    const actual = actualForMetric(metric, harnessReport);
    if (actual === null) continue;
    if (typeof fail === 'number' && actual > fail) {
      violations.push({ metric, actual, budget: fail, delta: actual - fail, severity: 'fail' });
    } else if (typeof warn === 'number' && actual > warn) {
      violations.push({ metric, actual, budget: warn, delta: actual - warn, severity: 'warn' });
    }
  }
  const status: 'pass' | 'warn' | 'fail' = violations.some(v => v.severity === 'fail')
    ? 'fail'
    : violations.some(v => v.severity === 'warn') ? 'warn' : 'pass';
  return { status, source, budget, violations };
}

/* ---------------------------------------------------------------- */

function resolveLoopControlPath(inputPath: string | undefined): string {
  if (typeof inputPath === 'string' && inputPath.length > 0) {
    const resolved = path.resolve(inputPath);
    assertControlDir(resolved);
    return resolved;
  }

  const input = process.cwd();
  try {
    const target = resolvePcfTarget(input);
    if (target.kind !== 'control') {
      console.error(
        `\n  Error: ${target.path} looks like a workspace (${target.controls.length} controls). ` +
          `'loop' and 'batch' target a single control — pass the control directory explicitly:\n` +
          `       pcfworkbench loop ./${target.controls[0] ?? 'MyControl'}\n`,
      );
      process.exit(2);
    }
    console.log(`[pcfworkbench] control: ${target.path}  (auto-detected from cwd)`);
    return target.path;
  } catch (e: any) {
    if (e instanceof ResolveTargetError) {
      console.error(`\n  Error: ${e.message}\n`);
      console.error(`  Tip: cd into a PCF control directory and re-run, or pass a path explicitly:`);
      console.error(`       pcfworkbench loop ./MyControl\n`);
      process.exit(1);
    }
    throw e;
  }
}

interface BatchScenarioConfig {
  name: string;
  skipInBatch: boolean;
}

function parseScenarioFilter(input: unknown): Set<string> | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const names = input
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

function loadScenarioNamesForBatch(
  controlPath: string,
  projectRoot: string,
  selected: Set<string> | null,
): string[] {
  const file = locateScenariosFile(controlPath, projectRoot);
  if (!file) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const scenarios = parseScenarios(raw);
    const filtered = scenarios
      .filter(s => !s.skipInBatch)
      .map(s => s.name)
      .filter(name => selected ? selected.has(name) : true);
    return [...new Set(filtered)];
  } catch (error: any) {
    console.warn(`[pcfworkbench batch] failed to read scenarios from ${file}: ${error?.message ?? String(error)}`);
    return [];
  }
}

function locateScenariosFile(controlPath: string, projectRoot: string): string | null {
  for (const candidate of [
    path.join(controlPath, 'test-scenarios.json'),
    path.join(projectRoot, 'test-scenarios.json'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseScenarios(raw: unknown): BatchScenarioConfig[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map(entry => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        skipInBatch: entry.skipInBatch === true,
      }))
      .filter(entry => entry.name.length > 0);
  }

  if (typeof raw === 'object' && raw !== null && Array.isArray((raw as any).scenarios)) {
    return parseScenarios((raw as any).scenarios);
  }

  return [];
}

function slugifyFileName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : 'scenario';
}

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function assertControlDir(controlPath: string): void {
  const inputManifest = path.join(controlPath, 'ControlManifest.Input.xml');
  const deployedManifest = path.join(controlPath, 'ControlManifest.xml');
  if (!fs.existsSync(inputManifest) && !fs.existsSync(deployedManifest)) {
    console.error(`\n  Error: ControlManifest not found at:\n  ${inputManifest}\n  ${deployedManifest}\n`);
    console.error(`  Make sure --path points to the directory containing ControlManifest.Input.xml (source) or ControlManifest.xml (deployed/extracted).\n`);
    process.exit(1);
  }
}

interface LoopOpts {
  controlPath: string;
  outDir: string;
  skipBuild: boolean;
  timeoutMs: number;
  headed: boolean;
  scenario?: string;
}

interface BuildResult {
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  errors: string[];
}

async function runLoop(opts: LoopOpts): Promise<number> {
  const t0 = Date.now();
  console.log(`\n  pcfworkbench loop`);
  console.log(`  Control: ${opts.controlPath}`);
  console.log(`  Out:     ${opts.outDir}\n`);

  /* --- 1. Build ------------------------------------------------- */
  let build: BuildResult;
  if (opts.skipBuild) {
    build = { ok: true, durationMs: 0, stdout: '', stderr: '', errors: [] };
    console.log('  [build] skipped (--skip-build)');
  } else {
    console.log('  [build] npm run build …');
    build = await runBuild(findProjectRoot(opts.controlPath));
    console.log(`  [build] ${build.ok ? 'ok' : 'FAIL'} (${build.durationMs} ms)`);
    if (!build.ok) {
      const report = emptyReport(opts, build, 'build_failed');
      writeReport(opts.outDir, report);
      console.error(`\n  Build failed. Report: ${path.join(opts.outDir, 'report.json')}\n`);
      return 1;
    }
  }

  /* --- 2. Free port + start Vite -------------------------------- */
  const port = await findFreePort(8181);
  process.env.PCF_CONTROL_PATH = opts.controlPath;
  console.log(`  [vite] starting on port ${port} …`);
  const server = await createServer({
    root: harnessRoot,
    configFile: false,
    plugins: harnessPlugins(),
    server: { port, host: '127.0.0.1', open: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = `http://127.0.0.1:${port}/?chrome=none${opts.scenario ? `&scenario=${encodeURIComponent(opts.scenario)}` : ''}`;
  if (opts.scenario) {
    console.log(`  [scenario] requesting "${opts.scenario}" via ?scenario= URL param`);
  }

  /* --- 3. Playwright drive -------------------------------------- */
  // Lazy-import to keep `pcfworkbench --path` startup fast.
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Suppress the first-load auto-generate scenarios dialog — its backdrop
  // intercepts clicks and the dialog confounds the headless loop. Setting the
  // global flag is sufficient for any control the harness loads.
  // Also block live Dataverse access (M2.P6 safety guardrail) — loop runs are
  // CI/AI bound and must never accidentally hit a real org even when a
  // scenario or persisted localStorage carries `dataSource: 'live'`.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pcf-workbench-suppress-autogen-all', '1');
    } catch { /* localStorage may be unavailable — silent */ }
    try {
      (window as unknown as { __PCF_WORKBENCH_BLOCK_LIVE__?: boolean }).__PCF_WORKBENCH_BLOCK_LIVE__ = true;
    } catch { /* ignore */ }
  });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const pageErrorStacks: (string | undefined)[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    pageErrorStacks.push(err.stack);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  let renderOk = false;
  let renderError: string | undefined;
  let harnessReport: any = null;

  try {
    // 'load' fires when the document and its initial resources are done. We
    // deliberately don't wait for 'networkidle' because Vite's HMR WebSocket
    // keeps an open connection forever, so the page is never network-idle in
    // dev. The real readiness signal is the test-bridge's __pcfwbHarnessReady
    // flag below.
    await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs });
    // Wait for control to render (test-bridge sets __pcfwbHarnessReady on first
    // successful updateView).
    await page.waitForFunction(() => (window as any).__pcfwbHarnessReady === true, undefined, {
      timeout: opts.timeoutMs,
    });
    renderOk = true;

    harnessReport = await page.evaluate(() => (window as any).__pcfwbHarnessReport?.() ?? null);
    await page.screenshot({
      path: path.join(opts.outDir, 'screenshot.png'),
      fullPage: true,
    });

    // Force a destroy so the resource tracker can diff listeners/timers/
    // observers. Re-read the report so `leaks` reflects post-destroy state.
    // Done after the screenshot — destroy unmounts the React tree.
    const destroyRan = await page.evaluate(
      () => (window as any).__pcfwbHarnessDestroy?.() ?? false,
    );
    if (destroyRan) {
      // Tiny pause to let the destroy lifecycle event propagate to the store.
      await page.waitForTimeout(50);
      harnessReport = await page.evaluate(
        () => (window as any).__pcfwbHarnessReport?.() ?? harnessReport,
      );
    }
  } catch (err: any) {
    renderError = err?.message ?? String(err);
    // Best-effort screenshot for diagnostics.
    try {
      await page.screenshot({
        path: path.join(opts.outDir, 'screenshot.png'),
        fullPage: true,
      });
    } catch { /* ignore */ }
    // Even on render failure, try to harvest leak info — the host may have
    // mounted before the crash.
    try {
      const destroyRan = await page.evaluate(
        () => (window as any).__pcfwbHarnessDestroy?.() ?? false,
      );
      if (destroyRan) {
        await page.waitForTimeout(50);
        harnessReport = await page.evaluate(
          () => (window as any).__pcfwbHarnessReport?.() ?? null,
        );
      }
    } catch { /* ignore */ }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  /* --- 4. Report ------------------------------------------------ */
  const totalMs = Date.now() - t0;
  const projectRoot = findProjectRoot(opts.controlPath);
  const { budget: budgetConfig, source: budgetSource } =
    loadPerfBudget(opts.controlPath, projectRoot);
  const budget = Object.keys(budgetConfig).length > 0
    ? evaluateBudget(harnessReport, budgetConfig, budgetSource)
    : null;

  const report = {
    schemaVersion: 1,
    runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: new Date().toISOString(),
    durationMs: totalMs,
    control: {
      path: opts.controlPath,
    },
    build: {
      ok: build.ok,
      skipped: opts.skipBuild,
      durationMs: build.durationMs,
      errors: build.errors,
    },
    harness: {
      url,
      ok: renderOk,
      error: renderError,
      consoleErrors,
      pageErrors,
      diagnostics: buildDiagnostics(consoleErrors, pageErrors, pageErrorStacks, renderError),
      report: harnessReport,
      screenshot: 'screenshot.png',
    },
    budget,
    summary: summarize({
      buildOk: build.ok,
      renderOk,
      consoleErrors,
      pageErrors,
      harnessReport,
      budget,
    }),
  };
  writeReport(opts.outDir, report);

  console.log(`\n  [summary] ${report.summary.status.toUpperCase()} — ${report.summary.headline}`);
  if (budget) {
    const summary = budget.violations.length === 0
      ? 'all metrics within budget'
      : `${budget.violations.length} violation(s): ${budget.violations.map(v => `${v.metric} ${v.severity}`).join(', ')}`;
    console.log(`  [budget]  ${budget.status.toUpperCase()} — ${summary}`);
  }
  const diags = report.harness.diagnostics as ErrorDiagnostic[] | undefined;
  if (diags && diags.length > 0) {
    for (const d of diags) {
      console.log(`  [explain] ${d.summary}`);
      console.log(`            cause: ${d.likelyCause}`);
      console.log(`            fix:   ${d.suggestedFix}`);
    }
  }
  console.log(`  [report]  ${path.join(opts.outDir, 'report.json')}\n`);

  return report.summary.status === 'pass' ? 0 : 1;
}

/* ---------------------------------------------------------------- */

function findProjectRoot(controlPath: string): string {
  // controlPath is typically <project>/<ControlName>; package.json lives in
  // the parent. Walk up until we find package.json.
  let dir = controlPath;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return controlPath; // fallback — caller will fail with a clear error
}

function runBuild(projectRoot: string): Promise<BuildResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'build'], {
      cwd: projectRoot,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const ok = code === 0;
      const errors: string[] = [];
      if (!ok) {
        // Extract TS / pcf-scripts error lines for the report.
        const combined = stdout + '\n' + stderr;
        const errLines = combined.split(/\r?\n/).filter(l =>
          /\berror\b/i.test(l) || /\bfailed\b/i.test(l) || /TS\d{4,}/.test(l));
        errors.push(...errLines.slice(0, 30));
      }
      resolve({ ok, durationMs: Date.now() - t0, stdout, stderr, errors });
    });
    child.on('error', (err) => {
      resolve({
        ok: false,
        durationMs: Date.now() - t0,
        stdout,
        stderr,
        errors: [err.message],
      });
    });
  });
}

function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (p: number) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : p;
        srv.close(() => resolve(port));
      });
      srv.listen(p, '127.0.0.1');
    };
    tryPort(preferred);
  });
}

function writeReport(outDir: string, report: any): void {
  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );
}

interface ErrorDiagnostic {
  source: 'pageError' | 'consoleError' | 'renderError';
  message: string;
  ruleId: string;
  summary: string;
  likelyCause: string;
  suggestedFix: string;
  severity: 'fatal' | 'warning' | 'info';
}

function buildDiagnostics(
  consoleErrors: string[],
  pageErrors: string[],
  pageErrorStacks: (string | undefined)[],
  renderError: string | undefined,
): ErrorDiagnostic[] {
  const out: ErrorDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (source: ErrorDiagnostic['source'], msg: string, stack?: string) => {
    const exp = explainError(msg, stack);
    if (!exp) return;
    const key = `${source}:${exp.ruleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, message: msg, ...exp });
  };
  for (let i = 0; i < pageErrors.length; i++) push('pageError', pageErrors[i], pageErrorStacks[i]);
  // Console error text from page.on('console') often includes the stack already
  // (Chrome formats `TypeError: foo\n    at bar (file:1:2)\n    ...` as one string),
  // so passing the message as both arg gives stack-aware rules a chance to match.
  for (const m of consoleErrors) push('consoleError', m, m);
  if (renderError) push('renderError', renderError);
  return out;
}

function emptyReport(opts: LoopOpts, build: BuildResult, reason: string) {
  return {
    schemaVersion: 1,
    runId: `${Date.now().toString(36)}-fail`,
    capturedAt: new Date().toISOString(),
    durationMs: build.durationMs,
    control: { path: opts.controlPath },
    build: { ok: build.ok, skipped: opts.skipBuild, durationMs: build.durationMs, errors: build.errors },
    harness: { url: null, ok: false, error: null, consoleErrors: [], pageErrors: [], report: null, screenshot: null },
    budget: null,
    summary: { status: 'fail', headline: reason, errors: build.errors.length, leaks: 0 },
  };
}

interface SummaryInput {
  buildOk: boolean;
  renderOk: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  harnessReport: any;
  budget: BudgetReport | null;
}

function summarize(s: SummaryInput): { status: 'pass' | 'warn' | 'fail'; headline: string; errors: number; leaks: number } {
  const leaks = Array.isArray(s.harnessReport?.leaks) ? s.harnessReport.leaks.length : 0;
  if (!s.buildOk) return { status: 'fail', headline: 'build failed', errors: 0, leaks: 0 };
  if (!s.renderOk) return { status: 'fail', headline: 'control did not render', errors: s.pageErrors.length + s.consoleErrors.length, leaks };
  const errs = s.pageErrors.length + s.consoleErrors.length;
  if (errs > 0) return { status: 'fail', headline: `${errs} console/page error(s)`, errors: errs, leaks };
  // Budget violations escalate before resource leaks because they're configured
  // expectations, while leaks are an absolute floor.
  if (s.budget?.status === 'fail') {
    const failed = s.budget.violations.filter(v => v.severity === 'fail');
    return { status: 'fail', headline: `perf budget exceeded: ${failed.map(v => v.metric).join(', ')}`, errors: 0, leaks };
  }
  if (leaks > 0) return { status: 'warn', headline: `${leaks} resource leak(s)`, errors: 0, leaks };
  if (s.budget?.status === 'warn') {
    const warned = s.budget.violations.filter(v => v.severity === 'warn');
    return { status: 'warn', headline: `perf budget soft-warn: ${warned.map(v => v.metric).join(', ')}`, errors: 0, leaks };
  }
  return { status: 'pass', headline: 'control rendered cleanly', errors: 0, leaks };
}
