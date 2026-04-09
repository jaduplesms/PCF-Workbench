import { useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, Badge, Button, Input, MessageBar, MessageBarBody, Switch, Tooltip,
} from '@fluentui/react-components';
import {
  Search24Regular, ArrowClockwise24Regular, Open24Regular, EyeOff24Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    height: '100vh',
    overflow: 'auto',
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#0078d4',
    color: 'white',
    padding: '24px 40px',
  },
  headerTitle: {
    fontSize: '28px',
    fontWeight: 600,
    letterSpacing: '0.5px',
  },
  headerSubtitle: {
    fontSize: '14px',
    opacity: 0.8,
    marginTop: '4px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '16px 40px',
    backgroundColor: 'white',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
  },
  statsBar: {
    display: 'flex',
    gap: '16px',
    fontSize: '13px',
    color: tokens.colorNeutralForeground3,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: '16px',
    padding: '24px 40px',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    transition: 'box-shadow 0.15s, transform 0.15s',
    cursor: 'pointer',
    ':hover': {
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
    },
  },
  cardDisabled: {
    opacity: 0.6,
    cursor: 'default',
    ':hover': {
      boxShadow: 'none',
      transform: 'none',
    },
  },
  thumbnail: {
    height: '170px',
    backgroundColor: '#f8f8f8',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    overflow: 'hidden',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: 'relative' as const,
  },
  thumbnailImg: {
    width: '100%',
    height: '100%',
    objectFit: 'contain' as const,
  },
  thumbnailPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
    fontSize: '13px',
  },
  placeholderIcon: {
    fontSize: '36px',
    opacity: 0.3,
  },
  cardBody: {
    padding: '14px 16px',
  },
  cardTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  cardNamespace: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontFamily: "'Consolas', monospace",
    marginTop: '2px',
  },
  cardBadges: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap' as const,
    marginTop: '8px',
  },
  cardMeta: {
    display: 'flex',
    gap: '12px',
    marginTop: '8px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  cardProperties: {
    marginTop: '8px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontFamily: "'Consolas', monospace",
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '100%',
  },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

interface GalleryControl {
  namespace: string;
  constructor: string;
  version: string;
  controlType: 'standard' | 'virtual';
  displayNameKey: string;
  descriptionKey: string;
  properties: Array<{ name: string; ofType: string; usage: string }>;
  featureUsage: Array<{ name: string; required: boolean }>;
  platformLibraries: Array<{ name: string; version: string }>;
  cssCount: number;
  hasBuild: boolean;
  hasDataJson: boolean;
  hasTestScenarios: boolean;
  hasThumbnail: boolean;
  controlDir: string;
  lastModified: string | null;
  bundleSize: number | null;
  packageSize: number | null;
  isPrivate: boolean;
}

export function Gallery() {
  const styles = useStyles();
  const [controls, setControls] = useState<GalleryControl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showPrivate, setShowPrivate] = useState(false);

  const loadControls = () => {
    setLoading(true);
    fetch('/api/gallery/controls')
      .then(r => r.json())
      .then(data => {
        setControls(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(loadControls, []);

  const visibleControls = showPrivate ? controls : controls.filter(c => !c.isPrivate);
  const privateCount = controls.filter(c => c.isPrivate).length;

  const filtered = search
    ? visibleControls.filter(c =>
        c.constructor.toLowerCase().includes(search.toLowerCase()) ||
        c.namespace.toLowerCase().includes(search.toLowerCase()) ||
        c.controlType.includes(search.toLowerCase())
      )
    : visibleControls;

  const builtCount = visibleControls.filter(c => c.hasBuild).length;
  const virtualCount = visibleControls.filter(c => c.controlType === 'virtual').length;

  const [switching, setSwitching] = useState<string | null>(null);

  const handleOpen = (c: GalleryControl) => {
    if (!c.hasBuild || switching) return;
    setSwitching(c.constructor);
    fetch('/api/switch-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controlDir: c.controlDir }),
    })
      .then(r => r.json())
      .then(result => {
        if (result.error) {
          setError(result.error);
          setSwitching(null);
        }
        // Server sends full-reload — page will refresh into harness mode
      })
      .catch(err => {
        setError(`Failed to open: ${err.message}`);
        setSwitching(null);
      });
  };

  const thumbnailUrl = (c: GalleryControl) => {
    if (!c.hasThumbnail) return null;
    return `/api/thumbnail?dir=${encodeURIComponent(c.controlDir)}&t=${Date.now()}`;
  };

  const formatSize = (bytes: number | null) => {
    if (bytes === null) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays} days ago`;
      return d.toLocaleDateString();
    } catch { return null; }
  };

  if (loading) {
    return (
      <div className={styles.root}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
          <Spinner label="Scanning workspace for PCF controls..." />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>PCF Workbench</div>
        <div className={styles.headerSubtitle}>
          {visibleControls.length} controls found in workspace{privateCount > 0 && !showPrivate ? ` (${privateCount} private hidden)` : ''}
        </div>
      </div>

      <div className={styles.toolbar}>
        <Input
          size="medium"
          placeholder="Search controls..."
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          contentBefore={<Search24Regular />}
          style={{ flex: 1, maxWidth: 400 }}
        />
        <div className={styles.statsBar}>
          <span>{builtCount} built</span>
          <span>{virtualCount} virtual</span>
          <span>{visibleControls.length - builtCount} unbuilt</span>
        </div>
        {privateCount > 0 && (
          <Tooltip content={`${showPrivate ? 'Hide' : 'Show'} ${privateCount} private control${privateCount > 1 ? 's' : ''}`} relationship="label">
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
              <EyeOff24Regular style={{ fontSize: 16 }} />
              <Switch
                checked={showPrivate}
                onChange={(_, d) => setShowPrivate(d.checked)}
                label={`${privateCount} private`}
                style={{ fontSize: '12px' }}
              />
            </div>
          </Tooltip>
        )}
        <Button
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={loadControls}
          title="Rescan workspace"
        />
      </div>

      {error && (
        <div style={{ padding: '16px 40px' }}>
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        </div>
      )}

      <div className={styles.grid}>
        {filtered.map(c => {
          const thumb = thumbnailUrl(c);
          const buildDate = formatDate(c.lastModified);
          const boundProps = c.properties.filter(p => p.usage === 'bound');
          const inputProps = c.properties.filter(p => p.usage === 'input');

          return (
            <div
              key={`${c.namespace}.${c.constructor}`}
              className={`${styles.card} ${!c.hasBuild ? styles.cardDisabled : ''}`}
              onClick={() => handleOpen(c)}
            >
              {/* Thumbnail */}
              <div className={styles.thumbnail}>
                {thumb ? (
                  <img src={thumb} className={styles.thumbnailImg} alt={c.constructor} />
                ) : (
                  <Tooltip
                    content={c.hasBuild
                      ? `Add a thumbnail.gif, .jpg, or .png to the control directory to show a preview here`
                      : 'Run npm run build in the control project first'}
                    relationship="description"
                  >
                    <div className={styles.thumbnailPlaceholder}>
                      <div className={styles.placeholderIcon}>
                        {c.controlType === 'virtual' ? '\u269B' : '\u2B1A'}
                      </div>
                      <span>{c.hasBuild ? 'No thumbnail yet' : 'Not built'}</span>
                    </div>
                  </Tooltip>
                )}
              </div>

              {/* Body */}
              <div className={styles.cardBody}>
                <div className={styles.cardTitle}>{c.constructor}</div>
                <div className={styles.cardNamespace}>{c.namespace} v{c.version}</div>

                {/* Badges */}
                <div className={styles.cardBadges}>
                  {c.isPrivate && <Badge appearance="filled" color="warning" size="small">private</Badge>}
                  <Badge
                    appearance="filled"
                    color={c.controlType === 'virtual' ? 'important' : 'informative'}
                    size="small"
                  >
                    {c.controlType}
                  </Badge>
                  {c.hasBuild
                    ? <Badge appearance="filled" color="success" size="small">built</Badge>
                    : <Badge appearance="outline" color="danger" size="small">not built</Badge>
                  }
                  {c.featureUsage.map(f => (
                    <Badge key={f.name} appearance="outline" size="small">{f.name}</Badge>
                  ))}
                  {c.platformLibraries.map(l => (
                    <Badge key={l.name} appearance="tint" size="small" color="brand">
                      {l.name} {l.version}
                    </Badge>
                  ))}
                  {c.hasDataJson && <Badge appearance="outline" color="success" size="small">data.json</Badge>}
                  {c.hasTestScenarios && <Badge appearance="outline" color="brand" size="small">test scenarios</Badge>}
                </div>

                {/* Properties summary */}
                <div className={styles.cardProperties}>
                  {boundProps.map(p => p.name).join(', ')}
                  {inputProps.length > 0 && ` + ${inputProps.length} input`}
                </div>

                {/* Meta */}
                <div className={styles.cardMeta}>
                  <span>{c.properties.length} props</span>
                  {c.cssCount > 0 && <span>{c.cssCount} CSS</span>}
                  {buildDate && <span>Built: {buildDate}</span>}
                  {c.bundleSize !== null && (
                    <span title={`Bundle: ${formatSize(c.bundleSize)} | Package: ${formatSize(c.packageSize)}`}
                      style={{ fontWeight: c.bundleSize > 500 * 1024 ? 600 : 'normal', color: c.bundleSize > 500 * 1024 ? '#d13438' : c.bundleSize > 200 * 1024 ? '#ffaa44' : undefined }}>
                      {formatSize(c.packageSize)}
                    </span>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className={styles.cardFooter}>
                <span style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>
                  {c.descriptionKey.length > 60 ? c.descriptionKey.slice(0, 60) + '...' : c.descriptionKey}
                </span>
                {c.hasBuild && (
                  <Button
                    appearance="primary"
                    size="small"
                    icon={<Open24Regular />}
                    onClick={(e) => { e.stopPropagation(); handleOpen(c); }}
                  >
                    Open
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: 40, color: tokens.colorNeutralForeground3 }}>
          {search ? `No controls matching "${search}"` : 'No PCF controls found in workspace'}
        </div>
      )}
    </div>
  );
}
