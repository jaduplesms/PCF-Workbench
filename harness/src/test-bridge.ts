/**
 * Test bridge — installs `window.__pcfwbHarnessReport()` and
 * `window.__pcfwbHarnessReady` so external drivers (Playwright, the
 * `pcf-harness loop` CLI, AI build-loop agents) can read a stable
 * JSON snapshot of harness state without scraping the DOM.
 *
 * This is a read-only window into the Zustand store. Calling the
 * function never mutates state.
 *
 * The shape returned here is the authoritative input to the MAI
 * `pcf-harness loop` report. If you change it, update
 * `harness/docs/ai-loop-report.schema.json` in the same commit.
 */

import { useHarnessStore } from './store/harness-store';

export interface HarnessReport {
  /** Schema version. Bump on breaking changes. */
  schemaVersion: 1;
  /** ms since epoch when the snapshot was taken. */
  capturedAt: number;
  control: {
    namespace: string | null;
    constructor: string | null;
    version: string | null;
    type: string | null;
  };
  lifecycle: {
    events: Array<{
      method: string;
      durationMs: number;
      error?: string;
      timestamp: number;
    }>;
    initCalled: boolean;
    firstUpdateViewMs: number | null;
    /** Last init→firstUpdateView gap in ms, or null if not yet rendered. */
  };
  performance: {
    renderCount: number;
    lastRenderTimeMs: number;
    avgRenderTimeMs: number;
    domNodeCount: number;
    jsHeapUsedMB: number;
  };
  leaks: Array<{ type: string; detail: string }>;
  webApi: {
    totalCalls: number;
    errorCount: number;
    calls: Array<{
      method: string;
      entityType: string;
      durationMs: number;
      recordCount: number;
      error?: string;
    }>;
  };
  logs: {
    /** Most-recent log entries (capped). */
    recent: Array<{
      category: string;
      method: string;
      coverage?: string;
    }>;
    /** Count of entries marked `unimplemented` (potential coverage gap). */
    unimplementedCount: number;
  };
}

function buildReport(): HarnessReport {
  const s = useHarnessStore.getState();
  const m = s.manifest;
  const events = s.lifecycleEvents;
  const initEvent = events.find(e => e.method === 'init');
  const firstUpdate = events.find(e => e.method === 'updateView');
  const firstUpdateViewMs =
    initEvent && firstUpdate ? firstUpdate.timestamp - initEvent.timestamp : null;
  const avgRender =
    s.renderTimings.length === 0
      ? 0
      : s.renderTimings.reduce((a, b) => a + b, 0) / s.renderTimings.length;
  const webApiErrors = s.webApiCalls.filter(c => !!c.error).length;
  const unimplementedCount = s.logEntries.filter(l => l.coverage === 'unimplemented').length;

  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    control: {
      namespace: m?.namespace ?? null,
      constructor: m?.constructor ?? null,
      version: m?.version ?? null,
      type: m?.controlType ?? null,
    },
    lifecycle: {
      events: events.slice(-50).map(e => ({
        method: e.method,
        durationMs: e.durationMs,
        error: e.error,
        timestamp: e.timestamp,
      })),
      initCalled: !!initEvent,
      firstUpdateViewMs,
    },
    performance: {
      renderCount: s.renderCount,
      lastRenderTimeMs: s.lastRenderTimeMs,
      avgRenderTimeMs: Math.round(avgRender * 100) / 100,
      domNodeCount: s.domNodeCount,
      jsHeapUsedMB: s.jsHeapUsedMB,
    },
    leaks: s.resourceLeaks.map(l => ({ type: l.type, detail: l.detail })),
    webApi: {
      totalCalls: s.webApiCalls.length,
      errorCount: webApiErrors,
      calls: s.webApiCalls.slice(-50).map(c => ({
        method: c.method,
        entityType: c.entityType,
        durationMs: c.durationMs,
        recordCount: c.recordCount,
        error: c.error,
      })),
    },
    logs: {
      recent: s.logEntries.slice(-50).map(l => ({
        category: l.category,
        method: l.method,
        coverage: l.coverage,
      })),
      unimplementedCount,
    },
  };
}

export function installTestBridge(): void {
  const w = window as any;
  w.__pcfwbHarnessReport = buildReport;
  // Drivers poll this flag rather than waiting for arbitrary timeouts.
  // Set once the harness has mounted and the control has had at least one
  // updateView (lifecycle event tracking is the same signal the UI uses).
  Object.defineProperty(w, '__pcfwbHarnessReady', {
    configurable: true,
    get() {
      const s = useHarnessStore.getState();
      return s.lifecycleEvents.some(e => e.method === 'updateView' && !e.error);
    },
  });
  // Lets drivers trigger destroy() on demand so the resource-tracker
  // can diff listeners/timers/observers and the next __pcfwbHarnessReport()
  // call surfaces the resulting `leaks` array. Returns true if the host
  // was registered and destroy ran, false if no control is mounted.
  w.__pcfwbHarnessDestroy = (): boolean => {
    if (!harnessHost) return false;
    try {
      harnessHost.destroy();
    } catch {
      // destroy errors are already captured in lifecycle events
    }
    return true;
  };
}

/**
 * Host registry — set by ControlViewport when it instantiates a ControlHost,
 * cleared on unmount. Used by `window.__pcfwbHarnessDestroy()` so external
 * drivers (loop CLI, Playwright) can force a destroy and pick up leaks.
 */
let harnessHost: { destroy: () => void } | null = null;

export function registerHarnessHost(host: { destroy: () => void } | null): void {
  harnessHost = host;
}
