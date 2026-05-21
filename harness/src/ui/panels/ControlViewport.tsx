import { useEffect, useRef, useCallback, useState } from 'react';
import { makeStyles, tokens, Spinner, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { useHarnessStore } from '../../store/harness-store';
import { ControlHost, type ControlHostState } from '../../loader/control-host';
import type { ManifestConfig } from '../../types/manifest';
import { FormNotificationBanner } from '../FormNotificationBanner';
import { registerHarnessHost } from '../../test-bridge';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  viewportWrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    backgroundColor: '#f0f0f0',
    overflow: 'auto',
    padding: '16px',
  },
  viewportFrame: {
    position: 'relative' as const,
    border: '2px solid #1a1a1a',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: '#fafafa',
    boxShadow: tokens.shadow8,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    flexShrink: 0,
    overflow: 'hidden',
  },
  viewportNotifications: {
    flexShrink: 0,
    width: '100%',
  },
  viewport: {
    backgroundColor: '#ffffff',
    overflow: 'hidden',
    position: 'relative' as const,
    containerType: 'inline-size',
    containerName: 'pcf-viewport',
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)',
  } as any,
  controlContainer: {
    width: '100%',
    minHeight: '48px',
    overflow: 'auto',
    height: '100%',
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '24px',
  },
  error: {
    margin: '16px',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '4px 12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    flexShrink: 0,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  statusItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  statusLabel: {
    fontSize: '10px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    opacity: 0.7,
    fontFamily: tokens.fontFamilyBase,
    fontWeight: tokens.fontWeightSemibold,
  },
});

interface Props {
  manifest: ManifestConfig;
  bundlePath: string;
  cssFiles: string[];
  controlDir: string;
}

export function ControlViewport({ manifest, bundlePath, cssFiles }: Props) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<ControlHost | null>(null);
  const [hostState, setHostState] = useState<ControlHostState>({ isLoaded: false, error: null });

  const viewportWidth = useHarnessStore(s => s.viewportWidth);
  const viewportHeight = useHarnessStore(s => s.viewportHeight);
  const containerWidth = useHarnessStore(s => s.containerWidth);
  const containerHeight = useHarnessStore(s => s.containerHeight);
  const propertyValues = useHarnessStore(s => s.propertyValues);
  const networkMode = useHarnessStore(s => s.networkMode);
  const isControlDisabled = useHarnessStore(s => s.isControlDisabled);
  const formFactor = useHarnessStore(s => s.formFactor);
  const isDarkMode = useHarnessStore(s => s.isDarkMode);
  const pageEntityId = useHarnessStore(s => s.pageEntityId);
  const pageEntityTypeName = useHarnessStore(s => s.pageEntityTypeName);
  const pageEntityRecordName = useHarnessStore(s => s.pageEntityRecordName);
  const isFullscreen = useHarnessStore(s => s.isFullscreen);
  const userLanguageId = useHarnessStore(s => s.userLanguageId);
  const userIsRTL = useHarnessStore(s => s.userIsRTL);
  const userTimeZoneOffsetMinutes = useHarnessStore(s => s.userTimeZoneOffsetMinutes);
  const host = useHarnessStore(s => s.host);
  const datasetState = useHarnessStore(s => s.datasetState);
  const dataVersion = useHarnessStore(s => s.dataVersion);
  const isAuthoringMode = useHarnessStore(s => s.isAuthoringMode);

  // Authoring mode is read on init() in real Dataverse and doesn't change at
  // runtime — but for harness UX we want toggling the switch to take effect
  // immediately. Force a full re-init when it flips.
  useEffect(() => {
    if (!hostRef.current?.isLoaded()) return;
    hostRef.current.reload();
  }, [isAuthoringMode]);

  // Initialize control host
  useEffect(() => {
    if (!containerRef.current) return;

    // Load control CSS into a scoped @layer to prevent Bootstrap from overriding harness styles.
    // Harness styles (unlayered) always win over layered styles per CSS cascade rules.
    // The control CSS applies inside the control container via specificity.
    const loadControlCss = async () => {
      // Remove any previously injected control CSS
      document.querySelectorAll('[data-pcf-css]').forEach(el => el.remove());

      // Establish layer order: control CSS goes in pcf-control layer (lowest priority).
      // Harness Fluent UI styles are unlayered (highest priority) and won't be affected
      // by Bootstrap resets. Control CSS applies normally to control elements since
      // harness atomic classes don't match control selectors.
      const layerOrder = document.createElement('style');
      layerOrder.setAttribute('data-pcf-css', 'layer-order');
      layerOrder.textContent = '@layer pcf-control;';
      document.head.insertBefore(layerOrder, document.head.firstChild);

      // Fetch all CSS files, wrap in @layer, and convert @media width queries
      // to @container queries so they respond to the viewport container size
      // (not the browser window) for device emulation.
      for (const cssFile of cssFiles) {
        try {
          const resp = await fetch(cssFile);
          if (!resp.ok) continue;
          let cssText = await resp.text();
          // Convert @media width queries to @container queries
          // @media (max-width: 768px) → @container pcf-viewport (max-width: 768px)
          // @media (min-width: 768px) → @container pcf-viewport (min-width: 768px)
          cssText = cssText.replace(
            /@media\s+only\s+screen\s+and\s*\(((?:max|min)-width:\s*\d+px)\)/g,
            '@container pcf-viewport ($1)'
          );
          cssText = cssText.replace(
            /@media\s*\(((?:max|min)-width:\s*\d+px)\)/g,
            '@container pcf-viewport ($1)'
          );
          const style = document.createElement('style');
          style.setAttribute('data-pcf-css', 'true');
          style.textContent = `@layer pcf-control {\n${cssText}\n}`;
          document.head.appendChild(style);
        } catch {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = cssFile;
          link.setAttribute('data-pcf-css', 'true');
          document.head.appendChild(link);
        }
      }
    };
    loadControlCss();

    const host = new ControlHost(
      manifest,
      useHarnessStore.getState,
      bundlePath,
      setHostState,
    );
    hostRef.current = host;
    registerHarnessHost(host);
    host.load(containerRef.current);

    return () => {
      // Clean up control CSS on unmount
      document.querySelectorAll('link[data-pcf-css]').forEach(el => el.remove());
      host.destroy();
      registerHarnessHost(null);
      hostRef.current = null;
    };
  }, [manifest, bundlePath]); // Only reload on manifest/bundle change

  // Listen for bundle changes (hot reload from Vite plugin file watcher)
  useEffect(() => {
    if (import.meta.hot) {
      import.meta.hot.on('pcf-bundle-changed', () => {
        console.log('[pcf-workbench] Bundle changed — reloading control');
        hostRef.current?.reload();
      });
    }
  }, []);


  // Trigger updateView when properties, network, device, or mode change.
  // Debounce to prevent cascading re-renders (especially for virtual controls
  // where ReactDOM.render can trigger synchronous state updates).
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hostRef.current?.isLoaded()) return;
    // Debounce: wait 50ms for rapid changes to settle
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(() => {
      hostRef.current?.callUpdateView();
    }, 50);
    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [propertyValues, networkMode, isControlDisabled, formFactor, isDarkMode, pageEntityId, pageEntityTypeName, pageEntityRecordName, containerWidth, containerHeight, isFullscreen, userLanguageId, userIsRTL, userTimeZoneOffsetMinutes, host, datasetState, dataVersion]);

  const handleReload = useCallback(() => {
    hostRef.current?.reload();
  }, []);

  // Register the reload callback in the store so the harness top bar's
  // Refresh button (and the form command bar's Refresh) can trigger it.
  const setReloadControl = useHarnessStore(s => s.setReloadControl);
  useEffect(() => {
    setReloadControl(handleReload);
    return () => setReloadControl(null);
  }, [handleReload, setReloadControl]);

  return (
    <div className={styles.root}>
      <div className={styles.viewportWrapper}>
        <div
          className={styles.viewportFrame}
          style={{
            width: viewportWidth,
            height: viewportHeight,
          }}
        >
          <div className={styles.viewportNotifications}>
            <FormNotificationBanner />
          </div>
          <div
            className={styles.viewport}
            style={{
              width: containerWidth ?? viewportWidth,
              height: containerHeight ?? viewportHeight,
            }}
          >
            {hostState.error && (
              <MessageBar intent="error" className={styles.error}>
                <MessageBarBody>{hostState.error}</MessageBarBody>
              </MessageBar>
            )}
            {!hostState.isLoaded && !hostState.error && (
              <div className={styles.center}>
                <Spinner label="Loading control..." />
              </div>
            )}
            <div ref={containerRef} className={styles.controlContainer} data-test-id="pcf-control-container" style={{
              width: containerWidth != null ? `${containerWidth}px` : '100%',
              height: containerHeight != null ? `${containerHeight}px` : '100%',
            }} />
          </div>
        </div>
      </div>

      <div className={styles.statusBar} aria-label="Viewport size">
        <div className={styles.statusItem}>
          <span className={styles.statusLabel}>Viewport</span>
          <span>{viewportWidth} × {viewportHeight}</span>
        </div>
        <div className={styles.statusItem}>
          <span className={styles.statusLabel}>Container</span>
          <span>{containerWidth ?? viewportWidth} × {containerHeight ?? viewportHeight}</span>
          {(containerWidth == null && containerHeight == null) && (
            <span style={{ opacity: 0.5, fontFamily: tokens.fontFamilyBase, fontSize: '10px' }}>(full)</span>
          )}
        </div>
      </div>
    </div>
  );
}
