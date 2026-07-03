// M11.M2 — Unit tests for harness/src/lib/scenario-store.ts
//
// Scope (this commit): pure functions only. The store-coupled functions
// (`buildDefaultScenario`, `resolveScenarioValues`, `captureScenarioFromStore`,
// `applyScenarioToStore`) require live Zustand store wiring and entity-data
// store interaction — they're queued as `describe.todo` and will be covered in
// a future pass that stands up a real (non-mocked) store instance per test.
// Per DESIGN.md §6 Q5: NO `vi.mock` allowed in P1.

import {
  scenariosStorageKey,
  activeScenarioStorageKey,
  autoGenSuppressStorageKey,
  buildDefaultScenario,
  normalizeScenario,
  normalizeScenarioList,
  nextTestScenarioNames,
  findUniqueCopyName,
  renameScenario,
  deleteScenario,
  upsertScenario,
  resolveScenarioValues,
  captureScenarioFromStore,
  applyScenarioToStore,
  applyScenarioAsActive,
  bootstrapLegacyDataJson,
  SCENARIO_SCHEMA_VERSION,
  type TestScenario,
} from './scenario-store';
import { useHarnessStore } from '../store/harness-store';
import {
  clearEntityData,
  getEntityData,
  loadEntityData,
  replaceMockEntityData,
} from '../store/data-store';
import { clearMetadata, getEntityMetadata } from '../store/metadata-store';

const v2 = (name: string, extra: Partial<TestScenario> = {}): TestScenario => ({
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  name,
  savedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const INITIAL_STORE_STATE = useHarnessStore.getState();

beforeEach(() => {
  useHarnessStore.setState(INITIAL_STORE_STATE, true);
  clearEntityData();
  clearMetadata();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Storage key helpers                                                        */
/* -------------------------------------------------------------------------- */

describe('storage key helpers', () => {
  it('scenariosStorageKey: prefixes the control id', () => {
    expect(scenariosStorageKey('PcfWorkbench.StarRating'))
      .toBe('pcf-workbench-scenarios-PcfWorkbench.StarRating');
  });

  it('activeScenarioStorageKey: prefixes the control id', () => {
    expect(activeScenarioStorageKey('PcfWorkbench.StarRating'))
      .toBe('pcf-workbench-active-scenario-PcfWorkbench.StarRating');
  });

  it('autoGenSuppressStorageKey: prefixes the control id', () => {
    expect(autoGenSuppressStorageKey('PcfWorkbench.StarRating'))
      .toBe('pcf-workbench-suppress-autogen-PcfWorkbench.StarRating');
  });

  it('storage keys are namespaced distinctly so they cannot collide', () => {
    const id = 'X';
    const keys = [
      scenariosStorageKey(id),
      activeScenarioStorageKey(id),
      autoGenSuppressStorageKey(id),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* normalizeScenario — defensive parser for unknown localStorage / disk blobs */
/* -------------------------------------------------------------------------- */

describe('normalizeScenario', () => {
  describe('rejection paths', () => {
    it('rejects null', () => {
      expect(normalizeScenario(null)).toBeNull();
    });

    it('rejects non-object primitives', () => {
      expect(normalizeScenario('hello')).toBeNull();
      expect(normalizeScenario(42)).toBeNull();
      expect(normalizeScenario(true)).toBeNull();
    });

    it('rejects array input (must be a scenario object, not a list)', () => {
      expect(normalizeScenario([])).toBeNull();
    });

    it('rejects missing name field', () => {
      expect(normalizeScenario({ savedAt: '2026-01-01' })).toBeNull();
    });

    it('rejects empty-string name', () => {
      expect(normalizeScenario({ name: '' })).toBeNull();
    });
  });

  describe('v1 → v2 migration', () => {
    it('detects v1 by presence of legacy flat fields (no schemaVersion + pageEntityId)', () => {
      const v1 = {
        name: 'Old scenario',
        savedAt: '2026-01-01T00:00:00.000Z',
        propertyValues: { foo: 'bar' },
        pageEntityId: 'abc-123',
        pageEntityTypeName: 'account',
        pageEntityRecordName: 'Contoso',
        networkMode: 'slow3g',
        devicePreset: 'iphone-14-pro',
        isControlDisabled: false,
      };
      const result = normalizeScenario(v1);
      expect(result).not.toBeNull();
      expect(result!.schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
      expect(result!.name).toBe('Old scenario');
      expect(result!.propertyValues).toEqual({ foo: 'bar' });
      // v1's flat fields became v2 nested objects:
      expect(result!.pageContext).toEqual({
        entityId: 'abc-123',
        typeName: 'account',
        recordName: 'Contoso',
      });
      expect(result!.network).toEqual({ mode: 'slow3g' });
      expect(result!.device).toEqual({ preset: 'iphone-14-pro' });
    });

    it('drops pageContext entirely when all three legacy page fields are empty', () => {
      const v1 = {
        name: 'No page context',
        savedAt: '2026-01-01T00:00:00.000Z',
        propertyValues: {},
        pageEntityId: '',
        pageEntityTypeName: '',
        networkMode: 'online',
        devicePreset: 'desktop',
        isControlDisabled: false,
      };
      const result = normalizeScenario(v1);
      expect(result!.pageContext).toBeUndefined();
    });

    it('coerces invalid network mode to default `online` during v1 migration', () => {
      const v1 = {
        name: 'Bad network mode',
        savedAt: '2026-01-01T00:00:00.000Z',
        propertyValues: {},
        pageEntityId: '',
        pageEntityTypeName: '',
        networkMode: 'gigabit', // invalid
        devicePreset: 'desktop',
        isControlDisabled: false,
      };
      const result = normalizeScenario(v1);
      expect(result!.network).toEqual({ mode: 'online' });
    });
  });

  describe('v2 passthrough', () => {
    it('accepts a minimal v2 scenario (name + savedAt only)', () => {
      const result = normalizeScenario({
        schemaVersion: 2,
        name: 'Minimal',
        savedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Minimal');
      expect(result!.schemaVersion).toBe(2);
    });

    it('round-trips full pageContext / network / device / userSettings', () => {
      const input = {
        schemaVersion: 2,
        name: 'Full',
        savedAt: '2026-01-01T00:00:00.000Z',
        propertyValues: { rating: 5 },
        pageContext: { entityId: 'g', typeName: 'account', recordName: 'Acme' },
        network: { mode: 'slow3g', customLatencyMs: 1500 },
        device: { preset: 'iphone-14-pro', containerWidth: 390, containerHeight: 844, host: 'Web', isFullBleed: false },
        userSettings: {
          languageId: 1033,
          isRTL: false,
          timeZoneOffsetMinutes: -300,
          userId: 'u1',
          userName: 'Alice',
          securityRoles: ['System Administrator'],
        },
        dataSource: 'mock',
      };
      const result = normalizeScenario(input);
      expect(result!.pageContext).toEqual({ entityId: 'g', typeName: 'account', recordName: 'Acme' });
      expect(result!.network).toEqual({ mode: 'slow3g', customLatencyMs: 1500 });
      expect(result!.device).toEqual({ preset: 'iphone-14-pro', containerWidth: 390, containerHeight: 844, host: 'Web', isFullBleed: false });
      expect(result!.userSettings).toMatchObject({ languageId: 1033, isRTL: false, userId: 'u1', userName: 'Alice' });
      expect(result!.userSettings?.securityRoles).toEqual(['System Administrator']);
      expect(result!.dataSource).toBe('mock');
    });

    it('drops invalid dataSource values (must be "mock" or "live")', () => {
      const result = normalizeScenario({
        schemaVersion: 2,
        name: 'Bad dataSource',
        savedAt: '2026-01-01T00:00:00.000Z',
        dataSource: 'somethingElse',
      });
      expect(result!.dataSource).toBeUndefined();
    });

    it('drops userSettings entirely when every field is invalid', () => {
      const result = normalizeScenario({
        schemaVersion: 2,
        name: 'Bad user settings',
        savedAt: '2026-01-01T00:00:00.000Z',
        userSettings: { languageId: 'not-a-number', isRTL: 'not-a-bool' },
      });
      expect(result!.userSettings).toBeUndefined();
    });

    it('keeps device.containerWidth=null (explicit null is meaningful, means "auto")', () => {
      const result = normalizeScenario({
        schemaVersion: 2,
        name: 'Null container',
        savedAt: '2026-01-01T00:00:00.000Z',
        device: { preset: 'desktop', containerWidth: null, containerHeight: null },
      });
      expect(result!.device).toEqual({ preset: 'desktop', containerWidth: null, containerHeight: null });
    });
  });

  describe('savedAt fallback', () => {
    it('defaults to epoch when savedAt is missing', () => {
      const result = normalizeScenario({ schemaVersion: 2, name: 'No date' });
      expect(result!.savedAt).toBe('1970-01-01T00:00:00.000Z');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* normalizeScenarioList                                                      */
/* -------------------------------------------------------------------------- */

describe('normalizeScenarioList', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeScenarioList(null)).toEqual([]);
    expect(normalizeScenarioList('not an array')).toEqual([]);
    expect(normalizeScenarioList({ name: 'single' })).toEqual([]);
  });

  it('drops unrecognizable entries silently and keeps the rest', () => {
    const result = normalizeScenarioList([
      { name: 'Good', savedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 2 },
      null,
      { invalid: 'no name' },
      { name: '', savedAt: '2026-01-01' }, // empty name → rejected
      { name: 'Also good', savedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 2 },
    ]);
    expect(result.map(s => s.name)).toEqual(['Good', 'Also good']);
  });
});

/* -------------------------------------------------------------------------- */
/* nextTestScenarioNames                                                      */
/* -------------------------------------------------------------------------- */

describe('nextTestScenarioNames', () => {
  it('starts at 1 when no existing scenarios', () => {
    expect(nextTestScenarioNames([], 3)).toEqual([
      'Test scenario 1',
      'Test scenario 2',
      'Test scenario 3',
    ]);
  });

  it('continues after the highest existing index, even with gaps', () => {
    const existing = [v2('Test scenario 2'), v2('Test scenario 5'), v2('Custom name')];
    expect(nextTestScenarioNames(existing, 2)).toEqual([
      'Test scenario 6',
      'Test scenario 7',
    ]);
  });

  it('ignores non-matching names when computing max index', () => {
    const existing = [v2('Test scenario abc'), v2('Test scenario'), v2('Foo')];
    expect(nextTestScenarioNames(existing, 1)).toEqual(['Test scenario 1']);
  });

  it('returns empty array when count is 0', () => {
    expect(nextTestScenarioNames([], 0)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* findUniqueCopyName                                                         */
/* -------------------------------------------------------------------------- */

describe('findUniqueCopyName', () => {
  it('appends "(copy)" when name is free', () => {
    expect(findUniqueCopyName([], 'Foo')).toBe('Foo (copy)');
  });

  it('appends "(copy 2)" when "(copy)" is already taken', () => {
    expect(findUniqueCopyName([v2('Foo (copy)')], 'Foo')).toBe('Foo (copy 2)');
  });

  it('keeps incrementing past collisions', () => {
    const existing = [
      v2('Foo (copy)'),
      v2('Foo (copy 2)'),
      v2('Foo (copy 3)'),
      v2('Foo (copy 4)'),
    ];
    expect(findUniqueCopyName(existing, 'Foo')).toBe('Foo (copy 5)');
  });

  it('does not consider unrelated names as collisions', () => {
    expect(findUniqueCopyName([v2('Bar (copy)')], 'Foo')).toBe('Foo (copy)');
  });
});

/* -------------------------------------------------------------------------- */
/* renameScenario                                                             */
/* -------------------------------------------------------------------------- */

describe('renameScenario', () => {
  it('returns the same list when oldName === newName (no-op)', () => {
    const list = [v2('A'), v2('B')];
    expect(renameScenario(list, 'A', 'A')).toBe(list);
  });

  it('throws when newName collides with an existing scenario', () => {
    const list = [v2('A'), v2('B')];
    expect(() => renameScenario(list, 'A', 'B')).toThrow(/already exists/);
  });

  it('renames the matching scenario and bumps savedAt', () => {
    const list = [v2('A'), v2('B')];
    const result = renameScenario(list, 'A', 'Z');
    expect(result.map(s => s.name)).toEqual(['Z', 'B']);
    expect(result[0].savedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns a new array (does not mutate the input)', () => {
    const list = [v2('A')];
    const result = renameScenario(list, 'A', 'Z');
    expect(result).not.toBe(list);
    expect(list[0].name).toBe('A');
  });

  it('silently no-ops when oldName does not exist', () => {
    const list = [v2('A')];
    const result = renameScenario(list, 'Nonexistent', 'Z');
    expect(result.map(s => s.name)).toEqual(['A']);
  });
});

/* -------------------------------------------------------------------------- */
/* deleteScenario                                                             */
/* -------------------------------------------------------------------------- */

describe('deleteScenario', () => {
  it('removes the matching scenario', () => {
    const list = [v2('A'), v2('B'), v2('C')];
    expect(deleteScenario(list, 'B').map(s => s.name)).toEqual(['A', 'C']);
  });

  it('returns the same shape when no match', () => {
    const list = [v2('A')];
    expect(deleteScenario(list, 'Nonexistent').map(s => s.name)).toEqual(['A']);
  });

  it('returns a new array (does not mutate)', () => {
    const list = [v2('A'), v2('B')];
    const result = deleteScenario(list, 'A');
    expect(result).not.toBe(list);
    expect(list.length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* upsertScenario                                                             */
/* -------------------------------------------------------------------------- */

describe('upsertScenario', () => {
  it('appends when no scenario with that name exists', () => {
    const list = [v2('A')];
    const result = upsertScenario(list, v2('B'));
    expect(result.map(s => s.name)).toEqual(['A', 'B']);
  });

  it('replaces in-place when a scenario with the same name exists', () => {
    const list = [v2('A', { description: 'old' }), v2('B')];
    const updated = v2('A', { description: 'new' });
    const result = upsertScenario(list, updated);
    expect(result.length).toBe(2);
    expect(result[0].description).toBe('new');
    expect(result[0]).toBe(updated);
  });

  it('preserves order on replace', () => {
    const list = [v2('A'), v2('B'), v2('C')];
    const result = upsertScenario(list, v2('B', { description: 'updated' }));
    expect(result.map(s => s.name)).toEqual(['A', 'B', 'C']);
  });

  it('returns a new array (does not mutate input)', () => {
    const list = [v2('A')];
    const result = upsertScenario(list, v2('B'));
    expect(result).not.toBe(list);
    expect(list.length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Store-coupled functions                                                     */
/* -------------------------------------------------------------------------- */

describe('buildDefaultScenario', () => {
  it('captures manifest defaults and omits dataRecords when mock store is empty', () => {
    const manifest = {
      namespace: 'PcfWorkbench',
      constructor: 'Demo',
      properties: [
        { name: 'title', ofType: 'SingleLine.Text', usage: 'input', defaultValue: 'Hello' },
        { name: 'enabled', ofType: 'TwoOptions', usage: 'input', defaultValue: null },
        { name: 'count', ofType: 'Whole.None', usage: 'input', defaultValue: null },
      ],
      dataSets: [],
      typeGroups: {},
    } as any;
    const scenario = buildDefaultScenario(manifest, 'Default');
    expect(scenario.schemaVersion).toBe(2);
    expect(scenario.name).toBe('Default');
    expect(scenario.propertyValues?.title).toBe('Hello');
    expect(typeof scenario.propertyValues?.enabled).toBe('boolean');
    expect(typeof scenario.propertyValues?.count).toBe('number');
    expect(scenario.dataRecords).toBeUndefined();
  });

  it('includes dataRecords snapshot when mock store is non-empty', () => {
    loadEntityData({ account: [{ accountid: 'a1', name: 'Acme' }] });
    const scenario = buildDefaultScenario(null, 'Default');
    expect(scenario.dataRecords).toEqual({
      account: [{ accountid: 'a1', name: 'Acme' }],
    });
  });
});

describe('resolveScenarioValues', () => {
  it('returns propertyValues as-is when no fieldBindings are present', () => {
    const result = resolveScenarioValues(v2('No bindings', { propertyValues: { foo: 'bar' } }));
    expect(result).toEqual({ foo: 'bar' });
  });

  it('resolves bound values from page record + fieldBindings', () => {
    loadEntityData({
      account: [
        { accountid: 'a1', name: 'Acme', revenue: 123 },
      ],
    });
    const scenario = v2('Bindings', {
      propertyValues: { title: 'fallback' },
      fieldBindings: { title: 'name', amount: 'revenue' },
      pageContext: { entityId: 'a1', typeName: 'account' },
    });
    const result = resolveScenarioValues(scenario);
    expect(result).toEqual({ title: 'Acme', amount: 123 });
  });

  it('converts formatted lookup payload into LookupValue[] shape', () => {
    loadEntityData({
      account: [{
        accountid: 'a1',
        _primarycontactid_value: '11111111-1111-1111-1111-111111111999',
        '_primarycontactid_value@OData.Community.Display.V1.FormattedValue': 'Alice Johnson',
      }],
    });
    const scenario = v2('Lookup conversion', {
      fieldBindings: { contact: 'primarycontactid' },
      pageContext: { entityId: 'a1', typeName: 'account' },
    });
    const result = resolveScenarioValues(scenario);
    expect(result.contact).toEqual([{
      id: '11111111-1111-1111-1111-111111111999',
      name: 'Alice Johnson',
      entityType: 'primarycontactid',
    }]);
  });

  it('backfills defaults for manifest properties omitted by the scenario', () => {
    useHarnessStore.setState({
      manifest: {
        namespace: 'PcfWorkbench',
        constructor: 'Demo',
        properties: [
          { name: 'title', ofType: 'SingleLine.Text', usage: 'input', defaultValue: 'Hello' },
          { name: 'enabled', ofType: 'TwoOptions', usage: 'input', defaultValue: null },
        ],
        dataSets: [],
        typeGroups: {},
      } as any,
    });
    const result = resolveScenarioValues(v2('Backfill', { propertyValues: {} }));
    expect(result.title).toBe('Hello');
    expect(typeof result.enabled).toBe('boolean');
  });
});

describe('captureScenarioFromStore', () => {
  it('captures mock-mode state including dataRecords snapshot', () => {
    replaceMockEntityData({ account: [{ accountid: 'a1', name: 'Acme' }] });
    useHarnessStore.setState({
      propertyValues: { title: 'Hello' },
      pageEntityId: 'a1',
      pageEntityTypeName: 'account',
      pageEntityRecordName: 'Acme',
      networkMode: 'slow3g',
      customLatencyMs: 1500,
      devicePreset: 'desktop',
      containerWidth: 500,
      containerHeight: 300,
      host: 'Web',
      isFullBleed: false,
      userLanguageId: 1033,
      userIsRTL: false,
      userTimeZoneOffsetMinutes: 0,
      userId: 'u1',
      userName: 'Alice',
      userSecurityRoles: ['Basic User'],
      isControlDisabled: true,
      dataSource: 'mock',
    });
    const snap = captureScenarioFromStore('Snap', '2026-01-02T00:00:00.000Z');
    expect(snap.name).toBe('Snap');
    expect(snap.dataSource).toBe('mock');
    expect(snap.dataRecords).toEqual({ account: [{ accountid: 'a1', name: 'Acme' }] });
  });

  it('omits dataRecords in live mode and includes liveProfile pin', () => {
    useHarnessStore.setState({
      dataSource: 'live',
      liveProfile: {
        user: 'u',
        orgUrl: 'https://example.crm.dynamics.com',
        tenantId: 't',
        authority: 'a',
        friendlyName: 'Example',
        environmentType: null,
        environmentGeo: null,
        isCurrent: true,
      },
    });
    const snap = captureScenarioFromStore('Live snap', '2026-01-02T00:00:00.000Z');
    expect(snap.dataSource).toBe('live');
    expect(snap.dataRecords).toBeUndefined();
    expect(snap.liveProfile).toEqual({
      orgUrl: 'https://example.crm.dynamics.com',
      friendlyName: 'Example',
    });
  });
});

describe('applyScenarioToStore / applyScenarioAsActive', () => {
  it('applies property values + context + network + device + data + metadata', () => {
    const scenario = v2('Apply me', {
      propertyValues: { title: 'Applied' },
      pageContext: { entityId: 'a1', typeName: 'account', recordName: 'Acme' },
      network: { mode: 'offline', customLatencyMs: 2500 },
      device: { preset: 'iphone-14', containerWidth: 390, containerHeight: 844, host: 'Mobile', isFullBleed: true },
      userSettings: { userName: 'Mobile Tech' },
      isControlDisabled: true,
      dataSource: 'mock',
      dataRecords: { account: [{ accountid: 'a1', name: 'Acme' }] },
      metadata: {
        account: {
          displayName: 'Account',
          columns: { name: { displayName: 'Name', type: 'SingleLine.Text' } },
          primaryIdAttribute: 'accountid',
          primaryNameAttribute: 'name',
        },
      },
    });

    applyScenarioToStore(scenario);
    const s = useHarnessStore.getState();
    expect(s.propertyValues).toEqual({ title: 'Applied' });
    expect(s.pageEntityId).toBe('a1');
    expect(s.pageEntityTypeName).toBe('account');
    expect(s.pageEntityRecordName).toBe('Acme');
    expect(s.networkMode).toBe('offline');
    expect(s.customLatencyMs).toBe(2500);
    expect(s.devicePreset).toBe('iphone-14');
    expect(s.containerWidth).toBe(390);
    expect(s.containerHeight).toBe(844);
    expect(s.host).toBe('Mobile');
    expect(s.isFullBleed).toBe(true);
    expect(s.userName).toBe('Mobile Tech');
    expect(s.isControlDisabled).toBe(true);
    expect(getEntityData('account')).toEqual([{ accountid: 'a1', name: 'Acme' }]);
    expect(getEntityMetadata('account')?.primaryIdAttribute).toBe('accountid');
  });

  it('resets device fields to defaults when scenario.device is absent', () => {
    useHarnessStore.setState({
      devicePreset: 'iphone-14',
      containerWidth: 390,
      containerHeight: 844,
      host: 'Mobile',
      isFullBleed: true,
    });
    applyScenarioToStore(v2('No device block', { propertyValues: {} }));
    const s = useHarnessStore.getState();
    expect(s.devicePreset).toBe('desktop');
    expect(s.containerWidth).toBeNull();
    expect(s.containerHeight).toBeNull();
    expect(s.host).toBe('Web');
    expect(s.isFullBleed).toBe(false);
  });

  it('sets active scenario and clears dirty flag transactionally', () => {
    useHarnessStore.setState({ activeScenarioName: 'Old', isDirty: true });
    const scenario = v2('New Active', { propertyValues: { x: 1 } });
    applyScenarioAsActive('Demo.Control', scenario);
    const s = useHarnessStore.getState();
    expect(s.activeScenarioName).toBe('New Active');
    expect(s.isDirty).toBe(false);
  });
});

describe('bootstrapLegacyDataJson', () => {
  it('loads valid legacy data into the mock store and returns true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ account: [{ accountid: 'a1', name: 'Acme' }] }),
    }));
    const result = await bootstrapLegacyDataJson();
    expect(result).toBe(true);
    expect(getEntityData('account')).toEqual([{ accountid: 'a1', name: 'Acme' }]);
  });

  it('returns false when endpoint responds with non-object payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }));
    await expect(bootstrapLegacyDataJson()).resolves.toBe(false);
  });
});
