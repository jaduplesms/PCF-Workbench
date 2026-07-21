// M9 — Auto-spawn build watcher.
//
// pcf-scripts ships `start watch` which combines Browsersync + webpack-watch
// in one process. PCF Workbench has the reload half (Vite HMR on out/bundle.js
// changes) but historically relied on the user to run `npm run build` in a
// second terminal. This module closes the gap: when the harness boots in
// single-control mode it watches the user's source and runs `npm run build`
// on every save (debounced), streaming status to the UI via an SSE endpoint.
//
// Why full `npm run build` instead of `webpack --watch`?
//   pcf-scripts wraps webpack with custom plugins and a generated config; the
//   simplest tool-chain-agnostic approach is to invoke the project's own
//   build script. Slower per cycle (~10s vs. ~2s incremental) but works for
//   any PCF tool-chain, including future replacements of pcf-scripts.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar';

export type BuildPhase = 'idle' | 'compiling' | 'success' | 'error';

export interface BuildStatus {
  phase: BuildPhase;
  /** Wall-clock duration of the most recent build that reached terminal state. */
  durationMs?: number;
  /** Trimmed list of error/warning lines from the most recent failed build. */
  errors?: string[];
  /** Monotonic event index, useful for clients to dedupe / order. */
  seq: number;
  /** ISO timestamp of the latest event. */
  at: string;
}

export interface BuildWatcherOptions {
  projectRoot: string;
  controlDir: string;
  onStatus: (status: BuildStatus) => void;
  /** Debounce window between source change and build kick-off. */
  debounceMs?: number;
  /** Logger; defaults to console with `[pcf-workbench:build-watch]` prefix. */
  log?: (msg: string) => void;
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.css', '.resx', '.json']);
const SOURCE_BASENAMES = new Set(['ControlManifest.Input.xml']);
// Harness fixture / config files that live in the control dir but are NOT
// control source — changing them must NOT trigger a pcf-scripts rebuild
// (they're served live by the Vite plugin instead).
const HARNESS_CONFIG_BASENAMES = new Set([
  'data.json',
  'test-scenarios.json',
  'metadata.json',
  'execute-mocks.json',
  '.pcf-audit.json',
]);

const IGNORE_DIRS = new Set([
  'out',
  'obj',
  'bin',
  'node_modules',
  'generated',
  '.git',
  '__visual__',
]);

export class BuildWatcher {
  private opts: Required<Omit<BuildWatcherOptions, 'log'>> & { log: (msg: string) => void };
  private status: BuildStatus = { phase: 'idle', seq: 0, at: new Date().toISOString() };
  private debounceTimer: NodeJS.Timeout | null = null;
  private currentChild: ChildProcess | null = null;
  private pendingRebuild = false;
  private disposed = false;
  private watcher: ChokidarWatcher | null = null;

  constructor(options: BuildWatcherOptions) {
    this.opts = {
      debounceMs: 300,
      log: (msg: string) => console.log(`[pcf-workbench:build-watch] ${msg}`),
      ...options,
    } as any;
    this.attach();
  }

  getStatus(): BuildStatus {
    return this.status;
  }

  /** Public hook so the SSE endpoint can subscribe to status changes. */
  onStatus(cb: (status: BuildStatus) => void): () => void {
    const wrapped = (s: BuildStatus) => cb(s);
    this._subs.push(wrapped);
    return () => {
      const i = this._subs.indexOf(wrapped);
      if (i >= 0) this._subs.splice(i, 1);
    };
  }

  private _subs: Array<(s: BuildStatus) => void> = [];

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.watcher) {
      this.watcher.close().catch(() => { /* */ });
      this.watcher = null;
    }
    if (this.currentChild) {
      try {
        if (process.platform === 'win32' && this.currentChild.pid) {
          spawn('taskkill', ['/pid', String(this.currentChild.pid), '/T', '/F'], {
            stdio: 'ignore',
            shell: false,
          });
        } else {
          this.currentChild.kill('SIGTERM');
        }
      } catch {
        // best-effort
      }
      this.currentChild = null;
    }
  }

  private attach() {
    const target = this.opts.controlDir;
    this.watcher = chokidar.watch(target, {
      ignored: (filePath: string) => {
        const abs = path.resolve(filePath);
        const rel = path.relative(target, abs);
        if (!rel || rel === '.') return false;
        const segs = rel.split(/[\\/]/);
        return segs.some((s) => IGNORE_DIRS.has(s));
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const onEvent = (file: string) => this.handleChange(file);
    this.watcher.on('change', onEvent);
    this.watcher.on('add', onEvent);
    this.watcher.on('unlink', onEvent);
    this.watcher.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`watcher error: ${message}`);
    });
    this.opts.log(`watching ${target}`);
  }

  private isInteresting(file: string): boolean {
    const abs = path.resolve(file);
    const rel = path.relative(this.opts.controlDir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const segs = rel.split(/[\\/]/);
    if (segs.some((s) => IGNORE_DIRS.has(s))) return false;
    const base = segs[segs.length - 1];
    if (base.endsWith('.d.ts')) return false;
    if (HARNESS_CONFIG_BASENAMES.has(base)) return false;
    if (SOURCE_BASENAMES.has(base)) return true;
    const ext = path.extname(base).toLowerCase();
    return SOURCE_EXTS.has(ext);
  }

  private handleChange(file: string) {
    if (!this.isInteresting(file)) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.kickBuild(`source changed: ${path.relative(this.opts.controlDir, file)}`);
    }, this.opts.debounceMs);
  }

  private kickBuild(reason: string) {
    if (this.disposed) return;
    if (this.currentChild) {
      // A build is already running. Mark a rebuild as pending so we re-run
      // once the current one finishes (covers the case where the user saves
      // multiple times during a slow build).
      this.pendingRebuild = true;
      this.opts.log(`build already running, queued rebuild (${reason})`);
      return;
    }
    this.runBuild(reason);
  }

  private runBuild(reason: string) {
    const started = Date.now();
    this.emit({ phase: 'compiling', seq: this.status.seq + 1, at: new Date().toISOString() });
    this.opts.log(`rebuild start (${reason})`);

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawn(npm, ['run', 'build'], {
        cwd: this.opts.projectRoot,
        shell: process.platform === 'win32',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
    } catch (err: any) {
      this.emit({
        phase: 'error',
        seq: this.status.seq + 1,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        errors: [`spawn failed: ${err?.message ?? err}`],
      });
      return;
    }
    this.currentChild = child;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      this.currentChild = null;
      const durationMs = Date.now() - started;
      const ok = code === 0;
      if (ok) {
        this.opts.log(`rebuild success in ${(durationMs / 1000).toFixed(1)}s`);
        this.emit({
          phase: 'success',
          seq: this.status.seq + 1,
          at: new Date().toISOString(),
          durationMs,
        });
      } else {
        const errors = extractErrors(stdout, stderr).slice(0, 30);
        this.opts.log(`rebuild failed (exit ${code}) in ${(durationMs / 1000).toFixed(1)}s`);
        this.emit({
          phase: 'error',
          seq: this.status.seq + 1,
          at: new Date().toISOString(),
          durationMs,
          errors,
        });
      }
      if (this.pendingRebuild && !this.disposed) {
        this.pendingRebuild = false;
        // Small grace period so a flurry of saves coalesces.
        setTimeout(() => this.kickBuild('queued rebuild after previous build finished'), 50);
      }
    });
    child.on('error', (err) => {
      this.currentChild = null;
      this.opts.log(`build child errored: ${err.message}`);
      this.emit({
        phase: 'error',
        seq: this.status.seq + 1,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        errors: [err.message],
      });
    });
  }

  private emit(next: BuildStatus) {
    this.status = next;
    for (const cb of this._subs) {
      try { cb(next); } catch { /* swallow */ }
    }
    try { this.opts.onStatus(next); } catch { /* swallow */ }
  }
}

function extractErrors(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  return combined
    .split(/\r?\n/)
    .filter((l) => /\berror\b/i.test(l) || /TS\d{4,}/.test(l) || /\bfailed\b/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Walk up to find package.json (mirrors bin/pcfworkbench.ts findProjectRoot). */
export function findProjectRootForBuild(controlPath: string): string | null {
  let dir = path.resolve(controlPath);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when the project's package.json has a `build` script we can run. */
export function projectHasBuildScript(projectRoot: string): boolean {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return Boolean(pkg?.scripts?.build);
  } catch {
    return false;
  }
}
