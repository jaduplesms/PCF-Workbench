import type { ManifestConfig, ManifestProperty, ManifestDataSet } from '../types/manifest';
import type { DatasetBinding, ViewDefinition, ViewColumn, ViewSelector } from '../types/dataset-binding';
import { isResolvedView, synthesizeDefaultView } from '../types/dataset-binding';
import { fetchXmlToViewFragment } from '../lib/fetchxml-parser';
import { getCachedLiveView } from '../api/dv-client';
import type { HarnessStore } from '../store/harness-store';
import { createClientShim } from './client';
import { createDeviceShim } from './device';
import { createModeShim } from './mode';
import { createNavigationShim } from './navigation';
import { createFormattingShim } from './formatting';
import { createUserSettingsShim } from './user-settings';
import { createOrgSettingsShim } from './org-settings';
import { createUtilsShim } from './utils';
import { createResourcesShim, lookupResxString } from './resources';
import { createWebApiShim } from './web-api';
import { pushDialog, type OpenFormDialogRequest } from './dialog-bus';
import { createFluentDesignShim } from './fluent-design';
import { createCopilotShim } from './copilot';
import { createAccessibilityShim } from './accessibility';
import { createThemingShim } from './theming';
import { createReportingShim } from './reporting';
import { addEntityRecord, deleteEntityRecord, getEntityStoreKeys } from '../store/data-store';
import { getColumnDisplayName, getEntityMetadata } from '../store/metadata-store';
import { defaultDatasetState } from '../store/harness-store';
import {
  closePopupEntry,
  createPopupEntry,
  deletePopupEntry,
  getPopupsIdValue,
  openPopupEntry,
  setPopupsIdValue,
  updatePopupEntry,
} from './popup-bus';

/**
 * Build a typed parameter property based on manifest of-type.
 */
/**
 * Convert a Dataverse logical name to a human-readable display name.
 * e.g. msdyn_latitude → Latitude, starttime → Start Time, _msdyn_workorder_value → Work Order
 */
function formatDisplayName(logicalName: string): string {
  let name = logicalName;
  // Strip common prefixes
  name = name.replace(/^_/, '').replace(/_value$/, '');
  name = name.replace(/^msdyn_/, '').replace(/^cr_/, '');
  // Split on underscores and camelCase boundaries
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  name = name.replace(/_/g, ' ');
  // Capitalise each word
  return name.replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function buildProperty(prop: ManifestProperty, rawValue: any, boundColumn?: string, entityType?: string) {
  const displayName = boundColumn
    ? (entityType ? getColumnDisplayName(entityType, boundColumn) : null) ?? formatDisplayName(boundColumn)
    : prop.displayNameKey;

  // Look up column metadata for additional attributes (Format, etc.)
  let columnType: string | undefined;
  if (boundColumn && entityType) {
    const meta = getEntityMetadata(entityType);
    columnType = meta?.columns[boundColumn]?.type;
  }

  // Detect duration fields from metadata type: Integer fields named "duration" or "*duration"
  // In Dataverse, duration fields are Integer with Format="Duration"
  const isDuration = columnType === 'Integer' && boundColumn &&
    (boundColumn === 'duration' || boundColumn.endsWith('duration'));

  // Format duration minutes as "Nd Nh Nm" (matches UCI Duration display).
  // 0 → "0 minutes", 90 → "1 hour 30 minutes", 1500 → "1 day 1 hour".
  function formatDurationMinutes(mins: number): string {
    if (!Number.isFinite(mins) || mins < 0) return String(mins);
    if (mins === 0) return '0 minutes';
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    const parts: string[] = [];
    if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    return parts.join(' ');
  }

  // Default formatted: best-effort sync stringify. Special-cased per-type below.
  let baseFormatted = '';
  if (rawValue != null) {
    if (isDuration && typeof rawValue === 'number') {
      baseFormatted = formatDurationMinutes(rawValue);
    } else if (Array.isArray(rawValue) && rawValue[0]?.name) {
      // LookupValue[] — use the lookup name
      baseFormatted = String(rawValue[0].name);
    } else if (typeof rawValue === 'object') {
      // Avoid raw "[object Object]" when something slips through as an object.
      baseFormatted = '';
    } else {
      baseFormatted = String(rawValue);
    }
  }

  const base = {
    error: false,
    errorMessage: '',
    formatted: baseFormatted,
    type: prop.ofType,
    attributes: {
      LogicalName: boundColumn || prop.name,
      DisplayName: displayName,
      Type: columnType ?? prop.ofType,
      Format: isDuration ? 'Duration' : undefined,
    },
  };

  switch (prop.ofType) {
    case 'Lookup.Simple':
      return {
        ...base,
        raw: rawValue ?? null,
        getTargetEntityType: () => rawValue?.[0]?.entityType ?? '',
        getViewId: () => '',
      };

    case 'TwoOptions':
      return { ...base, raw: rawValue ?? false };

    case 'Whole.None':
    case 'FP':
    case 'Decimal':
    case 'Currency':
      return { ...base, raw: rawValue != null ? Number(rawValue) : null };

    case 'DateAndTime.DateOnly':
    case 'DateAndTime.DateAndTime':
      return { ...base, raw: rawValue ? new Date(rawValue) : null };

    case 'OptionSet':
      return { ...base, raw: rawValue != null ? Number(rawValue) : null };

    case 'SingleLine.Text':
    case 'SingleLine.Email':
    case 'SingleLine.Phone':
    case 'SingleLine.URL':
    case 'SingleLine.TextArea':
    case 'Multiple':
    default:
      // Auto-detect lookup arrays (from test scenarios or of-type-group fields)
      if (Array.isArray(rawValue) && rawValue.length > 0 && rawValue[0]?.id) {
        return {
          ...base,
          raw: rawValue,
          formatted: rawValue[0].name ?? String(rawValue[0].id),
          getTargetEntityType: () => rawValue[0].entityType ?? '',
          getViewId: () => '',
        };
      }
      return { ...base, raw: rawValue ?? null, formatted: rawValue != null ? String(rawValue) : '' };
  }
}

/**
 * Build the `dataset.columns[]` array surfaced to the control. Prefers the
 * `<property-set>` descriptors from the manifest (so controls receive real
 * `dataType` values like 'Currency', 'OptionSet', 'Lookup.Simple') and
 * falls back to the legacy data-key inference (everything `string`) only
 * when the manifest declares no columns — preserves back-compat for
 * controls authored without property-sets.
 *
 * When `view` is provided (P1+), columns are filtered + reordered to match
 * the view's column list. View-column metadata (displayName override, width,
 * sortDirection) layers on top of the manifest descriptor. Manifest columns
 * NOT in the view are dropped — this mirrors UCI, where a view's column list
 * is authoritative over the manifest's property-set superset.
 */
export function buildDatasetColumns(
  ds: ManifestDataSet,
  resolvedEntity: string,
  getEntityData: (entityType: string) => Record<string, any>[],
  typeGroups: Record<string, string[]>,
  getLcid: () => number,
  view?: ViewDefinition,
  columnBindings?: Record<string, { field: string; ofType?: string }>,
) {
  if (ds.columns && ds.columns.length > 0) {
    const manifestByName = new Map(ds.columns.map(c => [c.name, c] as const));
    // P1: view-driven column list + order. Bindings supply the view; when no
    // view is configured (or view has no columns), fall back to the manifest's
    // full column set so legacy behaviour is preserved.
    const viewColumns: ViewColumn[] = view?.columns?.length
      ? view.columns
      : ds.columns.map(c => ({ name: c.name }));

    const out: any[] = [];
    viewColumns.forEach((vc, idx) => {
      const col = manifestByName.get(vc.name);
      if (!col) return; // view referenced a column not in the manifest — skip
      // Resolve `of-type-group` to the bound type (when the maker pinned one
      // via columnBindings) or fall back to the first declared type in the
      // group. The maker-pinned type matches what real UCI surfaces; the
      // fallback preserves pre-bindings behaviour for unconfigured columns.
      let ofType = col.ofType;
      if (col.ofTypeGroup && typeGroups[col.ofTypeGroup]?.length) {
        const bound = columnBindings?.[col.name]?.ofType;
        ofType = bound && typeGroups[col.ofTypeGroup].includes(bound)
          ? bound
          : typeGroups[col.ofTypeGroup][0];
      }
      // Display name precedence: view override > RESX-resolved manifest key > column name.
      let displayName = vc.displayName;
      if (!displayName) {
        const dnk = col.displayNameKey;
        displayName = dnk ? lookupResxString(dnk, getLcid()) : col.name;
      }
      const visualSizeFactor = typeof vc.width === 'number'
        ? Math.max(0.1, vc.width / 100)
        : 1;
      out.push({
        name: col.name,
        displayName,
        dataType: mapOfTypeToDataType(ofType),
        // Alias points at the actual row field — when columnBindings re-maps
        // a property-set to a different column (e.g. ConfigColumn1 → estimateunitamount),
        // the alias is what controls inspect to figure out the underlying
        // logical name. Mirrors UCI's column.alias semantics.
        alias: columnBindings?.[col.name]?.field ?? col.name,
        order: idx,
        visualSizeFactor,
        isHidden: false,
        isPrimary: col.name.toLowerCase() === 'id' || col.name.toLowerCase().endsWith('id'),
        disableSorting: false,
      });
    });
    return out;
  }
  // Legacy fallback — synthesise columns from the first record's keys.
  const rows = getEntityData(resolvedEntity);
  const first = rows[0] ?? {};
  return Object.keys(first).map(name => ({
    name,
    displayName: name,
    dataType: 'string',
    alias: name,
    order: -1,
    visualSizeFactor: 1,
    isHidden: false,
    isPrimary: name.toLowerCase().endsWith('id'),
    disableSorting: false,
  }));
}

/**
 * Map a PCF manifest `ofType` to the runtime `dataset.columns[].dataType`
 * string that controls receive. Mirrors the values shipped by Dynamics for
 * `dataset.columns[].dataType`. Returns the input verbatim when unknown so
 * controls that switch on raw ofType strings still match.
 */
function mapOfTypeToDataType(ofType: string): string {
  switch (ofType) {
    case 'SingleLine.Text':
    case 'SingleLine.Email':
    case 'SingleLine.Phone':
    case 'SingleLine.URL':
    case 'SingleLine.TextArea':
    case 'SingleLine.Ticker':
      return ofType;
    case 'Multiple': return 'Multiple';
    case 'Whole.None': return 'Whole.None';
    case 'FP': return 'FP';
    case 'Decimal': return 'Decimal';
    case 'Currency': return 'Currency';
    case 'OptionSet': return 'OptionSet';
    case 'MultiSelectOptionSet': return 'MultiSelectOptionSet';
    case 'TwoOptions': return 'TwoOptions';
    case 'DateAndTime.DateOnly': return 'DateAndTime.DateOnly';
    case 'DateAndTime.DateAndTime': return 'DateAndTime.DateAndTime';
    case 'Lookup.Simple': return 'Lookup.Simple';
    case 'Lookup.Customer': return 'Lookup.Customer';
    case 'Lookup.Owner': return 'Lookup.Owner';
    case 'Lookup.Regarding': return 'Lookup.Regarding';
    default: return ofType;
  }
}

/**
 * Resolve the binding's view to a concrete `ViewDefinition`. Resolution
 * order, all sync (no network):
 *  1. Already a `ViewDefinition` — return as-is.
 *  2. Selector with inline `viewFetchXml` — parse via the P5.0 FetchXML
 *     parser into an ad-hoc view (entityType + columns + sort).
 *  3. Selector with `viewId` — look up in `binding.views` library first
 *     (in-scenario user-authored views always win), then fall back to the
 *     live-views cache populated by `liveListViews` for `savedquery:` /
 *     `userquery:` selectors. The Data panel triggers the async fetch
 *     before activating the binding so the cache is warm by the time the
 *     dataset shim runs.
 *  4. No resolvable view — synthesise a default from manifest columns so
 *     the dataset still has a defined shape.
 */
export function resolveViewForBinding(
  ds: ManifestDataSet,
  binding: DatasetBinding | undefined,
  fallbackEntity: string,
): ViewDefinition {
  if (binding && isResolvedView(binding.view)) {
    return binding.view;
  }

  if (binding) {
    const sel = binding.view as ViewSelector;

    // 2. Inline FetchXML — parse to ad-hoc view.
    if (sel.viewFetchXml) {
      const fragment = fetchXmlToViewFragment(sel.viewFetchXml);
      return {
        viewId: sel.viewId ?? `inline-${ds.name}`,
        displayName: 'Inline FetchXML',
        entityType: fragment.entityType || fallbackEntity,
        viewType: 'system',
        columns: fragment.columns,
        fetchXml: sel.viewFetchXml,
      };
    }

    // 3a. Selector by viewId — check the binding's local `views` library.
    if (sel.viewId && binding.views) {
      const fromLib = binding.views.find(v => v.viewId === sel.viewId);
      if (fromLib) return fromLib;
    }

    // 3b. Selector by viewId — check the live-views cache (P5.1).
    if (sel.viewId) {
      const live = getCachedLiveView(sel.viewId);
      if (live) return live;
    }
  }

  return synthesizeDefaultView(
    ds.name,
    binding?.parentRecordRef?.entityType ?? fallbackEntity,
    (ds.columns ?? []).map(c => c.name),
  );
}

/**
 * Normalise a Dataverse-style GUID (strip braces, lowercase) for FK comparison.
 * Mirrors how the WebAPI shim normalises IDs in `$filter` clauses.
 */
function normalizeGuid(id: string | undefined | null): string {
  if (id == null) return '';
  return String(id).replace(/[{}]/g, '').toLowerCase();
}

/**
 * P2 — filter rows by a parent foreign-key column. The child entity may store
 * the FK under any of the common shapes: `<col>`, `<col>id`, `_<col>_value`,
 * `_<col>id_value`. We check all of them and match against the normalised
 * parent record id.
 *
 * Exported for unit testing.
 */
export function filterByParentFk(
  rows: Record<string, any>[],
  lookupColumn: string,
  parentEntityId: string,
): Record<string, any>[] {
  const wanted = normalizeGuid(parentEntityId);
  if (!wanted) return rows;
  const candidates = [
    lookupColumn,
    `${lookupColumn}id`,
    `_${lookupColumn}_value`,
    `_${lookupColumn}id_value`,
  ];
  return rows.filter(row => {
    for (const key of candidates) {
      const v = row[key];
      if (v != null && normalizeGuid(String(v)) === wanted) return true;
    }
    return false;
  });
}

/**
 * Build a dataset shim that mimics ComponentFramework.PropertyTypes.DataSet.
 * Reads records from the entity data store using the dataset name as the entity type.
 */
function buildDataSet(
  ds: ManifestDataSet,
  getEntityData: (entityType: string) => Record<string, any>[],
  getState: () => HarnessStore,
  typeGroups: Record<string, string[]> = {},
) {
  const refreshCallbacks: Array<() => void> = [];

  const binding = getState().datasetBindings[ds.name];

  // Resolve the view ONCE up front so selector-only bindings (viewId /
  // viewFetchXml) participate in the entity / sort fallback chain below.
  // Pre-P5.2 this only ran after `getRecords` and the early `binding.view`
  // checks silently saw the unresolved selector.
  const earlyResolvedView = resolveViewForBinding(ds, binding, ds.name);

  function getRecords() {
    // Resolve the dataset entity ONCE up front from the binding. A dataset's
    // rows come from one well-defined entity — never from page context. UCI
    // never leaks the form's record into a Homegrid/Subgrid/Associated grid;
    // an empty/in-flight fetch renders empty. Falling back to
    // `pageEntityTypeName` here used to silently render the parent record as
    // a row when the dataset's own fetch hadn't landed yet (a footgun the
    // moment live mode shipped).
    //
    //   associated → binding.relationshipReferencingEntity (hard pin)
    //   subgrid    → view.entityType (parent-FK filter still applies below)
    //   homegrid   → view.entityType → ds.name → first non-empty key in store
    //                (last one is data.json compat: maker may have keyed by
    //                logical name while ds.name is an alias like
    //                "bookingRecords")
    let rawData: Record<string, any>[] = [];
    let resolvedEntity = ds.name;

    if (binding?.host === 'associated') {
      resolvedEntity = binding.relationshipReferencingEntity
        ?? earlyResolvedView.entityType
        ?? ds.name;
      rawData = getEntityData(resolvedEntity);
    } else {
      const viewEntity = earlyResolvedView.entityType;
      if (viewEntity) {
        rawData = getEntityData(viewEntity);
        if (rawData.length > 0) resolvedEntity = viewEntity;
      }
      if (rawData.length === 0) {
        rawData = getEntityData(ds.name);
        resolvedEntity = ds.name;
      }
      if (rawData.length === 0) {
        // data.json compat: maker may have keyed by logical name while
        // ds.name is an alias (e.g. dataset binding "productDataSet" vs
        // entity "msdyn_workorderproduct"). Two heuristics, in order:
        //
        //  1. If the binding has columnBindings, prefer the entity whose row
        //     schema actually contains those bound field names. This handles
        //     the common case where data.json holds multiple entities (the
        //     dataset entity AND its lookup targets like `product`, `uom`)
        //     and the naive "first non-empty" picked the wrong one.
        //  2. Otherwise fall back to the first non-empty key (excluding the
        //     page entity — that's the form record, not a dataset row).
        const pageEntity = getState().pageEntityTypeName;
        const boundFields = binding?.columnBindings
          ? Object.values(binding.columnBindings).map(b => b.field).filter(Boolean)
          : [];
        if (boundFields.length > 0) {
          let bestKey = '';
          let bestScore = 0;
          for (const key of getEntityStoreKeys()) {
            if (key === pageEntity) continue;
            const rows = getEntityData(key);
            if (rows.length === 0) continue;
            const sample = rows[0];
            let score = 0;
            for (const f of boundFields) {
              // Match direct field, OData lookup form, or formatted-value
              if (sample[f] !== undefined
                || sample[`_${f}_value`] !== undefined
                || sample[`_${f}`] !== undefined) score += 1;
            }
            if (score > bestScore) { bestScore = score; bestKey = key; }
          }
          if (bestKey) {
            rawData = getEntityData(bestKey);
            resolvedEntity = bestKey;
          }
        }
        if (rawData.length === 0) {
          for (const key of getEntityStoreKeys()) {
            if (key === pageEntity) continue;
            const data = getEntityData(key);
            if (data.length > 0) { rawData = data; resolvedEntity = key; break; }
          }
        }
      }
    }

    // P2: subgrid parent-FK filter. When the binding pins host='subgrid' and a
    // lookupColumn, narrow rawData to rows whose FK column points at the
    // effective parent record (binding.parentRecordRef OR pageContext fallback).
    // Mirrors UCI's subgrid behaviour, where the form's record adds an implicit
    // filter to the grid query.
    if (binding?.host === 'subgrid' && binding.lookupColumn) {
      const parentEntityId = binding.parentRecordRef?.entityId ?? getState().pageEntityId;
      if (parentEntityId) {
        rawData = filterByParentFk(rawData, binding.lookupColumn, parentEntityId);
      }
    }

    // Apply sorting from current dataset state, or fall back to the view's
    // default sort (any view column with sortDirection set). UCI applies the
    // view's default sort on first load; the harness mirrors that, then
    // user/control interactions overwrite via setDatasetSorting.
    const dsState = getState().datasetState[ds.name] ?? defaultDatasetState();
    let working = [...rawData];
    const effectiveSorting = dsState.sorting.length > 0
      ? dsState.sorting
      : earlyResolvedView.columns
          .filter(c => c.sortDirection === 'asc' || c.sortDirection === 'desc')
          .map(c => ({ name: c.name, sortDirection: c.sortDirection === 'desc' ? 1 : 0 }));
    if (effectiveSorting.length > 0) {
      working.sort((a, b) => {
        for (const sort of effectiveSorting) {
          const av = a[sort.name];
          const bv = b[sort.name];
          if (av === bv) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          const cmp = av < bv ? -1 : 1;
          return sort.sortDirection === 1 ? -cmp : cmp;
        }
        return 0;
      });
    }
    const totalAfterFilter = working.length;
    // Slice to current page (cumulative pages)
    const limit = dsState.pageNumber * dsState.pageSize;
    working = working.slice(0, limit);

    const records: Record<string, any> = {};
    const sortedIds: string[] = [];

    for (const row of working) {
      // Find the ID field
      const idField = Object.keys(row).find(k => k.toLowerCase().endsWith('id') || k === 'id');
      const id = idField ? String(row[idField]) : String(Math.random());
      sortedIds.push(id);
      records[id] = {
        getRecordId: () => id,
        getValue: (field: string) => {
          // P5: honour columnBindings — when the maker re-mapped a property-set
          // name to a different row field (e.g. ConfigColumn1 → estimateunitamount),
          // resolve to that field. The control still calls getValue('ConfigColumn1');
          // the alias re-mapping is invisible to it. Matches UCI behaviour where
          // record.getValue(<property-set-name>) returns the bound field's value.
          const bound = binding?.columnBindings?.[field]?.field;
          const lookupField = bound ?? field;
          let val = row[lookupField];
          let actualKey = lookupField;
          // Fallback: if field not found, try OData lookup format (_field_value, _field)
          if (val === undefined) {
            for (const candidate of [`_${lookupField}_value`, `_${lookupField}id`, `_${lookupField}`]) {
              if (row[candidate] !== undefined) { val = row[candidate]; actualKey = candidate; break; }
            }
          }
          // Defensive auto-bind: when the maker hasn't explicitly mapped this
          // property-set AND the property-set name doesn't appear in the row,
          // try a normalised name-match against the row's keys. Catches the
          // "All columns (default)" view case where the synthesised view has
          // manifest property-set names ("Product") but rows are keyed by
          // Dataverse field names ("msdyn_product" / "_msdyn_product_value").
          // Mirrors deriveColumnBindingsFromCandidates' suffix/prefix stripping.
          if (val === undefined && !bound) {
            const needle = field.toLowerCase().replace(/[_\s-]/g, '');
            for (const k of Object.keys(row)) {
              if (k.includes('@')) continue; // skip OData annotations
              const norm = k.toLowerCase()
                .replace(/^_+/, '')
                .replace(/_value$/, '')
                .replace(/^[a-z][a-z0-9]{1,7}_/, '') // strip publisher prefix
                .replace(/[_\s-]/g, '');
              if (norm === needle || norm.includes(needle) || needle.includes(norm)) {
                val = row[k];
                actualKey = k;
                break;
              }
            }
          }
          if (val == null) {
            // Real UCI returns null here, but lots of controls in the wild
            // call `record.getValue("MyLookup").id.guid` without null-checking.
            // For a property-set declared as Lookup.* in the manifest, return
            // an empty-but-shape-correct lookup so the control can finish
            // updateView. We log a one-line warning so the maker knows.
            const colDef = ds.columns.find(c => c.name === field);
            const ofType = (colDef?.ofType ?? binding?.columnBindings?.[field]?.ofType ?? '').toString();
            if (ofType.toLowerCase().startsWith('lookup')) {
              return {
                id: { guid: '' },
                name: '',
                entityType: '',
                etn: '',
              };
            }
            return null;
          }
          // If the raw value looks like a GUID, return as a lookup object
          // Check for annotation on both the original field and the resolved key
          if (typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
            const annotation = row[`${lookupField}@OData.Community.Display.V1.FormattedValue`]
              ?? row[`${actualKey}@OData.Community.Display.V1.FormattedValue`];
            // Real Dataverse returns the target entity logical name via
            // @Microsoft.Dynamics.CRM.lookuplogicalname. Without it, controls
            // that resolve lookup targets via record.getValue(alias).etn
            // (e.g. PGProductView's MultiAddService.readTargetEntityFromRows)
            // can't figure out which entity to query and silently return
            // empty results. Fall back to the column name only when no
            // annotation is present (legacy data.json shape).
            const targetEntity = row[`${lookupField}@Microsoft.Dynamics.CRM.lookuplogicalname`]
              ?? row[`${actualKey}@Microsoft.Dynamics.CRM.lookuplogicalname`]
              ?? lookupField;
            const name = annotation != null ? String(annotation) : '';
            return {
              id: { guid: val },
              name,
              // Modern ComponentFramework.LookupValue shape.
              entityType: String(targetEntity),
              // Legacy {etn,id,name} shape — still used by many controls
              // (including PGProductView). Real UCI dataset values expose
              // BOTH, so we match.
              etn: String(targetEntity),
            };
          }
          return val;
        },
        getFormattedValue: (field: string) => {
          const bound = binding?.columnBindings?.[field]?.field;
          const lookupField = bound ?? field;
          // Check for OData formatted value annotation — try direct field and OData fallback keys
          let annotation = row[`${lookupField}@OData.Community.Display.V1.FormattedValue`]
            ?? row[`_${lookupField}_value@OData.Community.Display.V1.FormattedValue`]
            ?? row[`_${lookupField}@OData.Community.Display.V1.FormattedValue`];
          // Same defensive auto-bind as getValue: when no binding is set and
          // the field doesn't appear in the row, find a normalised match.
          let resolvedKey = lookupField;
          if (annotation == null && !bound && row[lookupField] === undefined) {
            const needle = field.toLowerCase().replace(/[_\s-]/g, '');
            for (const k of Object.keys(row)) {
              if (k.includes('@')) continue;
              const norm = k.toLowerCase()
                .replace(/^_+/, '')
                .replace(/_value$/, '')
                .replace(/^[a-z][a-z0-9]{1,7}_/, '')
                .replace(/[_\s-]/g, '');
              if (norm === needle || norm.includes(needle) || needle.includes(norm)) {
                resolvedKey = k;
                annotation = row[`${k}@OData.Community.Display.V1.FormattedValue`];
                break;
              }
            }
          }
          if (annotation != null) return String(annotation);
          // Fallback: try direct field, then OData lookup format
          const val = row[resolvedKey] ?? row[`_${resolvedKey}_value`] ?? row[`_${resolvedKey}`];
          return val != null ? String(val) : '';
        },
        getNamedReference: () => ({ id: { guid: id }, name: '', etn: ds.name }),
      };
    }
    return { records, sortedIds, totalAfterFilter, resolvedEntity };
  }

  const { records, sortedIds, totalAfterFilter, resolvedEntity } = getRecords();
  const dsState = getState().datasetState[ds.name] ?? defaultDatasetState();
  // Resolve the view ONCE for this build cycle. Used to drive columns,
  // getViewId, getTitle, and getTargetEntityType so the control sees a
  // consistent view-shaped facade.
  const resolvedView = resolveViewForBinding(ds, binding, resolvedEntity);
  // Mutable sorting array — controls may push/splice into it; refresh() captures back into store.
  const liveSorting: any[] = dsState.sorting.map(s => ({ ...s }));
  let liveFilter: any = dsState.filtering;
  const totalResultCount = totalAfterFilter;
  const limit = dsState.pageNumber * dsState.pageSize;
  const hasNextPage = limit < totalResultCount;
  const hasPreviousPage = dsState.pageNumber > 1;

  return {
    loading: false,
    error: false,
    errorMessage: '',
    paging: {
      totalResultCount,
      pageSize: dsState.pageSize,
      hasNextPage,
      hasPreviousPage,
      loadNextPage: () => {
        getState().addLogEntry({ category: 'data', method: 'paging.loadNextPage', args: { dataSet: ds.name }, coverage: 'implemented' });
        getState().setDatasetPage(ds.name, dsState.pageNumber + 1, dsState.pageSize);
      },
      loadPreviousPage: () => {
        getState().addLogEntry({ category: 'data', method: 'paging.loadPreviousPage', args: { dataSet: ds.name }, coverage: 'implemented' });
        getState().setDatasetPage(ds.name, Math.max(1, dsState.pageNumber - 1), dsState.pageSize);
      },
      setPageSize: (size: number) => {
        getState().addLogEntry({ category: 'data', method: 'paging.setPageSize', args: { dataSet: ds.name, size }, coverage: 'implemented' });
        getState().setDatasetPage(ds.name, 1, size);
      },
      firstPageNumber: 1,
      lastPageNumber: Math.max(1, Math.ceil(totalResultCount / dsState.pageSize)),
      reset: () => {
        getState().addLogEntry({ category: 'data', method: 'paging.reset', args: { dataSet: ds.name }, coverage: 'implemented' });
        getState().setDatasetPage(ds.name, 1, dsState.pageSize);
      },
    },
    sorting: liveSorting,
    filtering: {
      getFilter: () => liveFilter,
      setFilter: (f: any) => {
        liveFilter = f;
        getState().setDatasetFiltering(ds.name, f);
      },
    },
    linking: {
      getLinkedEntities: () => {
        // Build linked entity list from all entity types in the data store.
        // In real Dynamics, these come from the view definition's linked entities.
        const knownEntities: Array<{name: string; alias: string}> = [];
        for (const name of getEntityStoreKeys()) {
          const data = getEntityData(name);
          if (data.length > 0) {
            knownEntities.push({ name, alias: name });
          }
        }
        return knownEntities;
      },
      addLinkedEntity: () => {},
    },
    records,
    sortedRecordIds: sortedIds,
    columns: buildDatasetColumns(ds, resolvedEntity, getEntityData, typeGroups, () => getState().userLanguageId, resolvedView, binding?.columnBindings),
    refresh: () => {
      // Capture any control-side mutations to sorting back into store, then trigger updateView.
      getState().setDatasetSorting(ds.name, liveSorting.map(s => ({ name: s.name, sortDirection: s.sortDirection })));
      getState().addLogEntry({ category: 'data', method: 'dataset.refresh', args: { dataSet: ds.name }, coverage: 'implemented' });
      for (const cb of refreshCallbacks) cb();
    },
    openDatasetItem: (ref: any) => {
      // Wire to the same dialog-bus channel as navigation.openForm so a row
      // click actually opens the record in a modal. ref is an EntityReference
      // ({ etn, id, name }) — translate to the openForm options shape.
      getState().addLogEntry({ category: 'navigation', method: 'openDatasetItem', args: ref, coverage: 'implemented' });
      const entityName = ref?.etn ?? ref?.entityType ?? ref?.LogicalName ?? resolvedEntity;
      const entityId = ref?.id ?? ref?.Id ?? ref?.entityId;
      return new Promise(resolve => {
        pushDialog<OpenFormDialogRequest>({
          kind: 'openForm',
          options: { entityName, entityId, openInNewWindow: false },
          parameters: undefined,
          resolve: () => resolve(undefined as any),
        });
      });
    },
    getTitle: () => resolvedView.displayName || ds.displayNameKey,
    getViewId: () => resolvedView.viewId || '',
    getTargetEntityType: () => resolvedView.entityType || resolvedEntity,
    addOnDatasetItemOpened: () => {},
    removeOnDatasetItemOpened: () => {},
    addColumn: () => {},
    delete: () => {
      const ids = getState().datasetState[ds.name]?.selectedIds ?? [];
      getState().addLogEntry({ category: 'data', method: 'dataset.delete', args: { dataSet: ds.name, ids }, coverage: 'implemented' });
      let removed = 0;
      for (const id of ids) {
        if (deleteEntityRecord(resolvedEntity, id)) removed++;
      }
      if (removed > 0) {
        getState().setDatasetSelectedIds(ds.name, []);
        getState().bumpDataVersion();
      }
      return Promise.resolve(ids);
    },
    newRecord: () => {
      const created = addEntityRecord(resolvedEntity, {});
      getState().addLogEntry({ category: 'data', method: 'dataset.newRecord', args: { dataSet: ds.name, record: created }, coverage: 'implemented' });
      getState().bumpDataVersion();
      return Promise.resolve(created);
    },
    save: () => {
      // In mock mode, every dataset mutation (newRecord / delete / column
      // setValue) is persisted to the in-memory data-store synchronously, so
      // there is nothing dirty to flush here. Real Dataverse persistence is
      // M2 (Live Dataverse Bridge) territory. Tagged 'implemented' because
      // the mock-mode contract — "save returns resolved when state is on
      // disk" — is already satisfied at every mutation point.
      getState().addLogEntry({ category: 'data', method: 'dataset.save', args: { dataSet: ds.name }, coverage: 'implemented' });
      return Promise.resolve();
    },
    getSelectedRecordIds: () => getState().datasetState[ds.name]?.selectedIds ?? [],
    setSelectedRecordIds: (ids: string[]) => {
      getState().setDatasetSelectedIds(ds.name, ids);
    },
    clearSelectedRecordIds: () => {
      getState().setDatasetSelectedIds(ds.name, []);
    },
  };
}

/**
 * Build the parameters object from manifest + current property values.
 */
/**
 * Resolve $columnName field bindings from entity data.
 * Returns the resolved value, or the original if not a binding.
 */
function resolveFieldBinding(
  rawValue: any,
  getEntityData: (entityType: string) => Record<string, any>[],
  getState: () => HarnessStore,
): any {
  if (typeof rawValue !== 'string' || !rawValue.startsWith('$')) return rawValue;

  const columnName = rawValue.substring(1);
  const state = getState();
  const entityType = state.pageEntityTypeName;
  const entityId = state.pageEntityId;
  if (!entityType || !entityId) return null;

  const records = getEntityData(entityType);
  const normalId = entityId.replace(/[{}]/g, '').toLowerCase();
  const record = records.find(r => {
    for (const key of Object.keys(r)) {
      if ((key.toLowerCase().endsWith('id') || key === 'id') &&
          String(r[key]).replace(/[{}]/g, '').toLowerCase() === normalId) {
        return true;
      }
    }
    return false;
  });
  if (!record) return null;

  // Check for OData lookup format
  const lookupVal = record[`_${columnName}_value`];
  const formatted = record[`_${columnName}_value@OData.Community.Display.V1.FormattedValue`]
    ?? record[`${columnName}@OData.Community.Display.V1.FormattedValue`];
  if (lookupVal && formatted) {
    const entityType =
      record[`_${columnName}_value@Microsoft.Dynamics.CRM.lookuplogicalname`]
      ?? columnName;
    return [{ id: lookupVal, name: formatted, entityType }];
  }
  return record[columnName] ?? null;
}

function buildParameters(
  manifest: ManifestConfig,
  propertyValues: Record<string, any>,
  getEntityData: (entityType: string) => Record<string, any>[],
  getState: () => HarnessStore,
) {
  const params: Record<string, any> = {};
  const selectedTypes = getState().propertyTypes;
  for (const prop of manifest.properties) {
    const rawVal = propertyValues[prop.name];
    const boundColumn = typeof rawVal === 'string' && rawVal.startsWith('$') ? rawVal.substring(1) : undefined;
    const resolved = resolveFieldBinding(rawVal, getEntityData, getState);
    // For of-type-group properties, use the maker's selected type instead of the generic "Property"
    const effectiveProp = prop.ofTypeGroup && selectedTypes[prop.name]
      ? { ...prop, ofType: selectedTypes[prop.name] }
      : prop;
    params[prop.name] = buildProperty(effectiveProp, resolved, boundColumn, getState().pageEntityTypeName);
  }
  for (const ds of manifest.dataSets) {
    params[ds.name] = buildDataSet(ds, getEntityData, getState, manifest.typeGroups);
  }
  return params;
}

export interface CreateContextHooks {
  /** Called when the control invokes context.factory.requestRender(). */
  requestRender?: () => void;
}

/**
 * Build a Proxy for context.events so any manifest-declared event the control
 * invokes (e.g. context.events.OnSelected(payload)) is logged to the harness
 * console with its arguments. Returns a real function for any accessed key.
 */
function createEventsProxy(getState: () => HarnessStore): Record<string, (...args: any[]) => void> {
  const handlers: Record<string, (...args: any[]) => void> = {};
  return new Proxy(handlers, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') return (target as any)[prop];
      if (!target[prop]) {
        target[prop] = (...args: any[]) => {
          getState().addLogEntry({
            category: 'events',
            method: prop,
            args: args.length === 1 ? args[0] : args,
            coverage: 'stub',
          });
        };
      }
      return target[prop];
    },
    has() {
      // Make `'OnSelected' in context.events` always return true so feature-detection works.
      return true;
    },
  });
}

/**
 * Create a full ComponentFramework.Context object.
 */
export function createContext(
  manifest: ManifestConfig,
  getState: () => HarnessStore,
  getEntityData: (entityType: string) => Record<string, any>[],
  hooks: CreateContextHooks = {},
) {
  const state = getState();
  const events = createEventsProxy(getState);

  return {
    parameters: buildParameters(manifest, state.propertyValues, getEntityData, getState),
    client: createClientShim(getState),
    device: createDeviceShim(getState),
    factory: {
      getPopupService: () => ({
        createPopup: (popup: any) => {
          getState().addLogEntry({ category: 'factory', method: 'popup.create', args: { name: popup?.name }, coverage: 'implemented' });
          if (popup?.name) createPopupEntry(popup);
        },
        deletePopup: (name: string) => {
          getState().addLogEntry({ category: 'factory', method: 'popup.delete', args: { name }, coverage: 'implemented' });
          deletePopupEntry(name);
        },
        openPopup: (name: string) => {
          getState().addLogEntry({ category: 'factory', method: 'popup.open', args: { name }, coverage: 'implemented' });
          openPopupEntry(name);
        },
        closePopup: (name: string) => {
          getState().addLogEntry({ category: 'factory', method: 'popup.close', args: { name }, coverage: 'implemented' });
          closePopupEntry(name);
        },
        updatePopup: (popup: any) => {
          getState().addLogEntry({ category: 'factory', method: 'popup.update', args: { name: popup?.name }, coverage: 'implemented' });
          if (popup?.name) updatePopupEntry(popup);
        },
        setPopupsId: (id: string) => {
          getState().addLogEntry({ category: 'factory', method: 'popup.setPopupsId', args: { id }, coverage: 'implemented' });
          setPopupsIdValue(id);
        },
        getPopupsId: () => getPopupsIdValue(),
      }),
      requestRender: () => {
        getState().addLogEntry({ category: 'factory', method: 'requestRender', coverage: 'implemented' });
        hooks.requestRender?.();
      },
      fireEvent: (name: string, payload?: any) => {
        getState().addLogEntry({ category: 'factory', method: 'fireEvent', args: { name, payload }, coverage: 'implemented' });
        // Dispatch through the events Proxy so any registered listener fires.
        // The Proxy auto-creates a logging handler for any unknown event name.
        if (typeof (events as any)[name] === 'function') {
          (events as any)[name](payload);
        }
      },
      /**
       * UNDOCUMENTED — internal field NOT in @types/powerapps-component-framework.
       * Microsoft's internal MscrmControls (e.g. Field Service
       * InspectionControls.SurveyControl) branch on
       * `context.factory._customControlProperties.configuration.Name` (and the
       * sibling `.manifest.ConstructorName`) to detect which sub-variant of the
       * bundle is hosting them. Both surfaces resolve to the control's
       * constructor name from the manifest. Do NOT rely on this in
       * partner/ISV controls — use `context.parameters` and explicit input
       * properties instead.
       */
      _customControlProperties: {
        configuration: { Name: manifest.constructor },
        manifest: {
          ConstructorName: manifest.constructor,
          Namespace: manifest.namespace,
          Version: manifest.version,
        },
      },
    },
    formatting: createFormattingShim(),
    mode: createModeShim(getState),
    navigation: createNavigationShim(getState),
    resources: createResourcesShim(getState),
    userSettings: createUserSettingsShim(getState),
    orgSettings: createOrgSettingsShim(getState),
    utils: createUtilsShim(getState),
    webAPI: createWebApiShim(getState, getEntityData),
    updatedProperties: ['all'],
    events,
    fluentDesignLanguage: createFluentDesignShim(getState),
    copilot: createCopilotShim(getState),
    accessibility: createAccessibilityShim(getState),
    theming: createThemingShim(getState),
    reporting: createReportingShim(getState),

    // Non-standard context extensions used by some controls (e.g. InspectionControl)
    page: {
      get entityId() { return getState().pageEntityId; },
      get entityTypeName() { return getState().pageEntityTypeName; },
      get entityRecordName() { return getState().pageEntityRecordName; },
      appId: '',
      isPageReadOnly: false,
      getClientUrl(): string {
        return typeof window !== 'undefined' ? window.location.origin : '';
      },
    },
  };
}

/**
 * Rebuild just the parameters portion of the context (for updateView calls).
 */
export function rebuildParameters(
  context: any,
  manifest: ManifestConfig,
  propertyValues: Record<string, any>,
  updatedProperties?: string[],
  getEntityData?: (entityType: string) => Record<string, any>[],
  getState?: () => HarnessStore,
): void {
  // Rebuild scalar properties, resolving $columnName bindings
  for (const prop of manifest.properties) {
    const rawVal = propertyValues[prop.name];
    const boundColumn = typeof rawVal === 'string' && rawVal.startsWith('$') ? rawVal.substring(1) : undefined;
    const resolved = (getEntityData && getState)
      ? resolveFieldBinding(rawVal, getEntityData, getState)
      : rawVal;
    context.parameters[prop.name] = buildProperty(prop, resolved, boundColumn, getState?.().pageEntityTypeName);
  }
  // Rebuild datasets if data functions provided
  if (getEntityData && getState) {
    for (const ds of manifest.dataSets) {
      context.parameters[ds.name] = buildDataSet(ds, getEntityData, getState, manifest.typeGroups);
    }
  }
  context.updatedProperties = updatedProperties ?? ['all'];
}
