/**
 * Entity metadata store.
 *
 * Supports TWO formats:
 *
 * 1. Dataverse API format (raw response from EntityDefinitions endpoint):
 *    Save the response from:
 *    GET /api/data/v9.2/EntityDefinitions?$filter=LogicalName eq '{entity}'
 *        &$select=LogicalName,DisplayName
 *        &$expand=Attributes($select=LogicalName,DisplayName,AttributeType)
 *
 * 2. Simple format (hand-authored):
 *    { "entityName": { "displayName": "...", "columns": { "col": { "displayName": "...", "type": "..." } } } }
 *
 * The harness auto-detects the format and normalises to the simple format.
 */

export interface ColumnMetadata {
  displayName: string;
  type?: string;
  options?: Array<{ value: number; text: string }>;
  targets?: string[];
  defaultValue?: any;
}

export type MetadataProvenanceKind = 'snapshot' | 'live' | 'inferred' | 'manual';

export interface MetadataProvenance {
  kind: MetadataProvenanceKind;
  orgUrl?: string;
  capturedAt?: string;
}

/**
 * 1:N / N:1 relationship between a parent (ReferencedEntity) and a child
 * (ReferencingEntity). On the parent's `oneToManyRelationships`, the parent
 * is `referencedEntity`; on the child's `manyToOneRelationships`, the same
 * relationship appears in the same shape (the harness deliberately mirrors
 * the Dataverse OneToManyRelationship payload — no inversion).
 *
 * Shape matches the live `LiveRelationship` from `api/dv-client.ts` so that
 * a future "copy live metadata to mock" action can drop the array in
 * verbatim.
 */
export interface RelationshipMetadata {
  /** e.g. `msdyn_msdyn_workorder_msdyn_workorderproduct_WorkOrder`. */
  schemaName: string;
  /** Child entity (where the lookup attribute lives). */
  referencingEntity: string;
  /** Lookup attribute on the child pointing at the parent (e.g. `msdyn_workorder`). */
  referencingAttribute: string;
  /** Parent entity (where the relationship "starts"). */
  referencedEntity: string;
  /** Primary id attribute on the parent (e.g. `msdyn_workorderid`). */
  referencedAttribute: string;
}

/**
 * N:N relationship via an intersect entity. Shape mirrors the Dataverse
 * ManyToManyRelationship payload so copy-from-live is a structural drop.
 * Not yet consumed by the Associated-host picker (1:N only today).
 */
export interface ManyToManyMetadata {
  /** Relationship schema name. */
  schemaName: string;
  /** Intersect entity logical name. */
  intersectEntity: string;
  /** Side 1 entity + its intersect attribute. */
  entity1LogicalName: string;
  entity1IntersectAttribute: string;
  /** Side 2 entity + its intersect attribute. */
  entity2LogicalName: string;
  entity2IntersectAttribute: string;
}

export interface EntityMetadata {
  displayName: string;
  columns: Record<string, ColumnMetadata>;
  /** Where this schema came from. Snapshot provenance is persisted in
   * metadata.json; inferred/manual metadata remains explicit in the UI. */
  provenance?: MetadataProvenance;
  /** Primary key column name (e.g. `formid` for `systemform`). Populated
   *  in live mode from EntityDefinitions.PrimaryIdAttribute; may be absent
   *  for hand-rolled mock metadata, in which case callers fall back to the
   *  `<entityType>id` convention. */
  primaryIdAttribute?: string;
  /** Primary name column (e.g. `name` / `fullname`). Same source/fallback. */
  primaryNameAttribute?: string;
  /** 1:N relationships where THIS entity is the parent (referencedEntity).
   *  Used by the Associated-host relationship picker in mock mode. */
  oneToManyRelationships?: RelationshipMetadata[];
  /** 1:N relationships where THIS entity is the child (referencingEntity).
   *  i.e. the lookup attributes on this entity. Mirrored from the parent's
   *  oneToManyRelationships for query convenience. Not yet consumed in mock. */
  manyToOneRelationships?: RelationshipMetadata[];
  /** N:N relationships this entity participates in. Not yet consumed in mock. */
  manyToManyRelationships?: ManyToManyMetadata[];
}

/** Convenience: return the 1:N relationships from `parentEntity` declared in
 *  mock metadata. Returns an empty array when the entity has no metadata or
 *  no relationships authored. */
export function getOneToManyRelationships(parentEntity: string): RelationshipMetadata[] {
  return metadataStore[parentEntity]?.oneToManyRelationships ?? [];
}

let metadataStore: Record<string, EntityMetadata> = {};
const metadataListeners = new Set<() => void>();
let metadataVersion = 0;

function notifyMetadata(): void {
  metadataVersion++;
  for (const fn of metadataListeners) fn();
}

/** Subscribe to metadata-store mutations. Returns an unsubscribe fn. */
export function subscribeMetadata(listener: () => void): () => void {
  metadataListeners.add(listener);
  return () => metadataListeners.delete(listener);
}

/** Version counter for `useSyncExternalStore` snapshot keying. */
export function getMetadataVersion(): number {
  return metadataVersion;
}

/** Snapshot of the entire metadata store. Used by scenario serialization
 *  and the DataPanel "Metadata" tab. */
export function getAllMetadata(): Record<string, EntityMetadata> {
  return { ...metadataStore };
}

/** Replace the metadata for a single entity. Used by the DataPanel JSON
 *  editor when the user manually edits an entity's metadata. */
export function setEntityMetadata(entityType: string, meta: EntityMetadata): void {
  metadataStore = {
    ...metadataStore,
    [entityType]: {
      ...meta,
      provenance: meta.provenance ?? { kind: 'manual' },
    },
  };
  notifyMetadata();
}

/** Drop a single entity from the metadata store. */
export function deleteEntityMetadata(entityType: string): void {
  if (!(entityType in metadataStore)) return;
  const next = { ...metadataStore };
  delete next[entityType];
  metadataStore = next;
  notifyMetadata();
}

/** Replace the entire metadata store atomically. Used when applying a
 *  scenario that carries a serialized metadata snapshot. */
export function replaceAllMetadata(data: Record<string, EntityMetadata>): void {
  metadataStore = Object.fromEntries(
    Object.entries(data).map(([entityType, meta]) => [
      entityType,
      {
        ...meta,
        provenance: meta.provenance ?? { kind: 'inferred' },
      },
    ]),
  );
  notifyMetadata();
}

/** Clear every entity from the metadata store. */
export function clearMetadata(): void {
  metadataStore = {};
  notifyMetadata();
}

/**
 * Load metadata, auto-detecting Dataverse API format vs simple format.
 */
export function loadMetadata(data: any): void {
  if (!data || typeof data !== 'object') return;

  let mutated = false;
  const next = { ...metadataStore };
  const envelopeProvenance = provenanceFromEnvelope(data);

  // Detect Dataverse API format: has "value" array with Attributes
  if (Array.isArray(data.value) && data.value.length > 0 && data.value[0].Attributes) {
    for (const entity of data.value) {
      const parsed = parseDataverseEntity(entity, envelopeProvenance);
      if (parsed) {
        next[parsed.logicalName] = parsed.metadata;
        mutated = true;
      }
    }
  }

  // Check if it's an array of Dataverse responses (multiple files merged)
  else if (Array.isArray(data)) {
    for (const item of data) {
      loadMetadata(item);
    }
    return;
  }

  // Simple format — use directly, but validate structure
  else {
    for (const [key, val] of Object.entries(data)) {
      const entity = val as any;
      if (entity.displayName && entity.columns) {
        next[key] = {
          ...entity,
          provenance: entity.provenance ?? { kind: 'inferred' },
        };
        mutated = true;
      } else if (entity.Attributes) {
        const parsed = parseDataverseEntity(entity, envelopeProvenance);
        if (parsed) {
          next[parsed.logicalName] = parsed.metadata;
          mutated = true;
        }
      }
    }
  }

  if (mutated) {
    metadataStore = next;
    notifyMetadata();
  }
}

function provenanceFromEnvelope(data: any): MetadataProvenance | undefined {
  if (data?.source?.kind === 'dataverse-snapshot') {
    return {
      kind: 'snapshot',
      orgUrl: data.source.orgUrl,
      capturedAt: data.generatedAt,
    };
  }
  if (data?.source?.kind === 'live') {
    return { kind: 'live', orgUrl: data.source.orgUrl };
  }
  return undefined;
}

function parseDataverseEntity(
  entity: any,
  fallbackProvenance?: MetadataProvenance,
): { logicalName: string; metadata: EntityMetadata } | null {
  const logicalName = entity.LogicalName;
  if (!logicalName) return null;

  const displayLabel = entity.DisplayName?.UserLocalizedLabel;
  const displayName = displayLabel?.Label ?? logicalName;

  const columns: Record<string, ColumnMetadata> = {};
  for (const attr of (entity.Attributes ?? [])) {
    const attrLogical = attr.LogicalName;
    const attrLabel = attr.DisplayName?.UserLocalizedLabel;
    // Fall back to logical name when no localized display label is present —
    // ensures hand-rolled metadata or columns missing a UserLocalizedLabel
    // still surface in form-store seeding.
    const col: ColumnMetadata = {
      displayName: attrLabel?.Label ?? attrLogical,
      type: attr.AttributeType,
    };
    // Picklist/State/Status options — works for inline OptionSet,
    // GlobalOptionSet, or simple { Options:[...] } shape.
    const os = attr.OptionSet ?? attr.GlobalOptionSet;
    if (os && Array.isArray(os.Options)) {
      const opts: Array<{ value: number; text: string }> = [];
      for (const o of os.Options) {
        if (o?.Value == null) continue;
        const lbl = o.Label?.UserLocalizedLabel?.Label
          ?? o.Label?.LocalizedLabels?.[0]?.Label
          ?? String(o.Value);
        opts.push({ value: Number(o.Value), text: lbl });
      }
      if (opts.length) col.options = opts;
    }
    // Lookup targets
    if (Array.isArray(attr.Targets) && attr.Targets.length) {
      col.targets = attr.Targets.slice();
    }
    // Default form value — picklists carry DefaultFormValue; other types
    // expose DefaultValue. Preserve so form-store can prefill Quick Create.
    if (attr.DefaultFormValue != null && attr.DefaultFormValue !== -1) {
      col.defaultValue = attr.DefaultFormValue;
    } else if (attr.DefaultValue != null) {
      col.defaultValue = attr.DefaultValue;
    }
    columns[attrLogical] = col;
  }

  return {
    logicalName,
    metadata: {
      displayName,
      columns,
      provenance: entity._pcfWorkbenchProvenance ?? fallbackProvenance ?? { kind: 'inferred' },
      primaryIdAttribute: entity.PrimaryIdAttribute,
      primaryNameAttribute: entity.PrimaryNameAttribute,
    },
  };
}

export function getEntityMetadata(entityType: string): EntityMetadata | null {
  return metadataStore[entityType] ?? null;
}

export function getColumnDisplayName(entityType: string, columnName: string): string | null {
  const entity = metadataStore[entityType];
  if (!entity) return null;
  return entity.columns[columnName]?.displayName ?? null;
}

export function getEntityDisplayName(entityType: string): string | null {
  return metadataStore[entityType]?.displayName ?? null;
}

/**
 * List every entity type currently loaded in the metadata store.
 * Used by form-store to pre-seed attributes/controls for all entities so
 * cross-entity getAttribute() lookups work (e.g. a child-grid PCF whose
 * page entity is the parent record but whose form targets a child entity).
 */
export function getAllEntityTypes(): string[] {
  return Object.keys(metadataStore);
}
