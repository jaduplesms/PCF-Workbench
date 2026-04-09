import { useEffect, useState } from 'react';
import { FluentProvider, webLightTheme, webDarkTheme, Spinner, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { HarnessShell } from './ui/HarnessShell';
import { Gallery } from './ui/gallery/Gallery';
import { useHarnessStore } from './store/harness-store';
import { loadEntityData } from './store/data-store';
import { setResxStrings } from './shim/resources';
import type { ManifestConfig } from './types/manifest';

// Import from virtual module (provided by pcf-plugin).
import { manifest as manifestData, bundlePath, cssFiles, resxStrings, isGalleryMode, controlDir } from 'virtual:pcf-manifest';

export function App() {
  const isDarkMode = useHarnessStore(s => s.isDarkMode);
  const setManifest = useHarnessStore(s => s.setManifest);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Gallery mode — no specific control, show the catalog
  if (isGalleryMode || !manifestData) {
    return (
      <FluentProvider theme={webLightTheme}>
        <Gallery />
      </FluentProvider>
    );
  }

  useEffect(() => {
    setManifest(manifestData);

    // Load RESX localized strings
    if (resxStrings && Object.keys(resxStrings).length > 0) {
      setResxStrings(resxStrings);
      console.log(`[pcf-workbench] RESX: ${Object.keys(resxStrings).length} strings loaded`);
    }

    // Load data.json from the PCF project directory
    fetch('/pcf-data/data.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(data => {
        if (data && Object.keys(data).length > 0) {
          loadEntityData(data);
          const tableCount = Object.keys(data).length;
          const recordCount = Object.values(data as Record<string, any[]>).reduce((sum, arr) => sum + arr.length, 0);
          console.log(`[pcf-workbench] Loaded data.json: ${tableCount} tables, ${recordCount} records`);
        } else {
          console.log('[pcf-workbench] No data.json found. WebAPI calls will return empty results.');
        }
        setReady(true);
      });
  }, []);

  if (!ready) {
    return (
      <FluentProvider theme={webLightTheme}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
          <Spinner label="Loading PCF control manifest..." />
        </div>
      </FluentProvider>
    );
  }

  return (
    <FluentProvider theme={isDarkMode ? webDarkTheme : webLightTheme}>
      <HarnessShell manifest={manifestData} bundlePath={bundlePath} cssFiles={cssFiles} controlDir={controlDir} />
    </FluentProvider>
  );
}
