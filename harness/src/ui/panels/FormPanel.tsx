import { useEffect, useState, useSyncExternalStore, useCallback, type ReactNode } from 'react';
import {
  makeStyles, mergeClasses, tokens, Input, Switch, Button, Badge, Text, Dropdown, Option,
} from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import {
  subscribeFormState,
  getFormStateVersion,
  listAttributes,
  listControls,
  listTabs,
  setAttributeValue,
  setControlVisible,
  setControlDisabled,
  setControlNotification,
  clearControlNotification,
  setTabVisible,
  setTabDisplayState,
  isFormDirty,
  getDirtyAttributes,
  getFormType,
  type AttributeState,
} from '../../store/form-store';
import { getEntityStoreKeys, getEntityData } from '../../store/data-store';
import { getEntityMetadata } from '../../store/metadata-store';
import { SearchPicker, type SearchPickerItem } from '../common/SearchPicker';

const useStyles = makeStyles({
  root: {
    padding: '12px',
    boxSizing: 'border-box',
    fontSize: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    // Defense-in-depth — the parent sidePanelContent owns scrolling, but
    // if any row miscalculates we'd rather clip than spawn an inner
    // horizontal scrollbar inside the side panel.
    overflowX: 'hidden',
  },
  // Short explanatory copy shown under a section header or at the top of the
  // panel. Muted, small, wraps.
  intro: {
    fontSize: '11px',
    lineHeight: 1.45,
    color: tokens.colorNeutralForeground3,
  },
  introCode: {
    fontFamily: 'Consolas, monospace',
    fontSize: '10px',
    color: tokens.colorNeutralForeground2,
  },
  // Card section — matches the Data tab's collapsible blocks (bordered,
  // rounded, background2 card with a normal-case semibold title). Replaces the
  // old flat uppercase + <Divider/> treatment so both tabs feel consistent.
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  collapsibleHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  sectionTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  collapsibleChevron: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
    width: '16px',
    height: '16px',
  },
  collapsibleBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  // Attribute row — two lines so the field name/type and its editor + actions
  // don't cram on a narrow panel. Rendered as an inset (background1) card on
  // top of the section's background2 so rows are visually distinct.
  attrRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '6px 8px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
  },
  rowDirty: {
    borderLeft: `3px solid ${tokens.colorPaletteYellowBorderActive}`,
  },
  attrTop: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  attrName: {
    fontFamily: 'Consolas, monospace',
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flex: '1 1 auto',
  },
  attrLabel: {
    fontSize: '12px',
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flex: '0 1 auto',
  },
  attrLogical: {
    fontFamily: 'Consolas, monospace',
    fontSize: '10px',
    color: tokens.colorNeutralForeground4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flex: '1 1 auto',
  },
  attrFormatted: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    flexShrink: 0,
  },
  attrType: {
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
  },
  dirtyDot: {
    flexShrink: 0,
    fontSize: '10px',
    color: tokens.colorPaletteYellowForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  attrBottom: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  attrInput: {
    flex: '1 1 140px',
    minWidth: 0,
    width: '100%',
  },
  controlRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
  },
  controlName: {
    flex: '1 1 100%',
    minWidth: 0,
  },
  tabRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
  },
  tabName: {
    flex: '1 1 100%',
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
  metaStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  metaLabel: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    marginRight: '2px',
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

const FORM_TYPE_LABEL: Record<number, string> = {
  0: 'Undefined',
  1: 'Create',
  2: 'Update',
  3: 'ReadOnly',
  4: 'Disabled',
  6: 'BulkEdit',
  11: 'ReadOptimized',
};

const COLLAPSE_STORAGE_KEY = 'pcf-workbench:form-panel:collapsed';

function readCollapsedMap(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, boolean> : {};
  } catch { return {}; }
}

function writeCollapsedMap(map: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

interface CollapsibleSectionProps {
  /** Stable id used to persist open/closed state across reloads. */
  id: string;
  title: ReactNode;
  /** Optional tooltip on the header (mirrors what the section title already
   *  had so users get the same explanation when hovering). */
  titleTooltip?: string;
  /** When true, section starts collapsed unless the user has flipped it. */
  defaultCollapsed?: boolean;
  /** Stable test id for the section root. */
  testId?: string;
  children: ReactNode;
}

function CollapsibleSection({ id, title, titleTooltip, defaultCollapsed = false, testId, children }: CollapsibleSectionProps): JSX.Element {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const map = readCollapsedMap();
    return id in map ? map[id] : defaultCollapsed;
  });
  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      const map = readCollapsedMap();
      map[id] = next;
      writeCollapsedMap(map);
      return next;
    });
  }, [id]);
  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  }, [toggle]);
  return (
    <div className={styles.section} data-test-id={testId}>
      <div
        className={mergeClasses(styles.sectionTitle, styles.collapsibleHeader)}
        onClick={toggle}
        onKeyDown={onKey}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={titleTooltip}
        data-test-id={testId ? `${testId}-header` : undefined}
      >
        {collapsed
          ? <ChevronRight16Regular className={styles.collapsibleChevron} />
          : <ChevronDown16Regular className={styles.collapsibleChevron} />}
        <span>{title}</span>
      </div>
      {!collapsed && (
        <div className={styles.collapsibleBody} data-test-id={testId ? `${testId}-body` : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Attribute editors — type-aware, UCI-style. Committing a value calls */
/* setAttributeValue, which already fires onChange (form-store.ts).    */
/* ------------------------------------------------------------------ */

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'money', 'double']);

/** Format a stored value into a `datetime-local` input string (local time). */
function toDateTimeLocal(v: any): string {
  if (v == null || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Build a cross-table list of mock records so lookup fields become a picker
 *  instead of a raw GUID box. We don't know a lookup's target entity (it isn't
 *  captured on the attribute), so we search every mock table and group by it. */
function buildLookupItems(): SearchPickerItem<{ entityType: string; id: string; name: string }>[] {
  const items: SearchPickerItem<{ entityType: string; id: string; name: string }>[] = [];
  for (const type of getEntityStoreKeys()) {
    const meta = getEntityMetadata(type);
    const idAttr = meta?.primaryIdAttribute ?? `${type}id`;
    const nameAttr = meta?.primaryNameAttribute ?? 'name';
    for (const rec of getEntityData(type)) {
      const idKey = idAttr in rec
        ? idAttr
        : Object.keys(rec).find(k => k.toLowerCase().endsWith('id')) ?? '';
      const id = idKey ? String(rec[idKey] ?? '') : '';
      if (!id) continue;
      const name = String(rec[nameAttr] ?? rec.name ?? id);
      items.push({ value: id, text: name, secondary: `${type} · ${id}`, group: type, raw: { entityType: type, id, name } });
    }
  }
  return items;
}

function LookupEditor({ attr }: { attr: AttributeState }): JSX.Element {
  const all = buildLookupItems();
  // Scope to the lookup's target entity when we know it (from the record's
  // lookuplogicalname annotation or metadata); otherwise search every table.
  let items = attr.lookupTarget ? all.filter(i => i.raw.entityType === attr.lookupTarget) : all;
  const currentId = attr.value == null ? '' : String(attr.value);
  // The record's FormattedValue is the authoritative display name for the
  // current value (e.g. "WO-00047"). Ensure the picker shows it even when the
  // target record has no resolvable primary-name column, or no mock row at all.
  if (currentId && attr.formattedValue) {
    const idx = items.findIndex(i => i.value === currentId);
    if (idx >= 0) {
      items = items.map((it, i) => (i === idx ? { ...it, text: attr.formattedValue! } : it));
    } else {
      items = [{
        value: currentId,
        text: attr.formattedValue,
        secondary: attr.lookupTarget ? `${attr.lookupTarget} · ${currentId}` : currentId,
        group: attr.lookupTarget,
        raw: { entityType: attr.lookupTarget ?? '', id: currentId, name: attr.formattedValue },
      }, ...items];
    }
  }
  const current = items.find(i => i.value === currentId);
  const placeholder = current ? current.text : (attr.formattedValue ?? (currentId || 'Pick a record…'));
  return (
    <SearchPicker
      items={items}
      activeValue={currentId || null}
      placeholder={placeholder}
      unfetchedMessage={attr.lookupTarget
        ? `No mock ${attr.lookupTarget} records — add them in the Data tab.`
        : 'No mock records — add tables in the Data tab.'}
      onSelect={(item) => setAttributeValue(attr.name, item.value)}
      size="small"
      testIdPrefix={`fp-attr-${attr.name}`}
    />
  );
}

interface AttributeEditorProps {
  attr: AttributeState;
  className?: string;
  textValue: string;
  onTextChange: (v: string) => void;
  onTextCommit: () => void;
}

/** Renders the right editor control for an attribute's type. */
function AttributeEditor({ attr, className, textValue, onTextChange, onTextCommit }: AttributeEditorProps): JSX.Element {
  const testId = `fp-attr-${attr.name}-input`;

  if (attr.attributeType === 'boolean') {
    return (
      <Switch
        className={className}
        checked={!!attr.value}
        onChange={(_, d) => setAttributeValue(attr.name, d.checked)}
        label={attr.value ? 'true' : 'false'}
        data-test-id={testId}
        title="Value — toggle the boolean; onChange fires automatically"
      />
    );
  }

  if (attr.attributeType === 'optionset' && attr.options && attr.options.length > 0) {
    const selected = attr.value == null ? '' : String(attr.value);
    const selectedText = attr.options.find(o => String(o.value) === selected)?.text ?? '';
    return (
      <Dropdown
        size="small"
        className={className}
        value={selectedText}
        selectedOptions={[selected]}
        placeholder="— none —"
        onOptionSelect={(_, d) => {
          const v = d.optionValue ?? '';
          setAttributeValue(attr.name, v === '' ? null : Number(v));
        }}
        data-test-id={testId}
        title="Value — pick an option; the friendly label is shown, the numeric value is stored"
      >
        <Option value="" text="— none —">— none —</Option>
        {attr.options.map(o => (
          <Option key={o.value} value={String(o.value)} text={o.text}>
            {o.text} <span style={{ color: tokens.colorNeutralForeground4, fontSize: '10px' }}>({o.value})</span>
          </Option>
        ))}
      </Dropdown>
    );
  }

  if (attr.attributeType === 'lookup') {
    return <span className={className}><LookupEditor attr={attr} /></span>;
  }

  if (attr.attributeType === 'datetime') {
    return (
      <Input
        size="small"
        type="datetime-local"
        className={className}
        value={toDateTimeLocal(attr.value)}
        onChange={(_, d) => {
          if (!d.value) { setAttributeValue(attr.name, null); return; }
          const parsed = new Date(d.value);
          setAttributeValue(attr.name, isNaN(parsed.getTime()) ? null : parsed);
        }}
        data-test-id={testId}
        title="Value — pick a date/time; onChange fires automatically"
      />
    );
  }

  const isNum = NUMERIC_TYPES.has(attr.attributeType);
  return (
    <Input
      size="small"
      type={isNum ? 'number' : 'text'}
      className={className}
      value={textValue}
      onChange={(_, d) => onTextChange(d.value)}
      onBlur={onTextCommit}
      placeholder={attr.value == null ? 'null' : ''}
      data-test-id={testId}
      title="Value — edit and tab away; onChange fires when the field commits"
    />
  );
}

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
      <div className={styles.intro}>
        Simulate the Dynamics 365 form around your control — no real form needed.
        Edit field values, toggle control state, raise notifications, and show/hide
        tabs, then watch how your PCF reacts to{' '}
        <span className={styles.introCode}>formContext</span> /{' '}
        <span className={styles.introCode}>Xrm.Page</span>.
      </div>

      <div className={styles.metaStrip} data-test-id="fp-section-form">
        <span
          className={styles.metaLabel}
          title="The form's overall state your control can read: which form type is open and whether any field has unsaved edits."
        >
          Form
        </span>
        <span title="Form type — what kind of form is open (Create, Update, ReadOnly, Disabled, BulkEdit, etc.)">
          <Badge appearance="outline" data-test-id="fp-form-type">
            FormType: {FORM_TYPE_LABEL[snap.formType] ?? snap.formType}
          </Badge>
        </span>
        <span title="Dirty — how many attribute values have changed since the last seed or save">
          <Badge
            appearance={snap.dirty ? 'filled' : 'outline'}
            color={snap.dirty ? 'warning' : undefined}
            data-test-id="fp-form-dirty"
          >
            {snap.dirty ? `Dirty (${snap.dirtyCount})` : 'Clean'}
          </Badge>
        </span>
      </div>

      <CollapsibleSection
        id="attributes"
        title={`Attributes (${snap.attributes.length})`}
        titleTooltip="Attributes are the data fields on the form's record — the values your control reads and writes via formContext.getAttribute(name)."
        defaultCollapsed={true}
        testId="fp-section-attributes"
      >
        <div className={styles.intro}>
          Fields on the record your control reads via{' '}
          <span className={styles.introCode}>formContext.getAttribute(name)</span>.
          Change a value with the friendly editor and <strong>onChange fires
          automatically</strong> — just like a user editing that field on a real form.
        </div>
        {snap.attributes.length === 0 && (
          <div className={styles.emptyMsg}>
            No attributes seeded. Add records to <code>data.json</code> or bound
            properties to the manifest.
          </div>
        )}
        {snap.attributes.map(a => {
          const isNum = NUMERIC_TYPES.has(a.attributeType);
          const commitText = () => {
            const raw = editing[a.name] ?? '';
            let parsed: any = raw;
            if (isNum) {
              const n = Number(raw);
              parsed = raw === '' ? null : (Number.isFinite(n) ? n : null);
            } else if (raw === '') {
              parsed = null;
            }
            setAttributeValue(a.name, parsed);
          };
          return (
            <div
              key={a.name}
              className={mergeClasses(styles.attrRow, a.isDirty ? styles.rowDirty : undefined)}
              data-test-id={`fp-attr-${a.name}`}
            >
              <div className={styles.attrTop}>
                {a.displayName && a.displayName !== a.name ? (
                  <>
                    <span className={styles.attrLabel} title={a.displayName}>{a.displayName}</span>
                    <span className={styles.attrLogical} title={`${a.name} — logical column name`}>{a.name}</span>
                  </>
                ) : (
                  <span className={styles.attrName} title={`${a.name} — column name on the record`}>
                    {a.name}
                  </span>
                )}
                <span className={styles.attrType} title="Field type — determines what values are accepted">
                  {a.attributeType}
                </span>
                {a.isDirty && <span className={styles.dirtyDot} title="Unsaved change">●</span>}
              </div>
              <div className={styles.attrBottom}>
                <AttributeEditor
                  attr={a}
                  className={styles.attrInput}
                  textValue={editing[a.name] ?? ''}
                  onTextChange={(v) => setEditing(prev => ({ ...prev, [a.name]: v }))}
                  onTextCommit={commitText}
                />
                {a.formattedValue && a.attributeType !== 'lookup' && (
                  <span className={styles.attrFormatted} title="Friendly value (from the record's FormattedValue annotation)">
                    {a.formattedValue}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </CollapsibleSection>

      <CollapsibleSection
        id="controls"
        title={`Controls (${snap.controls.length})`}
        titleTooltip="Controls are the UI widgets bound to fields. Toggle visibility / disabled state or raise a notification to test how your control reacts."
        defaultCollapsed={true}
        testId="fp-section-controls"
      >
        <div className={styles.intro}>
          UI controls bound to fields. Toggle <strong>visible</strong> /{' '}
          <strong>disabled</strong>, or raise a field-level notification, to test
          how your control responds.
        </div>
        {snap.controls.map(c => (
          <div key={c.name} className={styles.controlRow} data-test-id={`fp-ctrl-${c.name}`}>
            <span
              className={mergeClasses(styles.attrName, styles.controlName)}
              title={`${c.name} — toggle visibility or disabled state to test how your PCF reacts`}
            >
              {c.name}
            </span>
            <Switch
              size="small"
              checked={c.visible}
              onChange={(_, d) => setControlVisible(c.name, d.checked)}
              label="visible"
              data-test-id={`fp-ctrl-${c.name}-visible`}
              title="Visibility — show or hide this control on the form"
            />
            <Switch
              size="small"
              checked={c.disabled}
              onChange={(_, d) => setControlDisabled(c.name, d.checked)}
              label="disabled"
              data-test-id={`fp-ctrl-${c.name}-disabled`}
              title="Disabled — make this control read-only on the form"
            />
            <Button
              size="small"
              appearance="secondary"
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
              title={c.notifications.size > 0
                ? 'Clear all notifications on this control (formContext.getControl(name).clearNotification(...)).'
                : 'Raise a test ERROR notification on this control (formContext.getControl(name).setNotification(...)). Useful for verifying that the field-level error indicator appears.'}
            >
              {c.notifications.size > 0 ? `Clear (${c.notifications.size})` : 'Notify'}
            </Button>
          </div>
        ))}
      </CollapsibleSection>

      <CollapsibleSection
        id="tabs"
        title={`Tabs (${snap.tabs.length})`}
        titleTooltip="Tabs are the top-level form sections (General, Details, Related, …). Show/hide or expand/collapse to test controls that adapt to the active tab."
        defaultCollapsed={true}
        testId="fp-section-tabs"
      >
        <div className={styles.intro}>
          Form tabs (General, Details, …). Show/hide or expand/collapse to test
          controls that adapt to the active tab.
        </div>
        {snap.tabs.map(t => (
          <div key={t.name} className={styles.tabRow} data-test-id={`fp-tab-${t.name}`}>
            <span
              className={mergeClasses(styles.attrName, styles.tabName)}
              title={`${t.label ?? t.name} — toggle visibility and display state for this tab`}
            >
              {t.label ?? t.name} <Text size={100}>({t.name})</Text>
            </span>
            <Switch
              size="small"
              checked={t.visible}
              onChange={(_, d) => setTabVisible(t.name, d.checked)}
              label="visible"
              data-test-id={`fp-tab-${t.name}-visible`}
              title="Visibility — show or hide this tab on the form"
            />
            <Button
              size="small"
              appearance="subtle"
              onClick={() => setTabDisplayState(t.name, t.displayState === 'expanded' ? 'collapsed' : 'expanded')}
              data-test-id={`fp-tab-${t.name}-toggle`}
              title="Display state — expand or collapse this tab's sections"
            >
              {t.displayState}
            </Button>
          </div>
        ))}
      </CollapsibleSection>
    </div>
  );
}
