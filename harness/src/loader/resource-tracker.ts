import type { ResourceLeak } from '../store/harness-store';

interface TrackedListener {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
}

interface TrackedTimer {
  id: number;
  kind: 'interval' | 'timeout';
  label: string;
}

interface TrackedObserver {
  observer: MutationObserver | ResizeObserver | IntersectionObserver;
  kind: string;
}

/**
 * Tracks resources created by a PCF control so we can detect leaks
 * (resources not cleaned up in destroy()).
 *
 * Call install() after init, snapshot() before destroy, then getLeaks() after destroy.
 */
export class ResourceTracker {
  private listeners: TrackedListener[] = [];
  private timers: TrackedTimer[] = [];
  private observers: TrackedObserver[] = [];

  private origAddEventListener: typeof EventTarget.prototype.addEventListener;
  private origRemoveEventListener: typeof EventTarget.prototype.removeEventListener;
  private origSetInterval: typeof globalThis.setInterval;
  private origClearInterval: typeof globalThis.clearInterval;
  private origSetTimeout: typeof globalThis.setTimeout;
  private origClearTimeout: typeof globalThis.clearTimeout;

  private origMutationObserver: typeof MutationObserver;
  private origResizeObserver: typeof ResizeObserver;
  private origIntersectionObserver: typeof IntersectionObserver;

  private installed = false;
  private container: HTMLElement | null = null;

  constructor() {
    this.origAddEventListener = EventTarget.prototype.addEventListener;
    this.origRemoveEventListener = EventTarget.prototype.removeEventListener;
    this.origSetInterval = globalThis.setInterval.bind(globalThis);
    this.origClearInterval = globalThis.clearInterval.bind(globalThis);
    this.origSetTimeout = globalThis.setTimeout.bind(globalThis);
    this.origClearTimeout = globalThis.clearTimeout.bind(globalThis);
    this.origMutationObserver = globalThis.MutationObserver;
    this.origResizeObserver = globalThis.ResizeObserver;
    this.origIntersectionObserver = globalThis.IntersectionObserver;
  }

  /**
   * Install monkey-patches to track resource creation/removal.
   * Only tracks events on elements inside the container (or on window/document).
   */
  install(container: HTMLElement): void {
    if (this.installed) return;
    this.installed = true;
    this.container = container;
    this.listeners = [];
    this.timers = [];
    this.observers = [];

    const tracker = this;

    // Patch addEventListener
    const origAdd = this.origAddEventListener;
    const origRemove = this.origRemoveEventListener;

    EventTarget.prototype.addEventListener = function(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (tracker.isTrackedTarget(this)) {
        tracker.listeners.push({ target: this, type, listener });
      }
      return origAdd.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      if (tracker.isTrackedTarget(this)) {
        const idx = tracker.listeners.findIndex(
          l => l.target === this && l.type === type && l.listener === listener
        );
        if (idx >= 0) tracker.listeners.splice(idx, 1);
      }
      return origRemove.call(this, type, listener, options);
    };

    // Patch setInterval/clearInterval
    globalThis.setInterval = function(handler: TimerHandler, ms?: number, ...args: any[]) {
      const id = tracker.origSetInterval(handler, ms, ...args);
      tracker.timers.push({ id: id as unknown as number, kind: 'interval', label: `setInterval(${ms}ms)` });
      return id;
    } as typeof globalThis.setInterval;

    globalThis.clearInterval = function(id?: number) {
      tracker.timers = tracker.timers.filter(t => t.id !== id);
      return tracker.origClearInterval(id);
    } as typeof globalThis.clearInterval;

    // Patch setTimeout/clearTimeout (only track long-lived ones > 5s as potential leaks)
    globalThis.setTimeout = function(handler: TimerHandler, ms?: number, ...args: any[]) {
      const id = tracker.origSetTimeout(handler, ms, ...args);
      if (ms && ms > 5000) {
        tracker.timers.push({ id: id as unknown as number, kind: 'timeout', label: `setTimeout(${ms}ms)` });
      }
      // Auto-remove when timeout fires
      const numericId = id as unknown as number;
      tracker.origSetTimeout(() => {
        tracker.timers = tracker.timers.filter(t => t.id !== numericId);
      }, (ms || 0) + 50);
      return id;
    } as typeof globalThis.setTimeout;

    globalThis.clearTimeout = function(id?: number) {
      tracker.timers = tracker.timers.filter(t => t.id !== id);
      return tracker.origClearTimeout(id);
    } as typeof globalThis.clearTimeout;

    // Patch MutationObserver
    globalThis.MutationObserver = class extends tracker.origMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        tracker.observers.push({ observer: this, kind: 'MutationObserver' });
      }
      disconnect() {
        tracker.observers = tracker.observers.filter(o => o.observer !== this);
        super.disconnect();
      }
    } as typeof MutationObserver;

    // Patch ResizeObserver
    globalThis.ResizeObserver = class extends tracker.origResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        tracker.observers.push({ observer: this, kind: 'ResizeObserver' });
      }
      disconnect() {
        tracker.observers = tracker.observers.filter(o => o.observer !== this);
        super.disconnect();
      }
    } as typeof ResizeObserver;

    // Patch IntersectionObserver
    globalThis.IntersectionObserver = class extends tracker.origIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        tracker.observers.push({ observer: this, kind: 'IntersectionObserver' });
      }
      disconnect() {
        tracker.observers = tracker.observers.filter(o => o.observer !== this);
        super.disconnect();
      }
    } as typeof IntersectionObserver;
  }

  /**
   * Uninstall all monkey-patches and restore originals.
   */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;

    EventTarget.prototype.addEventListener = this.origAddEventListener;
    EventTarget.prototype.removeEventListener = this.origRemoveEventListener;
    globalThis.setInterval = this.origSetInterval as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = this.origClearInterval as unknown as typeof globalThis.clearInterval;
    globalThis.setTimeout = this.origSetTimeout as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = this.origClearTimeout as unknown as typeof globalThis.clearTimeout;
    globalThis.MutationObserver = this.origMutationObserver;
    globalThis.ResizeObserver = this.origResizeObserver;
    globalThis.IntersectionObserver = this.origIntersectionObserver;
  }

  /**
   * Get remaining tracked resources as leak reports.
   * Call after control.destroy() to see what wasn't cleaned up.
   */
  getLeaks(): ResourceLeak[] {
    const leaks: ResourceLeak[] = [];

    // Playwright injects a fixed set of window listeners for input synthesis
    // and a probe event. Filter these so the report shows only listeners the
    // user's control actually registered.
    const PLAYWRIGHT_NOISE = new Set([
      '__playwright_global_listeners_check__',
      'mousemove', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick',
      'contextmenu', 'pointerdown', 'pointerup',
      'touchstart', 'touchend', 'touchcancel',
    ]);

    for (const l of this.listeners) {
      // Framework-level noise: document listeners are nearly always added by
      // UI libraries (Fluent click-outside, React event delegation) and not
      // the control's responsibility to clean up.
      if (l.target === document) continue;
      if (l.target === window && PLAYWRIGHT_NOISE.has(l.type)) continue;
      const targetName = l.target === window ? 'window'
        : l.target === document ? 'document'
        : (l.target as HTMLElement).tagName?.toLowerCase() || 'element';
      leaks.push({
        type: 'eventListener',
        detail: `${targetName}.addEventListener("${l.type}") not removed`,
      });
    }

    for (const t of this.timers) {
      leaks.push({
        type: 'timer',
        detail: `${t.label} not cleared`,
      });
    }

    for (const o of this.observers) {
      leaks.push({
        type: 'observer',
        detail: `${o.kind}.disconnect() not called`,
      });
    }

    return leaks;
  }

  private isTrackedTarget(target: EventTarget): boolean {
    // Track window and document listeners
    if (target === window || target === document) return true;
    // Track listeners on elements inside the control container
    if (this.container && target instanceof Node && this.container.contains(target)) return true;
    return false;
  }
}
