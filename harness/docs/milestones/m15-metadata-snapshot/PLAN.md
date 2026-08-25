# M15 — Metadata Snapshot — Plan

> Companion to `DESIGN.md`.

**Status:** Shipped.

| Phase | Output | Gate |
|---|---|---|
| P1 | Snapshot scope + Dataverse metadata fetch service | Unit tests for entity/column/lookup scoping |
| P2 | Safe `metadata.json` merge/write endpoint | Existing unrelated entities survive a snapshot |
| P3 | Snapshot button, first-run choices, provenance badges | UI can snapshot and immediately display schema provenance |
| P4 | Documentation and roadmap closeout | Unit tests, typecheck, build, and Playwright acceptance green |

All phases are complete. The focused ConformanceTester Playwright gate remains
green after the Data panel and metadata-store changes.

## Acceptance criteria

- Metadata loads before the control's first render.
- Snapshot includes attribute types, choices, boolean labels, display names,
  primary id/name attributes, and lookup targets.
- Scope is limited to scenario entities, used columns, and lookup targets.
- Existing unrelated metadata is preserved.
- A metadata write does not invoke the PCF build watcher.
- The Data panel distinguishes snapshotted metadata from inferred metadata.
