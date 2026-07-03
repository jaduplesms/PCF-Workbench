# M11 — Unit Tests for Pure-Logic Modules — Plan

> **Status:** Completed (technical gates green) · **Depends on:** `DESIGN.md`

5 milestones. Each ends at a hard, automatable acceptance gate. AI stops at the first failure for human review.

---

## M1 — Vitest scaffold + one canary test

**Goal:** Vitest installed, configured, runs, and proves the toolchain is wired correctly with one trivial test.

Todos:
- [ ] `npm install -D vitest @vitest/coverage-v8` in `harness/`.
- [ ] Add `vitest.config.ts` at `harness/vitest.config.ts` — inherits `vite.config.ts`, sets `test.globals=true`, `test.environment='node'` (P1 modules are all pure logic; no DOM needed for these 5).
- [ ] Add scripts to `harness/package.json`:
  - `"test": "vitest"` (watch mode)
  - `"test:run": "vitest run"` (one-shot)
  - `"test:coverage": "vitest run --coverage"`
- [ ] Update `harness/tsconfig.json` `types` array to include `vitest/globals` if `test.globals=true`.
- [ ] Add `harness/coverage/` to `.gitignore`.
- [ ] Write `harness/src/lib/scenario-store.test.ts` containing one canary test: `it('module loads', () => expect(true).toBe(true))`.

**Acceptance gate (M1):**
- `npm run test:run` exit 0, 1 test pass.
- `npm run typecheck` still exit 0.
- No existing Playwright spec is broken by config changes (run `conformance.spec.ts` to confirm).

---

## M2 — `scenario-store` tests

**Goal:** Cover the v1→v2 migration, `resolveScenarioValues`, `buildDefaultScenario`, `bootstrapLegacyDataJson` shape guards.

Todos:
- [ ] `normalizeScenario`: v1 (no schemaVersion) → v2 lift · v2 unchanged · partial / corrupt entries dropped · `pageContext` flattening · `userSettings` aggregation.
- [ ] `resolveScenarioValues`: plain `propertyValues` returned as-is · `fieldBindings` resolves against entity record · clamps when record missing · backfills manifest defaults for unspecified props.
- [ ] `buildDefaultScenario`: pulls manifest defaults · skips empty/null defaults · generates a sensible default per `ofType` · attaches `dataRecords` only if mock store non-empty.
- [ ] `captureScenarioFromStore`: snapshot shape matches v2 schema · live mode omits `dataRecords` · mock mode includes them.
- [ ] `applyScenarioToStore`: replaces propertyValues · replaces mock entity data only when mock + present · respects dirty-suppression contract.

**Acceptance gate (M2):**
- ≥10 tests pass · 0 fail.
- `scenario-store.ts` branch coverage ≥80% (informational only, no fail threshold).

---

## M3 — `manifest-parser` tests

**Goal:** XML edge cases covered. Should have caught H5 (`<img>` missing) before ship.

Todos:
- [ ] Single property · multiple properties (forced into array) · enum values · type-group ref.
- [ ] Single `<code>` and `<css>` · multiple of each · ordering preserved.
- [ ] `<img>` resource declarations (H5 regression test).
- [ ] `<platform-library>` React + Fluent variants.
- [ ] `<feature-usage>` block: single + multiple `<uses-feature>` · `required` boolean parsing.
- [ ] Missing attributes default sanely (description-key fallback to property name, etc.).
- [ ] Empty manifest doesn't crash; returns valid shape with empty arrays.
- [ ] Malformed XML throws a readable error (not a fast-xml-parser internal).

**Acceptance gate (M3):**
- ≥12 tests pass · 0 fail.
- One H5-specific test: parsing a manifest with `<img path="icons/star.png"/>` yields `resources.images = [{ path: 'icons/star.png' }]`.

---

## M4 — `web-api` OData parser tests

**Goal:** Filter grammar locked down. Silent OData regressions are the highest-cost class of bug in shim work.

Todos:
- [ ] Each binary operator: `eq`, `ne`, `gt`, `ge`, `lt`, `le` against string / number / boolean / null values.
- [ ] `and` / `or` precedence: `a eq 1 and b eq 2 or c eq 3` parses as `(a eq 1 and b eq 2) or c eq 3`.
- [ ] Parenthesised groups override precedence.
- [ ] Functions: `contains(name,'foo')`, `startswith`, `endswith`.
- [ ] Quoted strings with embedded apostrophes (`'O''Brien'`).
- [ ] `null` literal (`statecode eq null`).
- [ ] `$select` with single + multiple columns.
- [ ] `$orderby` with asc / desc / default direction.
- [ ] `$top` and `maxPageSize`.
- [ ] Combined queries: `$filter=... &$select=... &$orderby=... &$top=10`.

**Acceptance gate (M4):**
- ≥15 tests pass · 0 fail.
- Each operator + function has at least one positive and one boundary test.

---

## M5 — `date-rebase` + `data-store` tests + docs + commit

**Goal:** Close out P1 — final two modules + the docs update + ship.

Todos:
- [x] `date-rebase.ts`: anchor-relative rebasing · DST forward + back transitions · leap year (Feb 29) handling · timezone normalisation · null/undefined date fields left untouched · array of records.
- [x] `data-store.ts`: `replaceMockEntityData` deep-clones (mutating source doesn't affect store) · `mergeKeyedMockEntityData` dedups by id · subscriber notify fires exactly once per replace.
- [x] Update `harness/README.md` "Validation workflow" section to mention `npm run test` as the first-gate alongside `npm run typecheck`.
- [x] Update `.github/copilot-instructions.md` "Commands" + "Validation workflow" sections.
- [x] CI: add `npm run test:run` step to `.github/workflows/*` (if any exist) before Playwright runs.
- [ ] Commit: `test(harness): M11 P1 unit-test pass — vitest scaffold + 5 modules`.

**Acceptance gate (M5):**
- ≥30 total tests across all 5 modules, all pass.
- `npm run test:run` runs in <5s.
- `npm run typecheck` green.
- `conformance.spec.ts` green (verifies no Vitest setup regressed Vite build).
- Working tree clean after commit.

---

## Out of scope (explicitly deferred)

- React component tests (Playwright covers).
- Vite plugin tests (integration).
- Shim implementations directly (Conformance Tester grid IS the unit test).
- A coverage *threshold* (premature; we add coverage *report* only).
- E2E migration to Vitest from Playwright (different tools, different jobs).
- A "P2 — UI component tests" phase. If we want it later, it's a separate milestone with a fresh design doc.

---

*Once approved, AI executes M1, halts at first failing acceptance gate for review.*

---

## Closeout evidence

- `npm run test:run -- src/lib/scenario-store.test.ts src/parser/manifest-parser.test.ts src/shim/web-api.test.ts src/store/date-rebase.test.ts src/store/data-store.test.ts` → **176 passed / 0 failed**.
- `npm run typecheck` → **green**.
- `npx playwright test tests/conformance.spec.ts --reporter=list` (with `HARNESS_URL=http://127.0.0.1:8190`) → **2 passed / 0 failed**.
