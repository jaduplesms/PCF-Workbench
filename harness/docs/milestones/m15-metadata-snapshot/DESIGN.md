# M15 — Metadata Snapshot — Design

> **Status:** Shipped · **Last updated:** 2026-07-01

Capture the real Dataverse schema used by a control into a local
`metadata.json`, independently of record snapshots, so mock scenarios render
with real labels, types, choices, boolean labels, primary keys, and lookup
targets on first paint.

## Decisions

| Area | Decision |
|---|---|
| Authentication | Reuse the existing PAC-authenticated `/__pcf/dv` proxy. Tokens remain server-side. |
| Cache | Use the existing live GET response cache; metadata reruns are offline-fast. |
| Scope | Start from entities and columns in the current mock scenario, then include lookup targets referenced by data annotations or captured lookup metadata. |
| Storage | Write a Dataverse-shaped `metadata.json` envelope with per-entity provenance. |
| Merge | Replace only entities captured in the current run; preserve unrelated entities already on disk. |
| Startup | Continue loading `/pcf-data/metadata.json` before the control mounts. |
| Rebuilds | `metadata.json` remains a harness config file excluded from the PCF source build watcher. |
| Provenance | Normalized metadata carries `snapshot`, `live`, `inferred`, or `manual` provenance and the Data panel displays it. |

## Snapshot flow

1. Collect entity names and used columns from the current mock store.
2. Fetch each seed entity's base `EntityDefinitions` record.
3. Fetch typed choice, boolean, and lookup metadata through casted attribute
   endpoints and merge it into the base attributes.
4. Retain only used columns plus primary id/name attributes.
5. Add lookup targets to the queue and snapshot their primary id/name metadata.
6. POST the captured entities to `/pcf-data/metadata.json`.
7. The Vite plugin merges by `LogicalName`, writes the file, and returns the
   merged envelope; the client loads it into the metadata store immediately.

## File format

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-01T00:00:00.000Z",
  "source": {
    "kind": "dataverse-snapshot",
    "orgUrl": "https://example.crm.dynamics.com"
  },
  "value": [
    {
      "LogicalName": "account",
      "_pcfWorkbenchProvenance": {
        "kind": "snapshot",
        "orgUrl": "https://example.crm.dynamics.com",
        "capturedAt": "2026-07-01T00:00:00.000Z"
      },
      "Attributes": []
    }
  ]
}
```

## Non-goals

- Capturing every table in an environment.
- Coupling metadata capture to live record capture.
- Replacing scenario-embedded metadata; scenarios may still pin normalized
  metadata and preserve its provenance.
- Triggering a PCF compile after metadata changes.
