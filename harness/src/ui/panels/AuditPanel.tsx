import { useCallback, useEffect, useMemo, useState } from 'react';
import { makeStyles, tokens, Button, Badge, Spinner, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { ArrowClockwise24Regular } from '@fluentui/react-icons';
import { useHarnessStore } from '../../store/harness-store';
import type { ManifestConfig } from '../../types/manifest';

type AuditSeverity = 'info' | 'warn' | 'error';
type AuditStatus = 'pass' | 'warn' | 'error' | 'ignored';

interface AuditRuleResult {
  id: string;
  title: string;
  severity: AuditSeverity;
  status: AuditStatus;
  message: string;
  details?: string[];
}

interface AuditConfig {
  ignoreRules?: string[];
  bundleSizeWarningBytes?: number;
  bannedApiAllowList?: string[];
}

const DEFAULT_BUNDLE_WARN_BYTES = 750 * 1024;

const useStyles = makeStyles({
  root: {
    padding: '12px',
    boxSizing: 'border-box',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  summary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: '8px',
  },
  stat: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  statLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  statValue: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  row: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  rowHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  rowTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  rowMessage: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  details: {
    margin: 0,
    paddingLeft: '18px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
});

interface Props {
  manifest: ManifestConfig;
  bundlePath: string;
  cssFiles: string[];
}

export function AuditPanel({ manifest, bundlePath, cssFiles }: Props) {
  const styles = useStyles();
  const reloadEpoch = useHarnessStore(s => s.reloadEpoch);
  const leaks = useHarnessStore(s => s.resourceLeaks);
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<AuditRuleResult[]>([]);
  const [config, setConfig] = useState<AuditConfig>({});

  const runAudit = useCallback(async () => {
    setLoading(true);
    try {
      const loadedConfig = await loadAuditConfig();
      const ignore = new Set(loadedConfig.ignoreRules ?? []);
      const results: AuditRuleResult[] = [];

      const bundleText = await loadBundleText(bundlePath);
      const bundleBytes = new TextEncoder().encode(bundleText).byteLength;
      const cssTexts = await Promise.all(cssFiles.map(loadTextSafe));

      results.push(applyIgnore({
        id: 'bundle.size',
        title: 'Bundle size budget',
        severity: 'warn',
        status: bundleBytes > (loadedConfig.bundleSizeWarningBytes ?? DEFAULT_BUNDLE_WARN_BYTES) ? 'warn' : 'pass',
        message: bundleBytes > (loadedConfig.bundleSizeWarningBytes ?? DEFAULT_BUNDLE_WARN_BYTES)
          ? `Bundle is ${(bundleBytes / 1024).toFixed(1)} KB (budget ${(loadedConfig.bundleSizeWarningBytes ?? DEFAULT_BUNDLE_WARN_BYTES) / 1024} KB).`
          : `Bundle is ${(bundleBytes / 1024).toFixed(1)} KB.`,
      }, ignore));

      const bannedApiHits = collectBannedApiHits(bundleText, loadedConfig.bannedApiAllowList ?? []);
      for (const hit of bannedApiHits) {
        results.push(applyIgnore({
          id: `banned-api.${hit.token}`,
          title: `Banned API check: ${hit.token}`,
          severity: 'warn',
          status: hit.count > 0 ? 'warn' : 'pass',
          message: hit.count > 0
            ? `Detected ${hit.count} "${hit.token}" reference(s) in the compiled bundle. Note: matches include bundled dependencies, so some hits may originate from third-party code rather than your control source.`
            : `No "${hit.token}" references detected.`,
        }, ignore));
      }

      const cssFindings = collectCssScopeFindings(cssTexts);
      results.push(applyIgnore({
        id: 'css.global-selector',
        title: 'CSS scoping check',
        severity: 'warn',
        status: cssFindings.length > 0 ? 'warn' : 'pass',
        message: cssFindings.length > 0
          ? `Detected ${cssFindings.length} potentially-global selector(s). These are heuristic matches from the compiled CSS and may include framework or dependency styles.`
          : 'No obvious global selectors detected.',
        details: cssFindings.slice(0, 8),
      }, ignore));

      const manifestFindings = collectManifestFindings(manifest);
      for (const finding of manifestFindings) {
        results.push(applyIgnore(finding, ignore));
      }

      results.push(applyIgnore(buildLeakRule(leaks), ignore));

      const axeRule = await runAxeAudit();
      results.push(applyIgnore(axeRule, ignore));

      setConfig(loadedConfig);
      setRules(results);
    } finally {
      setLoading(false);
    }
  }, [bundlePath, cssFiles, leaks, manifest]);

  useEffect(() => {
    runAudit().catch(() => {
      setLoading(false);
      setRules([
        {
          id: 'audit.runtime',
          title: 'Audit execution',
          severity: 'error',
          status: 'error',
          message: 'Audit run failed. Check browser console for details.',
        },
      ]);
    });
  }, [runAudit, reloadEpoch]);

  const summary = useMemo(() => {
    return {
      error: rules.filter(r => r.status === 'error').length,
      warn: rules.filter(r => r.status === 'warn').length,
      pass: rules.filter(r => r.status === 'pass').length,
      ignored: rules.filter(r => r.status === 'ignored').length,
    };
  }, [rules]);

  return (
    <div className={styles.root} data-test-id="audit-panel">
      <div className={styles.header}>
        <span className={styles.title}>Audit</span>
        <Button appearance="subtle" size="small" icon={<ArrowClockwise24Regular />} onClick={() => runAudit()}>
          Re-run
        </Button>
      </div>

      <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
        Rules can be ignored via <code>.pcf-audit.json</code> (<code>ignoreRules</code>).
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner size="tiny" />
          <span style={{ fontSize: tokens.fontSizeBase200 }}>Running checks…</span>
        </div>
      )}

      {!loading && summary.error === 0 && summary.warn === 0 && (
        <MessageBar intent="success">
          <MessageBarBody>All enabled audit checks passed.</MessageBarBody>
        </MessageBar>
      )}

      {!loading && summary.error > 0 && (
        <MessageBar intent="error">
          <MessageBarBody>{summary.error} error check(s) failed.</MessageBarBody>
        </MessageBar>
      )}

      {!loading && summary.error === 0 && summary.warn > 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>{summary.warn} warning check(s) found.</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.summary}>
        <div className={styles.stat}><span className={styles.statLabel}>Errors</span><span className={styles.statValue}>{summary.error}</span></div>
        <div className={styles.stat}><span className={styles.statLabel}>Warnings</span><span className={styles.statValue}>{summary.warn}</span></div>
        <div className={styles.stat}><span className={styles.statLabel}>Passed</span><span className={styles.statValue}>{summary.pass}</span></div>
        <div className={styles.stat}><span className={styles.statLabel}>Ignored</span><span className={styles.statValue}>{summary.ignored}</span></div>
      </div>

      {config.bundleSizeWarningBytes && (
        <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
          Bundle warning budget: {(config.bundleSizeWarningBytes / 1024).toFixed(0)} KB
        </div>
      )}

      <div className={styles.list}>
        {rules.map(rule => (
          <div key={rule.id} className={styles.row}>
            <div className={styles.rowHead}>
              <span className={styles.rowTitle}>{rule.title}</span>
              <Badge color={badgeColorFor(rule.status)}>{rule.status.toUpperCase()}</Badge>
            </div>
            <div className={styles.rowMessage}>{rule.message}</div>
            {rule.details && rule.details.length > 0 && (
              <ul className={styles.details}>
                {rule.details.map((d, idx) => <li key={`${rule.id}-${idx}`}>{d}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function badgeColorFor(status: AuditStatus): 'danger' | 'warning' | 'success' | 'informative' {
  if (status === 'error') return 'danger';
  if (status === 'warn') return 'warning';
  if (status === 'ignored') return 'informative';
  return 'success';
}

function applyIgnore(rule: AuditRuleResult, ignore: Set<string>): AuditRuleResult {
  if (ignore.has(rule.id)) {
    return {
      ...rule,
      status: 'ignored',
      message: `${rule.message} (ignored by config)`,
    };
  }
  return rule;
}

async function loadAuditConfig(): Promise<AuditConfig> {
  const res = await fetch('/pcf-data/.pcf-audit.json', { cache: 'no-cache' });
  if (!res.ok) return {};
  const raw = await res.json().catch(() => ({}));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    ignoreRules: Array.isArray((raw as any).ignoreRules)
      ? (raw as any).ignoreRules.filter((v: unknown): v is string => typeof v === 'string')
      : undefined,
    bundleSizeWarningBytes: typeof (raw as any).bundleSizeWarningBytes === 'number'
      ? (raw as any).bundleSizeWarningBytes
      : undefined,
    bannedApiAllowList: Array.isArray((raw as any).bannedApiAllowList)
      ? (raw as any).bannedApiAllowList.filter((v: unknown): v is string => typeof v === 'string')
      : undefined,
  };
}

async function loadBundleText(bundlePath: string): Promise<string> {
  const response = await fetch(bundlePath, { cache: 'no-cache' });
  if (!response.ok) return '';
  return response.text();
}

async function loadTextSafe(url: string): Promise<string> {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return '';
    return r.text();
  } catch {
    return '';
  }
}

function countToken(source: string, pattern: RegExp): number {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

function collectBannedApiHits(bundleText: string, allowList: string[]) {
  const allowed = new Set(allowList);
  const checks = [
    { token: 'localStorage', re: /\blocalStorage\b/g },
    { token: 'sessionStorage', re: /\bsessionStorage\b/g },
    { token: 'documentCookie', re: /\bdocument\.cookie\b/g },
  ];
  return checks.map(c => ({
    token: c.token,
    count: allowed.has(c.token) ? 0 : countToken(bundleText, c.re),
  }));
}

function collectCssScopeFindings(cssTexts: string[]): string[] {
  const findings: string[] = [];
  for (const css of cssTexts) {
    if (!css) continue;
    const blocks = css.split('{');
    for (let i = 0; i < blocks.length - 1; i++) {
      const selectorChunk = blocks[i].trim();
      const selectors = selectorChunk.split(',').map(s => s.trim());
      for (const selector of selectors) {
        if (!selector) continue;
        if (
          selector.startsWith('body') ||
          selector.startsWith('html') ||
          selector.startsWith(':root') ||
          selector === '*' ||
          /^[a-z][a-z0-9-]*$/i.test(selector)
        ) {
          findings.push(selector);
        }
      }
    }
  }
  return [...new Set(findings)];
}

function collectManifestFindings(manifest: ManifestConfig): AuditRuleResult[] {
  const findings: AuditRuleResult[] = [];
  const boundProps = manifest.properties.filter(p => p.usage === 'bound');
  findings.push({
    id: 'manifest.bound-property-name',
    title: 'Manifest bound property naming',
    severity: 'info',
    status: 'pass',
    message: boundProps.length === 0
      ? 'No bound properties declared.'
      : boundProps.some(p => p.name === 'value')
        ? `Bound properties are [${boundProps.map(p => p.name).join(', ')}]. "value" is present (common convention).`
        : `Bound properties are [${boundProps.map(p => p.name).join(', ')}]. Naming is valid; "value" is optional convention only.`,
  });

  const versionRuleId = `pcfwb.audit.version.${manifest.namespace}.${manifest.constructor}`;
  let versionMessage = 'Version changed since last local audit run.';
  let versionStatus: AuditStatus = 'pass';
  try {
    const last = localStorage.getItem(versionRuleId);
    if (last && last === manifest.version) {
      versionStatus = 'warn';
      versionMessage = `Manifest version is still ${manifest.version}. Bump version before packaging changes.`;
    }
    localStorage.setItem(versionRuleId, manifest.version);
  } catch {
    versionMessage = 'Version check unavailable (localStorage not accessible).';
    versionStatus = 'pass';
  }
  findings.push({
    id: 'manifest.version-bump',
    title: 'Manifest version bump',
    severity: 'warn',
    status: versionStatus,
    message: versionMessage,
  });

  findings.push({
    id: 'manifest.feature-usage',
    title: 'Manifest feature usage declarations',
    severity: 'info',
    status: manifest.featureUsage.length === 0 ? 'warn' : 'pass',
    message: manifest.featureUsage.length === 0
      ? 'No <feature-usage> declarations found. Add explicit features for clarity and compatibility checks.'
      : `Feature usage declared: ${manifest.featureUsage.map(f => f.name).join(', ')}.`,
  });

  return findings;
}

function buildLeakRule(leaks: { type: string; detail: string }[]): AuditRuleResult {
  if (!Array.isArray(leaks) || leaks.length === 0) {
    return {
      id: 'resource-leaks.severity',
      title: 'Resource cleanup severity',
      severity: 'warn',
      status: 'pass',
      message: 'No resource leaks detected.',
    };
  }
  const byType = leaks.reduce<Record<string, number>>((acc, leak) => {
    acc[leak.type] = (acc[leak.type] ?? 0) + 1;
    return acc;
  }, {});
  const level: AuditStatus = leaks.length >= 5 ? 'error' : 'warn';
  return {
    id: 'resource-leaks.severity',
    title: 'Resource cleanup severity',
    severity: 'warn',
    status: level,
    message: `${leaks.length} leak(s) detected.`,
    details: Object.entries(byType).map(([type, count]) => `${type}: ${count}`),
  };
}

async function runAxeAudit(): Promise<AuditRuleResult> {
  const target = document.querySelector('[data-test-id="pcf-control-container"]');
  if (!target) {
    return {
      id: 'a11y.axe',
      title: 'Accessibility audit (axe-core)',
      severity: 'warn',
      status: 'warn',
      message: 'Control container not found for accessibility scan.',
    };
  }
  try {
    const axe = await import('axe-core');
    const result = await axe.run(target, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    const count = result.violations.length;
    return {
      id: 'a11y.axe',
      title: 'Accessibility audit (axe-core)',
      severity: 'warn',
      status: count > 0 ? 'warn' : 'pass',
      message: count > 0
        ? `${count} accessibility violation(s) detected.`
        : 'No axe-core violations detected.',
      details: result.violations.slice(0, 8).map(v => `${v.id}: ${v.help}`),
    };
  } catch (error: any) {
    return {
      id: 'a11y.axe',
      title: 'Accessibility audit (axe-core)',
      severity: 'warn',
      status: 'warn',
      message: `axe-core scan failed: ${error?.message ?? String(error)}`,
    };
  }
}
