import { useState, useEffect, useRef } from 'react';
import {
  makeStyles, tokens, Tab, TabList, Switch, Label, Button, Divider, Dropdown, Option, mergeClasses,
} from '@fluentui/react-components';
import {
  PlugConnected24Regular, Phone24Regular, TopSpeed24Regular,
  Settings24Regular, WeatherMoon24Regular, WeatherSunny24Regular,
  Database24Regular, Play24Regular, Person24Regular,
  Form24Regular, Shield24Regular, Warning24Regular, ArrowClockwise20Regular, Globe16Regular,
  ChevronRight20Regular, ChevronLeft20Regular,
  ChevronUp20Regular, ChevronDown20Regular,
} from '@fluentui/react-icons';
import { useHarnessStore, DEVICE_PRESETS, SHIM_PROFILE_LABELS, type ShimProfile } from '../store/harness-store';
import { ControlViewport } from './panels/ControlViewport';
import { PropertyEditor } from './panels/PropertyEditor';
import { ConsolePanel } from './panels/ConsolePanel';
import { NetworkPanel } from './panels/NetworkPanel';
import { DevicePanel } from './panels/DevicePanel';
import { PerformancePanel } from './panels/PerformancePanel';
import { DataPanel } from './panels/DataPanel';
import { ScenarioHeader } from './panels/ScenarioHeader';
import { LifecyclePanel } from './panels/LifecyclePanel';
import { UserSettingsPanel } from './panels/UserSettingsPanel';
import { FormPanel } from './panels/FormPanel';
import { FormChrome } from './panels/FormChrome';
import { AppNotificationBanner } from './AppNotificationBanner';
import { LiveReauthBanner } from './LiveReauthBanner';
import { CoveragePanel } from './panels/CoveragePanel';
import { AuditPanel } from './panels/AuditPanel';
import { useLivePageRecord } from '../loader/use-live-page-record';
import { useLiveDatasetRecords } from '../loader/use-live-dataset-records';
import { isLiveBlocked, liveBlockReason } from '../lib/live-block';
import { useBuildStatus } from '../store/build-watch-client';
import type { ManifestConfig } from '../types/manifest';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    height: '44px',
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    flexShrink: 0,
    gap: '12px',
  },
  logo: {
    fontWeight: 600,
    fontSize: '14px',
    letterSpacing: '0.5px',
  },
  topBarSpacer: {
    flex: 1,
  },
  topBarControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  mainPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  viewportArea: {
    flex: 1,
    overflow: 'hidden',
  },
  consoleArea: {
    height: '220px',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    overflow: 'hidden',
    position: 'relative',
  },
  consoleAreaCollapsed: {
    height: '28px',
  },
  sidePanel: {
    width: '360px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    flexShrink: 0,
    position: 'relative',
  },
  sidePanelCollapsed: {
    width: '32px',
  },
  sidePanelHeader: {
    height: '24px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '4px',
  },
  panelToggle: {
    minWidth: '24px',
    width: '24px',
    height: '20px',
    padding: 0,
  },
  bottomToggle: {
    position: 'absolute',
    top: '2px',
    right: '8px',
    zIndex: 10,
    minWidth: '24px',
    width: '24px',
    height: '24px',
    padding: 0,
  },
  collapsedRail: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    writingMode: 'vertical-rl',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    userSelect: 'none',
  },
  collapsedRailBottom: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: '12px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    userSelect: 'none',
  },
  sidePanelTabs: {
    flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowX: 'auto',
  },
  sidePanelContent: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    minWidth: 0,
  },
  modeControls: {
    padding: '12px',
  },
  modeHeader: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: '8px',
  },
});

interface Props {
  manifest: ManifestConfig;
  bundlePath: string;
  cssFiles: string[];
  controlDir: string;
  launchedAsGallery: boolean;
}

type SidePanelTab = 'properties' | 'form' | 'data' | 'network' | 'device' | 'user' | 'lifecycle' | 'performance' | 'audit' | 'coverage';

/** M9 — Build watcher status pill.
 *
 * Renders nothing while the watcher has never produced an event (idle+seq=0)
 * so that environments where the watcher is disabled (PCF_NO_WATCH, no build
 * script, gallery mode) stay clean. Once a build has happened we keep the
 * pill visible even when idle so users can see the previous duration. */
function BuildStatusPill() {
  const status = useBuildStatus();
  if (status.phase === 'idle' && status.seq === 0) return null;

  const palette: Record<string, { bg: string; border: string; fg: string; label: string; emoji: string }> = {
    compiling: { bg: 'rgba(50, 212, 255, 0.18)', border: 'rgba(50, 212, 255, 0.55)', fg: '#9be8ff', label: 'Building…', emoji: '⏳' },
    success:   { bg: 'rgba(60, 200, 120, 0.18)',  border: 'rgba(60, 200, 120, 0.55)',  fg: '#8ee0a6', label: 'Built',     emoji: '✓' },
    error:     { bg: 'rgba(255, 100, 100, 0.20)', border: 'rgba(255, 100, 100, 0.55)', fg: '#ff9aa2', label: 'Build error', emoji: '✗' },
    idle:      { bg: 'rgba(180, 180, 200, 0.15)', border: 'rgba(180, 180, 200, 0.45)', fg: '#cfcfdc', label: 'Build idle', emoji: '○' },
  };
  const p = palette[status.phase] ?? palette.idle;
  const dur = typeof status.durationMs === 'number' ? `${(status.durationMs / 1000).toFixed(1)}s` : '';
  const errCount = status.errors?.length ?? 0;
  const title = status.phase === 'error'
    ? `Last build failed in ${dur}\n` + (status.errors ?? []).slice(0, 8).join('\n')
    : status.phase === 'success'
      ? `Last build succeeded in ${dur}`
      : status.phase === 'compiling'
        ? 'Build in progress — saving a source file rebuilds automatically'
        : 'Build watcher idle';

  return (
    <span
      data-test-id="build-status-pill"
      data-phase={status.phase}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
        padding: '2px 8px', borderRadius: 10,
        color: p.fg, backgroundColor: p.bg, border: `1px solid ${p.border}`,
      }}
    >
      <span aria-hidden="true">{p.emoji}</span>
      {p.label}
      {status.phase === 'success' && dur && <span style={{ opacity: 0.75 }}>{dur}</span>}
      {status.phase === 'error' && errCount > 0 && <span style={{ opacity: 0.75 }}>({errCount})</span>}
    </span>
  );
}

export function HarnessShell({ manifest, bundlePath, cssFiles, controlDir, launchedAsGallery }: Props) {
  const styles = useStyles();
  const [activeTab, setActiveTab] = useState<SidePanelTab>('properties');

  // Cross-panel deep-link: form-chrome view pill's Edit button fires
  // `pcfwb:focus-dataset-binding`. The Data panel listens for the card focus,
  // but the tab also needs to switch when the user is on a different tab.
  useEffect(() => {
    const handler = () => setActiveTab('data');
    window.addEventListener('pcfwb:focus-dataset-binding', handler);
    return () => window.removeEventListener('pcfwb:focus-dataset-binding', handler);
  }, []);
  const isDarkMode = useHarnessStore(s => s.isDarkMode);
  const toggleDarkMode = useHarnessStore(s => s.toggleDarkMode);
  const isControlDisabled = useHarnessStore(s => s.isControlDisabled);
  const setControlDisabled = useHarnessStore(s => s.setControlDisabled);
  const networkMode = useHarnessStore(s => s.networkMode);
  const formChromeEnabled = useHarnessStore(s => s.formChromeEnabled);
  const toggleFormChrome = useHarnessStore(s => s.toggleFormChrome);
  const isAuthoringMode = useHarnessStore(s => s.isAuthoringMode);
  const setAuthoringMode = useHarnessStore(s => s.setAuthoringMode);
  const pageEntityTypeName = useHarnessStore(s => s.pageEntityTypeName);
  const shimProfile = useHarnessStore(s => s.shimProfile);
  const setShimProfile = useHarnessStore(s => s.setShimProfile);
  const reloadControl = useHarnessStore(s => s.reloadControl);
  const dataSource = useHarnessStore(s => s.dataSource);
  const liveProfile = useHarnessStore(s => s.liveProfile);
  const liveConnectionState = useHarnessStore(s => s.liveConnectionState);
  const rightPanelCollapsed = useHarnessStore(s => s.rightPanelCollapsed);
  const bottomPanelCollapsed = useHarnessStore(s => s.bottomPanelCollapsed);
  const chromeMode = useHarnessStore(s => s.chromeMode);
  const toggleRightPanel = useHarnessStore(s => s.toggleRightPanel);
  const toggleBottomPanel = useHarnessStore(s => s.toggleBottomPanel);

  // Auto-fetch the live page record when in Live mode. Re-runs on profile,
  // page id, or reloadEpoch change. See use-live-page-record for details.
  useLivePageRecord();
  // Auto-fetch live dataset records for any binding whose resolved view
  // carries FetchXML (live system/personal views). See use-live-dataset-records.
  useLiveDatasetRecords();

  // When the user toggles Mock <-> Live, treat it as a profile switch and
  // re-init the control. Skip the very first render so we don't double-load
  // on mount, and skip if the reload callback isn't wired yet (the control
  // host registers it after init completes).
  const lastDataSourceRef = useRef(dataSource);
  useEffect(() => {
    if (lastDataSourceRef.current !== dataSource) {
      lastDataSourceRef.current = dataSource;
      reloadControl?.();
    }
  }, [dataSource, reloadControl]);

  const devicePreset = useHarnessStore(s => s.devicePreset);
  const renderCount = useHarnessStore(s => s.renderCount);
  const lastRenderTimeMs = useHarnessStore(s => s.lastRenderTimeMs);

  const deviceLabel = DEVICE_PRESETS[devicePreset]?.name ?? 'Desktop';

  const networkBadge = networkMode === 'offline'
    ? { label: 'OFFLINE', color: '#ff6b6b', bg: 'rgba(255,107,107,0.2)' }
    : networkMode === 'slow3g'
    ? { label: 'SLOW 3G', color: '#ffd93d', bg: 'rgba(255,217,61,0.2)' }
    : networkMode === 'fast3g'
    ? { label: 'FAST 3G', color: '#ffd93d', bg: 'rgba(255,217,61,0.2)' }
    : networkMode === 'custom'
    ? { label: 'THROTTLED', color: '#ffd93d', bg: 'rgba(255,217,61,0.2)' }
    : null;

  return (
    <div className={styles.root}>
      {/* Top Bar */}
      <div className={styles.topBar}>
        {launchedAsGallery && (
          <Button
            appearance="subtle"
            size="small"
            onClick={() => {
              fetch('/api/switch-control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ controlDir: '' }),
              }).catch(() => {});
            }}
            style={{ color: 'white', fontWeight: 600, fontSize: 14, minWidth: 0, padding: '2px 8px' }}
            title="Back to Gallery"
          >
            &larr; Gallery
          </Button>
        )}
        <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: 0.2 }}>
          {manifest.namespace}.{manifest.constructor}
        </span>

        {/* Live mode pill — visible only once the org connection is live
            (Connect succeeded). Reminds users that fetches hit a real org. */}
        {dataSource === 'live' && liveConnectionState === 'connected' && (
          <span
            data-test-id="live-pill"
            title={liveProfile ? `Live: ${liveProfile.user} @ ${liveProfile.orgUrl}` : 'Live mode (no profile selected)'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              padding: '2px 8px', borderRadius: 10,
              color: '#ff9aa2',
              backgroundColor: 'rgba(255, 80, 80, 0.25)',
              border: '1px solid rgba(255, 80, 80, 0.5)',
            }}
          >
            <Globe16Regular style={{ width: 12, height: 12 }} />
            LIVE{liveProfile ? `: ${liveProfile.friendlyName}` : ''}
          </span>
        )}

        {/* Live-blocked pill (M2.P6) — visible whenever the session has the
            block flag set, regardless of dataSource. Confirms to the user
            (and to anyone watching a CI screenshot) that no live calls can
            slip through even if a scenario tries. */}
        {isLiveBlocked() && (
          <span
            data-test-id="live-blocked-pill"
            title={liveBlockReason()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              padding: '2px 8px', borderRadius: 10,
              color: '#7fffd4',
              backgroundColor: 'rgba(0, 180, 120, 0.25)',
              border: '1px solid rgba(0, 180, 120, 0.5)',
            }}
          >
            🛡 LIVE BLOCKED
          </span>
        )}

        {/* M9 — Build watcher status pill. Hidden when watcher reports
            phase==='idle' AND no build has happened yet (seq===0) so we don't
            advertise the feature in environments where it's disabled. */}
        <BuildStatusPill />

        {/* Status badges */}
        {networkBadge && (
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            padding: '2px 8px', borderRadius: 10,
            color: networkBadge.color, backgroundColor: networkBadge.bg,
          }}>
            {networkBadge.label}
          </span>
        )}
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {deviceLabel}
        </span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {renderCount > 0 && `${lastRenderTimeMs.toFixed(1)}ms`}
        </span>

        <span className={styles.topBarSpacer} />
        <div className={styles.topBarControl}>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwise20Regular />}
            onClick={() => reloadControl?.()}
            disabled={!reloadControl}
            title="Reload — fresh restart of the control"
            style={{ color: 'white' }}
            data-test-id="harness-top-reload"
          >
            Reload
          </Button>
        </div>
        <div
          className={styles.topBarControl}
          data-test-id="shim-profile-control"
          title="API profile — choose which Dataverse version the harness emulates to test backward compatibility"
        >
          <Label size="small" style={{ color: 'white' }}>API</Label>
          <Dropdown
            size="small"
            value={SHIM_PROFILE_LABELS[shimProfile]}
            selectedOptions={[shimProfile]}
            onOptionSelect={(_, d) => setShimProfile((d.optionValue as ShimProfile) ?? 'latest')}
            style={{ minWidth: 120 }}
          >
            <Option value="9.0">{SHIM_PROFILE_LABELS['9.0']}</Option>
            <Option value="9.2">{SHIM_PROFILE_LABELS['9.2']}</Option>
            <Option value="latest">{SHIM_PROFILE_LABELS['latest']}</Option>
          </Dropdown>
        </div>
        <div
          className={styles.topBarControl}
          title="Form chrome — show the UCI header, command bar, tab strip, and footer around the control"
        >
          <Label size="small" style={{ color: 'white' }}>Form chrome</Label>
          <Switch
            checked={formChromeEnabled}
            onChange={() => toggleFormChrome()}
            style={{ '--colorCompoundBrandBackground': 'white' } as any}
            aria-label="Toggle UCI form chrome"
          />
        </div>
        <div
          className={styles.topBarControl}
          title="Authoring mode — preview how the control looks inside the canvas or model-driven designer"
        >
          <Label size="small" style={{ color: 'white' }}>
            Authoring
          </Label>
          <Switch
            checked={isAuthoringMode}
            onChange={(_, d) => setAuthoringMode(d.checked)}
            data-test-id="authoring-mode-toggle"
            style={{ '--colorCompoundBrandBackground': 'white' } as any}
            aria-label="Toggle authoring (designer preview) mode"
          />
        </div>
        <div
          className={styles.topBarControl}
          title="Disabled — test how the control renders when it cannot be edited"
        >
          <Label size="small" style={{ color: 'white' }}>Disabled</Label>
          <Switch
            checked={isControlDisabled}
            onChange={(_, d) => setControlDisabled(d.checked)}
            style={{ '--colorCompoundBrandBackground': 'white' } as any}
            aria-label="Toggle disabled (read-only) state"
          />
        </div>
        <Button
          appearance="subtle"
          icon={isDarkMode ? <WeatherSunny24Regular /> : <WeatherMoon24Regular />}
          onClick={toggleDarkMode}
          style={{ color: 'white' }}
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        />
      </div>

      {/* Body */}
      <div className={styles.body}>
        {/* Main panel: viewport + console */}
        <div className={styles.mainPanel}>
          <div className={styles.viewportArea}>
            <AppNotificationBanner />
            <LiveReauthBanner />
            <FormChrome entityTypeName={pageEntityTypeName}>
              <ControlViewport manifest={manifest} bundlePath={bundlePath} cssFiles={cssFiles} controlDir={controlDir} />
            </FormChrome>
          </div>
          {chromeMode !== 'none' && (
            <div className={mergeClasses(styles.consoleArea, bottomPanelCollapsed && styles.consoleAreaCollapsed)}>
              <Button
                appearance="subtle"
                size="small"
                icon={bottomPanelCollapsed ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
                className={styles.bottomToggle}
                onClick={toggleBottomPanel}
                title={bottomPanelCollapsed ? 'Expand console' : 'Collapse console'}
                aria-label={bottomPanelCollapsed ? 'Expand console' : 'Collapse console'}
              />
              {bottomPanelCollapsed ? (
                <div className={styles.collapsedRailBottom}>Console (collapsed)</div>
              ) : (
                <ConsolePanel />
              )}
            </div>
          )}
        </div>

        {/* Side panel: tabs */}
        {chromeMode !== 'none' && (
          <div className={mergeClasses(styles.sidePanel, rightPanelCollapsed && styles.sidePanelCollapsed)}>
            <div className={styles.sidePanelHeader}>
              <Button
                appearance="subtle"
                size="small"
                icon={rightPanelCollapsed ? <ChevronLeft20Regular /> : <ChevronRight20Regular />}
                className={styles.panelToggle}
                onClick={toggleRightPanel}
                title={rightPanelCollapsed ? 'Expand side panel' : 'Collapse side panel'}
                aria-label={rightPanelCollapsed ? 'Expand side panel' : 'Collapse side panel'}
              />
            </div>
            {rightPanelCollapsed ? (
              <div className={styles.collapsedRail}>Workbench panels</div>
            ) : (
              <>
                <ScenarioHeader controlId={`${manifest.namespace}.${manifest.constructor}`} />
                <div className={styles.sidePanelTabs}>
                  <TabList
                    selectedValue={activeTab}
                    onTabSelect={(_, d) => setActiveTab(d.value as SidePanelTab)}
                    size="small"
                  >
                    <Tab value="properties" icon={<Settings24Regular />} title="Properties — set the control's bound and input property values" />
                    <Tab value="form" icon={<Form24Regular />} title="Form — simulate the surrounding form: attributes, controls, tabs and their events" />
                    <Tab value="data" icon={<Database24Regular />} title="Data — edit mock records or connect to a real Dataverse org" />
                    <Tab value="network" icon={<PlugConnected24Regular />} title="Network — test the control offline or on slow connections" />
                    <Tab value="device" icon={<Phone24Regular />} title="Device — preview on phone, tablet or desktop viewports" />
                    <Tab value="user" icon={<Person24Regular />} title="User — switch language, time zone, RTL and security roles" />
                    <Tab value="lifecycle" icon={<Play24Regular />} title="Lifecycle — see when init / updateView / destroy fire and how long they take" />
                    <Tab value="performance" icon={<TopSpeed24Regular />} title="Performance — render timings, WebAPI calls, and resource-leak detection" />
                    <Tab value="audit" icon={<Warning24Regular />} title="Audit — diagnostics and lint-style checks for accessibility, manifest, CSS, bundle size, and banned APIs" />
                    <Tab value="coverage" icon={<Shield24Regular />} title="Coverage — see which platform APIs your control actually uses" />
                  </TabList>
                </div>
                <div className={styles.sidePanelContent}>
                  <div style={{ display: activeTab === 'properties' ? 'contents' : 'none' }}><PropertyEditor manifest={manifest} /></div>
                  {activeTab === 'form' && <FormPanel />}
                  <div style={{ display: activeTab === 'data' ? 'contents' : 'none' }}><DataPanel /></div>
                  {activeTab === 'network' && <NetworkPanel />}
                  {activeTab === 'device' && <DevicePanel />}
                  {activeTab === 'user' && <UserSettingsPanel />}
                  {activeTab === 'lifecycle' && <LifecyclePanel />}
                  {activeTab === 'performance' && <PerformancePanel />}
                  {activeTab === 'audit' && <AuditPanel manifest={manifest} bundlePath={bundlePath} cssFiles={cssFiles} />}
                  {activeTab === 'coverage' && <CoveragePanel />}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
