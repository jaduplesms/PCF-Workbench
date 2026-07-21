/**
 * Form state store backing the formContext shim (M1.P1).
 *
 * Mirrors the runtime state a model-driven form keeps: attributes (with
 * onChange handlers), controls (visibility, disabled, notifications, options),
 * tabs/sections (visibility, focus, label, displayState), and form-level
 * handlers (onLoad / onSave / onPostSave).
 *
 * Seeded from the active record in `data-store` plus the manifest's bound
 * properties on first call to `seedFormState`.
 */

import type { ManifestConfig } from '../types/manifest';
import { getEntityData } from './data-store';
import { getEntityMetadata, getAllEntityTypes, getColumnDisplayName } from './metadata-store';

export type RequiredLevel = 'none' | 'recommended' | 'required';
export type DisplayState = 'expanded' | 'collapsed';
export type FormType = 0 | 1 | 2 | 3 | 4 | 6 | 11; // Undefined / Create / Update / ReadOnly / Disabled / BulkEdit / ReadOptimized
export type NotificationLevel = 'ERROR' | 'WARNING' | 'RECOMMENDATION';

export interface AttributeState {
  name: string;
  value: any;
  initialValue: any;
  requiredLevel: RequiredLevel;
  attributeType: string; // 'string' | 'integer' | 'datetime' | 'lookup' | 'optionset' | 'boolean' | 'decimal' | …
  isDirty: boolean;
  submitMode: 'always' | 'never' | 'dirty';
  format?: string;
  maxLength?: number;
  // options for optionsets
  options?: Array<{ value: number; text: string }>;
  /** Friendly display label for the field (from metadata, else a humanised
   *  logical name). Shown in the Form panel instead of the raw logical name. */
  displayName?: string;
  /** For lookup fields: the target entity logical name (from the record's
   *  `@Microsoft.Dynamics.CRM.lookuplogicalname` annotation or metadata). */
  lookupTarget?: string;
  /** Friendly current value (from the record's
   *  `@OData.Community.Display.V1.FormattedValue` annotation) — e.g. the option
   *  label or the lookup's display name, so the UI needn't resolve a GUID. */
  formattedValue?: string;
}

export interface ControlNotification {
  notificationLevel?: NotificationLevel;
  uniqueId: string;
  messages: string[];
  actions?: Array<{ message?: string; actions?: Array<() => void> }>;
}

export interface ControlState {
  name: string;
  attributeName?: string; // null for sub-grids etc.
  controlType: string; // 'standard' | 'subgrid' | 'iframe' | 'kbsearch' | …
  visible: boolean;
  disabled: boolean;
  label?: string;
  notifications: Map<string, ControlNotification>;
}

export interface SectionState {
  name: string;
  label?: string;
  visible: boolean;
  parentTab: string;
  controls: string[];
}

export interface TabState {
  name: string;
  label?: string;
  visible: boolean;
  displayState: DisplayState;
  focused: boolean;
  sections: string[];
}

export type AttrChangeHandler = (executionContext: any) => void;
export type FormHandler = (executionContext: any) => void;

interface FormStateInternal {
  attributes: Map<string, AttributeState>;
  controls: Map<string, ControlState>;
  tabs: Map<string, TabState>;
  sections: Map<string, SectionState>;
  attrChangeHandlers: Map<string, Set<AttrChangeHandler>>;
  onLoadHandlers: Set<FormHandler>;
  onSaveHandlers: Set<FormHandler>;
  onPostSaveHandlers: Set<FormHandler>;
  formType: FormType;
  formId: string;
  primaryAttributeName?: string;
  sharedVariables: Map<string, any>;
}

const state: FormStateInternal = {
  attributes: new Map(),
  controls: new Map(),
  tabs: new Map(),
  sections: new Map(),
  attrChangeHandlers: new Map(),
  onLoadHandlers: new Set(),
  onSaveHandlers: new Set(),
  onPostSaveHandlers: new Set(),
  formType: 2, // Update
  formId: '00000000-0000-0000-0000-000000000000',
  sharedVariables: new Map(),
};

interface LastSeed {
  manifest: ManifestConfig;
  pageEntityTypeName: string;
  pageEntityId: string;
  pageEntityRecordName: string;
}
let lastSeed: LastSeed | null = null;

/**
 * Re-run the previous seed with updated page-entity context. No-op if
 * seedFormState has never been called. Called by scenario loads + page-entity
 * edits so getAttribute/getControl reflect the new record without requiring
 * the host to re-mount the control.
 */
export function reseedForPageEntity(
  pageEntityTypeName: string,
  pageEntityId: string,
  pageEntityRecordName: string,
): void {
  if (!lastSeed) return;
  if (
    lastSeed.pageEntityTypeName === pageEntityTypeName
    && lastSeed.pageEntityId === pageEntityId
    && lastSeed.pageEntityRecordName === pageEntityRecordName
  ) return;
  seedFormState(lastSeed.manifest, pageEntityTypeName, pageEntityId, pageEntityRecordName);
}

const listeners = new Set<() => void>();
let storeVersion = 0;

function notify(): void {
  storeVersion += 1;
  for (const l of listeners) {
    try { l(); } catch (e) { console.error('[pcf-workbench] form-store listener error', e); }
  }
}

export function subscribeFormState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFormStateVersion(): number {
  return storeVersion;
}

// ──────────────────────────────────────────────────────────────────────────
// Seeding
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map a Dataverse `AttributeType` string (as returned by EntityDefinitions ->
 * Attributes) to the form-store's attributeType vocabulary. Used when seeding
 * attributes from entity-metadata for columns the active record doesn't set.
 */
function mapMetadataAttrType(dvType?: string): string {
  if (!dvType) return 'string';
  switch (dvType) {
    case 'Boolean': return 'boolean';
    case 'DateTime': return 'datetime';
    case 'Decimal': return 'decimal';
    case 'Double': return 'decimal';
    case 'Integer':
    case 'BigInt': return 'integer';
    case 'Money': return 'money';
    case 'Lookup':
    case 'Customer':
    case 'Owner': return 'lookup';
    case 'Picklist':
    case 'State':
    case 'Status': return 'optionset';
    case 'MultiSelectPicklist': return 'multiselectoptionset';
    case 'Memo': return 'memo';
    case 'String':
    case 'Uniqueidentifier':
    case 'EntityName':
    default: return 'string';
  }
}

/** OData annotation suffixes present on mock/live records. */
const FORMATTED_VALUE_SUFFIX = '@OData.Community.Display.V1.FormattedValue';
const LOOKUP_LOGICALNAME_SUFFIX = '@Microsoft.Dynamics.CRM.lookuplogicalname';

/** Turn a logical name into a friendly label as a fallback when metadata has no
 *  display name. `msdyn_bookingmethod` → "Booking Method", `_x_value` handled by
 *  the caller (stripped first). Best-effort only; metadata display names win. */
function humanizeLogicalName(logical: string): string {
  let s = logical;
  // Strip a publisher prefix like `msdyn_`, `jdp_`, `new_` (but not a bare word).
  const us = s.indexOf('_');
  if (us > 0 && us <= 8 && us < s.length - 1) s = s.slice(us + 1);
  s = s.replace(/id$/i, '').replace(/[_]+/g, ' ').trim();
  if (!s) return logical;
  // Split camelCase and title-case each word.
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Prefer a real metadata display name; fall back to a humanised logical name
 *  when metadata is absent OR the "display name" is just the logical name
 *  (Dataverse returns the logical name for columns with no localized label,
 *  e.g. denormalised `*name` columns). */
function resolveDisplayName(colName: string, metaDisplayName?: string | null): string {
  return metaDisplayName && metaDisplayName !== colName
    ? metaDisplayName
    : humanizeLogicalName(colName);
}

function inferAttrType(value: any, ofType?: string): string {
  if (ofType) {
    const t = ofType.toLowerCase();
    if (t.includes('lookup')) return 'lookup';
    if (t.includes('optionset')) return 'optionset';
    if (t === 'twooptions' || t === 'boolean') return 'boolean';
    if (t === 'datetime' || t === 'datentime') return 'datetime';
    if (t === 'decimal') return 'decimal';
    if (t === 'whole.none' || t === 'integer') return 'integer';
    if (t === 'currency') return 'money';
    if (t.includes('multiple')) return 'memo';
    return 'string';
  }
  if (value == null) return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  if (value instanceof Date) return 'datetime';
  return 'string';
}

/**
 * Seed the form state from the manifest and the active record in data-store.
 * Idempotent — calling again resets the form to its initial state.
 */
export function seedFormState(
  manifest: ManifestConfig,
  pageEntityTypeName: string,
  pageEntityId: string,
  pageEntityRecordName: string,
): void {
  lastSeed = { manifest, pageEntityTypeName, pageEntityId, pageEntityRecordName };
  state.attributes.clear();
  state.controls.clear();
  state.tabs.clear();
  state.sections.clear();
  state.attrChangeHandlers.clear();
  state.onLoadHandlers.clear();
  state.onSaveHandlers.clear();
  state.onPostSaveHandlers.clear();
  state.sharedVariables.clear();
  state.formType = pageEntityId ? 2 : 1; // Update if there's an id, Create otherwise
  state.formId = '00000000-0000-0000-0000-000000000000';

  // Find the active record in data.json
  const records = pageEntityTypeName ? getEntityData(pageEntityTypeName) : [];
  const active = pageEntityId
    ? records.find(r =>
        Object.keys(r).some(k => k.toLowerCase() === `${pageEntityTypeName}id` && String(r[k]).toLowerCase() === pageEntityId.toLowerCase()),
      )
    : records[0];

  // Pre-resolve entity metadata once so we can prefer metadata-declared
  // attribute types over value-inferred ones (e.g. an optionset value of
  // 690970001 is an integer to inferAttrType but really a 'optionset', and
  // a money value rounded to 1875 is integer-shaped but really 'money').
  const entityMeta = pageEntityTypeName ? getEntityMetadata(pageEntityTypeName) : null;

  if (active) {
    for (const [key, raw] of Object.entries(active)) {
      // Skip OData annotation keys (foo@OData.Community.Display.V1.FormattedValue)
      if (key.includes('@')) continue;
      const isLookupValue = key.startsWith('_') && key.endsWith('_value');
      const attrName = isLookupValue ? key.slice(1, -'_value'.length) : key;
      const metaCol = entityMeta?.columns[attrName];
      const metaType = metaCol?.type;
      // Read the OData annotations that sit alongside this key. They encode the
      // lookup target entity and the friendly display value the platform would
      // otherwise resolve for us — no metadata.json required.
      const formattedValue = active[`${key}${FORMATTED_VALUE_SUFFIX}`];
      const lookupTarget = active[`${key}${LOOKUP_LOGICALNAME_SUFFIX}`];
      let attributeType = metaType ? mapMetadataAttrType(metaType) : inferAttrType(raw);
      // The `_x_value` convention is definitive: it's a lookup even when no
      // metadata is present and the raw value is just a GUID string.
      if (isLookupValue) attributeType = 'lookup';
      addAttributeInternal({
        name: attrName,
        value: raw,
        initialValue: raw,
        requiredLevel: 'none',
        attributeType,
        isDirty: false,
        submitMode: 'dirty',
        options: metaCol?.options,
        displayName: resolveDisplayName(attrName, metaCol?.displayName ?? findColumnLabelAcrossEntities(attrName)),
        lookupTarget: typeof lookupTarget === 'string' ? lookupTarget : undefined,
        formattedValue: formattedValue != null ? String(formattedValue) : undefined,
      });
    }
  }

  // Seed every column declared in entity metadata that wasn't already
  // populated from the active record. This gives controls a complete picture
  // of the form's attributes — getAttribute('msdyn_quantity') returns a real
  // attribute with the correct type from metadata even when the record has
  // no value for that column yet (Create form, sparse record, etc).
  if (entityMeta) {
    for (const [colName, col] of Object.entries(entityMeta.columns)) {
      if (state.attributes.has(colName)) continue;
      const def = col.defaultValue ?? null;
      addAttributeInternal({
        name: colName,
        value: def,
        initialValue: def,
        requiredLevel: 'none',
        attributeType: mapMetadataAttrType(col.type),
        isDirty: false,
        submitMode: 'dirty',
        options: col.options,
        displayName: resolveDisplayName(colName, col.displayName),
      });
    }
  }

  // Seed every OTHER entity's metadata columns too. Many controls (child
  // grids, bulk-add, custom form renderers) host a form for a different
  // entity than the page record. Without these extras, getAttribute on a
  // related-entity field would return null and labels would fall back to
  // logical names.
  for (const typeName of getAllEntityTypes()) {
    if (typeName === pageEntityTypeName) continue;
    const meta = getEntityMetadata(typeName);
    if (!meta) continue;
    for (const [colName, col] of Object.entries(meta.columns)) {
      if (state.attributes.has(colName)) continue;
      const def = col.defaultValue ?? null;
      addAttributeInternal({
        name: colName,
        value: def,
        initialValue: def,
        requiredLevel: 'none',
        attributeType: mapMetadataAttrType(col.type),
        isDirty: false,
        submitMode: 'dirty',
        options: col.options,
        displayName: resolveDisplayName(colName, col.displayName),
      });
    }
  }

  // Add manifest-bound properties as attributes if not already present
  for (const prop of manifest.properties) {
    if (prop.usage !== 'bound') continue;
    if (state.attributes.has(prop.name)) continue;
    addAttributeInternal({
      name: prop.name,
      value: null,
      initialValue: null,
      requiredLevel: prop.required ? 'required' : 'none',
      attributeType: inferAttrType(null, prop.ofType),
      isDirty: false,
      submitMode: 'dirty',
    });
  }

  // Heuristic primary attribute (run after data.json + manifest binding so we
  // can fall through to bound props when the active record can't be located —
  // which is the common case for field-bound PCFs whose entity isn't in
  // data.json). Preference order:
  //   1) an attribute literally named 'name' (Dataverse convention),
  //   2) the entity's <typename>name (e.g. accountname, contactname),
  //   3) the first string attribute,
  //   4) the first attribute of any kind.
  const allAttrs = Array.from(state.attributes.values());
  const conventional = pageEntityTypeName ? `${pageEntityTypeName}name` : null;
  state.primaryAttributeName =
    (state.attributes.has('name') ? 'name' : undefined)
    ?? (conventional && state.attributes.has(conventional) ? conventional : undefined)
    ?? allAttrs.find(a => a.attributeType === 'string')?.name
    ?? allAttrs[0]?.name;

  // For every attribute, register a default control of the same name.
  // Pull the human-readable label from metadata DisplayName when available
  // so controls show "Estimate Quantity" instead of "msdyn_estimatequantity".
  for (const attr of state.attributes.values()) {
    if (state.controls.has(attr.name)) continue;
    const metaLabel =
      (pageEntityTypeName ? getColumnDisplayName(pageEntityTypeName, attr.name) : null)
      ?? findColumnLabelAcrossEntities(attr.name)
      ?? attr.name;
    state.controls.set(attr.name, {
      name: attr.name,
      attributeName: attr.name,
      controlType: 'standard',
      visible: true,
      disabled: false,
      label: metaLabel,
      notifications: new Map(),
    });
  }

  // Default tab + section so getControl().getParent() lookups don't crash
  state.sections.set('general', {
    name: 'general',
    label: 'General',
    visible: true,
    parentTab: 'tab_general',
    controls: Array.from(state.controls.keys()),
  });
  state.tabs.set('tab_general', {
    name: 'tab_general',
    label: 'General',
    visible: true,
    displayState: 'expanded',
    focused: true,
    sections: ['general'],
  });

  notify();
}

function addAttributeInternal(attr: AttributeState): void {
  state.attributes.set(attr.name, attr);
  if (!state.attrChangeHandlers.has(attr.name)) {
    state.attrChangeHandlers.set(attr.name, new Set());
  }
}

/**
 * Look up the display label for a column across every entity in metadata.
 * Used when the active page entity doesn't own this column (e.g. a child
 * grid hosts attributes from a different entity).
 */
function findColumnLabelAcrossEntities(colName: string): string | null {
  for (const typeName of getAllEntityTypes()) {
    const label = getColumnDisplayName(typeName, colName);
    if (label) return label;
  }
  return null;
}

/**
 * Augment the existing form-store with metadata-backed attributes and controls
 * for `entityType` without resetting handlers, values, or other entity seeds.
 * Called by web-api.ts when the control loads a `systemform` record so its
 * target entity's columns become available via getAttribute/getControl.
 */
export function seedAdditionalEntity(entityType: string): void {
  if (!entityType) return;
  const meta = getEntityMetadata(entityType);
  if (!meta) return;
  let added = 0;
  for (const [colName, col] of Object.entries(meta.columns)) {
    if (state.attributes.has(colName)) continue;
    const def = col.defaultValue ?? null;
    addAttributeInternal({
      name: colName,
      value: def,
      initialValue: def,
      requiredLevel: 'none',
      attributeType: mapMetadataAttrType(col.type),
      isDirty: false,
      submitMode: 'dirty',
      options: col.options,
    });
    state.controls.set(colName, {
      name: colName,
      attributeName: colName,
      controlType: 'standard',
      visible: true,
      disabled: false,
      label: col.displayName ?? colName,
      notifications: new Map(),
    });
    added += 1;
  }
  if (added > 0) notify();
}

// ──────────────────────────────────────────────────────────────────────────
// Read / write helpers
// ──────────────────────────────────────────────────────────────────────────

export function getAttributeState(name: string): AttributeState | undefined {
  return state.attributes.get(name);
}

export function getControlState(name: string): ControlState | undefined {
  return state.controls.get(name);
}

export function getTabState(name: string): TabState | undefined {
  return state.tabs.get(name);
}

export function getSectionState(name: string): SectionState | undefined {
  return state.sections.get(name);
}

export function listAttributes(): AttributeState[] { return Array.from(state.attributes.values()); }
export function listControls(): ControlState[] { return Array.from(state.controls.values()); }
export function listTabs(): TabState[] { return Array.from(state.tabs.values()); }
export function listSections(): SectionState[] { return Array.from(state.sections.values()); }

export function setAttributeValue(name: string, value: any, fromHandler = false): boolean {
  const attr = state.attributes.get(name);
  if (!attr) return false;
  if (Object.is(attr.value, value)) return false;
  attr.value = value;
  attr.isDirty = !Object.is(attr.value, attr.initialValue);
  notify();
  if (!fromHandler) fireOnChange(name);
  return true;
}

export function setAttributeRequiredLevel(name: string, level: RequiredLevel): boolean {
  const attr = state.attributes.get(name);
  if (!attr) return false;
  attr.requiredLevel = level;
  notify();
  return true;
}

export function setControlVisible(name: string, visible: boolean): boolean {
  const c = state.controls.get(name);
  if (!c) return false;
  c.visible = visible;
  notify();
  return true;
}

export function setControlDisabled(name: string, disabled: boolean): boolean {
  const c = state.controls.get(name);
  if (!c) return false;
  c.disabled = disabled;
  notify();
  return true;
}

export function setControlNotification(name: string, n: ControlNotification): boolean {
  const c = state.controls.get(name);
  if (!c) return false;
  c.notifications.set(n.uniqueId, n);
  notify();
  return true;
}

export function clearControlNotification(name: string, uniqueId?: string): boolean {
  const c = state.controls.get(name);
  if (!c) return false;
  if (uniqueId) c.notifications.delete(uniqueId); else c.notifications.clear();
  notify();
  return true;
}

export function setTabVisible(name: string, visible: boolean): boolean {
  const t = state.tabs.get(name);
  if (!t) return false;
  t.visible = visible;
  notify();
  return true;
}

export function setTabDisplayState(name: string, displayState: DisplayState): boolean {
  const t = state.tabs.get(name);
  if (!t) return false;
  t.displayState = displayState;
  notify();
  return true;
}

export function setTabFocus(name: string): boolean {
  const target = state.tabs.get(name);
  if (!target) return false;
  let changed = false;
  for (const t of state.tabs.values()) {
    const shouldFocus = t.name === name;
    if (t.focused !== shouldFocus) {
      t.focused = shouldFocus;
      changed = true;
    }
  }
  if (changed) notify();
  return true;
}

export function setSectionVisible(name: string, visible: boolean): boolean {
  const s = state.sections.get(name);
  if (!s) return false;
  s.visible = visible;
  notify();
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Handler registration
// ──────────────────────────────────────────────────────────────────────────

export function addAttrOnChange(name: string, handler: AttrChangeHandler): void {
  if (!state.attrChangeHandlers.has(name)) state.attrChangeHandlers.set(name, new Set());
  state.attrChangeHandlers.get(name)!.add(handler);
}

export function removeAttrOnChange(name: string, handler: AttrChangeHandler): void {
  state.attrChangeHandlers.get(name)?.delete(handler);
}

export function fireOnChange(name: string, executionContext?: any): void {
  const handlers = state.attrChangeHandlers.get(name);
  if (!handlers || handlers.size === 0) return;
  const ctx = executionContext ?? minimalExecutionContext(name);
  for (const h of handlers) {
    try { h(ctx); } catch (e) { console.error(`[pcf-workbench] onChange(${name}) threw`, e); }
  }
}

/**
 * Minimal executionContext used when fireOnChange is triggered by a non-shim
 * mutation (e.g. the harness UI directly calling setAttributeValue). When the
 * form-context shim is active it injects a richer builder via
 * `setExecutionContextBuilder` so handlers always receive a real
 * `getFormContext()` regardless of who triggered the change.
 */
type ExecutionContextBuilder = (eventSource: string, payload: any, depth?: number) => any;
let _executionContextBuilder: ExecutionContextBuilder | null = null;
export function setExecutionContextBuilder(builder: ExecutionContextBuilder | null): void {
  _executionContextBuilder = builder;
}

function minimalExecutionContext(attrName: string): any {
  if (_executionContextBuilder) {
    return _executionContextBuilder(`attribute.${attrName}.fireOnChange`, { getName: () => attrName }, 1);
  }
  return {
    getFormContext: () => null,
    getEventSource: () => ({ getName: () => attrName }),
    getEventArgs: () => ({ isDefaultPrevented: () => false, preventDefault: () => {}, getSaveMode: () => 1 }),
    getDepth: () => 1,
    getSharedVariable: <T = any>(key: string): T | undefined => state.sharedVariables.get(key) as T | undefined,
    setSharedVariable: (key: string, value: any) => { state.sharedVariables.set(key, value); },
    getContext: () => null,
  };
}

export function addOnLoad(handler: FormHandler): void { state.onLoadHandlers.add(handler); }
export function removeOnLoad(handler: FormHandler): void { state.onLoadHandlers.delete(handler); }
export function addOnSave(handler: FormHandler): void { state.onSaveHandlers.add(handler); }
export function removeOnSave(handler: FormHandler): void { state.onSaveHandlers.delete(handler); }
export function addOnPostSave(handler: FormHandler): void { state.onPostSaveHandlers.add(handler); }
export function removeOnPostSave(handler: FormHandler): void { state.onPostSaveHandlers.delete(handler); }

export function fireOnLoad(executionContext: any): void {
  for (const h of state.onLoadHandlers) {
    try { h(executionContext); } catch (e) { console.error('[pcf-workbench] onLoad threw', e); }
  }
}

export function fireOnSave(executionContext: any): void {
  for (const h of state.onSaveHandlers) {
    try { h(executionContext); } catch (e) { console.error('[pcf-workbench] onSave threw', e); }
  }
}

export function fireOnPostSave(executionContext: any): void {
  for (const h of state.onPostSaveHandlers) {
    try { h(executionContext); } catch (e) { console.error('[pcf-workbench] onPostSave threw', e); }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Form-level metadata
// ──────────────────────────────────────────────────────────────────────────

export function getFormType(): FormType { return state.formType; }
export function setFormType(t: FormType): void { state.formType = t; notify(); }
export function getFormId(): string { return state.formId; }
export function getPrimaryAttributeName(): string | undefined { return state.primaryAttributeName; }

export function getSharedVariable<T = any>(key: string): T | undefined { return state.sharedVariables.get(key); }
export function setSharedVariable(key: string, value: any): void { state.sharedVariables.set(key, value); }

export function getFormSnapshot() {
  return {
    formType: state.formType,
    formId: state.formId,
    primaryAttributeName: state.primaryAttributeName,
    attributes: Array.from(state.attributes.values()),
    controls: Array.from(state.controls.values()),
    tabs: Array.from(state.tabs.values()),
    sections: Array.from(state.sections.values()),
    onLoadHandlerCount: state.onLoadHandlers.size,
    onSaveHandlerCount: state.onSaveHandlers.size,
    onPostSaveHandlerCount: state.onPostSaveHandlers.size,
  };
}

export function isFormDirty(): boolean {
  for (const a of state.attributes.values()) if (a.isDirty) return true;
  return false;
}

export function getDirtyAttributes(): AttributeState[] {
  return Array.from(state.attributes.values()).filter(a => a.isDirty);
}

export function resetDirty(): void {
  for (const a of state.attributes.values()) {
    a.initialValue = a.value;
    a.isDirty = false;
  }
  notify();
}
