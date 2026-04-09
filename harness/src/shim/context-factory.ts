import type { ManifestConfig, ManifestProperty, ManifestDataSet } from '../types/manifest';
import type { HarnessStore } from '../store/harness-store';
import { createClientShim } from './client';
import { createDeviceShim } from './device';
import { createModeShim } from './mode';
import { createNavigationShim } from './navigation';
import { createFormattingShim } from './formatting';
import { createUserSettingsShim } from './user-settings';
import { createUtilsShim } from './utils';
import { createResourcesShim } from './resources';
import { createWebApiShim } from './web-api';
import { createFluentDesignShim } from './fluent-design';
import { getEntityStoreKeys } from '../store/data-store';

/**
 * Build a typed parameter property based on manifest of-type.
 */
function buildProperty(prop: ManifestProperty, rawValue: any) {
  const base = {
    error: false,
    errorMessage: '',
    formatted: rawValue != null ? String(rawValue) : '',
    type: prop.ofType,
    attributes: {
      LogicalName: prop.name,
      DisplayName: prop.displayNameKey,
      Type: prop.ofType,
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
      return { ...base, raw: rawValue ?? null };
  }
}

/**
 * Build a dataset shim that mimics ComponentFramework.PropertyTypes.DataSet.
 * Reads records from the entity data store using the dataset name as the entity type.
 */
function buildDataSet(
  ds: ManifestDataSet,
  getEntityData: (entityType: string) => Record<string, any>[],
  getState: () => HarnessStore,
) {
  const refreshCallbacks: Array<() => void> = [];

  function getRecords() {
    // Try dataset name first (e.g. "bookingRecords")
    let rawData = getEntityData(ds.name);
    if (rawData.length === 0) {
      // Fallback: try pageEntityTypeName from store
      const pageEntity = getState().pageEntityTypeName;
      if (pageEntity) rawData = getEntityData(pageEntity);
    }
    if (rawData.length === 0) {
      // Fallback: use the first entity in the data store that has array records
      // This handles data.json keyed by entity logical name (e.g. "bookableresourcebooking")
      // when the dataset name is different (e.g. "bookingRecords")
      for (const key of getEntityStoreKeys()) {
        const data = getEntityData(key);
        if (data.length > 0) { rawData = data; break; }
      }
    }
    const records: Record<string, any> = {};
    const sortedIds: string[] = [];

    for (const row of rawData) {
      // Find the ID field
      const idField = Object.keys(row).find(k => k.toLowerCase().endsWith('id') || k === 'id');
      const id = idField ? String(row[idField]) : String(Math.random());
      sortedIds.push(id);
      records[id] = {
        getRecordId: () => id,
        getValue: (field: string) => {
          let val = row[field];
          let actualKey = field;
          // Fallback: if field not found, try OData lookup format (_field_value, _field)
          if (val === undefined) {
            for (const candidate of [`_${field}_value`, `_${field}id`, `_${field}`]) {
              if (row[candidate] !== undefined) { val = row[candidate]; actualKey = candidate; break; }
            }
          }
          if (val == null) return null;
          // If the raw value looks like a GUID, return as a lookup object
          // Check for annotation on both the original field and the resolved key
          if (typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
            const annotation = row[`${field}@OData.Community.Display.V1.FormattedValue`]
              ?? row[`${actualKey}@OData.Community.Display.V1.FormattedValue`];
            return { id: { guid: val }, name: annotation != null ? String(annotation) : '', entityType: field };
          }
          return val;
        },
        getFormattedValue: (field: string) => {
          // Check for OData formatted value annotation — try direct field and OData fallback keys
          const annotation = row[`${field}@OData.Community.Display.V1.FormattedValue`]
            ?? row[`_${field}_value@OData.Community.Display.V1.FormattedValue`]
            ?? row[`_${field}@OData.Community.Display.V1.FormattedValue`];
          if (annotation != null) return String(annotation);
          // Fallback: try direct field, then OData lookup format
          const val = row[field] ?? row[`_${field}_value`] ?? row[`_${field}`];
          return val != null ? String(val) : '';
        },
        getNamedReference: () => ({ id: { guid: id }, name: '', etn: ds.name }),
      };
    }
    return { records, sortedIds };
  }

  const { records, sortedIds } = getRecords();

  return {
    loading: false,
    error: false,
    errorMessage: '',
    paging: {
      totalResultCount: sortedIds.length,
      pageSize: 250,
      hasNextPage: false,
      hasPreviousPage: false,
      loadNextPage: () => {},
      loadPreviousPage: () => {},
      setPageSize: () => {},
      firstPageNumber: 1,
      lastPageNumber: 1,
      reset: () => {},
    },
    sorting: [],
    filtering: { getFilter: () => null, setFilter: () => {} },
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
    columns: Object.keys(sortedIds.length > 0 ? getEntityData(ds.name)[0] ?? {} : {}).map(name => ({
      name,
      displayName: name,
      dataType: 'string',
      alias: name,
      order: -1,
      visualSizeFactor: 1,
      isHidden: false,
      isPrimary: name.toLowerCase().endsWith('id'),
      disableSorting: false,
    })),
    refresh: () => {
      getState().addLogEntry({ category: 'data', method: 'dataset.refresh', args: { dataSet: ds.name } });
      for (const cb of refreshCallbacks) cb();
    },
    openDatasetItem: (ref: any) => {
      getState().addLogEntry({ category: 'navigation', method: 'openDatasetItem', args: ref });
    },
    getTitle: () => ds.displayNameKey,
    getViewId: () => '',
    getTargetEntityType: () => ds.name,
    addOnDatasetItemOpened: () => {},
    removeOnDatasetItemOpened: () => {},
    addColumn: () => {},
    delete: () => Promise.resolve(),
    newRecord: () => Promise.resolve(),
    save: () => Promise.resolve(),
    getSelectedRecordIds: () => [],
    setSelectedRecordIds: () => {},
    clearSelectedRecordIds: () => {},
  };
}

/**
 * Build the parameters object from manifest + current property values.
 */
function buildParameters(
  manifest: ManifestConfig,
  propertyValues: Record<string, any>,
  getEntityData: (entityType: string) => Record<string, any>[],
  getState: () => HarnessStore,
) {
  const params: Record<string, any> = {};
  for (const prop of manifest.properties) {
    params[prop.name] = buildProperty(prop, propertyValues[prop.name]);
  }
  for (const ds of manifest.dataSets) {
    params[ds.name] = buildDataSet(ds, getEntityData, getState);
  }
  return params;
}

/**
 * Create a full ComponentFramework.Context object.
 */
export function createContext(
  manifest: ManifestConfig,
  getState: () => HarnessStore,
  getEntityData: (entityType: string) => Record<string, any>[],
) {
  const state = getState();

  return {
    parameters: buildParameters(manifest, state.propertyValues, getEntityData, getState),
    client: createClientShim(getState),
    device: createDeviceShim(getState),
    factory: {
      getPopupService: () => ({
        createPopup: () => {},
        deletePopup: () => {},
        openPopup: () => {},
        closePopup: () => {},
        updatePopup: () => {},
        setPopupsId: () => {},
        getPopupsId: () => '',
      }),
      requestRender: () => {
        getState().addLogEntry({ category: 'factory', method: 'requestRender' });
      },
    },
    formatting: createFormattingShim(),
    mode: createModeShim(getState),
    navigation: createNavigationShim(getState),
    resources: createResourcesShim(),
    userSettings: createUserSettingsShim(),
    utils: createUtilsShim(getState),
    webAPI: createWebApiShim(getState, getEntityData),
    updatedProperties: ['all'],
    events: {},
    fluentDesignLanguage: createFluentDesignShim(getState),
    copilot: {},

    // Non-standard context extensions used by some controls (e.g. InspectionControl)
    page: {
      get entityId() { return getState().pageEntityId; },
      get entityTypeName() { return getState().pageEntityTypeName; },
      appId: '',
      isPageReadOnly: false,
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
  // Rebuild scalar properties
  for (const prop of manifest.properties) {
    context.parameters[prop.name] = buildProperty(prop, propertyValues[prop.name]);
  }
  // Rebuild datasets if data functions provided
  if (getEntityData && getState) {
    for (const ds of manifest.dataSets) {
      context.parameters[ds.name] = buildDataSet(ds, getEntityData, getState);
    }
  }
  context.updatedProperties = updatedProperties ?? ['all'];
}
