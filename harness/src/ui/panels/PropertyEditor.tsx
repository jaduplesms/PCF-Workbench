import { useCallback, useMemo } from 'react';
import {
  makeStyles, tokens, Input, Label, Switch, SpinButton, Textarea,
  Divider, Badge, Dropdown, Option,
} from '@fluentui/react-components';
import type { ManifestConfig, ManifestProperty } from '../../types/manifest';
import { useHarnessStore } from '../../store/harness-store';
import { getEntityData, getEntityStoreKeys } from '../../store/data-store';
import { getColumnDisplayName, getEntityDisplayName, getEntityMetadata } from '../../store/metadata-store';
import { ControlInfoCard } from './ControlInfoCard';

const useStyles = makeStyles({
  root: {
    padding: '12px',
    overflowY: 'auto',
    height: '100%',
  },
  header: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: '12px',
  },
  field: {
    marginBottom: '12px',
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '4px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  typeHint: {
    fontSize: '10px',
    opacity: 0.6,
    fontWeight: 'normal' as const,
  },
  lookupGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  columnLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    marginBottom: '2px',
  },
  boundValue: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontFamily: "'Consolas', monospace",
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    marginTop: '2px',
    wordBreak: 'break-all' as const,
  },
});

/**
 * Map PCF property types to compatible Dataverse attribute types.
 * Returns null if no filtering should be applied (accept all types).
 */
function getCompatibleTypes(ofType: string): string[] | null {
  switch (ofType) {
    case 'TwoOptions':
      return ['Boolean'];
    case 'Whole.None':
      return ['Integer', 'BigInt'];
    case 'FP':
    case 'Decimal':
      return ['Decimal', 'Double', 'Money'];
    case 'Currency':
      return ['Money', 'Decimal'];
    case 'DateAndTime.DateOnly':
    case 'DateAndTime.DateAndTime':
      return ['DateTime'];
    case 'OptionSet':
      return ['Picklist', 'State', 'Status'];
    case 'MultiSelectOptionSet':
      return ['Virtual']; // MultiSelect picklists are Virtual in Dataverse
    case 'Lookup.Simple':
      return ['Lookup', 'Owner', 'Customer'];
    case 'SingleLine.Text':
    case 'SingleLine.Email':
    case 'SingleLine.Phone':
    case 'SingleLine.URL':
    case 'SingleLine.TextArea':
      return ['String', 'Memo'];
    case 'Multiple':
      return ['String', 'Memo'];
    default:
      return null; // Accept all types (e.g. of-type-group)
  }
}

/** Filter entity columns by compatible types using metadata */
function filterColumnsByType(entityType: string, columns: string[], ofType: string): string[] {
  const compatibleTypes = getCompatibleTypes(ofType);
  if (!compatibleTypes) return columns; // No filtering

  const meta = getEntityMetadata(entityType);
  if (!meta) return columns; // No metadata — show all

  return columns.filter(col => {
    const colMeta = meta.columns[col];
    if (!colMeta?.type) return true; // No type info — include
    return compatibleTypes.includes(colMeta.type);
  });
}

/** Get available columns from the first record of an entity in data.json */
function getEntityColumns(entityType: string): string[] {
  if (!entityType) return [];
  const records = getEntityData(entityType);
  if (records.length === 0) {
    // Try all entity keys to find one with data
    for (const key of getEntityStoreKeys()) {
      const data = getEntityData(key);
      if (data.length > 0) {
        return Object.keys(data[0]).filter(k => !k.includes('@'));
      }
    }
    return [];
  }
  return Object.keys(records[0]).filter(k => !k.includes('@'));
}

/** Resolve a column value from entity data */
function resolveColumnValue(entityType: string, entityId: string, columnName: string): any {
  if (!entityType || !entityId || !columnName) return null;
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

  const val = record[columnName];
  // Check for OData lookup format
  const formatted = record[`${columnName}@OData.Community.Display.V1.FormattedValue`]
    ?? record[`_${columnName}_value@OData.Community.Display.V1.FormattedValue`];
  const lookupVal = record[`_${columnName}_value`];

  if (lookupVal && formatted) {
    return [{ id: lookupVal, name: formatted, entityType: columnName }];
  }
  return val ?? null;
}

/** Friendly label for PCF property types */
function formatTypeName(ofType: string): string {
  if (ofType.startsWith('SingleLine.')) return ofType.replace('SingleLine.', '');
  if (ofType.startsWith('DateAndTime.')) return ofType.replace('DateAndTime.', '');
  if (ofType === 'Whole.None') return 'Whole Number';
  if (ofType === 'FP') return 'Floating Point';
  if (ofType === 'Multiple') return 'Multi-Line Text';
  if (ofType === 'Lookup.Simple') return 'Lookup';
  return ofType;
}

function PropertyField({ prop, manifest, entityColumns, pageEntityTypeName, pageEntityId }: {
  prop: ManifestProperty;
  manifest: ManifestConfig;
  entityColumns: string[];
  pageEntityTypeName: string;
  pageEntityId: string;
}) {
  const styles = useStyles();
  const value = useHarnessStore(s => s.propertyValues[prop.name]);
  const setValue = useHarnessStore(s => s.setPropertyValue);
  const selectedType = useHarnessStore(s => s.propertyTypes[prop.name]);
  const setPropertyType = useHarnessStore(s => s.setPropertyType);
  const typeGroupTypes = prop.ofTypeGroup ? manifest.typeGroups[prop.ofTypeGroup] : undefined;

  // Track which column this property is bound to (stored as $columnName in the value)
  const boundColumn = typeof value === 'string' && value.startsWith('$') ? value.substring(1) : null;
  // Track related field reference (stored as @sourceSlot.fieldName)
  const isRelatedField = typeof value === 'string' && value.startsWith('@');
  const resolvedValue = boundColumn ? resolveColumnValue(pageEntityTypeName, pageEntityId, boundColumn) : value;
  const displayValue = resolvedValue !== null && resolvedValue !== undefined
    ? (Array.isArray(resolvedValue) ? resolvedValue[0]?.name ?? String(resolvedValue[0]?.id) : String(resolvedValue))
    : '';

  const handleColumnSelect = useCallback((_: any, data: { optionValue?: string }) => {
    const col = data.optionValue;
    if (!col || col === '__none__') {
      setValue(prop.name, null);
    } else {
      // Store as $columnName — the context factory resolves it
      setValue(prop.name, `$${col}`);
    }
  }, [prop.name, setValue]);

  const handleTextChange = useCallback((_: any, data: { value: string }) => {
    setValue(prop.name, data.value || null);
  }, [prop.name, setValue]);

  const handleNumberChange = useCallback((_: any, data: { value?: number | null }) => {
    setValue(prop.name, data.value ?? null);
  }, [prop.name, setValue]);

  const handleSwitchChange = useCallback((_: any, data: { checked: boolean }) => {
    setValue(prop.name, data.checked);
  }, [prop.name, setValue]);

  const usageBadge = prop.usage === 'bound'
    ? <Badge appearance="filled" color="brand" size="small">bound</Badge>
    : <Badge appearance="outline" size="small">input</Badge>;

  // BOUND properties: always show Table column dropdown (matches Power Apps maker)
  if (prop.usage === 'bound' && entityColumns.length > 0) {
    return (
      <div className={styles.field}>
        <div className={styles.label}>
          {prop.displayNameKey}
          {prop.required && <span style={{ color: '#d13438' }}>*</span>}
          <span className={styles.typeHint}>({prop.ofType})</span>
        </div>
        <div className={styles.columnLabel}>Table column</div>
        <Dropdown
          size="small"
          placeholder="Select an option"
          selectedOptions={boundColumn ? [boundColumn] : []}
          value={boundColumn ? (getColumnDisplayName(pageEntityTypeName, boundColumn) ?? boundColumn) : ''}
          onOptionSelect={handleColumnSelect}
        >
          <Option value="__none__" text="">— None —</Option>
          {filterColumnsByType(pageEntityTypeName, entityColumns, prop.ofType).map(col => {
            const dn = getColumnDisplayName(pageEntityTypeName, col);
            const label = dn ? `${dn} (${col})` : col;
            return <Option key={col} value={col} text={label}>{label}</Option>;
          })}
        </Dropdown>
        {boundColumn && displayValue && (
          <div className={styles.boundValue}>
            {displayValue}
          </div>
        )}
      </div>
    );
  }

  // INPUT properties with entity data: show "Bind to table column" checkbox (matches Power Apps maker)
  if (prop.usage === 'input' && entityColumns.length > 0) {
    // Track bound state: $columnName means bound, anything else means static
    // Also treat $__pending__ as bound (user toggled on but hasn't selected a column yet)
    const isBoundToColumn = boundColumn !== null || value === '$';

    const renderStaticEditor = () => {
      const staticVal = typeof value === 'string' && !value.startsWith('$') ? value : '';
      switch (prop.ofType) {
        case 'TwoOptions':
          return <Switch checked={value === true || value === 'true'} onChange={handleSwitchChange} />;
        case 'Enum':
          if (prop.enumValues && prop.enumValues.length > 0) {
            return (
              <Dropdown
                size="small"
                placeholder="Select an option"
                selectedOptions={staticVal ? [staticVal] : []}
                value={prop.enumValues.find(v => v.value === staticVal)?.displayNameKey ?? staticVal}
                onOptionSelect={(_, d) => setValue(prop.name, d.optionValue ?? null)}
              >
                {prop.enumValues.map(v => (
                  <Option key={v.value} value={v.value} text={v.displayNameKey}>{v.displayNameKey}</Option>
                ))}
              </Dropdown>
            );
          }
          return (
            <Input size="small" value={staticVal} onChange={handleTextChange} placeholder={prop.descriptionKey || 'Static value'} />
          );
        case 'Multiple':
          return <Textarea size="small" value={staticVal} onChange={handleTextChange} resize="vertical" />;
        default:
          return <Input size="small" value={staticVal} onChange={handleTextChange} placeholder={prop.descriptionKey || 'Static value'} />;
      }
    };

    return (
      <div className={styles.field}>
        <div className={styles.label}>
          {prop.displayNameKey}
          <span className={styles.typeHint}>({selectedType ? formatTypeName(selectedType) : prop.ofType})</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', fontSize: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isBoundToColumn}
            onChange={(e) => {
              if (e.target.checked) {
                setValue(prop.name, '$'); // Pending column selection
              } else {
                setValue(prop.name, '');
              }
            }}
          />
          Bind to table column
        </label>
        {isBoundToColumn ? (
          <>
            <div className={styles.columnLabel}>Table column</div>
            <Dropdown
              size="small"
              placeholder="Select an option"
              selectedOptions={boundColumn ? [boundColumn] : []}
              value={boundColumn ? (getColumnDisplayName(pageEntityTypeName, boundColumn) ?? boundColumn) : ''}
              onOptionSelect={handleColumnSelect}
            >
              <Option value="__none__" text="">— None —</Option>
              {filterColumnsByType(pageEntityTypeName, entityColumns, prop.ofType).map(col => {
                const dn = getColumnDisplayName(pageEntityTypeName, col);
                const label = dn ? `${dn} (${col})` : col;
                return <Option key={col} value={col} text={label}>{label}</Option>;
              })}
            </Dropdown>
            {boundColumn && displayValue && (
              <div className={styles.boundValue}>{displayValue}</div>
            )}
          </>
        ) : (
          <>
            {typeGroupTypes && typeGroupTypes.length > 0 && (
              <>
                <div className={styles.columnLabel}>Type</div>
                <Dropdown
                  size="small"
                  selectedOptions={selectedType ? [selectedType] : []}
                  value={selectedType ? formatTypeName(selectedType) : ''}
                  onOptionSelect={(_, d) => { if (d.optionValue) setPropertyType(prop.name, d.optionValue); }}
                >
                  {typeGroupTypes.map(t => (
                    <Option key={t} value={t} text={formatTypeName(t)}>{formatTypeName(t)}</Option>
                  ))}
                </Dropdown>
              </>
            )}
            <div className={styles.columnLabel}>Static value</div>
            {renderStaticEditor()}
          </>
        )}
      </div>
    );
  }

  // Fallback: input properties without entity data, or bound without entity data

  // For of-type-group properties without entity data: show Type picker + text input
  if (typeGroupTypes && typeGroupTypes.length > 0) {
    return (
      <div className={styles.field}>
        <div className={styles.label}>
          {prop.displayNameKey} {usageBadge}
          <span className={styles.typeHint}>{selectedType ? formatTypeName(selectedType) : prop.ofTypeGroup}</span>
        </div>
        <div className={styles.columnLabel}>Type</div>
        <Dropdown
          size="small"
          selectedOptions={selectedType ? [selectedType] : []}
          value={selectedType ? formatTypeName(selectedType) : ''}
          onOptionSelect={(_, d) => { if (d.optionValue) setPropertyType(prop.name, d.optionValue); }}
        >
          {typeGroupTypes.map(t => (
            <Option key={t} value={t} text={formatTypeName(t)}>{formatTypeName(t)}</Option>
          ))}
        </Dropdown>
        <div className={styles.columnLabel} style={{ marginTop: 6 }}>Value</div>
        <Input
          size="small"
          value={typeof value === 'string' ? value : (value != null ? String(value) : '')}
          onChange={handleTextChange}
          placeholder={prop.descriptionKey || prop.name}
        />
      </div>
    );
  }

  switch (prop.ofType) {
    case 'Lookup.Simple': {
      const lookup = value as any;
      return (
        <div className={styles.field}>
          <div className={styles.label}>
            {prop.displayNameKey} {usageBadge}
            <span className={styles.typeHint}>{prop.ofType}</span>
          </div>
          <div className={styles.lookupGroup}>
            <Input
              size="small"
              placeholder="ID (GUID)"
              value={lookup?.[0]?.id ?? ''}
              onChange={(_, d) => {
                if (!d.value) {
                  setValue(prop.name, null);
                } else {
                  setValue(prop.name, [{
                    id: d.value,
                    name: lookup?.[0]?.name ?? '',
                    entityType: lookup?.[0]?.entityType ?? '',
                  }]);
                }
              }}
            />
            <Input
              size="small"
              placeholder="Display Name"
              value={lookup?.[0]?.name ?? ''}
              onChange={(_, d) => {
                if (lookup?.[0]) {
                  setValue(prop.name, [{ ...lookup[0], name: d.value }]);
                }
              }}
            />
            <Input
              size="small"
              placeholder="Entity Type"
              value={lookup?.[0]?.entityType ?? ''}
              onChange={(_, d) => {
                if (lookup?.[0]) {
                  setValue(prop.name, [{ ...lookup[0], entityType: d.value }]);
                }
              }}
            />
          </div>
        </div>
      );
    }

    case 'TwoOptions':
      return (
        <div className={styles.field}>
          <div className={styles.label}>
            {prop.displayNameKey} {usageBadge}
            <span className={styles.typeHint}>{prop.ofType}</span>
          </div>
          <Switch checked={value ?? false} onChange={handleSwitchChange} />
        </div>
      );

    case 'Whole.None':
    case 'FP':
    case 'Decimal':
    case 'Currency':
      return (
        <div className={styles.field}>
          <div className={styles.label}>
            {prop.displayNameKey} {usageBadge}
            <span className={styles.typeHint}>{prop.ofType}</span>
          </div>
          <SpinButton
            size="small"
            value={value ?? 0}
            onChange={handleNumberChange}
          />
        </div>
      );

    case 'Enum':
      if (prop.enumValues && prop.enumValues.length > 0) {
        const enumVal = typeof value === 'string' ? value : (value != null ? String(value) : '');
        return (
          <div className={styles.field}>
            <div className={styles.label}>
              {prop.displayNameKey} {usageBadge}
              <span className={styles.typeHint}>{prop.ofType}</span>
            </div>
            <Dropdown
              size="small"
              placeholder="Select an option"
              selectedOptions={enumVal ? [enumVal] : []}
              value={prop.enumValues.find(v => v.value === enumVal)?.displayNameKey ?? enumVal}
              onOptionSelect={(_, d) => setValue(prop.name, d.optionValue ?? null)}
            >
              {prop.enumValues.map(v => (
                <Option key={v.value} value={v.value} text={v.displayNameKey}>{v.displayNameKey}</Option>
              ))}
            </Dropdown>
          </div>
        );
      }
      // Fall through to default text input if no enum values defined
      return (
        <div className={styles.field}>
          <div className={styles.label}>
            {prop.displayNameKey} {usageBadge}
            <span className={styles.typeHint}>{prop.ofType}</span>
          </div>
          <Input
            size="small"
            value={typeof value === 'string' ? value : (value != null ? String(value) : '')}
            onChange={handleTextChange}
            placeholder={prop.descriptionKey || prop.name}
          />
        </div>
      );

    case 'Multiple':
      return (
        <div className={styles.field}>
          <div className={styles.label}>
            {prop.displayNameKey} {usageBadge}
            <span className={styles.typeHint}>{prop.ofType}</span>
          </div>
          <Textarea
            size="small"
            value={value ?? ''}
            onChange={handleTextChange}
            resize="vertical"
          />
        </div>
      );

    default:
      return (
        <div className={styles.field}>
          <div className={styles.label}>
            {prop.displayNameKey} {usageBadge}
            <span className={styles.typeHint}>{prop.ofType}</span>
          </div>
          <Input
            size="small"
            value={typeof value === 'string' ? value : (value != null ? String(value) : '')}
            onChange={handleTextChange}
            placeholder={prop.descriptionKey || prop.name}
          />
        </div>
      );
  }
}

interface Props {
  manifest: ManifestConfig;
}

export function PropertyEditor({ manifest }: Props) {
  const styles = useStyles();
  const pageEntityId = useHarnessStore(s => s.pageEntityId);
  const pageEntityTypeName = useHarnessStore(s => s.pageEntityTypeName);
  const setPageEntityId = useHarnessStore(s => s.setPageEntityId);
  const setPageEntityTypeName = useHarnessStore(s => s.setPageEntityTypeName);

  // Get available entity types from data.json
  const entityTypes = useMemo(() => getEntityStoreKeys(), []);

  // Get columns for the selected entity type
  const entityColumns = useMemo(() => getEntityColumns(pageEntityTypeName), [pageEntityTypeName]);

  const boundProps = manifest.properties.filter(p => p.usage === 'bound');
  const inputProps = manifest.properties.filter(p => p.usage === 'input');

  return (
    <div className={styles.root}>
      <ControlInfoCard manifest={manifest} />

      {/* Page Context */}
      <Label size="small" weight="semibold" style={{ opacity: 0.6 }}>Page Context</Label>
      <div className={styles.field}>
        <div className={styles.label}>
          Entity Type Name
          <span className={styles.typeHint}>context.page.entityTypeName</span>
        </div>
        {entityTypes.length > 0 ? (
          <Dropdown
            size="small"
            placeholder="Select entity type"
            selectedOptions={pageEntityTypeName ? [pageEntityTypeName] : []}
            value={pageEntityTypeName}
            onOptionSelect={(_, d) => setPageEntityTypeName(d.optionValue ?? '')}
          >
            <Option value="" text="">— None —</Option>
            {entityTypes.map(t => (
              <Option key={t} value={t} text={t}>{t}</Option>
            ))}
          </Dropdown>
        ) : (
          <Input
            size="small"
            placeholder="e.g. msdyn_workorderservicetask"
            value={pageEntityTypeName}
            onChange={(_, d) => setPageEntityTypeName(d.value)}
          />
        )}
      </div>
      <div className={styles.field}>
        <div className={styles.label}>
          Entity ID
          <span className={styles.typeHint}>context.page.entityId</span>
        </div>
        <Input
          size="small"
          placeholder="Record GUID"
          value={pageEntityId}
          onChange={(_, d) => setPageEntityId(d.value)}
        />
      </div>
      <Divider style={{ margin: '8px 0' }} />

      <div className={styles.header}>Properties</div>

      {boundProps.length > 0 && (
        <>
          <Label size="small" weight="semibold" style={{ opacity: 0.6 }}>Bound Properties</Label>
          {boundProps.map(p => (
            <PropertyField
              key={p.name}
              prop={p}
              manifest={manifest}
              entityColumns={entityColumns}
              pageEntityTypeName={pageEntityTypeName}
              pageEntityId={pageEntityId}
            />
          ))}
        </>
      )}

      {inputProps.length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Label size="small" weight="semibold" style={{ opacity: 0.6 }}>Input Properties</Label>
          {inputProps.map(p => (
            <PropertyField
              key={p.name}
              prop={p}
              manifest={manifest}
              entityColumns={entityColumns}
              pageEntityTypeName={pageEntityTypeName}
              pageEntityId={pageEntityId}
            />
          ))}
        </>
      )}
    </div>
  );
}
