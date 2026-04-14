import { create } from 'zustand';
import type { ManifestConfig } from '../types/manifest';

export interface LogEntry {
  id: number;
  timestamp: number;
  category: string;
  method: string;
  args?: any;
  result?: any;
}

export interface WebApiCallRecord {
  id: number;
  timestamp: number;
  method: string;           // retrieveMultipleRecords, retrieveRecord, etc.
  entityType: string;
  durationMs: number;
  responseSize: number;     // approximate JSON size in bytes
  recordCount: number;      // number of entities returned
  options?: string;          // OData query string
  error?: string;
}

export interface HeapSnapshot {
  timestamp: number;
  heapUsedMB: number;
  label: string;            // what triggered the snapshot (e.g. "after updateView #3")
}

export type LifecycleMethod = 'init' | 'updateView' | 'getOutputs' | 'destroy' | 'notifyOutputChanged';

export interface LifecycleEvent {
  id: number;
  timestamp: number;
  method: LifecycleMethod;
  durationMs: number;
  error?: string;
}

export interface ResourceLeak {
  type: 'eventListener' | 'timer' | 'observer';
  detail: string;
}

export type NetworkMode = 'online' | 'offline' | 'slow3g' | 'fast3g' | 'custom';

export interface DevicePreset {
  name: string;
  width: number;
  height: number;
  formFactor: number; // 1=Desktop, 2=Tablet, 3=Phone
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  desktop: { name: 'Desktop', width: 1280, height: 720, formFactor: 1 },
  'iphone-14': { name: 'iPhone 14 Pro', width: 390, height: 844, formFactor: 3 },
  'pixel-7': { name: 'Pixel 7', width: 412, height: 915, formFactor: 3 },
  ipad: { name: 'iPad', width: 820, height: 1180, formFactor: 2 },
};

export interface HarnessStore {
  // Manifest
  manifest: ManifestConfig | null;
  setManifest: (manifest: ManifestConfig) => void;

  // Property values
  propertyValues: Record<string, any>;
  setPropertyValue: (name: string, value: any) => void;
  setPropertyValues: (values: Record<string, any>) => void;

  // Property types (for of-type-group properties — tracks the maker's Type dropdown selection)
  propertyTypes: Record<string, string>;
  setPropertyType: (name: string, type: string) => void;

  // Network conditioning
  networkMode: NetworkMode;
  customLatencyMs: number;
  setNetworkMode: (mode: NetworkMode) => void;
  setCustomLatencyMs: (ms: number) => void;

  // Device emulation
  devicePreset: string;
  viewportWidth: number;
  viewportHeight: number;
  formFactor: number;
  setDevicePreset: (preset: string) => void;

  // Control mode
  isControlDisabled: boolean;
  setControlDisabled: (disabled: boolean) => void;

  // Page context (for controls that read context.page.entityId / entityTypeName)
  pageEntityId: string;
  pageEntityTypeName: string;
  setPageEntityId: (id: string) => void;
  setPageEntityTypeName: (name: string) => void;

  // Theme
  isDarkMode: boolean;
  toggleDarkMode: () => void;

  // Performance metrics
  renderCount: number;
  lastRenderTimeMs: number;
  renderTimings: number[];       // history of render durations (ms)
  webApiCallCount: number;
  domNodeCount: number;
  jsHeapUsedMB: number;
  webApiCalls: WebApiCallRecord[];
  heapSnapshots: HeapSnapshot[];
  incrementRenderCount: (timeMs: number) => void;
  incrementWebApiCallCount: () => void;
  addWebApiCall: (call: Omit<WebApiCallRecord, 'id' | 'timestamp'>) => void;
  updateDomNodeCount: (count: number) => void;
  updateJsHeap: (mb: number) => void;
  addHeapSnapshot: (label: string) => void;
  resetMetrics: () => void;

  // Lifecycle tracking
  lifecycleEvents: LifecycleEvent[];
  addLifecycleEvent: (event: Omit<LifecycleEvent, 'id' | 'timestamp'>) => void;
  clearLifecycle: () => void;

  // Resource leak detection
  resourceLeaks: ResourceLeak[];
  setResourceLeaks: (leaks: ResourceLeak[]) => void;

  // Console log
  logEntries: LogEntry[];
  addLogEntry: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLog: () => void;
}

let nextLogId = 1;

export const useHarnessStore = create<HarnessStore>((set, get) => ({
  // Manifest
  manifest: null,
  setManifest: (manifest) => {
    // Initialize property values with defaults
    const propertyValues: Record<string, any> = {};
    for (const prop of manifest.properties) {
      if (prop.ofType === 'Lookup.Simple') {
        propertyValues[prop.name] = null;
      } else if (prop.ofType === 'TwoOptions') {
        propertyValues[prop.name] = false;
      } else if (['Whole.None', 'FP', 'Decimal', 'Currency'].includes(prop.ofType)) {
        propertyValues[prop.name] = null;
      } else {
        propertyValues[prop.name] = prop.defaultValue ?? null;
      }
    }
    // Initialize property types for of-type-group properties (default to SingleLine.Text)
    const propertyTypes: Record<string, string> = {};
    for (const prop of manifest.properties) {
      if (prop.ofTypeGroup && manifest.typeGroups[prop.ofTypeGroup]) {
        const groupTypes = manifest.typeGroups[prop.ofTypeGroup];
        propertyTypes[prop.name] = groupTypes.includes('SingleLine.Text') ? 'SingleLine.Text' : groupTypes[0];
      }
    }
    set({ manifest, propertyValues, propertyTypes });
  },

  // Property values
  propertyValues: {},
  setPropertyValue: (name, value) => set(s => ({
    propertyValues: { ...s.propertyValues, [name]: value },
  })),
  setPropertyValues: (values) => set(s => ({
    propertyValues: { ...s.propertyValues, ...values },
  })),

  // Property types
  propertyTypes: {},
  setPropertyType: (name, type) => set(s => ({
    propertyTypes: { ...s.propertyTypes, [name]: type },
  })),

  // Network
  networkMode: 'online',
  customLatencyMs: 1000,
  setNetworkMode: (mode) => set({ networkMode: mode }),
  setCustomLatencyMs: (ms) => set({ customLatencyMs: ms }),

  // Device
  devicePreset: 'desktop',
  viewportWidth: DEVICE_PRESETS.desktop.width,
  viewportHeight: DEVICE_PRESETS.desktop.height,
  formFactor: DEVICE_PRESETS.desktop.formFactor,
  setDevicePreset: (preset) => {
    const p = DEVICE_PRESETS[preset];
    if (p) {
      set({
        devicePreset: preset,
        viewportWidth: p.width,
        viewportHeight: p.height,
        formFactor: p.formFactor,
      });
    }
  },

  // Mode
  isControlDisabled: false,
  setControlDisabled: (disabled) => set({ isControlDisabled: disabled }),

  // Page context
  pageEntityId: '',
  pageEntityTypeName: '',
  setPageEntityId: (id) => set({ pageEntityId: id }),
  setPageEntityTypeName: (name) => set({ pageEntityTypeName: name }),

  // Theme
  isDarkMode: false,
  toggleDarkMode: () => set(s => ({ isDarkMode: !s.isDarkMode })),

  // Performance
  renderCount: 0,
  lastRenderTimeMs: 0,
  renderTimings: [],
  webApiCallCount: 0,
  domNodeCount: 0,
  jsHeapUsedMB: 0,
  webApiCalls: [],
  heapSnapshots: [],
  incrementRenderCount: (timeMs) => set(s => ({
    renderCount: s.renderCount + 1,
    lastRenderTimeMs: timeMs,
    renderTimings: [...s.renderTimings.slice(-49), timeMs], // keep last 50
  })),
  incrementWebApiCallCount: () => set(s => ({ webApiCallCount: s.webApiCallCount + 1 })),
  addWebApiCall: (call) => set(s => ({
    webApiCalls: [
      ...s.webApiCalls.slice(-99), // keep last 100
      { ...call, id: s.webApiCallCount, timestamp: Date.now() },
    ],
    webApiCallCount: s.webApiCallCount + 1,
  })),
  updateDomNodeCount: (count) => set({ domNodeCount: count }),
  updateJsHeap: (mb) => set({ jsHeapUsedMB: mb }),
  addHeapSnapshot: (label) => {
    const perf = performance as any;
    const mb = perf.memory ? perf.memory.usedJSHeapSize / (1024 * 1024) : 0;
    if (mb > 0) {
      set(s => ({
        jsHeapUsedMB: mb,
        heapSnapshots: [
          ...s.heapSnapshots.slice(-99), // keep last 100
          { timestamp: Date.now(), heapUsedMB: mb, label },
        ],
      }));
    }
  },
  resetMetrics: () => set({
    renderCount: 0, lastRenderTimeMs: 0, renderTimings: [],
    webApiCallCount: 0, domNodeCount: 0, jsHeapUsedMB: 0,
    webApiCalls: [], heapSnapshots: [], lifecycleEvents: [], resourceLeaks: [],
  }),

  // Lifecycle
  lifecycleEvents: [],
  addLifecycleEvent: (event) => set(s => ({
    lifecycleEvents: [
      ...s.lifecycleEvents.slice(-199), // keep last 200
      { ...event, id: s.lifecycleEvents.length + 1, timestamp: Date.now() },
    ],
  })),
  clearLifecycle: () => set({ lifecycleEvents: [], resourceLeaks: [] }),

  // Resource leaks
  resourceLeaks: [],
  setResourceLeaks: (leaks) => set({ resourceLeaks: leaks }),

  // Log
  logEntries: [],
  addLogEntry: (entry) => set(s => ({
    logEntries: [
      ...s.logEntries.slice(-499), // keep last 500
      { ...entry, id: nextLogId++, timestamp: Date.now() },
    ],
  })),
  clearLog: () => set({ logEntries: [] }),
}));
