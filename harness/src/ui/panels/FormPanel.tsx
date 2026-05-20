import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  makeStyles, tokens, Input, Switch, Button, Badge, Divider, Text, Dropdown, Option,
} from '@fluentui/react-components';
import {
  subscribeFormState,
  getFormStateVersion,
  listAttributes,
  listControls,
  listTabs,
  setAttributeValue,
  setAttributeRequiredLevel,
  setControlVisible,
  setControlDisabled,
  setControlNotification,
  clearControlNotification,
  setTabVisible,
  setTabDisplayState,
  fireOnChange,
  isFormDirty,
  getDirtyAttributes,
  getFormType,
  type RequiredLevel,
} from '../../store/form-store';

const useStyles = makeStyles({
  root: {
    padding: '12px',
    boxSizing: 'border-box',
    fontSize: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    // No height / overflow here — the parent `sidePanelContent` in
    // HarnessShell already provides the scroll container. Setting overflow
    // here produced nested scrollbars at the default side-panel width.
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minWidth: 0,
  },
  sectionTitle: {
    fontWeight: 600,
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: tokens.colorNeutralForeground2,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr) auto auto',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 6px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  rowDirty: {
    borderLeft: `3px solid ${tokens.colorPaletteYellowBorderActive}`,
  },
  attrName: {
    fontFamily: 'Consolas, monospace',
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  attrCell: {
    minWidth: 0,
    overflow: 'hidden',
  },
  attrType: {
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
  },
  controlRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto auto',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 6px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  tabRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 6px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  emptyMsg: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: '11px',
  },
  toolbar: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  },
});

interface FormSnapshot {
  attributes: ReturnType<typeof listAttributes>;
  controls: ReturnType<typeof listControls>;
  tabs: ReturnType<typeof listTabs>;
  dirty: boolean;
  dirtyCount: number;
  formType: number;
  version: number;
}

let cachedSnapshot: FormSnapshot | null = null;
let cachedVersion = -1;

function getSnapshot(): FormSnapshot {
  const v = getFormStateVersion();
  if (cachedSnapshot && cachedVersion === v) return cachedSnapshot;
  cachedVersion = v;
  cachedSnapshot = {
    attributes: listAttributes(),
    controls: listControls(),
    tabs: listTabs(),
    dirty: isFormDirty(),
    dirtyCount: getDirtyAttributes().length,
    formType: getFormType(),
    version: v,
  };
  return cachedSnapshot;
}

/** Subscribe a React component to form-store mutations. */
function useFormSnapshot(): FormSnapshot {
  return useSyncExternalStore(subscribeFormState, getSnapshot, getSnapshot);
}

const REQUIRED_LEVELS: RequiredLevel[] = ['none', 'recommended', 'required'];

const FORM_TYPE_LABEL: Record<number, string> = {
  0: 'Undefined',
  1: 'Create',
  2: 'Update',
  3: 'ReadOnly',
  4: 'Disabled',
  6: 'BulkEdit',
  11: 'ReadOptimized',
};

/**
 * FormPanel — operator UI for poking the formContext store. Lets the developer
 * edit attribute values, fire onChange handlers, toggle control visibility/
 * disabled state, raise notifications, and toggle tabs without writing JS.
 *
 * Stable data-test-id attributes (`fp-attr-<name>`, `fp-ctrl-<name>`,
 * `fp-tab-<name>`) make the panel scriptable from the Playwright MCP.
 */
export function FormPanel(): JSX.Element {
  const styles = useStyles();
  const snap = useFormSnapshot();
  const [editing, setEditing] = useState<Record<string, string>>({});

  // Re-seed local edit buffer when the underlying store changes
  useEffect(() => {
    setEditing(prev => {
      const next: Record<string, string> = {};
      for (const a of snap.attributes) {
        next[a.name] = prev[a.name] ?? (a.value == null ? '' : String(a.value));
      }
      return next;
    });
  }, [snap.version]);

  return (
    <div className={styles.root} data-test-id="form-panel">
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Form metadata</div>
        <div className={styles.toolbar}>
          <Badge appearance="outline" data-test-id="fp-form-type">
            FormType: {FORM_TYPE_LABEL[snap.formType] ?? snap.formType}
          </Badge>
          <Badge
            appearance={snap.dirty ? 'filled' : 'outline'}
            color={snap.dirty ? 'warning' : undefined}
            data-test-id="fp-form-dirty"
          >
            {snap.dirty ? `Dirty (${snap.dirtyCount})` : 'Clean'}
          </Badge>
        </div>
      </div>

      <Divider />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Attributes ({snap.attributes.length})</div>
        {snap.attributes.length === 0 && (
          <div className={styles.emptyMsg}>
            No attributes seeded. Add records to <code>data.json</code> or bound
            properties to the manifest.
          </div>
        )}
        {snap.attributes.map(a => (
          <div
            key={a.name}
            className={`${styles.row} ${a.isDirty ? styles.rowDirty : ''}`}
            data-test-id={`fp-attr-${a.name}`}
          >
            <div className={styles.attrCell}>
              <div className={styles.attrName} title={a.name}>{a.name}</div>
              <div className={styles.attrType}>{a.attributeType}</div>
            </div>
            <Input
              size="small"
              value={editing[a.name] ?? ''}
              onChange={(_, d) => setEditing(prev => ({ ...prev, [a.name]: d.value }))}
              onBlur={() => {
                const raw = editing[a.name] ?? '';
                let parsed: any = raw;
                if (a.attributeType === 'integer' || a.attributeType === 'decimal' || a.attributeType === 'money') {
                  const n = Number(raw);
                  parsed = Number.isFinite(n) ? n : null;
                } else if (a.attributeType === 'boolean') {
                  parsed = raw === 'true' || raw === '1';
                } else if (raw === '') {
                  parsed = null;
                }
                setAttributeValue(a.name, parsed);
              }}
              data-test-id={`fp-attr-${a.name}-input`}
              style={{ minWidth: 0 }}
            />
            <Dropdown
              size="small"
              value={a.requiredLevel}
              selectedOptions={[a.requiredLevel]}
              onOptionSelect={(_, d) => {
                if (d.optionValue) setAttributeRequiredLevel(a.name, d.optionValue as RequiredLevel);
              }}
              style={{ minWidth: '92px', width: '92px' }}
              data-test-id={`fp-attr-${a.name}-required`}
            >
              {REQUIRED_LEVELS.map(l => <Option key={l} value={l}>{l}</Option>)}
            </Dropdown>
            <Button
              size="small"
              appearance="subtle"
              onClick={() => fireOnChange(a.name)}
              data-test-id={`fp-attr-${a.name}-fire`}
              title="Fire onChange handlers"
            >
              fire
            </Button>
          </div>
        ))}
      </div>

      <Divider />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Controls ({snap.controls.length})</div>
        {snap.controls.map(c => (
          <div key={c.name} className={styles.controlRow} data-test-id={`fp-ctrl-${c.name}`}>
            <span className={styles.attrName} title={c.name}>{c.name}</span>
            <Switch
              size="small"
              checked={c.visible}
              onChange={(_, d) => setControlVisible(c.name, d.checked)}
              label="visible"
              data-test-id={`fp-ctrl-${c.name}-visible`}
            />
            <Switch
              size="small"
              checked={c.disabled}
              onChange={(_, d) => setControlDisabled(c.name, d.checked)}
              label="disabled"
              data-test-id={`fp-ctrl-${c.name}-disabled`}
            />
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                if (c.notifications.size > 0) {
                  clearControlNotification(c.name);
                } else {
                  setControlNotification(c.name, {
                    notificationLevel: 'ERROR',
                    uniqueId: `fp-${c.name}`,
                    messages: [`Test notification on ${c.name}`],
                  });
                }
              }}
              data-test-id={`fp-ctrl-${c.name}-notify`}
              title={c.notifications.size > 0 ? 'Clear notification' : 'Raise notification'}
            >
              {c.notifications.size > 0 ? `clr (${c.notifications.size})` : 'notify'}
            </Button>
          </div>
        ))}
      </div>

      <Divider />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Tabs ({snap.tabs.length})</div>
        {snap.tabs.map(t => (
          <div key={t.name} className={styles.tabRow} data-test-id={`fp-tab-${t.name}`}>
            <span className={styles.attrName}>
              {t.label ?? t.name} <Text size={100}>({t.name})</Text>
            </span>
            <Switch
              size="small"
              checked={t.visible}
              onChange={(_, d) => setTabVisible(t.name, d.checked)}
              label="visible"
              data-test-id={`fp-tab-${t.name}-visible`}
            />
            <Button
              size="small"
              appearance="subtle"
              onClick={() => setTabDisplayState(t.name, t.displayState === 'expanded' ? 'collapsed' : 'expanded')}
              data-test-id={`fp-tab-${t.name}-toggle`}
            >
              {t.displayState}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
