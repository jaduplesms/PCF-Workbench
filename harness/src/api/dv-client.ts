/**
 * Browser-side client for the Vite plugin's Dataverse proxy.
 *
 * Talks to `/__pcf/dv/*` (same-origin) — never directly to the org.
 * Reads the per-session secret from `<meta name="pcf-session">` injected by
 * the dataverse-security plugin; the proxy rejects requests without it.
 *
 * Adapts live OData responses (`{ value, "@odata.nextLink" }`) to the
 * existing offline shim contract (`{ entities, nextLink }`) so that the
 * rest of the harness UI keeps working unchanged regardless of dataSource.
 */

import { useHarnessStore, type PublicProfile } from '../store/harness-store';
import { loadMetadata, getEntityMetadata } from '../store/metadata-store';
import { fetchXmlToViewFragment } from '../lib/fetchxml-parser';
import type { ViewDefinition } from '../types/dataset-binding';

const PROXY_BASE = '/__pcf/dv';

let sessionSecretCache: string | null = null;

/** Returns the per-session secret injected by dataverse-security plugin via
 *  `<meta name="pcf-session">`. Exported so other callers (cache admin panel)
 *  can attach the required `x-pcf-session` header without re-implementing the
 *  lookup. Throws if the meta tag is missing. */
export function getSessionSecret(): string {
  if (sessionSecretCache) return sessionSecretCache;
  if (typeof document === 'undefined') {
    throw new Error('dv-client: document not available (server-side render?)');
  }
  const meta = document.querySelector('meta[name="pcf-session"]');
  const value = meta?.getAttribute('content') ?? '';
  if (!value) {
    throw new Error(
      'dv-client: <meta name="pcf-session"> not found on the page. ' +
        'Is the dataverse-security plugin enabled?',
    );
  }
  sessionSecretCache = value;
  return value;
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/json',
    'x-pcf-session': getSessionSecret(),
    ...extra,
  };
}

export interface ProxyErrorBody {
  error: string;
  message: string;
  meta?: Record<string, unknown>;
}

export function normalizeProxyErrorBody(
  raw: unknown,
  status: number,
  statusText: string,
): ProxyErrorBody {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (typeof record.error === 'string') {
      return {
        error: record.error,
        message: typeof record.message === 'string'
          ? record.message
          : `HTTP ${status} ${statusText}`,
        meta: record.meta && typeof record.meta === 'object'
          ? record.meta as Record<string, unknown>
          : undefined,
      };
    }

    const nested = record.error;
    if (nested && typeof nested === 'object') {
      const error = nested as Record<string, unknown>;
      const rawMessage = error.message;
      const message = typeof rawMessage === 'string'
        ? rawMessage
        : rawMessage && typeof rawMessage === 'object'
          ? String((rawMessage as Record<string, unknown>).value ?? '')
          : '';
      return {
        error: typeof error.code === 'string' && error.code
          ? error.code
          : 'dataverse-error',
        message: message || `HTTP ${status} ${statusText}`,
        meta: { upstream: error },
      };
    }
  }

  return {
    error: 'upstream-error',
    message: `HTTP ${status} ${statusText}`,
  };
}

export class DvProxyError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ProxyErrorBody,
  ) {
    super(`[${status}] ${body.error}: ${body.message}`);
    this.name = 'DvProxyError';
  }
}

async function parseError(res: Response): Promise<DvProxyError> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = null;
  }
  const body = normalizeProxyErrorBody(raw, res.status, res.statusText);
  return new DvProxyError(res.status, body);
}

function maybeFlagReauth(err: DvProxyError, orgUrl: string): void {
  if (err.body.error === 'pac-reauth-required' || err.body.error === 'pac-profile-missing') {
    useHarnessStore.getState().setPacReauthRequired({ org: orgUrl, kind: 'reauth' });
  } else if (err.body.error === 'pac-cache-corrupt') {
    useHarnessStore.getState().setPacReauthRequired({ org: orgUrl, kind: 'cache-corrupt' });
  }
}

/* -------------------------------------------------------------------------- */
/* Profile listing                                                             */
/* -------------------------------------------------------------------------- */

export interface ProfileListResponse {
  profiles: PublicProfile[];
  current: string | null;
}

export async function listProfiles(): Promise<ProfileListResponse> {
  const res = await fetch(`${PROXY_BASE}/profiles`, { headers: buildHeaders() });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ProfileListResponse;
}

/* -------------------------------------------------------------------------- */
/* Raw GET                                                                     */
/* -------------------------------------------------------------------------- */

export async function dvGet<T = unknown>(orgUrl: string, path: string, prefer?: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${PROXY_BASE}${path}${sep}org=${encodeURIComponent(orgUrl)}`;
  const headers = buildHeaders(prefer ? { Prefer: prefer } : undefined);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await parseError(res);
    maybeFlagReauth(err, orgUrl);
    throw err;
  }
  useHarnessStore.getState().setPacReauthRequired(null);
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* OData response adapter                                                      */
/* -------------------------------------------------------------------------- */

interface ODataValueResponse<T = Record<string, unknown>> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

export interface AdaptedMultiResponse {
  entities: Record<string, unknown>[];
  nextLink?: string;
  totalRecordCount?: number;
}

export function adaptMultiResponse(raw: ODataValueResponse): AdaptedMultiResponse {
  return {
    entities: raw.value ?? [],
    nextLink: raw['@odata.nextLink'],
    totalRecordCount: raw['@odata.count'],
  };
}

/* -------------------------------------------------------------------------- */
/* Entity set name resolver                                                    */
/* -------------------------------------------------------------------------- */

export interface EntityResolved {
  entitySetName: string;
  primaryNameAttribute?: string;
  primaryIdAttribute?: string;
}

const entityMetaInflight = new Map<string, Promise<EntityResolved>>();

/**
 * Resolve the OData EntitySetName + PrimaryName/PrimaryId attributes for a
 * Dataverse logical entity name. Cached in `entitySetCache` (single string-
 * shaped slot per entity for back-compat: serialised JSON if extra fields
 * are present). Falls back to `${logicalName}s` on any failure so a single
 * 401/403 doesn't poison the rest of the session.
 */
export async function resolveEntityMetadata(orgUrl: string, logicalName: string): Promise<EntityResolved> {
  const cache = useHarnessStore.getState().entitySetCache;
  const cached = cache[logicalName];
  if (cached) {
    if (cached.startsWith('{')) {
      try { return JSON.parse(cached) as EntityResolved; } catch { /* fall through */ }
    }
    return { entitySetName: cached };
  }

  const inflight = entityMetaInflight.get(logicalName);
  if (inflight) return inflight;

  const path = `/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`
    + `?$select=EntitySetName,PrimaryNameAttribute,PrimaryIdAttribute`;
  const p = (async () => {
    try {
      const r = await dvGet<{ EntitySetName?: string; PrimaryNameAttribute?: string; PrimaryIdAttribute?: string }>(orgUrl, path);
      const resolved: EntityResolved = {
        entitySetName: r.EntitySetName ?? `${logicalName}s`,
        primaryNameAttribute: r.PrimaryNameAttribute,
        primaryIdAttribute: r.PrimaryIdAttribute,
      };
      useHarnessStore.getState().setEntitySetName(logicalName, JSON.stringify(resolved));
      return resolved;
    } catch (e) {
      useHarnessStore.getState().addLogEntry({
        category: 'webAPI',
        method: 'live.resolveEntityMetadata.fallback',
        args: { logicalName, error: (e as Error).message },
      });
      const fallback: EntityResolved = { entitySetName: `${logicalName}s` };
      useHarnessStore.getState().setEntitySetName(logicalName, fallback.entitySetName);
      return fallback;
    } finally {
      entityMetaInflight.delete(logicalName);
    }
  })();
  entityMetaInflight.set(logicalName, p);
  return p;
}

export async function resolveEntitySetName(orgUrl: string, logicalName: string): Promise<string> {
  return (await resolveEntityMetadata(orgUrl, logicalName)).entitySetName;
}

/* -------------------------------------------------------------------------- */
/* High-level retrieve helpers used by the live web-api shim                   */
/* -------------------------------------------------------------------------- */

export async function liveRetrieveMultiple(
  orgUrl: string,
  logicalEntity: string,
  options: string | undefined,
  maxPageSize: number | undefined,
): Promise<AdaptedMultiResponse> {
  // Short-circuit obviously-malformed filters BEFORE hitting Dataverse.
  // Common case: a control reads a null lookup (we stub to empty-guid for
  // crash safety) and substitutes it into `$filter=(<attr> eq )` — Dataverse
  // 400s on this, masking the real bug (the control didn't null-check). We
  // return an empty result instead so the maker can keep testing, with a
  // visible warning entry in the activity log that points at the control.
  if (options && hasEmptyFilterOperand(options)) {
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn(
        '[pcf-workbench] Skipping retrieveMultipleRecords — filter has empty operand. ' +
        'The control likely passed a null lookup id into $filter without checking. ' +
        `entity=${logicalEntity} options=${options}`,
      );
    }
    return { entities: [] };
  }
  const setName = await resolveEntitySetName(orgUrl, logicalEntity);
  const query = options
    ? options.startsWith('?') ? options : `?${options}`
    : '';
  const path = `/api/data/v9.2/${setName}${query}`;
  const prefer = maxPageSize ? `odata.maxpagesize=${maxPageSize}` : undefined;
  const raw = await dvGet<ODataValueResponse>(orgUrl, path, prefer);
  return adaptMultiResponse(raw);
}

/**
 * Detect `$filter` clauses with an empty right-hand operand on a comparison
 * operator — e.g. `(productid eq )`, `(name eq '')`. Matches patterns the
 * eq-empty-guid stub produces when controls don't null-check a Lookup value.
 * Lenient by design: a string-literal `eq ''` is also flagged because no
 * real PCF would intentionally filter for empty-string keys.
 */
function hasEmptyFilterOperand(options: string): boolean {
  // Find the $filter= segment (case-insensitive, may be URL-encoded).
  const decoded = (() => { try { return decodeURIComponent(options); } catch { return options; } })();
  const match = /\$filter=([^&]+)/i.exec(decoded);
  if (!match) return false;
  const expr = match[1];
  // `<attr> <op>` followed by `)` or end → empty operand
  // `<attr> <op> ''`                      → empty string literal
  // Operators: eq ne gt ge lt le
  return /\b(eq|ne|gt|ge|lt|le)\s*(?:\)|$|''|""|,)/i.test(expr);
}

/**
 * Retrieve a list of records using a raw FetchXML string. Dataverse Web API
 * supports `?fetchXml=<urlencoded>` on the entity set endpoint and returns
 * the result in the same OData envelope as `liveRetrieveMultiple`.
 *
 * Used by `useLiveDatasetRecords` to hydrate the live dataset cache from
 * whichever savedquery / userquery the maker selected in LiveViewsRow.
 */
export async function liveRetrieveByFetchXml(
  orgUrl: string,
  logicalEntity: string,
  fetchXml: string,
  maxPageSize?: number,
): Promise<AdaptedMultiResponse> {
  const setName = await resolveEntitySetName(orgUrl, logicalEntity);
  const path = `/api/data/v9.2/${setName}?fetchXml=${encodeURIComponent(fetchXml)}`;
  const prefer = maxPageSize ? `odata.maxpagesize=${maxPageSize}` : undefined;
  const raw = await dvGet<ODataValueResponse>(orgUrl, path, prefer);
  return adaptMultiResponse(raw);
}

export async function liveRetrieveSingle(
  orgUrl: string,
  logicalEntity: string,
  id: string,
  options: string | undefined,
): Promise<Record<string, unknown>> {
  const setName = await resolveEntitySetName(orgUrl, logicalEntity);
  const normalId = id.replace(/[{}]/g, '');
  const query = options
    ? options.startsWith('?') ? options : `?${options}`
    : '';
  const path = `/api/data/v9.2/${setName}(${normalId})${query}`;
  return await dvGet<Record<string, unknown>>(orgUrl, path);
}

/* -------------------------------------------------------------------------- */
/* Entity catalogue + record search — Page Context live pickers                */
/* -------------------------------------------------------------------------- */

export interface LiveEntityDescriptor {
  logicalName: string;
  displayName: string;
  entitySetName: string;
  primaryNameAttribute: string;
  primaryIdAttribute: string;
}

interface RawEntityDef {
  LogicalName: string;
  EntitySetName: string;
  PrimaryNameAttribute: string;
  PrimaryIdAttribute: string;
  DisplayName?: {
    UserLocalizedLabel?: { Label?: string };
    LocalizedLabels?: Array<{ Label?: string; LanguageCode?: number }>;
  };
}

const liveEntityListCache = new Map<string, LiveEntityDescriptor[]>();

/**
 * Fetch the full catalogue of entities in the org. Used by the Page Context
 * entity picker so the maker can search instead of pasting logical names.
 *
 * Returns every entity (~1500 in a stock org). We do NOT filter server-side
 * on `IsValidForAdvancedFind/Value` — Dataverse rejects managed-property
 * filters on `EntityDefinitions` with a 400. The SearchPicker handles the
 * volume client-side.
 */
export async function liveListEntities(
  orgUrl: string,
  force = false,
): Promise<LiveEntityDescriptor[]> {
  if (!force) {
    const cached = liveEntityListCache.get(orgUrl);
    if (cached) return cached;
  }
  const path =
    '/api/data/v9.2/EntityDefinitions'
    + '?$select=LogicalName,EntitySetName,PrimaryNameAttribute,PrimaryIdAttribute,DisplayName';
  const raw = await dvGet<{ value: RawEntityDef[] }>(orgUrl, path);
  const list: LiveEntityDescriptor[] = (raw.value ?? [])
    .map(e => ({
      logicalName: e.LogicalName,
      entitySetName: e.EntitySetName ?? `${e.LogicalName}s`,
      primaryNameAttribute: e.PrimaryNameAttribute ?? 'name',
      primaryIdAttribute: e.PrimaryIdAttribute ?? `${e.LogicalName}id`,
      displayName:
        e.DisplayName?.UserLocalizedLabel?.Label
        ?? e.DisplayName?.LocalizedLabels?.[0]?.Label
        ?? e.LogicalName,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Hydrate the per-entity metadata cache so subsequent retrieve calls
  // skip the EntityDefinitions round-trip.
  const setEntitySetName = useHarnessStore.getState().setEntitySetName;
  for (const e of list) {
    setEntitySetName(
      e.logicalName,
      JSON.stringify({
        entitySetName: e.entitySetName,
        primaryNameAttribute: e.primaryNameAttribute,
        primaryIdAttribute: e.primaryIdAttribute,
      }),
    );
  }
  liveEntityListCache.set(orgUrl, list);
  return list;
}

export interface LiveRecordResult {
  id: string;
  name: string;
}

/**
 * Search the top N records of a live entity by primary-name prefix. Used by
 * the Page Context record picker so the maker can pick from a UCI-style
 * dropdown instead of pasting a GUID.
 *
 * - When `query` is empty, returns the top `max` records ordered by name
 *   (gives the maker something to scroll through immediately).
 * - When `query` is non-empty, applies `startswith(primaryName, query)`.
 * - When `query` looks like a GUID, retrieves that single record directly
 *   so a paste-a-GUID workflow still works.
 */
export async function liveSearchRecords(
  orgUrl: string,
  logicalEntity: string,
  query: string,
  max = 25,
): Promise<LiveRecordResult[]> {
  const meta = await resolveEntityMetadata(orgUrl, logicalEntity);
  const nameAttr = meta.primaryNameAttribute ?? 'name';
  const idAttr = meta.primaryIdAttribute ?? `${logicalEntity}id`;
  const trimmed = query.trim();

  // GUID-paste fast path — return that single record if it exists.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    try {
      const path = `/api/data/v9.2/${meta.entitySetName}(${trimmed})?$select=${nameAttr},${idAttr}`;
      const rec = await dvGet<Record<string, unknown>>(orgUrl, path);
      return [{ id: String(rec[idAttr] ?? trimmed), name: String(rec[nameAttr] ?? trimmed) }];
    } catch { /* fall through */ }
  }

  const select = `$select=${idAttr},${nameAttr}`;
  const filter = trimmed
    ? `&$filter=${encodeURIComponent(`startswith(${nameAttr},'${trimmed.replace(/'/g, "''")}')`)}`
    : '';
  const order = `&$orderby=${nameAttr}`;
  const top = `&$top=${max}`;
  const path = `/api/data/v9.2/${meta.entitySetName}?${select}${filter}${order}${top}`;
  const raw = await dvGet<{ value: Array<Record<string, unknown>> }>(orgUrl, path);
  return (raw.value ?? []).map(r => ({
    id: String(r[idAttr] ?? ''),
    name: String(r[nameAttr] ?? r[idAttr] ?? ''),
  }));
}

/** Test/dev hook — drop the entity list cache. */
export function __clearLiveEntityListCache(orgUrl?: string): void {
  if (orgUrl) liveEntityListCache.delete(orgUrl);
  else liveEntityListCache.clear();
}

/**
 * Describes a single 1:N relationship discovered between a parent entity
 * and a child entity. Used by Associated-host dataset bindings so the
 * harness can show a UCI-style relationship picker and inject the parent
 * filter into the child's FetchXML.
 */
export interface LiveRelationship {
  /** Schema name, e.g. `msdyn_msdyn_workorder_msdyn_workorderproduct_WorkOrder`. */
  schemaName: string;
  /** Child entity (the dataset entity), e.g. `msdyn_workorderproduct`. */
  referencingEntity: string;
  /** Lookup attribute on the child that points back at the parent, e.g. `msdyn_workorder`. */
  referencingAttribute: string;
  /** Parent entity (typically the page context entity), e.g. `msdyn_workorder`. */
  referencedEntity: string;
  /** Primary id attribute on the parent. */
  referencedAttribute: string;
}

const liveRelationshipCache = new Map<string, LiveRelationship[]>();

/**
 * List the 1:N relationships from `parentEntity`. If `childEntity` is
 * provided, narrow to that child; otherwise return every 1:N relationship
 * (often dozens) so the picker UX can show the maker what entity each
 * relationship points at. Cached per (org, parent, child).
 */
export async function liveListRelationships(
  orgUrl: string,
  parentEntity: string,
  childEntity?: string,
  force = false,
): Promise<LiveRelationship[]> {
  const key = `${orgUrl}||${parentEntity}->${childEntity ?? '*'}`;
  if (!force) {
    const cached = liveRelationshipCache.get(key);
    if (cached) return cached;
  }
  const select = '$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedEntity,ReferencedAttribute';
  const filterParts: string[] = [];
  if (childEntity) filterParts.push(`ReferencingEntity eq '${childEntity}'`);
  const filter = filterParts.length > 0
    ? `&$filter=${encodeURIComponent(filterParts.join(' and '))}`
    : '';
  const path = `/api/data/v9.2/EntityDefinitions(LogicalName='${parentEntity}')/OneToManyRelationships?${select}${filter}`;
  const raw = await dvGet<{ value: Array<Record<string, string>> }>(orgUrl, path);
  const list: LiveRelationship[] = (raw.value ?? []).map(r => ({
    schemaName: r.SchemaName ?? '',
    referencingEntity: r.ReferencingEntity ?? childEntity ?? '',
    referencingAttribute: r.ReferencingAttribute ?? '',
    referencedEntity: r.ReferencedEntity ?? parentEntity,
    referencedAttribute: r.ReferencedAttribute ?? `${parentEntity}id`,
  })).filter(r => r.schemaName && r.referencingAttribute);
  liveRelationshipCache.set(key, list);
  return list;
}

/** Test/dev hook — drop the relationship list cache. */
export function __clearLiveRelationshipCache(): void {
  liveRelationshipCache.clear();
}

/**
 * Fetch the current page record from Dataverse with no $select / $expand —
 * driven by the harness page-record auto-fetch hook so bound properties
 * (resolved sync via `getEntityData`) can populate from a real org record.
 *
 * Returns the raw OData record with `@odata.*` annotations preserved so the
 * existing `resolveColumnValue` path picks up `@OData.Community.Display.V1.FormattedValue`
 * and `_<lookup>_value` shapes.
 */
export async function liveRetrievePageRecord(
  orgUrl: string,
  logicalEntity: string,
  id: string,
): Promise<{ record: Record<string, any>; primaryName: string | null }> {
  const meta = await resolveEntityMetadata(orgUrl, logicalEntity);
  // Fire attribute-metadata fetch in parallel with the record fetch — we
  // don't await it because record rendering doesn't strictly need it (display
  // names + types are progressive enhancement). Errors are logged and ignored.
  void ensureLiveAttributeMetadata(orgUrl, logicalEntity);
  const normalId = id.replace(/[{}]/g, '');
  const record = await dvGet<Record<string, any>>(orgUrl, `/api/data/v9.2/${meta.entitySetName}(${normalId})`);
  const primaryName = meta.primaryNameAttribute && record[meta.primaryNameAttribute] != null
    ? String(record[meta.primaryNameAttribute])
    : null;
  return { record, primaryName };
}

/* -------------------------------------------------------------------------- */
/* M2.P4 — Live writes (create / update / delete)                              */
/*                                                                            */
/* All three flow through the same proxy path with the appropriate verb. The  */
/* proxy adds Authorization, return=representation Prefer, and (for           */
/* update/delete) If-Match: * for unconditional writes.                        */
/* -------------------------------------------------------------------------- */

async function dvFetch<T>(
  orgUrl: string,
  path: string,
  init: { method: string; body?: string; ifMatch?: string },
): Promise<{ status: number; headers: Headers; body: T | null }> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${PROXY_BASE}${path}${sep}org=${encodeURIComponent(orgUrl)}`;
  const extra: Record<string, string> = {};
  if (init.body !== undefined) extra['Content-Type'] = 'application/json';
  if (init.ifMatch) extra['If-Match'] = init.ifMatch;
  const res = await fetch(url, { method: init.method, headers: buildHeaders(extra), body: init.body });
  if (!res.ok) {
    const err = await parseError(res);
    maybeFlagReauth(err, orgUrl);
    throw err;
  }
  useHarnessStore.getState().setPacReauthRequired(null);
  // Empty body on 204 — Dataverse returns 204 for delete and (without
  // return=representation) for update. With return=representation update
  // returns 200 + body.
  let body: T | null = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text) as T; } catch { body = null; }
    }
  }
  return { status: res.status, headers: res.headers, body };
}

export interface LiveCreateResult {
  id: string;
  record?: Record<string, any>;
}

/**
 * Create a record in the real Dataverse org. Resolves the entity-set name
 * via metadata, POSTs the payload with `Prefer: return=representation`, and
 * extracts the new id from either the `OData-EntityId` header or the
 * returned record.
 */
export async function liveCreateRecord(
  orgUrl: string,
  logicalEntity: string,
  data: Record<string, any>,
): Promise<LiveCreateResult> {
  const setName = await resolveEntitySetName(orgUrl, logicalEntity);
  const path = `/api/data/v9.2/${setName}`;
  const { headers, body } = await dvFetch<Record<string, any>>(orgUrl, path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  const idFromBody = body && typeof body === 'object' ? extractIdFromRecord(body, logicalEntity) : null;
  const idFromHeader = extractIdFromODataEntityId(headers.get('OData-EntityId') || headers.get('Location'));
  const id = idFromBody ?? idFromHeader ?? '';
  return { id, record: body ?? undefined };
}

export async function liveUpdateRecord(
  orgUrl: string,
  logicalEntity: string,
  id: string,
  data: Record<string, any>,
): Promise<{ record?: Record<string, any> }> {
  const setName = await resolveEntitySetName(orgUrl, logicalEntity);
  const normalId = id.replace(/[{}]/g, '');
  const path = `/api/data/v9.2/${setName}(${normalId})`;
  const { body } = await dvFetch<Record<string, any>>(orgUrl, path, {
    method: 'PATCH',
    body: JSON.stringify(data),
    ifMatch: '*',
  });
  return { record: body ?? undefined };
}

export async function liveDeleteRecord(
  orgUrl: string,
  logicalEntity: string,
  id: string,
): Promise<void> {
  const setName = await resolveEntitySetName(orgUrl, logicalEntity);
  const normalId = id.replace(/[{}]/g, '');
  const path = `/api/data/v9.2/${setName}(${normalId})`;
  await dvFetch<unknown>(orgUrl, path, { method: 'DELETE', ifMatch: '*' });
}

function extractIdFromRecord(record: Record<string, any>, logicalEntity: string): string | null {
  const candidates = [`${logicalEntity}id`, 'id'];
  for (const k of candidates) {
    if (typeof record[k] === 'string' && record[k]) return record[k];
  }
  // Fallback — first GUID-shaped field
  for (const v of Object.values(record)) {
    if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
  }
  return null;
}

function extractIdFromODataEntityId(header: string | null): string | null {
  if (!header) return null;
  // Shape: https://<org>.crm.dynamics.com/api/data/v9.2/contacts(1c1cc1cc-1111-...)
  const m = header.match(/\(([0-9a-f-]+)\)\s*$/i);
  return m ? m[1] : null;
}

/* -------------------------------------------------------------------------- */
/* Attribute-metadata fetcher (DisplayName + AttributeType)                    */
/* -------------------------------------------------------------------------- */

const attrMetaInflight = new Map<string, Promise<void>>();
const attrMetaLoaded = new Set<string>();

/**
 * Fetch attribute metadata (LogicalName, DisplayName, AttributeType + option
 * sets for Picklist/State/Status attributes) for a Dataverse entity in live
 * mode and merge it into the metadata store. The store's
 * `parseDataverseEntity` already understands the
 * `EntityDefinitions(...)?$expand=Attributes` shape, so we just hand it the
 * raw response. Idempotent + once-per-entity per session.
 *
 * In live mode this ALWAYS overwrites any prior mock-derived entry — the
 * real org is the source of truth. In mock mode this is a no-op.
 *
 * Two parallel fetches:
 *   1. Basic attribute list (LogicalName/DisplayName/AttributeType) — fast.
 *   2. PicklistAttributeMetadata typed-cast with OptionSet expansion —
 *      slower but resolves option-set labels for choice columns. Merged on
 *      top of (1) before handing to loadMetadata.
 */
export async function ensureLiveAttributeMetadata(orgUrl: string, logicalName: string): Promise<void> {
  if (useHarnessStore.getState().dataSource !== 'live') return;
  if (attrMetaLoaded.has(logicalName)) return;
  const inflight = attrMetaInflight.get(logicalName);
  if (inflight) return inflight;

  const basePath = `/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`
    + `?$select=LogicalName,DisplayName,SchemaName,PrimaryNameAttribute,PrimaryIdAttribute`
    + `&$expand=Attributes($select=LogicalName,DisplayName,AttributeType)`;
  // Picklist/State/Status options. The typed-cast filters the Attributes
  // collection to choice-typed entries and expands their OptionSet.
  const picklistPath = `/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`
    + `/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata`
    + `?$select=LogicalName,AttributeType&$expand=OptionSet($select=Options)`;

  const p = (async () => {
    try {
      const [entity, picklistRaw] = await Promise.all([
        dvGet<any>(orgUrl, basePath),
        dvGet<{ value: any[] }>(orgUrl, picklistPath).catch(() => ({ value: [] })),
      ]);
      // Merge OptionSet onto the matching attributes in `entity.Attributes`
      // so parseDataverseEntity picks them up via its existing OptionSet
      // branch. Keys are case-sensitive logical names per OData.
      if (entity?.Attributes && Array.isArray(picklistRaw.value)) {
        const byLogical = new Map<string, any>();
        for (const a of picklistRaw.value) {
          if (a?.LogicalName) byLogical.set(a.LogicalName, a);
        }
        for (const attr of entity.Attributes) {
          const pl = byLogical.get(attr?.LogicalName);
          if (pl?.OptionSet) attr.OptionSet = pl.OptionSet;
        }
      }
      loadMetadata({
        source: { kind: 'live', orgUrl },
        value: [entity],
      });
      attrMetaLoaded.add(logicalName);
      useHarnessStore.getState().addLogEntry({
        category: 'webAPI',
        method: 'live.attributeMetadata.ok',
        args: {
          logicalName,
          attributes: Array.isArray(entity?.Attributes) ? entity.Attributes.length : 0,
          picklists: Array.isArray(picklistRaw.value) ? picklistRaw.value.length : 0,
        },
      });
      // Bump dataVersion so any in-flight render picks up the new display
      // names, column types, and option-set labels.
      useHarnessStore.setState(s => ({ dataVersion: s.dataVersion + 1 }));
    } catch (e) {
      useHarnessStore.getState().addLogEntry({
        category: 'webAPI',
        method: 'live.attributeMetadata.error',
        args: { logicalName, error: (e as Error).message },
      });
    } finally {
      attrMetaInflight.delete(logicalName);
    }
  })();
  attrMetaInflight.set(logicalName, p);
  return p;
}

/** Returns the set of entities that have been hydrated with live metadata
 *  in this session. Used by the Data panel inspector. */
export function getLiveLoadedEntities(): string[] {
  return Array.from(attrMetaLoaded).sort();
}

/** Test seam: clear in-process attribute-metadata caches. */
export function __clearLiveAttributeMetadataCache(): void {
  attrMetaInflight.clear();
  attrMetaLoaded.clear();
}

/* -------------------------------------------------------------------------- */
/* P5.1 — live savedquery / userquery view fetcher                            */
/* -------------------------------------------------------------------------- */

/**
 * Raw savedquery / userquery records used by the mappers. Only the fields
 * we actually consume — keeps the test fixtures sane.
 */
export interface RawSavedQuery {
  savedqueryid: string;
  name?: string;
  fetchxml?: string;
  layoutxml?: string;
  isdefault?: boolean;
  returnedtypecode?: string;
}

export interface RawUserQuery {
  userqueryid: string;
  name?: string;
  fetchxml?: string;
  layoutxml?: string;
  returnedtypecode?: string;
}

/**
 * Pure: map a savedquery (system view) record to a `ViewDefinition`.
 * Falls back to ``fallbackEntity`` when the fetchxml is missing/malformed so
 * the picker still shows the view (with whatever columns the layoutxml ends
 * up giving us at render time).
 */
export function mapSavedQueryToView(
  record: RawSavedQuery,
  fallbackEntity: string,
): ViewDefinition {
  const fragment = fetchXmlToViewFragment(record.fetchxml ?? null);
  return {
    viewId: `savedquery:${record.savedqueryid}`,
    displayName: record.name?.trim() || 'Untitled system view',
    entityType: fragment.entityType || record.returnedtypecode || fallbackEntity,
    viewType: 'system',
    columns: fragment.columns,
    ...(record.fetchxml ? { fetchXml: record.fetchxml } : {}),
    ...(record.isdefault ? { isDefault: true } : {}),
  };
}

/**
 * Pure: map a userquery (personal view) record to a `ViewDefinition`.
 * Same fallback chain as `mapSavedQueryToView`.
 */
export function mapUserQueryToView(
  record: RawUserQuery,
  fallbackEntity: string,
): ViewDefinition {
  const fragment = fetchXmlToViewFragment(record.fetchxml ?? null);
  return {
    viewId: `userquery:${record.userqueryid}`,
    displayName: record.name?.trim() || 'Untitled personal view',
    entityType: fragment.entityType || record.returnedtypecode || fallbackEntity,
    viewType: 'personal',
    columns: fragment.columns,
    ...(record.fetchxml ? { fetchXml: record.fetchxml } : {}),
  };
}

/**
 * Pure: sort + dedupe a merged list of system + personal views.
 *  - System views first, then personal — matches UCI's view picker order.
 *  - Within each group, the default system view (isDefault) floats to the
 *    top; otherwise A→Z by displayName (case-insensitive).
 *  - Dedupe by viewId (later entry wins) so a re-fetch overlaying cached
 *    entries doesn't double-render.
 */
export function sortAndDedupeViews(
  views: ViewDefinition[],
  defaultSystemViewId?: string,
): ViewDefinition[] {
  const byId = new Map<string, ViewDefinition>();
  for (const v of views) byId.set(v.viewId, v);
  const merged = Array.from(byId.values());

  return merged.sort((a, b) => {
    // System before personal
    if (a.viewType !== b.viewType) {
      return a.viewType === 'system' ? -1 : 1;
    }
    // Default system view first
    if (defaultSystemViewId) {
      if (a.viewId === defaultSystemViewId) return -1;
      if (b.viewId === defaultSystemViewId) return 1;
    }
    // Alphabetical within group
    return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
  });
}

/**
 * In-process cache keyed by `${orgUrl}||${entityType}`. Lives on the module
 * so a single Data-panel mount + remount doesn't re-hit Web API for the same
 * pair. Cleared explicitly via `__clearLiveViewsCache` (test seam + a future
 * "Refresh views" button).
 */
const viewsCache = new Map<string, ViewDefinition[]>();
const viewsInflight = new Map<string, Promise<ViewDefinition[]>>();

function viewsCacheKey(orgUrl: string, entityType: string): string {
  return `${orgUrl}||${entityType.toLowerCase()}`;
}

/**
 * Fetch every system + personal view for an entity from the live org, parse
 * each one's fetchxml into a `ViewDefinition`, dedupe + sort, and cache the
 * result. Subsequent calls for the same (orgUrl, entity) pair return the
 * cached array without hitting the network.
 *
 * Concurrent calls share an in-flight promise — refresh-spamming the picker
 * UI won't issue parallel duplicate requests.
 *
 * Errors on either savedquery OR userquery do NOT fail the whole call; the
 * caller still gets whichever list resolved. Returns [] only when both
 * requests fail.
 */
export async function liveListViews(
  orgUrl: string,
  entityType: string,
): Promise<ViewDefinition[]> {
  const key = viewsCacheKey(orgUrl, entityType);
  const cached = viewsCache.get(key);
  if (cached) return cached;
  const inflight = viewsInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<ViewDefinition[]> => {
    const entity = entityType.toLowerCase();
    // querytype=0 is "Public View" — excludes Quick Find, Lookup, etc. which
    // aren't relevant to the dataset view picker. isdefault narrows the
    // default-view sort below.
    const sysFilter = `returnedtypecode eq '${entity}' and querytype eq 0`;
    const sysSelect = 'savedqueryid,name,fetchxml,layoutxml,isdefault,returnedtypecode';
    const usrFilter = `returnedtypecode eq '${entity}'`;
    const usrSelect = 'userqueryid,name,fetchxml,layoutxml,returnedtypecode';

    const sysPath = `/api/data/v9.2/savedqueries?$filter=${encodeURIComponent(sysFilter)}&$select=${sysSelect}`;
    const usrPath = `/api/data/v9.2/userqueries?$filter=${encodeURIComponent(usrFilter)}&$select=${usrSelect}`;

    const [sysResult, usrResult] = await Promise.allSettled([
      dvGet<ODataValueResponse<RawSavedQuery>>(orgUrl, sysPath),
      dvGet<ODataValueResponse<RawUserQuery>>(orgUrl, usrPath),
    ]);

    const sysRecords = sysResult.status === 'fulfilled' ? (sysResult.value.value ?? []) : [];
    const usrRecords = usrResult.status === 'fulfilled' ? (usrResult.value.value ?? []) : [];

    const sysViews = sysRecords.map(r => mapSavedQueryToView(r, entity));
    const usrViews = usrRecords.map(r => mapUserQueryToView(r, entity));
    const defaultSys = sysRecords.find(r => r.isdefault);
    const defaultId = defaultSys ? `savedquery:${defaultSys.savedqueryid}` : undefined;

    const merged = sortAndDedupeViews([...sysViews, ...usrViews], defaultId);
    viewsCache.set(key, merged);
    return merged;
  })();

  viewsInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    viewsInflight.delete(key);
  }
}

/** Test seam + UI "Refresh views" hook. Clears every (orgUrl, entity) entry. */
export function __clearLiveViewsCache(): void {
  viewsCache.clear();
  viewsInflight.clear();
}

/**
 * Sync peek into the live-views cache for a whole entity. Returns the cached
 * list for `(orgUrl, entity)` if `liveListViews` has populated it, otherwise
 * `undefined`. Used by the form-chrome view pill so its dropdown reflects the
 * full org views list in live mode (instead of only the views the maker has
 * explicitly adopted into the binding's library). Never triggers a fetch.
 */
export function getCachedLiveViewsForEntity(
  orgUrl: string,
  entityType: string,
): ViewDefinition[] | undefined {
  if (!orgUrl || !entityType) return undefined;
  return viewsCache.get(viewsCacheKey(orgUrl, entityType));
}

/**
 * Sync peek into the live-views cache. Returns the `ViewDefinition` matching
 * `viewId` (e.g. `"savedquery:<guid>"` or `"userquery:<guid>"`) if any
 * `(orgUrl, entity)` bucket has been populated by `liveListViews`, otherwise
 * `undefined`. The dataset shim uses this synchronously inside
 * `resolveViewForBinding` so that a selector-only binding can render
 * immediately once the Data panel has populated the cache via a prior
 * async fetch. Never triggers a fetch itself.
 */
export function getCachedLiveView(viewId: string): ViewDefinition | undefined {
  if (!viewId) return undefined;
  for (const list of viewsCache.values()) {
    const hit = list.find(v => v.viewId === viewId);
    if (hit) return hit;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Extracted-controls API (M9.P2 chunk 3)                                     */
/* -------------------------------------------------------------------------- */

const EXTRACTED_BASE = '/api/extracted';

export interface ExtractedMeta {
  extractedAt: string;
  orgUrl: string;
  extractedBy: string;
  customcontrolid: string;
  deployedName: string;
  namespace: string;
  constructor: string;
  version: string;
  compatibledatatypes: string | null;
  manifestBytes: number;
  bundleBytes: number;
  bundleWebresourceName: string;
  requiredFluentMajors: Array<'v8' | 'v9'>;
}

export interface CachedExtractDto {
  safe: string;
  controlDir: string;
  projectRoot: string;
  cacheBase: string;
  meta: ExtractedMeta | null;
  isComplete: boolean;
}

export interface ExtractedListResponse {
  defaultCacheBase: string;
  extracts: CachedExtractDto[];
}

export async function listExtractedControls(): Promise<ExtractedListResponse> {
  const res = await fetch(`${EXTRACTED_BASE}/list`, { headers: buildHeaders() });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ExtractedListResponse;
}

export interface ExtractDeployedRequest {
  orgUrl: string;
  controlName: string;
  outBase?: string;
}

export interface ExtractDeployedResponse {
  controlDir: string;
  projectRoot: string;
  meta: ExtractedMeta;
}

export async function extractDeployedControl(
  req: ExtractDeployedRequest,
): Promise<ExtractDeployedResponse> {
  const res = await fetch(`${EXTRACTED_BASE}/extract`, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await parseError(res);
    maybeFlagReauth(err, req.orgUrl);
    throw err;
  }
  return (await res.json()) as ExtractDeployedResponse;
}

export async function deleteExtractedControl(safe: string, cacheBase?: string): Promise<void> {
  const res = await fetch(`${EXTRACTED_BASE}/delete`, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ safe, cacheBase }),
  });
  if (!res.ok) throw await parseError(res);
}

export interface DeployedControlSummary {
  customcontrolid: string;
  name: string;
  version: string | null;
  namespace: string | null;
  constructor: string | null;
}

export interface ListDeployedControlsResponse {
  orgUrl: string;
  controls: DeployedControlSummary[];
}

export async function listDeployedControls(orgUrl: string): Promise<ListDeployedControlsResponse> {
  const res = await fetch(`${EXTRACTED_BASE}/list-controls?orgUrl=${encodeURIComponent(orgUrl)}`, {
    headers: buildHeaders(),
  });
  if (!res.ok) {
    const err = await parseError(res);
    maybeFlagReauth(err, orgUrl);
    throw err;
  }
  return (await res.json()) as ListDeployedControlsResponse;
}

export const __test__ = {
  PROXY_BASE,
  adaptMultiResponse,
};
