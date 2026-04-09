import type { ManifestConfig } from '../types/manifest';
import type { HarnessStore } from '../store/harness-store';
import { createContext, rebuildParameters } from '../shim/context-factory';
import { getEntityData } from '../store/data-store';
import { loadBundle } from './bundle-loader';
import { getReactDOMGlobal } from './platform-libs';
import { ResourceTracker } from './resource-tracker';
import { preloadBundleResources } from '../shim/resources';

export interface ControlHostState {
  isLoaded: boolean;
  error: string | null;
}

/**
 * Manages the lifecycle of a single PCF control instance.
 * Supports both standard (DOM) and virtual (React) controls.
 */
export class ControlHost {
  private control: any = null;
  private context: any = null;
  private container: HTMLDivElement | null = null;
  private manifest: ManifestConfig;
  private getState: () => HarnessStore;
  private bundlePath: string;
  private onStateChange: (state: ControlHostState) => void;
  private isUpdating = false; // guard against re-entrant updateView
  private resourceTracker = new ResourceTracker();
  // For virtual controls: a stable forceUpdate function to re-render without remounting
  private virtualForceUpdate: (() => void) | null = null;

  constructor(
    manifest: ManifestConfig,
    getState: () => HarnessStore,
    bundlePath: string,
    onStateChange: (state: ControlHostState) => void,
  ) {
    this.manifest = manifest;
    this.getState = getState;
    this.bundlePath = bundlePath;
    this.onStateChange = onStateChange;
  }

  async load(container: HTMLDivElement): Promise<void> {
    this.container = container;
    this.onStateChange({ isLoaded: false, error: null });

    try {
      // Load bundle (platform libs loaded first for virtual controls)
      const Ctor = await loadBundle(
        this.bundlePath,
        this.manifest.controlType,
        this.manifest.resources,
      );
      this.control = new Ctor();

      // Preload image/font resources so getResource returns from cache instantly
      await preloadBundleResources();

      // Build context
      this.context = createContext(this.manifest, this.getState, getEntityData);

      // notifyOutputChanged callback — defer logging to avoid triggering
      // React re-renders during the control's synchronous render cycle.
      const notifyOutputChanged = () => {
        setTimeout(() => {
          this.getState().addLogEntry({ category: 'lifecycle', method: 'notifyOutputChanged' });
          this.getState().addLifecycleEvent({ method: 'notifyOutputChanged', durationMs: 0 });
          if (this.control?.getOutputs) {
            const outputStart = performance.now();
            const outputs = this.control.getOutputs();
            const outputMs = performance.now() - outputStart;
            this.getState().addLogEntry({
              category: 'lifecycle',
              method: 'getOutputs',
              result: outputs,
            });
            this.getState().addLifecycleEvent({ method: 'getOutputs', durationMs: outputMs });
          }
        }, 0);
      };

      // init()
      const initStart = performance.now();
      if (this.manifest.controlType === 'standard') {
        this.control.init(this.context, notifyOutputChanged, {}, container);
      } else {
        this.control.init(this.context, notifyOutputChanged, {});
      }
      const initMs = performance.now() - initStart;
      this.getState().addLogEntry({
        category: 'lifecycle',
        method: 'init',
        args: { controlType: this.manifest.controlType, durationMs: Math.round(initMs) },
      });
      this.getState().addLifecycleEvent({ method: 'init', durationMs: initMs });

      // Start tracking resources after init so we can detect leaks on destroy
      this.resourceTracker.install(container);

      // First updateView
      this.callUpdateView();

      this.onStateChange({ isLoaded: true, error: null });
    } catch (err: any) {
      const message = err.message || String(err);
      console.error('[pcf-workbench] Load error:', message);
      this.onStateChange({ isLoaded: false, error: message });
    }
  }

  callUpdateView(): void {
    if (!this.control || !this.context) return;
    // Prevent re-entrant calls (e.g. notifyOutputChanged → store update → useEffect → updateView)
    if (this.isUpdating) return;
    this.isUpdating = true;

    // Rebuild parameters with current store values
    rebuildParameters(this.context, this.manifest, this.getState().propertyValues, undefined, getEntityData, this.getState);

    const start = performance.now();

    if (this.manifest.controlType === 'virtual' && this.container) {
      // Virtual controls return a React.ReactElement from updateView
      const element = this.control.updateView(this.context);

      if (element) {
        const ReactDOM = getReactDOMGlobal(this.manifest.resources);
        const React = (window as any).Reactv16 ?? (window as any).Reactv18 ?? (window as any).React;

        if (!this.virtualForceUpdate && React && ReactDOM) {
          // First render: mount a stable wrapper component that holds the element in a ref.
          // Subsequent callUpdateView calls just update the ref and forceUpdate —
          // this preserves the child component tree and its state (including loaded images).
          const host = this;
          const elementRef = { current: element };
          host._virtualElementRef = elementRef;

          class VirtualWrapper extends React.Component<{}, {}> {
            constructor(props: any) {
              super(props);
              host.virtualForceUpdate = () => this.forceUpdate();
            }
            render() {
              return host._virtualElementRef.current;
            }
          }

          if (ReactDOM.render) {
            ReactDOM.render(React.createElement(VirtualWrapper), this.container);
          } else if (ReactDOM.createRoot) {
            const root = ReactDOM.createRoot(this.container);
            root.render(React.createElement(VirtualWrapper));
          }
        } else if (this.virtualForceUpdate) {
          // Subsequent renders: update the ref and trigger re-render without remounting
          (this as any)._virtualElementRef.current = element;
          this.virtualForceUpdate();
        }
      }
    } else {
      this.control.updateView(this.context);
    }

    const elapsed = performance.now() - start;
    this.getState().incrementRenderCount(elapsed);

    // Update DOM node count
    if (this.container) {
      // Defer to next frame so React has time to commit
      requestAnimationFrame(() => {
        if (this.container) {
          const nodeCount = this.container.querySelectorAll('*').length;
          this.getState().updateDomNodeCount(nodeCount);
        }
      });
    }

    this.isUpdating = false;

    // Defer all store updates to after the render cycle completes
    const renderNum = this.getState().renderCount + 1;
    setTimeout(() => {
      this.getState().addLogEntry({ category: 'lifecycle', method: 'updateView', args: { renderNum, durationMs: Math.round(elapsed) } });
      this.getState().addLifecycleEvent({ method: 'updateView', durationMs: elapsed });
      this.getState().addHeapSnapshot(`updateView #${renderNum}`);
    }, 0);
  }

  destroy(): void {
    if (this.container && this.manifest.controlType === 'virtual') {
      // Unmount React tree before destroying the control
      try {
        const ReactDOM = getReactDOMGlobal(this.manifest.resources);
        if (ReactDOM?.unmountComponentAtNode) {
          ReactDOM.unmountComponentAtNode(this.container);
        }
      } catch {
        // Ignore unmount errors
      }
    }

    if (this.control) {
      const destroyStart = performance.now();
      try {
        this.control.destroy();
        const destroyMs = performance.now() - destroyStart;
        this.getState().addLogEntry({ category: 'lifecycle', method: 'destroy', args: { durationMs: Math.round(destroyMs) } });
        this.getState().addLifecycleEvent({ method: 'destroy', durationMs: destroyMs });
      } catch (err) {
        const destroyMs = performance.now() - destroyStart;
        this.getState().addLifecycleEvent({ method: 'destroy', durationMs: destroyMs, error: String(err) });
        console.warn('[pcf-workbench] Error in destroy():', err);
      }

      // Check for resource leaks after destroy
      const leaks = this.resourceTracker.getLeaks();
      this.resourceTracker.uninstall();
      if (leaks.length > 0) {
        console.warn(`[pcf-workbench] ${leaks.length} resource leak(s) detected after destroy():`, leaks);
        this.getState().setResourceLeaks(leaks);
        this.getState().addLogEntry({
          category: 'lifecycle',
          method: 'destroy',
          args: { leaks: leaks.length, details: leaks.map(l => l.detail) },
        });
      }

      this.control = null;
    }
    this.virtualForceUpdate = null;
    (this as any)._virtualElementRef = null;
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.context = null;
  }

  async reload(): Promise<void> {
    if (!this.container) return;
    this.destroy();
    this.resourceTracker = new ResourceTracker();
    this.getState().resetMetrics();
    this.getState().clearLog();
    await this.load(this.container);
  }

  isLoaded(): boolean {
    return this.control !== null;
  }
}
