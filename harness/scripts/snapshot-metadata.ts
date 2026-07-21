/**
 * One-off metadata snapshot (prototype for M15).
 *
 * Pulls REAL Dataverse entity metadata (types, option-set options, display
 * names, primary id/name, lookup targets) for the entities/columns actually
 * used by a control's scenarios + data.json, and writes a metadata.json the
 * harness can load (standard EntityDefinitions `{ "value": [...] }` shape).
 *
 * Auth reuses PAC's cached credentials via the harness's own
 * `acquireDataverseToken` — no `az`, same identity as `pac auth`.
 *
 * No metadata is guessed — every field comes from the org's EntityDefinitions
 * API. Attributes are scoped to columns present in the mock data (+ primary
 * id/name + lookup targets) so the Form panel doesn't balloon.
 *
 * Usage:
 *   npx tsx scripts/snapshot-metadata.ts <orgUrl> <controlDataDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { acquireDataverseToken } from '../src/vite-plugin/dataverse-proxy';

const orgUrl = (process.argv[2] ?? '').replace(/\/$/, '');
const dataDir = process.argv[3] ?? '';
if (!orgUrl || !dataDir) {
  console.error('Usage: npx tsx scripts/snapshot-metadata.ts <orgUrl> <controlDataDir>');
  process.exit(2);
}
const API = `${orgUrl}/api/data/v9.2`;
const CAST = 'Microsoft.Dynamics.CRM.';

let TOKEN = '';

async function get<T = any>(url: string): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'User-Agent': 'jaduples-PCFWorkbench-metadata-snapshot/0.1 (M15-prototype; jaduples@microsoft.com)',
        },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
      return res.json() as Promise<T>;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function getAll(url: string): Promise<any[]> {
  const items: any[] = [];
  let next: string | undefined = url;
  while (next) {
    const data: any = await get(next);
    items.push(...(data.value ?? []));
    next = data['@odata.nextLink'];
  }
  return items;
}

/** Normalise a record key to its attribute logical name (or null to skip). */
function normCol(key: string): string | null {
  if (key.includes('@')) return null;
  if (key.startsWith('_') && key.endsWith('_value')) return key.slice(1, -'_value'.length);
  return key;
}

/** Collect entity -> used columns, and the set of lookup target entities, from
 *  a scenarios file (array or {scenarios:[]}) or a bare data.json map. */
function collectUsed(file: string, used: Map<string, Set<string>>, targets: Set<string>): void {
  if (!fs.existsSync(file)) return;
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const scenarios: any[] = Array.isArray(doc) ? doc : (doc.scenarios ?? [doc]);
  const consume = (records: Record<string, any[]>) => {
    for (const [entity, rows] of Object.entries(records)) {
      if (!Array.isArray(rows)) continue;
      const cols = used.get(entity) ?? new Set<string>();
      used.set(entity, cols);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        for (const [key, val] of Object.entries(row)) {
          const c = normCol(key);
          if (c) cols.add(c);
          if (key.endsWith('@Microsoft.Dynamics.CRM.lookuplogicalname') && typeof val === 'string') {
            targets.add(val);
          }
        }
      }
    }
  };
  for (const scn of scenarios) {
    if (scn && typeof scn === 'object' && scn.dataRecords) consume(scn.dataRecords);
    else if (scn && typeof scn === 'object' && !scn.name) consume(scn); // bare data.json map
  }
}

async function optionMap(entity: string, cast: string, includeGlobal: boolean): Promise<Map<string, any>> {
  const m = new Map<string, any>();
  const expand = includeGlobal
    ? '$expand=OptionSet($select=Options),GlobalOptionSet($select=Options)'
    : '$expand=OptionSet($select=Options)';
  try {
    const rows = await getAll(
      `${API}/EntityDefinitions(LogicalName='${entity}')/Attributes/${CAST}${cast}?$select=LogicalName&${expand}`,
    );
    for (const a of rows) {
      const os = (a.OptionSet?.Options?.length ? a.OptionSet : null)
        ?? (a.GlobalOptionSet?.Options?.length ? a.GlobalOptionSet : null);
      if (os) m.set(a.LogicalName, os);
    }
  } catch (e: any) {
    console.log(`    (optionMap ${cast} on ${entity} failed: ${e.message})`);
  }
  return m;
}

async function main() {
  const auth = await acquireDataverseToken(orgUrl);
  TOKEN = auth.token;
  console.log(`Authenticated as ${auth.account.username} (via PAC) → ${orgUrl}`);

  const used = new Map<string, Set<string>>();
  const targets = new Set<string>();
  for (const fname of ['test-scenarios.json', 'data.json']) {
    collectUsed(path.join(dataDir, fname), used, targets);
  }
  for (const t of targets) if (!used.has(t)) used.set(t, new Set());

  const entities = [...used.keys()].sort().filter(e => !process.argv[4] || e === process.argv[4]);
  console.log(`Entities to snapshot (${entities.length}): ${entities.join(', ')}`);

  const result: any[] = [];
  for (const entity of entities) {
    let base: any;
    try {
      base = await get(
        `${API}/EntityDefinitions(LogicalName='${entity}')` +
          `?$select=LogicalName,PrimaryIdAttribute,PrimaryNameAttribute,DisplayName` +
          `&$expand=Attributes($select=LogicalName,AttributeType,DisplayName)`,
      );
    } catch (e: any) {
      console.log(`  ! skip ${entity}: ${e.message}`);
      continue;
    }

    const keep = new Set(used.get(entity));
    if (base.PrimaryIdAttribute) keep.add(base.PrimaryIdAttribute);
    if (base.PrimaryNameAttribute) keep.add(base.PrimaryNameAttribute);

    const opts = new Map<string, any>();
    for (const cast of ['PicklistAttributeMetadata', 'StateAttributeMetadata', 'StatusAttributeMetadata', 'MultiSelectPicklistAttributeMetadata']) {
      const includeGlobal = cast === 'PicklistAttributeMetadata' || cast === 'MultiSelectPicklistAttributeMetadata';
      for (const [k, v] of await optionMap(entity, cast, includeGlobal)) opts.set(k, v);
    }
    const lookupTargets = new Map<string, string[]>();
    try {
      for (const a of await getAll(`${API}/EntityDefinitions(LogicalName='${entity}')/Attributes/${CAST}LookupAttributeMetadata?$select=LogicalName,Targets`)) {
        if (a.Targets?.length) lookupTargets.set(a.LogicalName, a.Targets);
      }
    } catch { /* no lookups */ }

    const attrs: any[] = [];
    for (const a of base.Attributes ?? []) {
      if (!keep.has(a.LogicalName)) continue;
      if (opts.has(a.LogicalName)) a.OptionSet = opts.get(a.LogicalName);
      if (lookupTargets.has(a.LogicalName)) a.Targets = lookupTargets.get(a.LogicalName);
      attrs.push(a);
    }
    base.Attributes = attrs;
    result.push(base);
    console.log(`  ${entity}: ${attrs.length} attrs, ${attrs.filter(x => x.OptionSet).length} option-sets, ${attrs.filter(x => x.Targets).length} lookups`);
  }

  const out = path.join(dataDir, 'metadata.json');
  fs.writeFileSync(out, JSON.stringify({ value: result }, null, 2), 'utf-8');
  console.log(`\nWrote ${out} (${result.length} entities)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
