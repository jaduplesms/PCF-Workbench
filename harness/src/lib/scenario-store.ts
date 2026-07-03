/**
 * Central scenario store — single source of truth for the TestScenario v2
 * type, on-disk migration from v1, storage helpers, name generation, and
 * the apply/save plumbing used by both the side-panel `ScenarioHeader`
 * UI and the `?scenario=<name>` URL auto-loader (App.tsx, CI loop).
 *
 * Migration contract (rubber-duck #1, #6):
 *
 *   - Old `test-scenarios.json` files written by ScenariosPanel pre-rework
 *     have no `schemaVersion` — those are v1. `normalizeScenario` upgrades
 *     them in memory to v2 by leaving the new domains (`dataRecords`,
 *     `userSettings`, `dataSource`, `pageContext.recordName`, `network.customLatencyMs`,
 *     `device.containerWidth/Height/host`) undefined.
 *   - Partial / corrupt entries are dropped (warned to console); they do
 *     not abort the whole load.
 *   - Save always writes v2. We never write v1 again. v1 files keep loading
 *     forever.
 *   - Load NEVER overwrites a live store from `undefined` (rubber-duck #1) —
 *     `applyScenarioToStore` skips any domain absent on the scenario.
 */

import type { ManifestProperty, ManifestDataSet, ManifestConfig } from '../types/manifest';
import type { DatasetBindingMap } from '../types/dataset-binding';
import { synthesizeDefaultBinding, ensureViewsLibrary } from '../types/dataset-binding';
import { useHarnessStore, type NetworkMode } from '../store/harness-store';
import {
  getEntityData,
  getMockEntityDataSnapshot,
  replaceMockEntityData,
} from '../store/data-store';
import {
  getAllMetadata,
  replaceAllMetadata,
  loadMetadata,
  type EntityMetadata,
} from '../store/metadata-store';
import { reseedForPageEntity } from '../store/form-store';
import { rebaseDatesToToday } from '../store/date-rebase';
import { defaultValueFor } from './scenario-heuristic';

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

export const SCENARIO_SCHEMA_VERSION = 2 as const;

export interface ScenarioPageContext {
  entityId?: string;
  typeName?: string;
  recordName?: string;
}

export interface ScenarioNetwork {
  mode?: NetworkMode;
  customLatencyMs?: number;
}

export interface ScenarioDevice {
  preset?: string;
  containerWidth?: number | null;
  containerHeight?: number | null;
  host?: 'Web' | 'Mobile' | 'Outlook' | 'Teams';
  isFullBleed?: boolean;
}

export interface ScenarioUserSettings {
  languageId?: number;
  isRTL?: boolean;
  timeZoneOffsetMinutes?: number;
  userId?: string;
  userName?: string;
  securityRoles?: string[];
}

/**
 * v2 scenario. Every config domain is optional so partial scenarios round-trip
 * cleanly and v1 → v2 migration is a structural rename, not a default-fill.
 *
 * `dataSource: 'live'` is a marker only — we deliberately do NOT serialize
 * live record snapshots into scenarios (rubber-duck #4): they go stale and
 * would silently shadow real Dataverse data on Load.
 */
export interface TestScenario {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  name: string;
  description?: string;
  savedAt: string;

  /** Manifest-bound input property values. */
  propertyValues?: Record<string, any>;

  /** Map property names to entity column names for field-level binding.
   *  When loaded, the harness resolves values from the data.json record
   *  matching `pageContext.entityId + pageContext.typeName`. */
  fieldBindings?: Record<string, string>;

  pageContext?: ScenarioPageContext;
  network?: ScenarioNetwork;
  device?: ScenarioDevice;
  userSettings?: ScenarioUserSettings;

  /** Mock entity table snapshot. Mock-only — never populated in live mode. */
  dataRecords?: Record<string, Record<string, any>[]>;

  /** Entity metadata snapshot (logical name → schema). Captured from
   *  metadata-store on Save so a scenario can pin the schema it expects.
   *  Applies in BOTH mock and live mode (acts as a cache primer). */
  metadata?: Record<string, EntityMetadata>;

  /** 'mock' (default) or 'live'. When 'live', `dataRecords` is omitted. */
  dataSource?: 'mock' | 'live';

  /** Live PAC profile pin. Captured on Save when `dataSource === 'live'` so
   *  the scenario remembers which environment it was authored against.
   *  Apply matches by `orgUrl` first (durable), then `friendlyName` as a
   *  fallback. If no profile on the current machine matches, the harness
   *  surfaces a banner and the user picks manually — no silent fallback. */
  liveProfile?: {
    orgUrl: string;
    friendlyName: string;
  };

  isControlDisabled?: boolean;

  /** Per-dataset binding map: host type + parent ref + view. Keyed by manifest
   *  dataSet name. Omitted on legacy scenarios — `applyScenarioToStore` will
   *  synthesise a homegrid + all-columns default for any declared dataset that
   *  doesn't have an entry, preserving pre-P0 behaviour. */
  datasetBindings?: DatasetBindingMap;

  /** When true, the `pcfworkbench batch` CLI skips this scenario during
   *  headless loop/visual-regression runs. Optional; defaults to false
   *  (scenario is included). Has no effect on the interactive harness. */
  skipInBatch?: boolean;
}

/** Legacy v1 shape — kept for migration only. Do not import outside this file. */
interface TestScenarioV1 {
  name: string;
  description?: string;
  savedAt: string;
  propertyValues: Record<string, any>;
  fieldBindings?: Record<string, string>;
  pageEntityId: string;
  pageEntityTypeName: string;
  pageEntityRecordName?: string;
  networkMode: string;
  devicePreset: string;
  isControlDisabled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

export function scenariosStorageKey(controlId: string): string {
  return `pcf-workbench-scenarios-${controlId}`;
}

export function activeScenarioStorageKey(controlId: string): string {
  return `pcf-workbench-active-scenario-${controlId}`;
}

export function loadScenariosFromStorage(controlId: string): TestScenario[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(scenariosStorageKey(controlId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeScenarioList(parsed);
  } catch {
    return [];
  }
}

export function saveScenariosToStorage(controlId: string, scenarios: TestScenario[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(scenariosStorageKey(controlId), JSON.stringify(scenarios));
  } catch { /* quota / disabled localStorage — silent */ }
}

/**
 * Persist scenarios to the control's on-disk `test-scenarios.json` via the
 * Vite plugin's POST endpoint. Best-effort: failures fall through so the
 * localStorage copy remains the source of truth for the session. Returns the
 * server's reported path on success, or null on failure.
 *
 * `controlId` is unused server-side (the plugin already knows which control
 * it's serving) but kept in the signature to mirror the localStorage helper
 * and make multi-control gallery futures explicit.
 */
export async function saveScenariosToDisk(_controlId: string, scenarios: TestScenario[]): Promise<string | null> {
  try {
    const body = buildScenariosFile(scenarios, getAllMetadata());
    const r = await fetch('/pcf-data/test-scenarios.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body, null, 2),
    });
    if (!r.ok) return null;
    const respBody = await r.json().catch(() => ({}));
    return respBody?.path ?? null;
  } catch {
    return null;
  }
}

export function loadActiveScenarioName(controlId: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(activeScenarioStorageKey(controlId));
  } catch {
    return null;
  }
}

export function saveActiveScenarioName(controlId: string, name: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (name === null) {
      localStorage.removeItem(activeScenarioStorageKey(controlId));
    } else {
      localStorage.setItem(activeScenarioStorageKey(controlId), name);
    }
  } catch { /* silent */ }
}

/* -------------------------------------------------------------------------- */
/* Auto-generate prompt suppression                                           */
/* -------------------------------------------------------------------------- */

/**
 * Per-control "don't ask again" preference for the first-load auto-generate
 * dialog. A global key (`pcf-workbench-suppress-autogen-all`) is also honoured
 * — Playwright/CI sets that to keep the dialog out of automated runs.
 */
export function autoGenSuppressStorageKey(controlId: string): string {
  return `pcf-workbench-suppress-autogen-${controlId}`;
}

const AUTOGEN_SUPPRESS_ALL_KEY = 'pcf-workbench-suppress-autogen-all';

export function isAutoGenPromptSuppressed(controlId: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (localStorage.getItem(AUTOGEN_SUPPRESS_ALL_KEY) === '1') return true;
    return localStorage.getItem(autoGenSuppressStorageKey(controlId)) === '1';
  } catch {
    return false;
  }
}

export function setAutoGenPromptSuppressed(controlId: string, suppressed: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = autoGenSuppressStorageKey(controlId);
    if (suppressed) {
      localStorage.setItem(key, '1');
    } else {
      localStorage.removeItem(key);
    }
  } catch { /* silent */ }
}

/* -------------------------------------------------------------------------- */
/* Migration / normalization                                                  */
/* -------------------------------------------------------------------------- */

const VALID_NETWORK_MODES: NetworkMode[] = ['online', 'offline', 'slow3g', 'fast3g', 'custom'];
const VALID_HOSTS: Array<NonNullable<ScenarioDevice['host']>> = ['Web', 'Mobile', 'Outlook', 'Teams'];

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asNetworkMode(v: unknown): NetworkMode | undefined {
  return typeof v === 'string' && (VALID_NETWORK_MODES as string[]).includes(v)
    ? (v as NetworkMode)
    : undefined;
}

function asHost(v: unknown): ScenarioDevice['host'] | undefined {
  return typeof v === 'string' && (VALID_HOSTS as string[]).includes(v)
    ? (v as ScenarioDevice['host'])
    : undefined;
}

function migrateV1ToV2(s: TestScenarioV1): TestScenario {
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name: s.name,
    description: s.description,
    savedAt: s.savedAt,
    propertyValues: s.propertyValues,
    fieldBindings: s.fieldBindings,
    pageContext: (s.pageEntityId || s.pageEntityTypeName || s.pageEntityRecordName)
      ? {
          entityId: s.pageEntityId || undefined,
          typeName: s.pageEntityTypeName || undefined,
          recordName: s.pageEntityRecordName,
        }
      : undefined,
    network: s.networkMode ? { mode: asNetworkMode(s.networkMode) ?? 'online' } : undefined,
    device: s.devicePreset ? { preset: s.devicePreset } : undefined,
    isControlDisabled: s.isControlDisabled,
    // v1 had no data/user scope — leave undefined so Load skips them.
  };
}

/**
 * Best-effort coercion of an unknown blob into a valid `TestScenario`.
 * Returns `null` if the input is unrecoverable (no name, etc).
 */
export function normalizeScenario(raw: unknown): TestScenario | null {
  if (!isObject(raw)) return null;
  const name = asString(raw.name);
  if (!name) return null;
  const savedAt = asString(raw.savedAt) ?? new Date(0).toISOString();

  // v1 detection: no `schemaVersion` AND has the legacy flat fields.
  if (raw.schemaVersion === undefined) {
    if ('pageEntityId' in raw || 'networkMode' in raw || 'devicePreset' in raw) {
      try {
        return migrateV1ToV2({
          name,
          description: asString(raw.description),
          savedAt,
          propertyValues: isObject(raw.propertyValues) ? raw.propertyValues : {},
          fieldBindings: isObject(raw.fieldBindings) ? raw.fieldBindings as Record<string, string> : undefined,
          pageEntityId: asString(raw.pageEntityId) ?? '',
          pageEntityTypeName: asString(raw.pageEntityTypeName) ?? '',
          pageEntityRecordName: asString(raw.pageEntityRecordName),
          networkMode: asString(raw.networkMode) ?? 'online',
          devicePreset: asString(raw.devicePreset) ?? 'desktop',
          isControlDisabled: asBoolean(raw.isControlDisabled) ?? false,
        });
      } catch {
        return null;
      }
    }
    // Brand-new minimal scenario (no version, no legacy fields) — treat as v2.
  }

  const v2: TestScenario = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name,
    description: asString(raw.description),
    savedAt,
    propertyValues: isObject(raw.propertyValues) ? raw.propertyValues : undefined,
    fieldBindings: isObject(raw.fieldBindings) ? raw.fieldBindings as Record<string, string> : undefined,
    isControlDisabled: asBoolean(raw.isControlDisabled),
  };

  if (isObject(raw.pageContext)) {
    const pc = raw.pageContext;
    const entityId = asString(pc.entityId);
    const typeName = asString(pc.typeName);
    const recordName = asString(pc.recordName);
    if (entityId || typeName || recordName) v2.pageContext = { entityId, typeName, recordName };
  }

  if (isObject(raw.network)) {
    const mode = asNetworkMode(raw.network.mode);
    const customLatencyMs = asNumber(raw.network.customLatencyMs);
    if (mode || customLatencyMs !== undefined) v2.network = { mode, customLatencyMs };
  }

  if (isObject(raw.device)) {
    const preset = asString(raw.device.preset);
    const containerWidth = raw.device.containerWidth === null ? null : asNumber(raw.device.containerWidth);
    const containerHeight = raw.device.containerHeight === null ? null : asNumber(raw.device.containerHeight);
    const host = asHost(raw.device.host);
    const isFullBleed = asBoolean(raw.device.isFullBleed);
    if (preset || containerWidth !== undefined || containerHeight !== undefined || host || isFullBleed !== undefined) {
      v2.device = { preset, containerWidth, containerHeight, host, isFullBleed };
    }
  }

  if (isObject(raw.userSettings)) {
    const u = raw.userSettings;
    const userSettings: ScenarioUserSettings = {
      languageId: asNumber(u.languageId),
      isRTL: asBoolean(u.isRTL),
      timeZoneOffsetMinutes: asNumber(u.timeZoneOffsetMinutes),
      userId: asString(u.userId),
      userName: asString(u.userName),
      securityRoles: Array.isArray(u.securityRoles) ? u.securityRoles.filter((r: unknown) => typeof r === 'string') : undefined,
    };
    if (Object.values(userSettings).some(v => v !== undefined)) v2.userSettings = userSettings;
  }

  if (isObject(raw.dataRecords)) v2.dataRecords = raw.dataRecords as Record<string, Record<string, any>[]>;
  if (raw.dataSource === 'mock' || raw.dataSource === 'live') v2.dataSource = raw.dataSource;

  // Preserve fields added after the initial v2 baseline. These are stored
  // as plain JSON so a shallow object check + cast is sufficient — any
  // shape mismatch is caught downstream by the consumers (applyDatasetBindings
  // tolerates partial shapes via ensureViewsLibrary / default synthesis).
  if (isObject(raw.metadata)) v2.metadata = raw.metadata as Record<string, EntityMetadata>;
  if (isObject(raw.liveProfile)) {
    const orgUrl = asString(raw.liveProfile.orgUrl);
    const friendlyName = asString(raw.liveProfile.friendlyName);
    if (orgUrl && friendlyName) v2.liveProfile = { orgUrl, friendlyName };
  }
  if (isObject(raw.datasetBindings)) {
    v2.datasetBindings = raw.datasetBindings as DatasetBindingMap;
  }
  if (raw.skipInBatch === true) v2.skipInBatch = true;

  return v2;
}

export function normalizeScenarioList(raw: unknown): TestScenario[] {
  if (!Array.isArray(raw)) return [];
  const out: TestScenario[] = [];
  for (const entry of raw) {
    const norm = normalizeScenario(entry);
    if (norm) out.push(norm);
    else if (import.meta.env?.DEV) {
      console.warn('[scenario-store] dropping unrecognizable scenario entry', entry);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* File shape (schemaVersion 3): scenarios + shared metadata                  */
/* -------------------------------------------------------------------------- */

export const SCENARIOS_FILE_SCHEMA_VERSION = 3 as const;

export interface ScenariosFile {
  /** Scenarios (always normalized to v2). */
  scenarios: TestScenario[];
  /** Org-wide entity metadata (logical-name → schema). Optional. */
  metadata: Record<string, EntityMetadata> | null;
}

/**
 * Parse the on-disk `test-scenarios.json` body, accepting both shapes:
 *
 *   - v3 object:  `{ schemaVersion: 3, metadata: {...}, scenarios: [...] }`
 *   - v2 legacy:  bare `TestScenario[]` array
 *
 * Returns null only when `raw` is fundamentally not parseable.
 */
export function parseScenariosFile(raw: unknown): ScenariosFile {
  if (Array.isArray(raw)) {
    return { scenarios: normalizeScenarioList(raw), metadata: null };
  }
  if (raw && typeof raw === 'object') {
    const r = raw as { scenarios?: unknown; metadata?: unknown };
    const scenarios = Array.isArray(r.scenarios) ? normalizeScenarioList(r.scenarios) : [];
    const metadata = r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
      ? (r.metadata as Record<string, EntityMetadata>)
      : null;
    return { scenarios, metadata };
  }
  return { scenarios: [], metadata: null };
}

/**
 * Build the v3 file body for writing. Always embeds the current metadata
 * snapshot when one is provided (typically `getAllMetadata()`), so the
 * folded file remains a single source of truth.
 */
export function buildScenariosFile(
  scenarios: TestScenario[],
  metadata: Record<string, EntityMetadata> | null,
): unknown {
  const body: Record<string, unknown> = {
    schemaVersion: SCENARIOS_FILE_SCHEMA_VERSION,
    scenarios,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Name generation                                                            */
/* -------------------------------------------------------------------------- */

const TEST_SCENARIO_NAME_RE = /^Test scenario (\d+)$/;

/** Sequential `Test scenario N` names that don't collide with `existing`. */
export function nextTestScenarioNames(existing: TestScenario[], count: number): string[] {
  let maxIndex = 0;
  for (const s of existing) {
    const m = s.name.match(TEST_SCENARIO_NAME_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxIndex) maxIndex = n;
    }
  }
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(`Test scenario ${maxIndex + i}`);
  return out;
}

/** "Foo" → "Foo (copy)", "Foo (copy 2)", ... until unique against `existing`. */
export function findUniqueCopyName(existing: TestScenario[], base: string): string {
  const taken = new Set(existing.map(s => s.name));
  let candidate = `${base} (copy)`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} (copy ${n})`;
    n++;
  }
  return candidate;
}

/* -------------------------------------------------------------------------- */
/* Default scenario builder (used by first-load "No thanks" path + + New)     */
/* -------------------------------------------------------------------------- */

/**
 * Build a "Default" scenario from manifest defaults + current page context
 * defaults. Used when the user dismisses the first-load auto-prompt — we
 * never want a zero-scenarios state.
 */
export function buildDefaultScenario(
  manifest: ManifestConfig | null,
  name = 'Default',
): TestScenario {
  const propertyValues: Record<string, any> = {};
  if (manifest) {
    for (const p of manifest.properties) {
      const def = (p as ManifestProperty).defaultValue;
      if (def !== undefined && def !== null && def !== '') {
        propertyValues[p.name] = def;
      } else {
        const generated = defaultValueFor(p as ManifestProperty);
        if (generated !== undefined) propertyValues[p.name] = generated;
      }
    }
  }
  // Capture a snapshot of the current mock entity store. On first launch
  // ScenarioHeader seeds the store from any legacy data.json before calling
  // this helper, so the resulting Default scenario is fully self-contained
  // (data.json content is migrated into the scenario on disk and no longer
  // re-read at runtime).
  const dataRecords = getMockEntityDataSnapshot();
  const hasData = Object.keys(dataRecords).length > 0;
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name,
    description: 'Auto-created baseline. Edit any tab and Save to capture it.',
    savedAt: new Date().toISOString(),
    propertyValues,
    isControlDisabled: false,
    dataSource: 'mock',
    dataRecords: hasData ? dataRecords : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Legacy data.json bootstrap                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One-shot fetch of the control's legacy `data.json` and seed it into the
 * mock entity store. Returns `true` if data was loaded.
 *
 * `data.json` is **deprecated** as a runtime source: scenarios are now the
 * only on-disk source of truth for mock entity data. This helper exists
 * solely to migrate first-launch / pre-v2 controls — it's invoked once at
 * boot when no scenario carries `dataRecords`. After the next Save the
 * scenario captures the data and `data.json` is never read again.
 *
 * Failures are silent (best-effort); the harness still works without it.
 */
export async function bootstrapLegacyDataJson(): Promise<boolean> {
  try {
    const r = await fetch('/pcf-data/data.json');
    if (!r.ok) return false;
    const json = await r.json();
    if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
    const keys = Object.keys(json);
    if (keys.length === 0) return false;
    const shouldRebase = useHarnessStore.getState().rebaseDatesToToday;
    const finalData = shouldRebase ? rebaseDatesToToday(json) : (json as Record<string, Record<string, any>[]>);
    replaceMockEntityData(finalData);
    const recordCount = Object.values(finalData).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    );
    console.log(
      `[pcf-workbench] Migrated legacy data.json into mock store: ${keys.length} tables, ${recordCount} records${shouldRebase ? ' (dates rebased)' : ''}. ` +
      `On next Save these records become part of the active scenario; data.json will not be read again.`,
    );
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Capture / apply                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Capture the current harness state into a TestScenario v2. Used by 💾 Save.
 * Live-mode safety: when `dataSource === 'live'` we record the mode but NOT
 * the live records (rubber-duck #4).
 */
export function captureScenarioFromStore(name: string, savedAt = new Date().toISOString()): TestScenario {
  const s = useHarnessStore.getState();
  const dataSource: 'mock' | 'live' = s.dataSource === 'live' ? 'live' : 'mock';
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name,
    savedAt,
    propertyValues: { ...s.propertyValues },
    pageContext: {
      entityId: s.pageEntityId || undefined,
      typeName: s.pageEntityTypeName || undefined,
      recordName: s.pageEntityRecordName || undefined,
    },
    network: { mode: s.networkMode, customLatencyMs: s.customLatencyMs },
    device: {
      preset: s.devicePreset,
      containerWidth: s.containerWidth,
      containerHeight: s.containerHeight,
      host: s.host,
      isFullBleed: s.isFullBleed,
    },
    userSettings: {
      languageId: s.userLanguageId,
      isRTL: s.userIsRTL,
      timeZoneOffsetMinutes: s.userTimeZoneOffsetMinutes,
      userId: s.userId,
      userName: s.userName,
      securityRoles: [...s.userSecurityRoles],
    },
    isControlDisabled: s.isControlDisabled,
    dataSource,
    dataRecords: dataSource === 'mock' ? getMockEntityDataSnapshot() : undefined,
    liveProfile: dataSource === 'live' && s.liveProfile
      ? { orgUrl: s.liveProfile.orgUrl, friendlyName: s.liveProfile.friendlyName }
      : undefined,
    metadata: (() => {
      const m = getAllMetadata();
      return Object.keys(m).length > 0 ? m : undefined;
    })(),
    datasetBindings: Object.keys(s.datasetBindings).length > 0
      ? JSON.parse(JSON.stringify(s.datasetBindings))
      : undefined,
  };
}

/**
 * Resolve property values by walking fieldBindings against the loaded entity
 * record. Pure (no store writes). Falls back to plain `propertyValues`.
 *
 * H3 — Defaults every manifest property that the scenario didn't list, so
 * controls that read `context.parameters.<prop>.raw` for a prop the scenario
 * forgot don't crash with `Cannot read properties of undefined (reading raw)`.
 * Defaulted values come from `defaultValueFor()`, the same heuristic the
 * scenario generator uses, so the typed `.raw` shape always matches what
 * the property type expects.
 */
export function resolveScenarioValues(scenario: TestScenario): Record<string, any> {
  const base = { ...(scenario.propertyValues ?? {}) };

  // Backfill any manifest property the scenario omitted. This is harmless
  // for scenarios that listed every property — only missing keys get filled.
  const manifest = useHarnessStore.getState().manifest;
  if (manifest?.properties) {
    for (const prop of manifest.properties) {
      if (!(prop.name in base)) {
        const def = defaultValueFor(prop);
        if (def !== undefined) base[prop.name] = def;
      }
    }
  }

  const pc = scenario.pageContext;
  if (!scenario.fieldBindings || !pc?.entityId || !pc.typeName) return base;

  const records = getEntityData(pc.typeName);
  const normalId = pc.entityId.replace(/[{}]/g, '').toLowerCase();
  const record = records.find(r => {
    for (const key of Object.keys(r)) {
      if ((key.toLowerCase().endsWith('id') || key === 'id') &&
          String((r as any)[key]).replace(/[{}]/g, '').toLowerCase() === normalId) {
        return true;
      }
    }
    return false;
  }) as any;
  if (!record) return base;

  for (const [propName, columnName] of Object.entries(scenario.fieldBindings)) {
    const val = record[columnName];
    if (val !== undefined) base[propName] = val;
    const formatted = record[`_${columnName}_value@OData.Community.Display.V1.FormattedValue`]
      ?? record[`${columnName}@OData.Community.Display.V1.FormattedValue`];
    const lookupVal = record[`_${columnName}_value`] ?? record[columnName];
    if (formatted && typeof lookupVal === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}/.test(lookupVal)) {
      base[propName] = [{ id: lookupVal, name: formatted, entityType: columnName }];
    }
  }
  return base;
}

/**
 * Apply a scenario to the harness store. Every domain is skipped if absent
 * on the scenario (NEVER overwrite a live store from `undefined`). The
 * caller is responsible for wrapping this in a dirty-suppression block
 * if running inside an active-scenario context.
 */
export function applyScenarioToStore(scenario: TestScenario): void {
  const resolvedValues = resolveScenarioValues(scenario);
  const s = useHarnessStore.getState();

  // Properties: always replace (clean slate). Empty propertyValues + manifest
  // → just clears; the manifest defaults are reapplied by the caller via
  // resetScenarioDefaults if that's the intent.
  if (scenario.propertyValues !== undefined) {
    s.replacePropertyValues(resolvedValues);
  }

  if (scenario.pageContext) {
    if (scenario.pageContext.entityId !== undefined) s.setPageEntityId(scenario.pageContext.entityId);
    if (scenario.pageContext.typeName !== undefined) s.setPageEntityTypeName(scenario.pageContext.typeName);
    if (scenario.pageContext.recordName !== undefined) s.setPageEntityRecordName(scenario.pageContext.recordName);
  }

  if (scenario.network) {
    if (scenario.network.mode !== undefined) s.setNetworkMode(scenario.network.mode);
    if (scenario.network.customLatencyMs !== undefined) s.setCustomLatencyMs(scenario.network.customLatencyMs);
  }

  // Device — apply is always idempotent. Missing scenario.device or
  // missing individual fields reset to harness defaults (desktop, fluid,
  // Web host, not full-bleed). Without this, scenarios saved before device
  // capture existed (or hand-edited JSON) would inherit whatever device
  // state the previously-active scenario left behind, so switching A → B → A
  // would not return A to the same visual state as a page refresh.
  {
    const d = scenario.device ?? {};
    s.setDevicePreset(d.preset ?? 'desktop');
    s.setContainerWidth(d.containerWidth ?? null);
    s.setContainerHeight(d.containerHeight ?? null);
    s.setHost(d.host ?? 'Web');
    s.setFullBleed(d.isFullBleed ?? false);
  }

  if (scenario.userSettings) {
    const u = scenario.userSettings;
    if (u.languageId !== undefined) s.setUserLanguageId(u.languageId);
    if (u.isRTL !== undefined) s.setUserIsRTL(u.isRTL);
    if (u.timeZoneOffsetMinutes !== undefined) s.setUserTimeZoneOffsetMinutes(u.timeZoneOffsetMinutes);
    if (u.userId !== undefined) s.setUserId(u.userId);
    if (u.userName !== undefined) s.setUserName(u.userName);
    if (u.securityRoles !== undefined) s.setUserSecurityRoles(u.securityRoles);
  }

  if (scenario.isControlDisabled !== undefined) s.setControlDisabled(scenario.isControlDisabled);

  // Data source — honour scenario's pinned mode (P3). Switching to live is
  // safe even without a profile: the live web-api branch surfaces a clean
  // "Live mode requires a selected PAC profile" error instead of silently
  // failing, and the LiveModeControls UI guides the user to pick one.
  if (scenario.dataSource !== undefined && scenario.dataSource !== s.dataSource) {
    s.setDataSource(scenario.dataSource);
  }

  // Live profile pin — match by orgUrl (durable) first, then friendlyName as
  // a fallback for cross-machine portability. Auto-select only when the
  // scenario is in live mode AND the profile is available on this machine.
  // Mismatch sets a banner via setLivePageRecordError so the user knows to
  // re-auth or pick a different env. We compare against `s.liveProfiles`,
  // which is populated by DataPanel's listProfiles effect on first mount —
  // if it's empty (e.g. apply runs before profiles load), the scenario's
  // localStorage hint takes over via the existing pcf.liveOrgUrl restore.
  if (scenario.dataSource === 'live' && scenario.liveProfile) {
    const wanted = scenario.liveProfile;
    // Write the wanted orgUrl to localStorage so DataPanel's listProfiles
    // effect (which restores `pcf.liveOrgUrl` after fetching profiles)
    // picks THIS scenario's profile, not whatever the previous session
    // had selected. Apply path is the source of truth for "what to load".
    try { localStorage.setItem('pcf.liveOrgUrl', wanted.orgUrl); } catch { /* ignore */ }
    const available = s.liveProfiles ?? [];
    const matchByUrl = available.find(p => p.orgUrl === wanted.orgUrl);
    const matchByName = !matchByUrl
      ? available.find(p => p.friendlyName === wanted.friendlyName)
      : null;
    const chosen = matchByUrl ?? matchByName ?? null;
    if (chosen && chosen.orgUrl !== s.liveProfile?.orgUrl) {
      s.setLiveProfile(chosen);
    } else if (!chosen && available.length > 0) {
      // Profiles loaded but none match — surface a banner.
      s.setLivePageRecordError(
        `Scenario "${scenario.name}" was authored against PAC profile "${wanted.friendlyName}" (${wanted.orgUrl}), which isn't available on this machine. Pick an available environment from the Live profile dropdown.`,
      );
    }
    // If `available.length === 0`, profiles haven't loaded yet — the
    // localStorage hint (pcf.liveOrgUrl) we just wrote will be picked up
    // by DataPanel's listProfiles callback once they load.
  }

  // Data records — only when mock and present. Live mode is opted out at Save.
  if (scenario.dataRecords && scenario.dataSource !== 'live') {
    replaceMockEntityData(scenario.dataRecords);
  }

  // Metadata snapshot — applies in both mock and live mode. In live mode it
  // primes the cache so getEntityMetadata() resolves synchronously without
  // a round-trip; live EntityDefinitions fetches will overwrite per-entity.
  if (scenario.metadata && Object.keys(scenario.metadata).length > 0) {
    replaceAllMetadata(scenario.metadata);
  }

  // Re-seed form state for the (new) page entity so getAttribute/getControl
  // reflect the loaded record's columns without remounting the control.
  const pc = scenario.pageContext;
  if (pc?.typeName) {
    reseedForPageEntity(pc.typeName, pc.entityId ?? '', pc.recordName ?? '');
  }

  // Dataset bindings (P0). Always reapply — even when absent on the scenario
  // we want to clear stale bindings from the previous scenario and synthesise
  // homegrid + all-columns defaults for each declared dataset so the control
  // sees a consistent shape. Migration: legacy scenarios (no `datasetBindings`)
  // get the default; new scenarios overlay on top of the default for any
  // dataset they didn't explicitly bind.
  applyDatasetBindings(scenario.datasetBindings);

  s.addLogEntry({ category: 'scenario', method: 'load', args: { name: scenario.name } });
}

/**
 * Resolve the binding map to apply for a scenario:
 *  - Start with a synthesised default per manifest dataset (homegrid, all columns visible).
 *  - Overlay the scenario's explicit bindings (if any).
 *  - Replace the store map in one shot.
 *
 * Exported for unit tests. The synthesised default keeps pre-P0 behaviour
 * (no parent filter, all columns) so legacy scenarios keep working unchanged.
 */
export function applyDatasetBindings(explicit: DatasetBindingMap | undefined): void {
  const s = useHarnessStore.getState();
  const manifest = s.manifest;
  const merged: DatasetBindingMap = {};
  if (manifest?.dataSets?.length) {
    for (const ds of manifest.dataSets) {
      const entityType = manifest.constructor; // best-effort; refined in P1
      merged[ds.name] = synthesizeDefaultBinding(
        ds.name,
        entityType,
        ds.columns.map(c => c.name),
      );
    }
  }
  if (explicit) {
    for (const [name, binding] of Object.entries(explicit)) {
      merged[name] = ensureViewsLibrary(binding);
    }
  }
  s.replaceDatasetBindings(merged);
}

/* -------------------------------------------------------------------------- */
/* Transactional apply (active-scenario aware)                                */
/* -------------------------------------------------------------------------- */

/**
 * Apply `scenario` as the new active scenario. Wraps the cascade of scoped
 * setters in `withDirtySuppression` so the auto-dirty subscription doesn't
 * flag the freshly-loaded scenario as modified (rubber-duck #1). Also
 * persists the active-scenario name per control so reloads land back in
 * the same scenario.
 */
export function applyScenarioAsActive(controlId: string, scenario: TestScenario): void {
  const store = useHarnessStore.getState();
  store.withDirtySuppression(() => {
    applyScenarioToStore(scenario);
    store.setActiveScenarioName(scenario.name);
  });
  // setActiveScenarioName already clears isDirty, but be explicit so any
  // out-of-band markDirty queued before this returns is overridden.
  useHarnessStore.getState().clearDirty();
  saveActiveScenarioName(controlId, scenario.name);
}

/**
 * Reset the active scenario back to manifest defaults — equivalent to
 * loading a brand-new "Default" scenario but without persisting it yet.
 * The caller (typically `+ New` action) is responsible for capturing +
 * upserting the resulting state under the new scenario name.
 */
export function resetScenarioDefaults(
  controlId: string,
  manifest: import('../types/manifest').ManifestConfig,
  newName: string,
): TestScenario {
  const fresh = buildDefaultScenario(manifest, newName);
  applyScenarioAsActive(controlId, fresh);
  return fresh;
}

/* -------------------------------------------------------------------------- */
/* Capture-as-new helper (used by DataPanel "Capture as new scenario")        */
/* -------------------------------------------------------------------------- */

/**
 * Capture the current harness state as a fresh scenario, persist it to
 * localStorage + disk, make it the active scenario, and bump
 * `scenariosListVersion` so any external scenario list view refreshes.
 *
 * If a scenario with `name` already exists, a unique suffix is appended
 * (e.g. "Live capture 2026-06-01 13:14 (1)") so we never overwrite.
 */
export async function captureAndSaveAsNewScenario(
  controlId: string,
  baseName: string,
): Promise<TestScenario> {
  const list = await loadAllScenarios(controlId);
  const uniqueName = list.some(s => s.name === baseName)
    ? findUniqueCopyName(list, baseName)
    : baseName;
  const snap = captureScenarioFromStore(uniqueName);
  const next = upsertScenario(list, snap);
  saveScenariosToStorage(controlId, next);
  const diskPath = await saveScenariosToDisk(controlId, next);
  if (diskPath === null) {
    console.warn('[scenario-store] captureAndSaveAsNewScenario: disk write failed; localStorage holds the change.');
  }
  applyScenarioAsActive(controlId, snap);
  useHarnessStore.getState().bumpScenariosListVersion();
  return snap;
}

/* -------------------------------------------------------------------------- */
/* URL ?scenario=<name> auto-loader support                                   */
/* -------------------------------------------------------------------------- */

/**
 * Find a scenario by name. localStorage wins over the on-disk
 * test-scenarios.json (user-modified scenarios trump file defaults).
 */
export async function findScenarioByName(
  controlId: string,
  name: string,
): Promise<TestScenario | null> {
  const local = loadScenariosFromStorage(controlId);
  const localHit = local.find(s => s.name === name);
  if (localHit) return localHit;

  try {
    const r = await fetch('/pcf-data/test-scenarios.json');
    if (r.ok) {
      const { scenarios, metadata } = parseScenariosFile(await r.json());
      if (metadata) loadMetadata(metadata);
      const hit = scenarios.find(s => s.name === name);
      if (hit) return hit;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Merge localStorage + on-disk scenarios for a control. Local wins when names
 * collide and the local `savedAt` is newer. Used by the side-panel loader.
 *
 * Also hydrates the metadata store from the on-disk file's `metadata` block
 * (v3 shape) when present — folding `metadata.json` into the same file as
 * scenarios is the canonical v3 layout. Legacy v2 array files still load;
 * App.tsx's fallback fetch of `/pcf-data/metadata.json` covers those.
 */
export async function loadAllScenarios(controlId: string): Promise<TestScenario[]> {
  const local = loadScenariosFromStorage(controlId);
  let file: TestScenario[] = [];
  try {
    const r = await fetch('/pcf-data/test-scenarios.json');
    if (r.ok) {
      const parsed = parseScenariosFile(await r.json());
      file = parsed.scenarios;
      if (parsed.metadata) loadMetadata(parsed.metadata);
    }
  } catch { /* ignore */ }

  const merged: TestScenario[] = [];
  for (const fileSc of file) {
    const localSc = local.find(l => l.name === fileSc.name);
    merged.push(localSc && localSc.savedAt > fileSc.savedAt ? localSc : fileSc);
  }
  for (const s of local) {
    if (!merged.find(m => m.name === s.name)) merged.push(s);
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Rename / Delete                                                            */
/* -------------------------------------------------------------------------- */

export function renameScenario(scenarios: TestScenario[], oldName: string, newName: string): TestScenario[] {
  if (oldName === newName) return scenarios;
  if (scenarios.some(s => s.name === newName)) {
    throw new Error(`A scenario named "${newName}" already exists.`);
  }
  return scenarios.map(s => s.name === oldName ? { ...s, name: newName, savedAt: new Date().toISOString() } : s);
}

export function deleteScenario(scenarios: TestScenario[], name: string): TestScenario[] {
  return scenarios.filter(s => s.name !== name);
}

/** Replace-or-append by name. */
export function upsertScenario(scenarios: TestScenario[], scenario: TestScenario): TestScenario[] {
  const idx = scenarios.findIndex(s => s.name === scenario.name);
  if (idx >= 0) {
    const out = [...scenarios];
    out[idx] = scenario;
    return out;
  }
  return [...scenarios, scenario];
}
