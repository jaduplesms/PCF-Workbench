import { useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  makeStyles, tokens, Button, Badge, MessageBar, MessageBarBody, Checkbox,
  Radio, RadioGroup, Dropdown, Option, Spinner, Label, Input,
  TabList, Tab,
} from '@fluentui/react-components';
import { ArrowClockwise24Regular, Save24Regular, Globe16Regular, ArrowDownload24Regular, Add16Regular, Delete16Regular } from '@fluentui/react-icons';
import { useHarnessStore, type DataSource, type PublicProfile } from '../../store/harness-store';
import {
  loadEntityData, getEntityStoreKeys, getEntityData,
  deleteEntityTable, createEntityTable,
} from '../../store/data-store';
import {
  getAllMetadata, setEntityMetadata, deleteEntityMetadata,
  subscribeMetadata, getMetadataVersion,
  type EntityMetadata,
} from '../../store/metadata-store';
import { rebaseDatesToToday } from '../../store/date-rebase';
import { listProfiles, DvProxyError, getLiveLoadedEntities, getSessionSecret } from '../../api/dv-client';
import { loadAllScenarios, applyScenarioAsActive, captureAndSaveAsNewScenario } from '../../lib/scenario-store';
import { isLiveBlocked, liveBlockReason } from '../../lib/live-block';

const useStyles = makeStyles({
  root: {
    padding: '12px',
    boxSizing: 'border-box',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  header: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  tableList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  tableItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  tableItemActive: {
    backgroundColor: tokens.colorBrandBackground,
    color: 'white',
    '&:hover': {
      backgroundColor: tokens.colorBrandBackground,
    },
    '& .row-trash': {
      color: 'white',
    },
    '& .row-trash:hover': {
      color: 'white',
      backgroundColor: tokens.colorBrandBackgroundHover,
    },
  },
  rowTrash: {
    flexShrink: 0,
    opacity: 0.55,
    ':hover': { opacity: 1 },
  },
  tableName: {
    flex: 1,
    fontFamily: "'Consolas', monospace",
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowChips: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  rowCounts: {
    display: 'grid',
    gridTemplateColumns: '40px 64px',
    alignItems: 'center',
    justifyItems: 'end',
    gap: '4px',
    flexShrink: 0,
  },
  rowCountSlot: {
    display: 'inline-flex',
    justifyContent: 'flex-end',
  },
  editorArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  editorHeader: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '6px',
    rowGap: '4px',
    fontSize: tokens.fontSizeBase200,
    minWidth: 0,
  },
  editorTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
  },
  editorName: {
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    fontFamily: "'Consolas', monospace",
  },
  editorActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    marginLeft: 'auto',
  },
  textarea: {
    minHeight: '200px',
    maxHeight: '400px',
    overflowY: 'auto',
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    fontFamily: "'Consolas', monospace",
    fontSize: '11px',
    padding: '6px 8px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    resize: 'none',
    outline: 'none',
    '&:focus': {
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
  },
  actions: {
    display: 'flex',
    gap: '4px',
  },
  info: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  modeBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  liveOnline: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  pageCtxBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  pageCtxField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  pageCtxLabel: {
    fontSize: tokens.fontSizeBase200,
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
  },
  pageCtxHint: {
    fontFamily: "'Consolas', monospace",
    fontSize: '10px',
    color: tokens.colorNeutralForeground4,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 6px',
    cursor: 'pointer',
    userSelect: 'none',
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    '&:hover': { backgroundColor: tokens.colorNeutralBackground3 },
  },
  sectionCount: {
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground3,
  },
  sectionList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: '20px',
    marginBottom: '4px',
  },
});

interface DataSummary {
  tables: { name: string; count: number }[];
  totalRecords: number;
}

function getDataSummary(): DataSummary {
  // We need to inspect what's loaded — scan common table names
  // Since the data store doesn't expose all keys, we'll track them via a reload
  return { tables: [], totalRecords: 0 };
}

/**
 * Version-keyed snapshot cache for the metadata-store subscription. Required
 * because `useSyncExternalStore` bails if `getSnapshot` returns a fresh object
 * every call — we cache by `getMetadataVersion()` so React sees a stable ref
 * until the store actually mutates. Same pattern as form-store.
 */
const metadataSnapshotRef = (() => {
  let cachedVersion = -1;
  let cached: Record<string, EntityMetadata> = {};
  return {
    read(): Record<string, EntityMetadata> {
      const v = getMetadataVersion();
      if (v !== cachedVersion) {
        cachedVersion = v;
        cached = getAllMetadata();
      }
      return cached;
    },
  };
})();

/* -------------------------------------------------------------------------- */
/* Page Context — identifies the record the harness is "sitting on".          */
/* Drives Mock lookup (via getEntityData) AND Live page-record auto-fetch.    */
/* Lives on the Data tab (not Properties) because conceptually it's part of   */
/* the data source, not control configuration.                                */
/* -------------------------------------------------------------------------- */

function PageContextBlock({ mockTableNames }: { mockTableNames: string[] }) {
  const styles = useStyles();
  const dataSource = useHarnessStore(s => s.dataSource);
  const pageEntityTypeName = useHarnessStore(s => s.pageEntityTypeName);
  const pageEntityId = useHarnessStore(s => s.pageEntityId);
  const pageEntityRecordName = useHarnessStore(s => s.pageEntityRecordName);
  const setPageEntityTypeName = useHarnessStore(s => s.setPageEntityTypeName);
  const setPageEntityId = useHarnessStore(s => s.setPageEntityId);
  const setPageEntityRecordName = useHarnessStore(s => s.setPageEntityRecordName);
  const livePageRecordError = useHarnessStore(s => s.livePageRecordError);

  // In Mock mode the entity-type list comes from data.json; in Live mode
  // it's free-text (any logical name resolvable via EntityDefinitions).
  const showDropdown = dataSource === 'mock' && mockTableNames.length > 0;
  const isLive = dataSource === 'live';

  return (
    <div className={styles.pageCtxBlock} data-test-id="page-context-block">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          className={styles.header}
          title="Page context — set the entity type and record ID the control thinks it is hosted on"
        >
          Page context
        </span>
        <span className={styles.info} style={{ marginLeft: 'auto' }}>
          context.page / context.mode.contextInfo
        </span>
      </div>
      <div className={styles.pageCtxField}>
        <div className={styles.pageCtxLabel}>
          <span>Entity type name</span>
          <span className={styles.pageCtxHint}>page.entityTypeName</span>
        </div>
        {showDropdown ? (
          <Dropdown
            size="small"
            placeholder="Select entity type"
            selectedOptions={pageEntityTypeName ? [pageEntityTypeName] : []}
            value={pageEntityTypeName}
            onOptionSelect={(_, d) => setPageEntityTypeName(d.optionValue ?? '')}
          >
            <Option value="" text="">— None —</Option>
            {mockTableNames.map(t => (
              <Option key={t} value={t} text={t}>{t}</Option>
            ))}
          </Dropdown>
        ) : (
          <Input
            size="small"
            placeholder={isLive ? 'e.g. contact' : 'e.g. msdyn_workorderservicetask'}
            value={pageEntityTypeName}
            onChange={(_, d) => setPageEntityTypeName(d.value)}
          />
        )}
      </div>
      <div className={styles.pageCtxField}>
        <div className={styles.pageCtxLabel}>
          <span>Entity ID</span>
          <span className={styles.pageCtxHint}>page.entityId</span>
        </div>
        <Input
          size="small"
          placeholder="Record GUID"
          value={pageEntityId}
          onChange={(_, d) => setPageEntityId(d.value)}
          data-test-id="page-context-entity-id"
        />
        {isLive && livePageRecordError && pageEntityTypeName && pageEntityId && (
          <MessageBar intent="error" data-test-id="page-context-error" style={{ marginTop: 4 }}>
            <MessageBarBody>{livePageRecordError}</MessageBarBody>
          </MessageBar>
        )}
      </div>
      <div className={styles.pageCtxField}>
        <div className={styles.pageCtxLabel}>
          <span>Entity record name</span>
          <span className={styles.pageCtxHint}>
            {isLive ? 'auto-derived from PrimaryNameAttribute' : 'contextInfo.entityRecordName'}
          </span>
        </div>
        <Input
          size="small"
          placeholder={isLive ? 'Populates after successful fetch' : 'Record name'}
          value={pageEntityRecordName}
          onChange={(_, d) => setPageEntityRecordName(d.value)}
          readOnly={isLive}
          disabled={isLive}
        />
      </div>
      {isLive && pageEntityTypeName && pageEntityId && !livePageRecordError && (
        <div className={styles.info} style={{ marginTop: 4 }}>
          Auto-fetches from Dataverse on Reload.
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Live mode subpanel                                                          */
/* -------------------------------------------------------------------------- */

function SnapshotLiveToMockButton() {
  const liveFetchBuffer = useHarnessStore(s => s.liveFetchBuffer);
  const liveRecordCache = useHarnessStore(s => s.liveRecordCache);
  const snapshot = useHarnessStore(s => s.snapshotLiveToMock);
  const activeScenarioName = useHarnessStore(s => s.activeScenarioName);
  const manifest = useHarnessStore(s => s.manifest);
  const addLogEntry = useHarnessStore(s => s.addLogEntry);
  const [flash, setFlash] = useState<string | null>(null);

  // Count what's available without re-deriving on every render
  const bufferEntityCount = Object.keys(liveFetchBuffer).length;
  const bufferRecordCount = Object.values(liveFetchBuffer).reduce(
    (n, byId) => n + Object.keys(byId).length,
    0,
  );
  const cachedPageRecords = Object.keys(liveRecordCache).length;
  const total = bufferRecordCount + (cachedPageRecords > bufferEntityCount ? cachedPageRecords - bufferEntityCount : 0);
  const hasData = bufferRecordCount > 0 || cachedPageRecords > 0;

  const onSnapshot = useCallback(() => {
    const result = snapshot();
    addLogEntry({ category: 'data', method: 'snapshotLiveToMock', args: result });
    const written = result.addedCount + result.updatedCount;
    const detail = result.updatedCount > 0
      ? `${result.addedCount} added, ${result.updatedCount} updated`
      : `${result.addedCount} added`;
    const breakdown = Object.entries(result.perEntity)
      .map(([k, v]) => `${k} +${v.added}/~${v.updated} → ${v.total} (id: ${v.idField})`)
      .join(' · ');
    const msg = activeScenarioName
      ? `Merged ${written} record(s) (${detail}) across ${result.entityCount} entity type(s). ${breakdown ? '[' + breakdown + '] ' : ''}Existing mock entities preserved. Click Save to persist into "${activeScenarioName}".`
      : `Merged ${written} record(s) (${detail}) across ${result.entityCount} entity type(s). ${breakdown ? '[' + breakdown + '] ' : ''}Existing mock entities preserved. Switched to Mock mode.`;
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 12000);
  }, [snapshot, addLogEntry, activeScenarioName]);

  // P2: capture into a brand-new scenario without dirtying the current one.
  // Timestamped name lets the user kick off many captures in a row.
  const onCaptureAsNew = useCallback(async () => {
    if (!manifest) return;
    const result = snapshot();
    const controlId = `${manifest.namespace}.${manifest.constructor}`;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const baseName = `Live capture ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const saved = await captureAndSaveAsNewScenario(controlId, baseName);
    const written = result.addedCount + result.updatedCount;
    addLogEntry({ category: 'data', method: 'captureAsNewScenario', args: { name: saved.name, ...result } });
    setFlash(`Captured ${written} record(s) across ${result.entityCount} entity type(s) into new scenario "${saved.name}". Saved to disk.`);
    window.setTimeout(() => setFlash(null), 6000);
  }, [manifest, snapshot, addLogEntry]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <Button
          appearance="primary"
          size="small"
          icon={<ArrowDownload24Regular />}
          onClick={onSnapshot}
          disabled={!hasData}
          title={hasData
            ? `Snapshot to mock — copy ${total} buffered live record(s) into mock data and switch to Mock mode`
            : 'No live records buffered yet — render the control to populate the buffer'}
          data-test-id="snapshot-live-to-mock"
        >
          Snapshot live → mock ({total})
        </Button>
        <Button
          appearance="secondary"
          size="small"
          icon={<Save24Regular />}
          onClick={() => { void onCaptureAsNew(); }}
          disabled={!hasData || !manifest}
          title={hasData
            ? 'Capture as new scenario — save buffered live records to a new scenario on disk'
            : 'No live records buffered yet.'}
          data-test-id="capture-as-new-scenario"
        >
          Capture as new scenario
        </Button>
      </div>
      {flash && (
        <MessageBar intent="success">
          <MessageBarBody>{flash}</MessageBarBody>
        </MessageBar>
      )}
      {hasData && (
        <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3, lineHeight: 1.5 }} data-test-id="live-buffer-inspector">
          <div style={{ marginBottom: 2 }}><strong>Buffered live retrieves</strong> — captured by every <code>retrieveRecord</code> / <code>retrieveMultipleRecords</code> in live mode. Click Snapshot to merge into mock; existing entities are preserved.</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(liveFetchBuffer)
              .filter(([, byId]) => Object.keys(byId).length > 0)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([entityType, byId]) => (
                <Badge key={entityType} appearance="outline" size="small" data-test-id={`live-buffer-entry-${entityType}`}>
                  {entityType} · {Object.keys(byId).length}
                </Badge>
              ))}
          </div>
          {Object.keys(liveFetchBuffer).length === 0 && cachedPageRecords > 0 && (
            <div style={{ fontStyle: 'italic' }}>
              Page record only ({cachedPageRecords} entity type(s)). Trigger more fetches to capture related data.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shown in mock mode when the live-fetch buffer still has records (the user
 * was just in live mode and switched back without snapshotting). Surfaces
 * the Snapshot button so they can still capture retroactively. M2 follow-up
 * — previously the buffer was wiped on every mode flip, silently losing data.
 */
function PendingLiveCaptureBanner() {
  const liveFetchBuffer = useHarnessStore(s => s.liveFetchBuffer);
  const liveRecordCache = useHarnessStore(s => s.liveRecordCache);
  const totalRecords = Object.values(liveFetchBuffer).reduce(
    (n, byId) => n + Object.keys(byId).length, 0,
  );
  const hasData = totalRecords > 0 || Object.keys(liveRecordCache).length > 0;
  if (!hasData) return null;
  return (
    <div style={{ marginTop: 8 }} data-test-id="pending-live-capture-banner">
      <MessageBar intent="info" style={{ marginBottom: 6 }}>
        <MessageBarBody>
          <strong>Live retrieves still buffered.</strong> You switched back
          to Mock without snapshotting. Click <em>Snapshot live → mock</em>{' '}
          to merge them in (existing entities are preserved).
        </MessageBarBody>
      </MessageBar>
      <SnapshotLiveToMockButton />
    </div>
  );
}

function LiveModeControls() {
  const liveProfile = useHarnessStore(s => s.liveProfile);
  const liveProfiles = useHarnessStore(s => s.liveProfiles);
  const setLiveProfile = useHarnessStore(s => s.setLiveProfile);
  const setLiveProfiles = useHarnessStore(s => s.setLiveProfiles);
  const setReauth = useHarnessStore(s => s.setPacReauthRequired);
  const reloadControl = useHarnessStore(s => s.reloadControl);
  const addLogEntry = useHarnessStore(s => s.addLogEntry);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { profiles, current } = await listProfiles();
      setLiveProfiles(profiles);
      addLogEntry({ category: 'data', method: 'listProfiles', args: { count: profiles.length } });
      // Restore last-used org from localStorage, else current PAC profile.
      let chosen: PublicProfile | null = null;
      try {
        const last = localStorage.getItem('pcf.liveOrgUrl');
        if (last) chosen = profiles.find(p => p.orgUrl === last) ?? null;
      } catch { /* ignore */ }
      if (!chosen && current) {
        chosen = profiles.find(p => p.orgUrl === current) ?? null;
      }
      if (!chosen && profiles.length > 0) chosen = profiles[0];
      // Only auto-select if nothing is currently selected.
      if (!liveProfile && chosen) setLiveProfile(chosen);
    } catch (e) {
      const msg = e instanceof DvProxyError
        ? `${e.body.error}: ${e.body.message}`
        : (e as Error).message;
      setError(msg);
      addLogEntry({ category: 'data', method: 'listProfiles.error', args: { message: msg } });
    } finally {
      setLoading(false);
    }
  }, [setLiveProfiles, setLiveProfile, addLogEntry, liveProfile]);

  // Lazy-load on first mount of Live controls.
  useEffect(() => {
    if (liveProfiles.length === 0 && !loading) {
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = useCallback((orgUrl: string) => {
    const profile = liveProfiles.find(p => p.orgUrl === orgUrl) ?? null;
    setLiveProfile(profile);
    setReauth(null);
    reloadControl?.();
  }, [liveProfiles, setLiveProfile, setReauth, reloadControl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Dropdown
          size="small"
          placeholder="Select PAC profile…"
          value={liveProfile?.friendlyName ?? ''}
          selectedOptions={liveProfile ? [liveProfile.orgUrl] : []}
          onOptionSelect={(_, d) => onSelect(d.optionValue ?? '')}
          disabled={loading || liveProfiles.length === 0}
          style={{ flex: 1, minWidth: 0 }}
          data-test-id="live-profile-dropdown"
        >
          {liveProfiles.map(p => (
            <Option key={p.orgUrl} value={p.orgUrl} text={p.friendlyName}>
              {p.friendlyName}
              {p.isCurrent ? ' (current)' : ''}
            </Option>
          ))}
        </Dropdown>
        <Button
          appearance="subtle"
          size="small"
          icon={loading ? <Spinner size="tiny" /> : <ArrowClockwise24Regular />}
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh profiles"
          aria-label="Refresh profiles"
        />
      </div>

      {liveProfile && (
        <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3, lineHeight: 1.4 }}>
          <div><strong>User:</strong> {liveProfile.user}</div>
          <div><strong>Org:</strong> <code style={{ fontSize: 10 }}>{liveProfile.orgUrl}</code></div>
          {liveProfile.environmentType && (
            <div><strong>Environment:</strong> {liveProfile.environmentType}{liveProfile.environmentGeo ? ` · ${liveProfile.environmentGeo}` : ''}</div>
          )}
        </div>
      )}

      <SnapshotLiveToMockButton />

      <LiveCachePanel />

      <LiveMetadataInspector />

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {liveProfiles.length === 0 && !loading && !error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            No PAC profiles found. Run <code>pac auth create --url &lt;your-org&gt;</code> in a terminal, then click refresh.
          </MessageBarBody>
        </MessageBar>
      )}

      <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>
        Live mode: reads from <code>context.webAPI</code> hit the org directly;
        writes prompt a per-call confirm. Metadata is fetched from{' '}
        <code>EntityDefinitions</code> on first access. GET responses are
        cached on disk for offline-fast reruns.
      </div>
    </div>
  );
}

/**
 * M2.P7 — Compact live-cache stats + clear button. Hits the proxy admin
 * endpoint at /__pcf/dv/cache to show entries / hit-rate, and lets the user
 * clear the on-disk cache (useful when org data has actually changed
 * server-side and stale replays would mislead).
 */
interface LiveCacheStats {
  enabled: boolean;
  ttlSeconds: number;
  hits: number;
  misses: number;
  stores: number;
  invalidations: number;
  bypasses: number;
  staleEvictions: number;
  entries: number;
  sizeBytes: number;
  rootDir: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function LiveCachePanel() {
  const [stats, setStats] = useState<LiveCacheStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/__pcf/dv/cache', {
        method: 'GET',
        headers: { 'x-pcf-session': getSessionSecret() },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStats(await r.json() as LiveCacheStats);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/__pcf/dv/cache', {
        method: 'DELETE',
        headers: { 'x-pcf-session': getSessionSecret() },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const out = await r.json() as { cleared: number; stats: LiveCacheStats };
      setStats(out.stats);
      setFlash(`Cleared ${out.cleared} entr${out.cleared === 1 ? 'y' : 'ies'}.`);
      window.setTimeout(() => setFlash(null), 4000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!stats) {
    return (
      <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }} data-test-id="live-cache-panel">
        {err ? <span style={{ color: tokens.colorPaletteRedForeground1 }}>Cache stats unavailable: {err}</span> : 'Loading cache stats…'}
      </div>
    );
  }

  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? Math.round((stats.hits / total) * 100) : 0;

  return (
    <div
      style={{
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: 4,
        padding: '8px 10px',
        fontSize: 11,
        color: tokens.colorNeutralForeground2,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
      data-test-id="live-cache-panel"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <strong
            style={{ fontSize: 12, cursor: 'help' }}
            title={`Live response cache — replays GET responses from disk on the second run so live mode is offline-fast. Writes invalidate by entity set. Storage: ${stats.rootDir}. Override via env PCF_LIVE_CACHE=off / PCF_LIVE_CACHE_TTL_SECONDS=N.`}
          >
            Live response cache
          </strong>
          <Badge
            appearance={stats.enabled ? 'filled' : 'outline'}
            color={stats.enabled ? 'success' : 'subtle'}
            size="small"
          >
            {stats.enabled ? 'on' : 'off'}
          </Badge>
          {stats.ttlSeconds > 0 && (
            <Badge appearance="outline" size="small" title={`Entries older than ${stats.ttlSeconds}s are evicted`}>
              TTL {stats.ttlSeconds}s
            </Badge>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwise24Regular />}
            onClick={() => void refresh()}
            disabled={busy}
            aria-label="Refresh cache stats"
            title="Refresh cache stats"
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<Delete16Regular />}
            onClick={() => void clear()}
            disabled={busy || stats.entries === 0}
            title="Clear all cached responses"
            data-test-id="live-cache-clear"
          >
            Clear
          </Button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2 }}>
        <span style={{ color: tokens.colorNeutralForeground3 }}>Entries</span>
        <span data-test-id="live-cache-entries">{stats.entries} <span style={{ color: tokens.colorNeutralForeground3 }}>({formatBytes(stats.sizeBytes)})</span></span>
        <span style={{ color: tokens.colorNeutralForeground3 }}>Hit rate</span>
        <span data-test-id="live-cache-hitrate">{total > 0 ? `${hitRate}%` : '—'} <span style={{ color: tokens.colorNeutralForeground3 }}>({stats.hits}/{total})</span></span>
        {stats.stores > 0 && (<>
          <span style={{ color: tokens.colorNeutralForeground3 }}>Stored</span>
          <span>{stats.stores}</span>
        </>)}
        {stats.invalidations > 0 && (<>
          <span style={{ color: tokens.colorNeutralForeground3 }}>Invalidated</span>
          <span>{stats.invalidations}</span>
        </>)}
        {stats.staleEvictions > 0 && (<>
          <span style={{ color: tokens.colorNeutralForeground3 }}>Stale evictions</span>
          <span>{stats.staleEvictions}</span>
        </>)}
        {stats.bypasses > 0 && (<>
          <span style={{ color: tokens.colorNeutralForeground3 }}>Bypasses</span>
          <span>{stats.bypasses}</span>
        </>)}
      </div>
      {flash && (
        <div style={{ color: tokens.colorPaletteGreenForeground1, fontSize: 11 }} role="status">{flash}</div>
      )}
      {err && (
        <div style={{ color: tokens.colorPaletteRedForeground1, fontSize: 11 }}>{err}</div>
      )}
    </div>
  );
}

/**
 * M2.P5 — Compact inspector listing every entity whose metadata has been
 * hydrated from the live org this session. Helps debug "why is the display
 * name wrong?" by making the cache observable.
 */
function LiveMetadataInspector() {
  const dataVersion = useHarnessStore(s => s.dataVersion);
  // Re-read from dv-client every render keyed off dataVersion (bumped after
  // each successful ensureLiveAttributeMetadata fetch).
  const entities = (() => {
    try {
      // Lazy require pattern via dynamic import would be cleaner but adds
      // async; the function is sync + cheap so a static import is fine.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return getLiveLoadedEntities();
    } catch {
      return [];
    }
  })();
  // dataVersion is referenced so the effect picks up cache-clear bumps too.
  void dataVersion;

  if (entities.length === 0) {
    return (
      <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }} data-test-id="live-metadata-inspector-empty">
        Live metadata cache is empty. <code>context.utils.getEntityMetadata(...)</code>{' '}
        will populate it on first call.
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }} data-test-id="live-metadata-inspector">
      <div style={{ marginBottom: 2 }}><strong>Live metadata cache</strong> ({entities.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {entities.map(e => (
          <Badge key={e} appearance="outline" size="small" data-test-id={`live-meta-entry-${e}`}>{e}</Badge>
        ))}
      </div>
    </div>
  );
}

export function DataPanel() {
  const styles = useStyles();
  const addLogEntry = useHarnessStore(s => s.addLogEntry);
  const rebaseEnabled = useHarnessStore(s => s.rebaseDatesToToday);
  const setRebaseEnabled = useHarnessStore(s => s.setRebaseDatesToToday);
  const dataSource = useHarnessStore(s => s.dataSource);
  const setDataSource = useHarnessStore(s => s.setDataSource);
  const reloadControl = useHarnessStore(s => s.reloadControl);
  const activeScenarioName = useHarnessStore(s => s.activeScenarioName);
  const manifest = useHarnessStore(s => s.manifest);
  const [tables, setTables] = useState<{ name: string; records: any[] }[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'records' | 'schema'>('records');
  const [editJson, setEditJson] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Subscribe to metadata-store mutations (live fetches, scenario apply,
  // user edits) via useSyncExternalStore. Snapshot is keyed by the version
  // counter so React doesn't bail on object identity (see form-store).
  const metadataSnapshot = useSyncExternalStore(
    subscribeMetadata,
    () => metadataSnapshotRef.read(),
  );
  const metadataEntries = Object.entries(metadataSnapshot);

  // Hydrate the panel's local `tables` list from the in-memory entity store.
  // The store is populated by ScenarioHeader on first load (via the active
  // scenario's `dataRecords`, falling back to a one-shot legacy data.json
  // migration). DataPanel never fetches data.json itself.
  const hydrateFromStore = useCallback(() => {
    const keys = getEntityStoreKeys();
    const tableList = keys.map(name => ({ name, records: getEntityData(name) }));
    setTables(tableList);
    setLoaded(true);
  }, []);

  // Reset the entity store back to whatever the active scenario carries.
  // Replaces the previous "Reload data.json" affordance — scenarios are now
  // the source of truth, so reverting means re-applying the active scenario.
  const resetToActiveScenario = useCallback(async () => {
    if (!activeScenarioName || !manifest) {
      hydrateFromStore();
      return;
    }
    const controlId = `${manifest.namespace}.${manifest.constructor}`;
    const list = await loadAllScenarios(controlId);
    const active = list.find(s => s.name === activeScenarioName);
    if (active) {
      applyScenarioAsActive(controlId, active);
      addLogEntry({ category: 'data', method: 'reset-to-scenario', args: { scenario: active.name } });
    }
    hydrateFromStore();
  }, [activeScenarioName, manifest, hydrateFromStore, addLogEntry]);

  // Initial hydration + react to dataVersion bumps (scenario applied,
  // user edits, snapshot live → mock, etc.).
  const dataVersion = useHarnessStore(s => s.dataVersion);
  useEffect(() => {
    hydrateFromStore();
  }, [hydrateFromStore, dataVersion, activeScenarioName]);

  // Unified entity list — union of data table names and metadata keys.
  // Each row knows whether it has records, schema, or both. This is the
  // backbone of Option A: one entity per row, editor scopes to records/schema
  // via a TabList.
  type EntityRow = { name: string; recordCount: number; columnCount: number; hasData: boolean; hasSchema: boolean };
  const entityRows: EntityRow[] = (() => {
    const map = new Map<string, EntityRow>();
    for (const t of tables) {
      map.set(t.name, {
        name: t.name,
        recordCount: t.records.length,
        columnCount: 0,
        hasData: true,
        hasSchema: false,
      });
    }
    for (const [name, meta] of metadataEntries) {
      const existing = map.get(name);
      const colCount = Object.keys(meta.columns ?? {}).length;
      if (existing) {
        existing.columnCount = colCount;
        existing.hasSchema = true;
      } else {
        map.set(name, { name, recordCount: 0, columnCount: colCount, hasData: false, hasSchema: true });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const refreshEditor = useCallback((entity: string, mode: 'records' | 'schema') => {
    if (mode === 'records') {
      const table = tables.find(t => t.name === entity);
      setEditJson(JSON.stringify(table?.records ?? [], null, 2));
    } else {
      const meta = metadataSnapshot[entity];
      setEditJson(JSON.stringify(meta ?? { displayName: entity, columns: {} }, null, 2));
    }
    setEditError(null);
  }, [tables, metadataSnapshot]);

  const handleSelectEntity = useCallback((name: string) => {
    setSelectedEntity(name);
    refreshEditor(name, editorMode);
  }, [editorMode, refreshEditor]);

  const handleSwitchMode = useCallback((mode: 'records' | 'schema') => {
    setEditorMode(mode);
    if (selectedEntity) refreshEditor(selectedEntity, mode);
  }, [selectedEntity, refreshEditor]);

  const handleApply = useCallback(() => {
    if (!selectedEntity) return;
    let parsed: any;
    try {
      parsed = JSON.parse(editJson);
    } catch (err: any) {
      setEditError(`Invalid JSON: ${err.message}`);
      return;
    }
    if (editorMode === 'records') {
      if (!Array.isArray(parsed)) {
        setEditError('Records must be a JSON array');
        return;
      }
      const allData: Record<string, any[]> = {};
      for (const t of tables) {
        allData[t.name] = t.name === selectedEntity ? parsed : t.records;
      }
      // If selectedEntity is metadata-only (no table yet), seed it.
      if (!tables.some(t => t.name === selectedEntity)) {
        allData[selectedEntity] = parsed;
      }
      loadEntityData(allData);
      setEditError(null);
      addLogEntry({ category: 'data', method: 'updateTable', args: { table: selectedEntity, records: parsed.length } });
    } else {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setEditError('Schema must be an object with { displayName, columns, ... }');
        return;
      }
      if (typeof parsed.displayName !== 'string' || !parsed.columns || typeof parsed.columns !== 'object') {
        setEditError('Schema must have a string `displayName` and an object `columns`');
        return;
      }
      setEntityMetadata(selectedEntity, parsed as EntityMetadata);
      setEditError(null);
      addLogEntry({ category: 'data', method: 'updateMetadata', args: { entity: selectedEntity, columns: Object.keys(parsed.columns).length } });
    }
  }, [selectedEntity, editorMode, editJson, tables, addLogEntry]);

  const isValidEntityName = (n: string) => /^[a-z][a-z0-9_]*$/.test(n);

  // Atomic add: create both an empty records array AND a stub schema. This
  // upholds the harness invariant — every entity needs metadata or shims
  // (primaryIdAttribute lookup, dataset columns) silently degrade.
  const handleAddEntity = useCallback(() => {
    const raw = window.prompt('New entity — logical name (e.g. account, msdyn_workorder):');
    if (raw == null) return;
    const name = raw.trim().toLowerCase();
    if (!name) return;
    if (!isValidEntityName(name)) {
      window.alert(`"${name}" is not a valid logical name. Use lowercase letters, digits, and underscores; must start with a letter.`);
      return;
    }
    if (entityRows.some(r => r.name === name)) {
      window.alert(`Entity "${name}" already exists.`);
      return;
    }
    createEntityTable(name);
    if (!metadataSnapshot[name]) {
      setEntityMetadata(name, {
        displayName: name,
        columns: {},
        primaryIdAttribute: `${name}id`,
        primaryNameAttribute: 'name',
      });
    }
    setTables(prev => [...prev, { name, records: [] }]);
    setSelectedEntity(name);
    setEditorMode('records');
    refreshEditor(name, 'records');
    addLogEntry({ category: 'data', method: 'createEntity', args: { entity: name } });
  }, [entityRows, metadataSnapshot, refreshEditor, addLogEntry]);

  // Atomic delete: remove both the data table and the schema. Confirms once.
  const handleDeleteEntity = useCallback((name: string) => {
    if (!window.confirm(`Delete entity "${name}"? Removes both records and schema from the in-memory store. Save the scenario to persist.`)) return;
    deleteEntityTable(name);
    deleteEntityMetadata(name);
    setTables(prev => prev.filter(t => t.name !== name));
    if (selectedEntity === name) {
      setSelectedEntity(null);
      setEditJson('');
    }
    addLogEntry({ category: 'data', method: 'deleteEntity', args: { entity: name } });
  }, [selectedEntity, addLogEntry]);

  // Infer a stub schema from the first record's keys. Useful when records
  // exist but schema is missing — one click fills the gap so the rest of
  // the harness (primary-id resolution, dataset fallback) works.
  const handleGenerateSchema = useCallback((name: string) => {
    const table = tables.find(t => t.name === name);
    const sample = table?.records?.[0];
    if (!sample || typeof sample !== 'object') {
      window.alert(`No records on "${name}" — add records first or edit the schema directly.`);
      return;
    }
    const columns: Record<string, any> = {};
    for (const key of Object.keys(sample)) {
      const v = (sample as any)[key];
      let type: string = 'String';
      if (typeof v === 'number') type = Number.isInteger(v) ? 'Integer' : 'Decimal';
      else if (typeof v === 'boolean') type = 'Boolean';
      else if (v && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) type = 'DateTime';
      columns[key] = { displayName: key, type };
    }
    const guessedPk = `${name}id`;
    setEntityMetadata(name, {
      displayName: name,
      columns,
      primaryIdAttribute: guessedPk in columns ? guessedPk : Object.keys(columns)[0],
      primaryNameAttribute: 'name' in columns ? 'name' : Object.keys(columns)[0],
    });
    if (selectedEntity === name && editorMode === 'schema') {
      refreshEditor(name, 'schema');
    }
    addLogEntry({ category: 'data', method: 'generateSchema', args: { entity: name, columns: Object.keys(columns).length } });
  }, [tables, selectedEntity, editorMode, refreshEditor, addLogEntry]);

  return (
    <div className={styles.root}>
      <div className={styles.modeBlock}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className={styles.header}
            title="Data source — use mock records from the scenario, or connect to a real Dataverse org"
          >
            Data source
          </span>
          {dataSource === 'live' && (
            <span className={styles.liveOnline}>
              <Globe16Regular />
              LIVE
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowClockwise24Regular />}
            onClick={() => reloadControl?.()}
            disabled={!reloadControl}
            title="Reload — fresh restart of the control"
            data-test-id="data-panel-reload"
          >
            Reload
          </Button>
        </div>
        <RadioGroup
          value={dataSource}
          onChange={(_, d) => setDataSource(d.value as DataSource)}
          layout="horizontal"
          data-test-id="data-source-radio"
        >
          <Radio value="mock" label="Mock (scenario)" />
          <Radio
            value="live"
            label="Live (PAC)"
            disabled={isLiveBlocked()}
            title={isLiveBlocked() ? liveBlockReason() : undefined}
          />
        </RadioGroup>
        {isLiveBlocked() && (
          <MessageBar intent="warning" data-test-id="live-blocked-banner">
            <MessageBarBody>
              <strong>Live mode is blocked.</strong> {liveBlockReason()} Any scenario carrying <code>dataSource: 'live'</code> will fall back to mock.
            </MessageBarBody>
          </MessageBar>
        )}
        {dataSource === 'live' && <LiveModeControls />}
        {dataSource === 'mock' && <PendingLiveCaptureBanner />}
      </div>

      <PageContextBlock mockTableNames={tables.map(t => t.name)} />

      {dataSource === 'mock' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              className={styles.header}
              title="Mock data — edit records that flow into context.webAPI; save the scenario to persist changes"
            >
              Mock Data
            </span>
            <Button
              appearance="subtle"
              icon={<ArrowClockwise24Regular />}
              size="small"
              onClick={() => { void resetToActiveScenario(); }}
              disabled={!activeScenarioName}
              title={activeScenarioName
                ? `Reset to "${activeScenarioName}" — discard unsaved edits and reload the scenario's records`
                : 'No active scenario to reset to.'}
            />
          </div>

          <Checkbox
            checked={rebaseEnabled}
            onChange={(_, d) => setRebaseEnabled(!!d.checked)}
            label="Rebase dates to today"
            style={{ marginBottom: 4 }}
          />

          {tables.length === 0 && metadataEntries.length === 0 && loaded && (
            <div className={styles.info}>
              No mock records yet. Add a table by editing JSON in any other entity, or
              create one in the active scenario by editing below:
              <pre style={{ fontSize: 10, marginTop: 4, whiteSpace: 'pre-wrap' }}>
{`{
  "tableName": [
    { "id": "...", "name": "..." }
  ]
}`}
              </pre>
            </div>
          )}

          {/* Unified entity list — one row per entity. Records and schema
              live together because they describe the same thing; you cannot
              meaningfully have one without the other. The editor below
              switches between Records / Schema for the selected entity via
              a TabList. */}
          <div className={styles.sectionHeader}>
            <span>Entities</span>
            <span className={styles.sectionCount}>({entityRows.length})</span>
            <span style={{ flex: 1 }} />
            <Button
              appearance="subtle"
              size="small"
              icon={<Add16Regular />}
              onClick={(e) => { e.stopPropagation(); handleAddEntity(); }}
              title="Add entity — adds an empty table with records and schema placeholders"
              data-test-id="entity-add"
            >
              Add entity
            </Button>
          </div>
          <div className={styles.sectionList}>
            {entityRows.map(row => {
              const isSelected = selectedEntity === row.name;
              const meta = metadataSnapshot[row.name];
              return (
                <div
                  key={`entity-${row.name}`}
                  className={`${styles.tableItem} ${isSelected ? styles.tableItemActive : ''}`}
                  onClick={() => handleSelectEntity(row.name)}
                  data-test-id={`entity-node-${row.name}`}
                  title={`${meta?.displayName ?? row.name}${meta?.primaryIdAttribute ? ` · pk: ${meta.primaryIdAttribute}` : ''}`}
                >
                  <span className={styles.tableName}>{row.name}</span>
                  <div className={styles.rowChips}>
                    {!row.hasSchema && (
                      <Badge appearance="tint" color="warning" size="small" title="No schema — primary key and columns are guessed; go to Schema tab to generate one">⚠ no schema</Badge>
                    )}
                    {!row.hasData && (
                      <Badge appearance="tint" color="subtle" size="small" title="Schema exists but no records yet.">◌ no data</Badge>
                    )}
                  </div>
                  <div className={styles.rowCounts}>
                    <span className={styles.rowCountSlot}>
                      <Badge appearance="filled" color={isSelected ? 'subtle' : 'informative'} size="small" title={`${row.recordCount} records`}>
                        {row.recordCount}
                      </Badge>
                    </span>
                    <span className={styles.rowCountSlot}>
                      <Badge appearance="tint" color={isSelected ? 'subtle' : 'informative'} size="small" title={`${row.columnCount} schema columns`}>
                        {row.columnCount} col
                      </Badge>
                    </span>
                  </div>
                  <Button
                    className={`${styles.rowTrash} row-trash`}
                    appearance="subtle"
                    size="small"
                    icon={<Delete16Regular />}
                    style={isSelected ? { color: 'white' } : undefined}
                    onClick={(e) => { e.stopPropagation(); handleDeleteEntity(row.name); }}
                    title={`Delete entity "${row.name}" (records + schema)`}
                    data-test-id={`entity-delete-${row.name}`}
                  />
                </div>
              );
            })}
            {entityRows.length === 0 && (
              <div className={styles.info} style={{ paddingLeft: 8 }}>No entities yet. Click "Add entity" to create one, or apply a scenario.</div>
            )}
          </div>

          {selectedEntity && (
            <div className={styles.editorArea}>
              <div className={styles.editorHeader}>
                <div className={styles.editorTitle}>
                  <span
                    className={styles.editorName}
                    title={selectedEntity}
                  >
                    {selectedEntity}
                  </span>
                  <span className={styles.info} style={{ flexShrink: 0 }}>
                    {(() => {
                      const r = entityRows.find(x => x.name === selectedEntity);
                      return r ? `(${r.recordCount} records · ${r.columnCount} cols)` : '';
                    })()}
                  </span>
                </div>
                <div className={styles.editorActions}>
                  {(() => {
                    const schemaCols = Object.keys(metadataSnapshot[selectedEntity]?.columns ?? {}).length;
                    const recordCount = tables.find(t => t.name === selectedEntity)?.records.length ?? 0;
                    const showGenerate = editorMode === 'schema' && schemaCols === 0 && recordCount > 0;
                    return showGenerate ? (
                      <Button
                        appearance="subtle"
                        size="small"
                        onClick={() => handleGenerateSchema(selectedEntity)}
                        title="Infer columns from the first record. Best-effort — review and tune types after."
                        data-test-id="schema-generate"
                      >
                        Generate from records
                      </Button>
                    ) : null;
                  })()}
                  <Button
                    appearance="primary"
                    icon={<Save24Regular />}
                    size="small"
                    onClick={handleApply}
                  >
                    Apply
                  </Button>
                </div>
              </div>
              <TabList
                selectedValue={editorMode}
                onTabSelect={(_, d) => handleSwitchMode(d.value as 'records' | 'schema')}
                size="small"
              >
                <Tab value="records" data-test-id="editor-tab-records">Records</Tab>
                <Tab value="schema" data-test-id="editor-tab-schema">Schema</Tab>
              </TabList>
              {editorMode === 'schema' && !metadataSnapshot[selectedEntity] && (
                <MessageBar intent="warning">
                  <MessageBarBody>No schema yet. Edit and Apply to create one, or click "Generate from records".</MessageBarBody>
                </MessageBar>
              )}
              {editError && (
                <MessageBar intent="error">
                  <MessageBarBody>{editError}</MessageBarBody>
                </MessageBar>
              )}
              <textarea
                className={styles.textarea}
                value={editJson}
                onChange={e => setEditJson(e.target.value)}
                spellCheck={false}
                wrap="off"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
