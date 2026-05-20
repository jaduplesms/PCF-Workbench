#!/usr/bin/env node

// CLI entry point for the PCF Dev Harness.
//
// Two modes:
//   pcf-harness --path <dir>            Start the interactive harness (default).
//   pcf-harness loop --path <dir> ...   Run one build→render→report cycle
//                                       headlessly and write a JSON report
//                                       (the MAI AI build loop).
// In both modes the control must have been built (`npm run build` in the PCF
// project) so that out/controls/{Name}/bundle.js exists.

import { Command } from 'commander';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(__dirname, '..');

const program = new Command();

program
  .name('pcf-harness')
  .description('PCF dev harness — interactive runner + AI build loop')
  .version('0.2.0');

/* ---------------------------------------------------------------- */
/* Default: start the interactive harness.                          */
/* ---------------------------------------------------------------- */
program
  .command('start', { isDefault: true })
  .description('Start the interactive harness (default).')
  .requiredOption('--path <dir>', 'Path to the PCF control directory (containing ControlManifest.Input.xml)')
  .option('--port <number>', 'Port to run the dev server on', '8181')
  .option('--no-open', 'Do not open the browser automatically')
  .action(async (opts) => {
    const controlPath = path.resolve(opts.path);
    assertControlDir(controlPath);

    process.env.PCF_CONTROL_PATH = controlPath;

    console.log(`\n  PCF Dev Harness`);
    console.log(`  Control: ${controlPath}`);
    console.log(`  Port:    ${opts.port}\n`);

    try {
      const server = await createServer({
        configFile: path.join(harnessRoot, 'vite.config.ts'),
        root: harnessRoot,
        server: {
          port: parseInt(opts.port, 10),
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
  .requiredOption('--path <dir>', 'Path to the PCF control directory')
  .option('--out <dir>', 'Directory to write report.json + screenshot.png', './pcf-loop-reports')
  .option('--skip-build', 'Skip the npm run build step (use existing out/ bundle)', false)
  .option('--timeout <ms>', 'Max ms to wait for the control to render', '60000')
  .option('--headed', 'Run Playwright in headed mode for debugging', false)
  .action(async (opts) => {
    const controlPath = path.resolve(opts.path);
    assertControlDir(controlPath);
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });

    const exitCode = await runLoop({
      controlPath,
      outDir,
      skipBuild: !!opts.skipBuild,
      timeoutMs: parseInt(opts.timeout, 10),
      headed: !!opts.headed,
    });
    process.exit(exitCode);
  });

program.parse();

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */

function assertControlDir(controlPath: string): void {
  const manifestPath = path.join(controlPath, 'ControlManifest.Input.xml');
  if (!fs.existsSync(manifestPath)) {
    console.error(`\n  Error: ControlManifest.Input.xml not found at:\n  ${manifestPath}\n`);
    console.error(`  Make sure --path points to the directory containing ControlManifest.Input.xml.\n`);
    process.exit(1);
  }
}

interface LoopOpts {
  controlPath: string;
  outDir: string;
  skipBuild: boolean;
  timeoutMs: number;
  headed: boolean;
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
  console.log(`\n  pcf-harness loop`);
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
    configFile: path.join(harnessRoot, 'vite.config.ts'),
    root: harnessRoot,
    server: { port, host: '127.0.0.1', open: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = `http://127.0.0.1:${port}/`;

  /* --- 3. Playwright drive -------------------------------------- */
  // Lazy-import to keep `pcf-harness --path` startup fast.
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  let renderOk = false;
  let renderError: string | undefined;
  let harnessReport: any = null;

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeoutMs });
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
  } catch (err: any) {
    renderError = err?.message ?? String(err);
    // Best-effort screenshot for diagnostics.
    try {
      await page.screenshot({
        path: path.join(opts.outDir, 'screenshot.png'),
        fullPage: true,
      });
    } catch { /* ignore */ }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  /* --- 4. Report ------------------------------------------------ */
  const totalMs = Date.now() - t0;
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
      report: harnessReport,
      screenshot: 'screenshot.png',
    },
    summary: summarize({
      buildOk: build.ok,
      renderOk,
      consoleErrors,
      pageErrors,
      harnessReport,
    }),
  };
  writeReport(opts.outDir, report);

  console.log(`\n  [summary] ${report.summary.status.toUpperCase()} — ${report.summary.headline}`);
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

function emptyReport(opts: LoopOpts, build: BuildResult, reason: string) {
  return {
    schemaVersion: 1,
    runId: `${Date.now().toString(36)}-fail`,
    capturedAt: new Date().toISOString(),
    durationMs: build.durationMs,
    control: { path: opts.controlPath },
    build: { ok: build.ok, skipped: opts.skipBuild, durationMs: build.durationMs, errors: build.errors },
    harness: { url: null, ok: false, error: null, consoleErrors: [], pageErrors: [], report: null, screenshot: null },
    summary: { status: 'fail', headline: reason, errors: build.errors.length, leaks: 0 },
  };
}

interface SummaryInput {
  buildOk: boolean;
  renderOk: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  harnessReport: any;
}

function summarize(s: SummaryInput): { status: 'pass' | 'warn' | 'fail'; headline: string; errors: number; leaks: number } {
  if (!s.buildOk) return { status: 'fail', headline: 'build failed', errors: 0, leaks: 0 };
  if (!s.renderOk) return { status: 'fail', headline: 'control did not render', errors: s.pageErrors.length + s.consoleErrors.length, leaks: 0 };
  const errs = s.pageErrors.length + s.consoleErrors.length;
  const leaks = Array.isArray(s.harnessReport?.leaks) ? s.harnessReport.leaks.length : 0;
  if (errs > 0) return { status: 'fail', headline: `${errs} console/page error(s)`, errors: errs, leaks };
  if (leaks > 0) return { status: 'warn', headline: `${leaks} resource leak(s)`, errors: 0, leaks };
  return { status: 'pass', headline: 'control rendered cleanly', errors: 0, leaks };
}
