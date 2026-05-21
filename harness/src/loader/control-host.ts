import type { ManifestConfig } from '../types/manifest';
import type { HarnessStore } from '../store/harness-store';
import { createContext, rebuildParameters } from '../shim/context-factory';
import { getEntityData } from '../store/data-store';
import { loadBundle } from './bundle-loader';
import { getReactDOMGlobal } from './platform-libs';
import { ResourceTracker } from './resource-tracker';
import { preloadBundleResources } from '../shim/resources';
import { installXrmGlobalShims } from '../shim/xrm-global';
import { bindXrmPageToFormContext } from '../shim/xrm-form';
import { buildExecutionContext, buildFormContext, setFormContextLogger } from '../shim/form-context';
import { fireOnLoad, seedFormState } from '../store/form-store';

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
  // For virtual controls: ref to the current element so the wrapper can re-render with updated content
  private _virtualElementRef: { current: any } | null = null;
  // Snapshot of state at the previous updateView, used to compute updatedProperties
  private prevSnapshot: {
    propertyValues: Record<string, any>;
    viewportWidth: number;
    viewportHeight: number;
    containerWidth: number | null;
    containerHeight: number | null;
    pageEntityId: string;
    pageEntityTypeName: string;
    pageEntityRecordName: string;
    isFullscreen: boolean;
  } | null = null;

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

      // Seed the form state from data.json + manifest, then build the
      // formContext that backs Xrm.Page and executionContext.getFormContext()
      const initialState = this.getState();
      seedFormState(
        this.manifest,
        initialState.pageEntityTypeName,
        initialState.pageEntityId,
        initialState.pageEntityRecordName,
      );
      setFormContextLogger((entry) => this.getState().addLogEntry(entry));
      const formContext = buildFormContext({
        getPageEntityId: () => this.getState().pageEntityId,
        getPageEntityTypeName: () => this.getState().pageEntityTypeName,
        getPageEntityRecordName: () => this.getState().pageEntityRecordName,
        getPcfContext: () => this.context,
      });
      bindXrmPageToFormContext(formContext);

      // Build context
      this.context = createContext(this.manifest, this.getState, getEntityData, {
        requestRender: () => this.callUpdateView(),
      });

      // Install global Xrm shims (Xrm.WebApi, Xrm.Navigation, Xrm.Utility)
      // so 3rd-party controls that use globals instead of context APIs work correctly
      installXrmGlobalShims(this.getState, getEntityData);

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

      // Start tracking resources before init so we catch listeners/timers/
      // observers that the control registers during init() itself.
      this.resourceTracker.install(container);

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

      // First updateView
      this.callUpdateView();

      // Fire form-level onLoad handlers registered during init() (mirrors UCI
      // semantics where form scripts add onLoad before the form is "ready").
      try {
        fireOnLoad(buildExecutionContext('form.load', null));
      } catch (e) {
        console.error('[pcf-workbench] onLoad handlers threw', e);
      }

      this.onStateChange({ isLoaded: true, error: null });
    } catch (err: any) {
      const message = err.message || String(err);
      console.error('[pcf-workbench] Load error:', message);
      this.onStateChange({ isLoaded: false, error: message });
    }
  }

  /**
   * Compute the list of property names / reserved tokens that have changed
   * since the previous updateView. Returns ['all'] for the first call.
   * Reserved tokens emitted: 'layoutChanged' (viewport or container size),
   * 'parentRecord' (page context), 'fullscreen_open' / 'fullscreen_close'.
   */
  private computeUpdatedProperties(): string[] {
    const s = this.getState();
    if (!this.prevSnapshot) return ['all'];
    const result: string[] = [];

    const prev = this.prevSnapshot;
    const allKeys = new Set([...Object.keys(s.propertyValues), ...Object.keys(prev.propertyValues)]);
    for (const name of allKeys) {
      if (!Object.is(s.propertyValues[name], prev.propertyValues[name])) {
        result.push(name);
      }
    }

    if (
      s.viewportWidth !== prev.viewportWidth ||
      s.viewportHeight !== prev.viewportHeight ||
      s.containerWidth !== prev.containerWidth ||
      s.containerHeight !== prev.containerHeight
    ) {
      result.push('layoutChanged');
    }

    if (
      s.pageEntityId !== prev.pageEntityId ||
      s.pageEntityTypeName !== prev.pageEntityTypeName ||
      s.pageEntityRecordName !== prev.pageEntityRecordName
    ) {
      result.push('parentRecord');
    }

    if (s.isFullscreen !== prev.isFullscreen) {
      result.push(s.isFullscreen ? 'fullscreen_open' : 'fullscreen_close');
    }

    return result;
  }

  private snapshotState(): void {
    const s = this.getState();
    this.prevSnapshot = {
      propertyValues: { ...s.propertyValues },
      viewportWidth: s.viewportWidth,
      viewportHeight: s.viewportHeight,
      containerWidth: s.containerWidth,
      containerHeight: s.containerHeight,
      pageEntityId: s.pageEntityId,
      pageEntityTypeName: s.pageEntityTypeName,
      pageEntityRecordName: s.pageEntityRecordName,
      isFullscreen: s.isFullscreen,
    };
  }

  callUpdateView(): void {
    if (!this.control || !this.context) return;
    // Prevent re-entrant calls (e.g. notifyOutputChanged → store update → useEffect → updateView)
    if (this.isUpdating) return;
    this.isUpdating = true;

    // Diff state to produce a precise updatedProperties list
    const updated = this.computeUpdatedProperties();

    // Rebuild parameters with current store values
    rebuildParameters(this.context, this.manifest, this.getState().propertyValues, updated, getEntityData, this.getState);
    this.snapshotState();

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
              return host._virtualElementRef?.current ?? null;
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
    this.prevSnapshot = null;
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.context = null;
  }

  async reload(): Promise<void> {
    if (!this.container) return;
    // Bump the global reload epoch BEFORE destroying. This invalidates the
    // live page-record cache so the auto-fetch hook re-pulls from Dataverse
    // on the next render — gives the user a "Reload always means fresh data"
    // contract without needing a separate "Fetch record" button.
    this.getState().bumpReloadEpoch();
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
