import { useState, useCallback, useEffect } from 'react';
import {
  makeStyles, tokens, Button, Input, MessageBar, MessageBarBody, Divider,
} from '@fluentui/react-components';
import {
  Save24Regular, Open24Regular, Delete24Regular, Wand24Regular,
} from '@fluentui/react-icons';
import { useHarnessStore, DEVICE_PRESETS } from '../../store/harness-store';
import type { ManifestProperty, ManifestDataSet } from '../../types/manifest';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  topSection: {
    padding: '12px 12px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flexShrink: 0,
  },
  scrollSection: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 12px',
  },
  bottomSection: {
    padding: '8px 12px 12px',
    flexShrink: 0,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  header: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  desc: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  scenarioList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  scenarioItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  scenarioName: {
    flex: 1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  scenarioMeta: {
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
  },
  saveRow: {
    display: 'flex',
    gap: '4px',
  },
});

interface TestScenario {
  name: string;
  savedAt: string;
  propertyValues: Record<string, any>;
  pageEntityId: string;
  pageEntityTypeName: string;
  networkMode: string;
  devicePreset: string;
  isControlDisabled: boolean;
}

function storageKey(controlId: string): string {
  return `pcf-workbench-scenarios-${controlId}`;
}

function loadScenariosFromStorage(controlId: string): TestScenario[] {
  try {
    const raw = localStorage.getItem(storageKey(controlId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveScenariosToStorage(controlId: string, scenarios: TestScenario[]): void {
  localStorage.setItem(storageKey(controlId), JSON.stringify(scenarios));
}

/**
 * Generate a sensible default value for a manifest property based on its type.
 */
function defaultValueForType(prop: ManifestProperty): any {
  if (prop.defaultValue != null && prop.defaultValue !== '') return prop.defaultValue;
  switch (prop.ofType) {
    case 'Lookup.Simple':
      return [{ id: '00000000-0000-0000-0000-000000000001', name: `Sample ${prop.name}`, entityType: prop.name.toLowerCase() }];
    case 'TwoOptions':
      return false;
    case 'Whole.None':
      return 0;
    case 'FP':
    case 'Decimal':
      return 0.0;
    case 'Currency':
      return 100.00;
    case 'DateAndTime.DateOnly':
    case 'DateAndTime.DateAndTime':
      return new Date().toISOString();
    case 'OptionSet':
      return 0;
    case 'Multiple':
      return '';
    default:
      return '';
  }
}

/**
 * Auto-generate skeleton test scenarios from the manifest.
 * Creates scenarios covering device presets, network modes, and edge cases.
 */
function generateSkeletonScenarios(
  properties: ManifestProperty[],
  dataSets: ManifestDataSet[],
): TestScenario[] {
  const now = new Date().toISOString();

  // Build default property values
  const defaults: Record<string, any> = {};
  for (const prop of properties) {
    defaults[prop.name] = defaultValueForType(prop);
  }

  const scenarios: TestScenario[] = [];

  // 1. Happy path per device preset
  for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
    scenarios.push({
      name: `Default - ${preset.name}`,
      savedAt: now,
      propertyValues: { ...defaults },
      pageEntityId: '',
      pageEntityTypeName: '',
      networkMode: 'online',
      devicePreset: key,
      isControlDisabled: false,
    });
  }

  // 2. Offline mode (mobile)
  scenarios.push({
    name: 'Mobile - Offline',
    savedAt: now,
    propertyValues: { ...defaults },
    pageEntityId: '',
    pageEntityTypeName: '',
    networkMode: 'offline',
    devicePreset: 'iphone-14',
    isControlDisabled: false,
  });

  // 3. Slow 3G (mobile)
  scenarios.push({
    name: 'Mobile - Slow 3G',
    savedAt: now,
    propertyValues: { ...defaults },
    pageEntityId: '',
    pageEntityTypeName: '',
    networkMode: 'slow3g',
    devicePreset: 'pixel-7',
    isControlDisabled: false,
  });

  // 4. Disabled / read-only
  scenarios.push({
    name: 'Read-Only (Disabled)',
    savedAt: now,
    propertyValues: { ...defaults },
    pageEntityId: '',
    pageEntityTypeName: '',
    networkMode: 'online',
    devicePreset: 'desktop',
    isControlDisabled: true,
  });

  // 5. Empty / null values (edge case)
  const emptyValues: Record<string, any> = {};
  for (const prop of properties) {
    emptyValues[prop.name] = prop.ofType === 'TwoOptions' ? false : null;
  }
  scenarios.push({
    name: 'Empty Values (Edge Case)',
    savedAt: now,
    propertyValues: emptyValues,
    pageEntityId: '',
    pageEntityTypeName: '',
    networkMode: 'online',
    devicePreset: 'desktop',
    isControlDisabled: false,
  });

  // 6. If there are bound properties, create a "with entity context" scenario
  const hasBound = properties.some(p => p.usage === 'bound');
  const hasDataSet = dataSets.length > 0;
  if (hasBound || hasDataSet) {
    scenarios.push({
      name: 'With Entity Context',
      savedAt: now,
      propertyValues: { ...defaults },
      pageEntityId: '11111111-1111-1111-1111-111111111111',
      pageEntityTypeName: hasDataSet ? dataSets[0].name : 'entity',
      networkMode: 'online',
      devicePreset: 'desktop',
      isControlDisabled: false,
    });
  }

  return scenarios;
}

interface ScenariosPanelProps {
  controlId: string;
}

export function ScenariosPanel({ controlId }: ScenariosPanelProps) {
  const styles = useStyles();
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<{ text: string; intent: 'success' | 'error' } | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load scenarios when control changes — from file first, then localStorage
  useEffect(() => {
    setLoaded(false);
    setScenarios([]);

    fetch('/pcf-data/test-scenarios.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then((fileScenarios: TestScenario[] | null) => {
        const local = loadScenariosFromStorage(controlId);
        const file = (fileScenarios && Array.isArray(fileScenarios)) ? fileScenarios : [];

        // Merge: file scenarios first, then any local-only ones
        const merged = [...file];
        for (const s of local) {
          if (!merged.find(m => m.name === s.name)) {
            merged.push(s);
          }
        }
        setScenarios(merged);
        saveScenariosToStorage(controlId, merged);
        setLoaded(true);
      });
  }, [controlId]);

  const propertyValues = useHarnessStore(s => s.propertyValues);
  const pageEntityId = useHarnessStore(s => s.pageEntityId);
  const pageEntityTypeName = useHarnessStore(s => s.pageEntityTypeName);
  const networkMode = useHarnessStore(s => s.networkMode);
  const devicePreset = useHarnessStore(s => s.devicePreset);
  const isControlDisabled = useHarnessStore(s => s.isControlDisabled);

  const setPropertyValues = useHarnessStore(s => s.setPropertyValues);
  const setPageEntityId = useHarnessStore(s => s.setPageEntityId);
  const setPageEntityTypeName = useHarnessStore(s => s.setPageEntityTypeName);
  const setNetworkMode = useHarnessStore(s => s.setNetworkMode);
  const setDevicePreset = useHarnessStore(s => s.setDevicePreset);
  const setControlDisabled = useHarnessStore(s => s.setControlDisabled);
  const addLogEntry = useHarnessStore(s => s.addLogEntry);
  const manifest = useHarnessStore(s => s.manifest);

  const handleSave = useCallback(() => {
    const name = newName.trim() || `Scenario ${scenarios.length + 1}`;
    const scenario: TestScenario = {
      name,
      savedAt: new Date().toISOString(),
      propertyValues,
      pageEntityId,
      pageEntityTypeName,
      networkMode,
      devicePreset,
      isControlDisabled,
    };

    // Replace if same name exists, otherwise append
    const existing = scenarios.findIndex(s => s.name === name);
    const updated = [...scenarios];
    if (existing >= 0) {
      updated[existing] = scenario;
    } else {
      updated.push(scenario);
    }

    setScenarios(updated);
    saveScenariosToStorage(controlId, updated);
    setNewName('');
    setMessage({ text: `Saved "${name}"`, intent: 'success' });
    addLogEntry({ category: 'scenario', method: 'save', args: { name } });
    setTimeout(() => setMessage(null), 3000);
  }, [newName, scenarios, propertyValues, pageEntityId, pageEntityTypeName, networkMode, devicePreset, isControlDisabled, addLogEntry]);

  const handleLoad = useCallback((scenario: TestScenario) => {
    setPropertyValues(scenario.propertyValues);
    setPageEntityId(scenario.pageEntityId);
    setPageEntityTypeName(scenario.pageEntityTypeName);
    setNetworkMode(scenario.networkMode as any);
    setDevicePreset(scenario.devicePreset);
    setControlDisabled(scenario.isControlDisabled);
    setMessage({ text: `Loaded "${scenario.name}"`, intent: 'success' });
    addLogEntry({ category: 'scenario', method: 'load', args: { name: scenario.name } });
    setTimeout(() => setMessage(null), 3000);
  }, [setPropertyValues, setPageEntityId, setPageEntityTypeName, setNetworkMode, setDevicePreset, setControlDisabled, addLogEntry]);

  const handleDelete = useCallback((name: string) => {
    const updated = scenarios.filter(s => s.name !== name);
    setScenarios(updated);
    saveScenariosToStorage(controlId, updated);
    addLogEntry({ category: 'scenario', method: 'delete', args: { name } });
  }, [scenarios, addLogEntry]);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(scenarios, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pcf-workbench-scenarios.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [scenarios]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text) as TestScenario[];
        if (!Array.isArray(imported)) throw new Error('Expected JSON array');
        // Merge: replace by name, add new
        const merged = [...scenarios];
        for (const s of imported) {
          const idx = merged.findIndex(m => m.name === s.name);
          if (idx >= 0) merged[idx] = s;
          else merged.push(s);
        }
        setScenarios(merged);
        saveScenariosToStorage(controlId, merged);
        setMessage({ text: `Imported ${imported.length} scenario(s)`, intent: 'success' });
        setTimeout(() => setMessage(null), 3000);
      } catch (err: any) {
        setMessage({ text: `Import failed: ${err.message}`, intent: 'error' });
      }
    };
    input.click();
  }, [scenarios]);

  const handleGenerate = useCallback(() => {
    if (!manifest) return;
    const generated = generateSkeletonScenarios(manifest.properties, manifest.dataSets);
    // Merge: don't overwrite existing scenarios with same name
    const merged = [...scenarios];
    let added = 0;
    for (const s of generated) {
      if (!merged.find(m => m.name === s.name)) {
        merged.push(s);
        added++;
      }
    }
    setScenarios(merged);
    saveScenariosToStorage(controlId, merged);
    setMessage({ text: `Generated ${added} skeleton scenario(s)`, intent: 'success' });
    addLogEntry({ category: 'scenario', method: 'generate', args: { count: added } });
    setTimeout(() => setMessage(null), 3000);
  }, [manifest, scenarios, controlId, addLogEntry]);

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };

  return (
    <div className={styles.root}>
      {/* Fixed top: header, save, generate */}
      <div className={styles.topSection}>
        <div className={styles.header}>Test Scenarios</div>
        <div className={styles.desc}>
          Save and restore property values, page context, network mode, and device preset.
        </div>

        {message && (
          <MessageBar intent={message.intent}>
            <MessageBarBody>{message.text}</MessageBarBody>
          </MessageBar>
        )}

        <div className={styles.saveRow}>
          <Input
            size="small"
            placeholder="Scenario name..."
            value={newName}
            onChange={(_, d) => setNewName(d.value)}
            style={{ flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
          />
          <Button
            appearance="primary"
            icon={<Save24Regular />}
            size="small"
            onClick={handleSave}
          >
            Save
          </Button>
        </div>

        {manifest && (
          <Button
            appearance="outline"
            icon={<Wand24Regular />}
            size="small"
            onClick={handleGenerate}
            title="Auto-generate skeleton scenarios from manifest (device presets, network modes, edge cases)"
          >
            Generate Skeletons
          </Button>
        )}
      </div>

      {/* Scrollable scenario list */}
      <div className={styles.scrollSection}>
        <div className={styles.scenarioList}>
          {scenarios.length === 0 && (
            <div className={styles.desc} style={{ textAlign: 'center', padding: 16 }}>
              No saved scenarios yet. Configure properties above, then save here.
            </div>
          )}
          {scenarios.map(s => (
            <div key={s.name} className={styles.scenarioItem}>
              <div style={{ flex: 1 }}>
                <div className={styles.scenarioName}>{s.name}</div>
                <div className={styles.scenarioMeta}>
                  {formatDate(s.savedAt)} &middot; {Object.keys(s.propertyValues).length} props
                  {s.pageEntityTypeName && ` \u00b7 ${s.pageEntityTypeName}`}
                  {s.networkMode !== 'online' && ` \u00b7 ${s.networkMode}`}
                </div>
              </div>
              <Button
                appearance="primary"
                icon={<Open24Regular />}
                size="small"
                onClick={() => handleLoad(s)}
                title="Load scenario"
              >
                Load
              </Button>
              <Button
                appearance="subtle"
                icon={<Delete24Regular />}
                size="small"
                onClick={() => handleDelete(s.name)}
                title="Delete scenario"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Fixed bottom: import/export */}
      {scenarios.length > 0 && (
        <div className={styles.bottomSection}>
          <div className={styles.saveRow}>
            <Button appearance="outline" size="small" onClick={handleExport} style={{ flex: 1 }}>
              Export All
            </Button>
            <Button appearance="outline" size="small" onClick={handleImport} style={{ flex: 1 }}>
              Import
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
