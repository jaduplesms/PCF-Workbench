import path from 'node:path';

export interface BatchScenarioResult {
  scenario: string;
  outputDir: string;
  reportPath: string;
  screenshotPath: string | null;
  status: 'pass' | 'warn' | 'fail';
  headline: string;
  visual: {
    baselinePath: string | null;
    compared: boolean;
    updatedBaseline: boolean;
    diffRatio: number | null;
    threshold: number | null;
    diffPath: string | null;
    regression: boolean;
    error: string | null;
  };
}

export interface BatchReport {
  schemaVersion: 1;
  capturedAt: string;
  controlPath: string;
  outDir: string;
  baselineDir: string;
  thresholds: {
    diffThreshold: number;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    visualRegressions: number;
  };
  scenarios: BatchScenarioResult[];
}

export function buildBatchReport(input: Omit<BatchReport, 'schemaVersion' | 'capturedAt' | 'summary'>): BatchReport {
  const scenarios = [...input.scenarios].sort((a, b) => a.scenario.localeCompare(b.scenario));
  const summary = {
    total: scenarios.length,
    passed: scenarios.filter(s => s.status === 'pass' && !s.visual.regression).length,
    failed: scenarios.filter(s => s.status !== 'pass' || s.visual.regression).length,
    visualRegressions: scenarios.filter(s => s.visual.regression).length,
  };

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    controlPath: input.controlPath,
    outDir: input.outDir,
    baselineDir: input.baselineDir,
    thresholds: input.thresholds,
    summary,
    scenarios,
  };
}

export function toBatchSummaryMarkdown(report: BatchReport): string {
  const icon = report.summary.failed === 0 ? '✅' : '❌';
  const headline = `${icon} batch ${report.summary.failed === 0 ? 'passed' : 'failed'} — ${report.summary.total} scenario${report.summary.total === 1 ? '' : 's'} (${report.summary.passed} pass, ${report.summary.failed} fail, ${report.summary.visualRegressions} visual regression${report.summary.visualRegressions === 1 ? '' : 's'})`;
  const regressions = report.scenarios.filter(s => s.status !== 'pass' || s.visual.regression);

  if (regressions.length === 0) {
    return [headline, '', 'All scenarios passed with no visual regressions.'].join('\n');
  }

  const rows = regressions.map((r) => {
    const visual = r.visual.regression
      ? `regression ${(r.visual.diffRatio ?? 0).toFixed(4)} > ${(r.visual.threshold ?? 0).toFixed(4)}`
      : r.visual.error
        ? r.visual.error
        : 'ok';
    return `| ${escapePipe(r.scenario)} | ${r.status} | ${escapePipe(visual)} | ${escapePipe(path.relative(report.outDir, r.reportPath))} |`;
  });

  return [
    headline,
    '',
    '| Scenario | Runtime | Visual | Report |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, '\\|');
}
