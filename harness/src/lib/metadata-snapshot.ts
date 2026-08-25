import { dvGet } from '../api/dv-client';

const API_ROOT = '/api/data/v9.2';
const CAST_ROOT = 'Microsoft.Dynamics.CRM.';

export interface MetadataSnapshotScope {
  entities: Map<string, Set<string>>;
  annotatedLookupTargets: Set<string>;
}

export interface MetadataSnapshotResult {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    kind: 'dataverse-snapshot';
    orgUrl: string;
  };
  value: any[];
}

function normaliseColumn(key: string): string | null {
  if (key.includes('@')) return null;
  if (key.startsWith('_') && key.endsWith('_value')) {
    return key.slice(1, -'_value'.length);
  }
  return key;
}

export function collectMetadataSnapshotScope(
  records: Record<string, Record<string, any>[]>,
): MetadataSnapshotScope {
  const entities = new Map<string, Set<string>>();
  const annotatedLookupTargets = new Set<string>();

  for (const [entityType, rows] of Object.entries(records)) {
    const columns = entities.get(entityType) ?? new Set<string>();
    entities.set(entityType, columns);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        const column = normaliseColumn(key);
        if (column) columns.add(column);
        if (
          key.endsWith('@Microsoft.Dynamics.CRM.lookuplogicalname')
          && typeof value === 'string'
          && value
        ) {
          annotatedLookupTargets.add(value);
        }
      }
    }
  }

  for (const target of annotatedLookupTargets) {
    if (!entities.has(target)) entities.set(target, new Set());
  }
  return { entities, annotatedLookupTargets };
}

function logicalNameKey(logicalName: string): string {
  return logicalName.replace(/'/g, "''");
}

function relativeNextLink(nextLink: string): string {
  if (nextLink.startsWith('/')) return nextLink;
  const parsed = new URL(nextLink);
  return `${parsed.pathname}${parsed.search}`;
}

async function getAll(orgUrl: string, path: string): Promise<any[]> {
  const rows: any[] = [];
  let next: string | undefined = path;
  while (next) {
    const response: { value?: any[]; '@odata.nextLink'?: string } =
      await dvGet<{ value?: any[]; '@odata.nextLink'?: string }>(orgUrl, next);
    rows.push(...(response.value ?? []));
    next = response['@odata.nextLink']
      ? relativeNextLink(response['@odata.nextLink'])
      : undefined;
  }
  return rows;
}

async function fetchTypedOptions(
  orgUrl: string,
  entityType: string,
  cast: string,
  includeGlobal: boolean,
): Promise<Map<string, any>> {
  const optionSets = new Map<string, any>();
  const expand = includeGlobal
    ? '$expand=OptionSet($select=Options),GlobalOptionSet($select=Options)'
    : '$expand=OptionSet($select=Options)';
  const path = `${API_ROOT}/EntityDefinitions(LogicalName='${logicalNameKey(entityType)}')`
    + `/Attributes/${CAST_ROOT}${cast}?$select=LogicalName&${expand}`;
  const rows = await getAll(orgUrl, path).catch(() => []);
  for (const row of rows) {
    const optionSet = row.OptionSet?.Options?.length
      ? row.OptionSet
      : row.GlobalOptionSet?.Options?.length
        ? row.GlobalOptionSet
        : null;
    if (row.LogicalName && optionSet) optionSets.set(row.LogicalName, optionSet);
  }
  return optionSets;
}

async function fetchEntityMetadata(
  orgUrl: string,
  entityType: string,
  usedColumns: Set<string>,
  capturedAt: string,
): Promise<{ entity: any; lookupTargets: string[] }> {
  const key = logicalNameKey(entityType);
  const basePath = `${API_ROOT}/EntityDefinitions(LogicalName='${key}')`
    + '?$select=LogicalName,PrimaryIdAttribute,PrimaryNameAttribute,DisplayName'
    + '&$expand=Attributes($select=LogicalName,AttributeType,DisplayName)';

  const optionCasts = [
    ['PicklistAttributeMetadata', true],
    ['StateAttributeMetadata', false],
    ['StatusAttributeMetadata', false],
    ['MultiSelectPicklistAttributeMetadata', true],
  ] as const;

  const [base, optionMaps, booleans, lookups] = await Promise.all([
    dvGet<any>(orgUrl, basePath),
    Promise.all(optionCasts.map(([cast, includeGlobal]) =>
      fetchTypedOptions(orgUrl, entityType, cast, includeGlobal))),
    getAll(
      orgUrl,
      `${API_ROOT}/EntityDefinitions(LogicalName='${key}')/Attributes/${CAST_ROOT}BooleanAttributeMetadata`
        + '?$select=LogicalName&$expand=OptionSet($select=TrueOption,FalseOption)',
    ).catch(() => []),
    getAll(
      orgUrl,
      `${API_ROOT}/EntityDefinitions(LogicalName='${key}')/Attributes/${CAST_ROOT}LookupAttributeMetadata`
        + '?$select=LogicalName,Targets',
    ).catch(() => []),
  ]);

  const keep = new Set(usedColumns);
  if (base.PrimaryIdAttribute) keep.add(base.PrimaryIdAttribute);
  if (base.PrimaryNameAttribute) keep.add(base.PrimaryNameAttribute);

  const options = new Map<string, any>();
  for (const map of optionMaps) {
    for (const [logicalName, optionSet] of map) options.set(logicalName, optionSet);
  }
  for (const row of booleans) {
    const values = [row.OptionSet?.FalseOption, row.OptionSet?.TrueOption].filter(Boolean);
    if (row.LogicalName && values.length) options.set(row.LogicalName, { Options: values });
  }

  const lookupMap = new Map<string, string[]>();
  for (const row of lookups) {
    if (row.LogicalName && Array.isArray(row.Targets) && row.Targets.length) {
      lookupMap.set(row.LogicalName, row.Targets);
    }
  }

  const lookupTargets = new Set<string>();
  const attributes = (base.Attributes ?? [])
    .filter((attribute: any) => keep.has(attribute.LogicalName))
    .map((attribute: any) => {
      const next = { ...attribute };
      const optionSet = options.get(attribute.LogicalName);
      if (optionSet) next.OptionSet = optionSet;
      const targets = lookupMap.get(attribute.LogicalName);
      if (targets) {
        next.Targets = targets;
        for (const target of targets) lookupTargets.add(target);
      }
      return next;
    });

  return {
    entity: {
      ...base,
      Attributes: attributes,
      _pcfWorkbenchProvenance: {
        kind: 'snapshot',
        orgUrl,
        capturedAt,
      },
    },
    lookupTargets: Array.from(lookupTargets),
  };
}

export async function snapshotDataverseMetadata(
  orgUrl: string,
  records: Record<string, Record<string, any>[]>,
): Promise<MetadataSnapshotResult> {
  const capturedAt = new Date().toISOString();
  const scope = collectMetadataSnapshotScope(records);
  const queue = Array.from(scope.entities.keys());
  const captured = new Map<string, any>();

  for (let index = 0; index < queue.length; index++) {
    const entityType = queue[index];
    if (captured.has(entityType)) continue;
    const usedColumns = scope.entities.get(entityType) ?? new Set<string>();
    const result = await fetchEntityMetadata(orgUrl, entityType, usedColumns, capturedAt);
    captured.set(entityType, result.entity);
    for (const target of result.lookupTargets) {
      if (!scope.entities.has(target)) {
        scope.entities.set(target, new Set());
        queue.push(target);
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: capturedAt,
    source: { kind: 'dataverse-snapshot', orgUrl },
    value: Array.from(captured.values()).sort((a, b) =>
      String(a.LogicalName).localeCompare(String(b.LogicalName))),
  };
}

export async function persistMetadataSnapshot(
  snapshot: MetadataSnapshotResult,
): Promise<MetadataSnapshotResult> {
  const response = await fetch('/pcf-data/metadata.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Failed to write metadata.json (${response.status})`);
  }
  return body.metadata as MetadataSnapshotResult;
}
