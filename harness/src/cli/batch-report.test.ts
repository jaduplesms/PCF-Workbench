import { buildBatchReport, toBatchSummaryMarkdown, type BatchScenarioResult } from './batch-report';

function scenario(overrides: Partial<BatchScenarioResult> = {}): BatchScenarioResult {
  return {
    scenario: 'Default',
    outputDir: '/out/default',
    reportPath: '/out/default/report.json',
    screenshotPath: '/out/default/screenshot.png',
    status: 'pass',
    headline: 'ok',
    visual: {
      baselinePath: '/baseline/default.png',
      compared: true,
      updatedBaseline: false,
      diffRatio: 0,
      threshold: 0.005,
      diffPath: null,
      regression: false,
      error: null,
    },
    ...overrides,
  };
}

describe('buildBatchReport', () => {
  it('counts passes, failures, and visual regressions', () => {
    const report = buildBatchReport({
      controlPath: '/ctrl',
      outDir: '/out',
      baselineDir: '/baseline',
      thresholds: { diffThreshold: 0.005 },
      scenarios: [
        scenario({ scenario: 'A' }),
        scenario({ scenario: 'B', visual: { ...scenario().visual, regression: true, diffRatio: 0.02, diffPath: '/out/b/diff.png' } }),
        scenario({ scenario: 'C', status: 'fail' }),
      ],
    });
    expect(report.summary.total).toBe(3);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(2);
    expect(report.summary.visualRegressions).toBe(1);
    expect(report.scenarios.map(s => s.scenario)).toEqual(['A', 'B', 'C']);
  });
});

describe('toBatchSummaryMarkdown', () => {
  it('reports all-clear when nothing needs attention', () => {
    const report = buildBatchReport({
      controlPath: '/ctrl',
      outDir: '/out',
      baselineDir: '/baseline',
      thresholds: { diffThreshold: 0.005 },
      scenarios: [scenario({ scenario: 'A' })],
    });
    const md = toBatchSummaryMarkdown(report);
    expect(md).toContain('✅ batch passed');
    expect(md).toContain('All scenarios passed with no visual regressions.');
  });

  it('surfaces a baseline-missing scenario even when the run passed', () => {
    const report = buildBatchReport({
      controlPath: '/ctrl',
      outDir: '/out',
      baselineDir: '/baseline',
      thresholds: { diffThreshold: 0.005 },
      scenarios: [
        scenario({
          scenario: 'FreshScenario',
          status: 'pass',
          visual: {
            baselinePath: null,
            compared: false,
            updatedBaseline: false,
            diffRatio: null,
            threshold: null,
            diffPath: null,
            regression: false,
            error: 'baseline missing: /baseline/freshscenario.png',
          },
        }),
      ],
    });
    const md = toBatchSummaryMarkdown(report);
    expect(md).toContain('| FreshScenario | pass | baseline missing');
    expect(md).not.toContain('All scenarios passed');
  });
});
