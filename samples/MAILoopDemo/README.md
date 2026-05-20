# MAI Loop Demo — worked example

This folder is a tutorial fixture for the
[AI-Assisted PCF Build Loop](../../harness/docs/ai-build-loop.md). It
shows what a clean `pcf-harness loop` report looks like against a
working control, and walks through what an agent should do when the
report regresses.

The "pass" exhibit is generated from the in-tree
[`ConformanceTester`](../ConformanceTester/) sample — a real PCF that
exercises every shim surface the harness provides. The "fail" /
"warn" exhibits are illustrative.

> Why illustrative and not literal? The MAI milestone (Chunk 2) ships
> the worked-example narrative + the live PASS fixture. A literal
> deliberately-broken in-tree control follows in a later chunk
> (`mai-loop-broken-fixture`) — it requires its own `pac pcf init` +
> sources, which we deferred to keep this milestone focused on the
> loop CLI + docs.

---

## Files

| File | What |
| --- | --- |
| `report-pass-conformance.json` | Real report from `npx pcf-harness loop --path ../ConformanceTester/ConformanceTester --skip-build`. `summary.status = pass`. |
| `screenshot-pass-conformance.png` | Full-page Playwright screenshot captured during that run. |

---

## Reproducing the PASS exhibit

Prerequisite: build ConformanceTester once.

```bash
cd samples/ConformanceTester
npm install
npm run build
```

Then run the loop from the harness:

```bash
cd harness
npm run harness -- loop \
  --path ../samples/ConformanceTester/ConformanceTester \
  --out ../samples/MAILoopDemo/out \
  --skip-build
```

Expected output (last two lines):

```
  [summary] PASS — control rendered cleanly
  [report]  .../samples/MAILoopDemo/out/report.json
```

Compare your fresh `out/report.json` against
`report-pass-conformance.json`. The following should match exactly or
within a small tolerance:

| Field | Expected | Tolerance |
| --- | --- | --- |
| `summary.status` | `pass` | exact |
| `summary.errors` | `0` | exact |
| `summary.leaks` | `0` | exact |
| `harness.ok` | `true` | exact |
| `harness.report.lifecycle.initCalled` | `true` | exact |
| `harness.report.lifecycle.events.length` | `2` (init + updateView) | ±0 |
| `harness.report.performance.renderCount` | `1` | ±0 |
| `harness.report.performance.avgRenderTimeMs` | `≈28 ms` | ±50% |
| `harness.report.lifecycle.firstUpdateViewMs` | `≈50 ms` | ±100% |
| `harness.report.leaks.length` | `0` | exact |
| `harness.report.webApi.totalCalls` | `0` | exact |
| `harness.consoleErrors.length` | `0` | exact |
| `harness.pageErrors.length` | `0` | exact |

If anything in the **exact** rows drifts, you've found a regression.

---

## Illustrative FAIL report

This is what an agent would see if a control's `destroy()` forgot to
remove a `resize` event listener and threw on its first `updateView`:

```jsonc
{
  "schemaVersion": 1,
  "runId": "loop-fail-example",
  "summary": {
    "status": "fail",
    "headline": "1 console/page error(s)",
    "errors": 1,
    "leaks": 1
  },
  "build": { "ok": true, "skipped": false, "durationMs": 6800, "errors": [] },
  "harness": {
    "ok": true,
    "url": "http://127.0.0.1:8181/",
    "consoleErrors": [],
    "pageErrors": [
      "TypeError: Cannot read properties of undefined (reading 'value')"
    ],
    "report": {
      "lifecycle": {
        "initCalled": true,
        "firstUpdateViewMs": 42,
        "events": [
          { "method": "init",       "durationMs": 5.1,  "timestamp": 1716200000000 },
          { "method": "updateView", "durationMs": 12.3, "timestamp": 1716200000042,
            "error": "TypeError: Cannot read properties of undefined (reading 'value')" }
        ]
      },
      "leaks": [
        { "type": "eventListener",
          "detail": "resize listener registered in init() but not removed in destroy()" }
      ],
      "webApi":  { "totalCalls": 0, "errorCount": 0, "calls": [] },
      "logs":    { "recent": [], "unimplementedCount": 0 }
    }
  }
}
```

### How an agent should read this

1. `summary.status = fail` → must act.
2. `summary.errors = 1` and `pageErrors[0]` names the throw — open the
   control's `updateView()`, locate the `undefined.value` access.
3. `lifecycle.events[1].error` confirms the throw happened during the
   first `updateView`, not later.
4. `leaks[0].type = eventListener` → audit `destroy()` for matching
   `removeEventListener('resize', ...)`.
5. Apply the smallest fix (typically: guard the property access in
   `updateView`; ensure the listener handle is stashed and removed in
   `destroy`).
6. Re-run the loop. Expect `status = pass` if the diagnosis was right.

---

## Illustrative WARN report

`warn` means render succeeded with no console errors **but** at least
one resource leak was detected:

```jsonc
{
  "schemaVersion": 1,
  "summary": { "status": "warn", "headline": "2 resource leak(s)", "errors": 0, "leaks": 2 },
  "harness": {
    "ok": true,
    "report": {
      "leaks": [
        { "type": "timer",        "detail": "setInterval id=4 (10000ms) not cleared in destroy()" },
        { "type": "observer",     "detail": "MutationObserver instance #1 not disconnected" }
      ]
    }
  }
}
```

`warn` returns exit code `1` — CI must treat it as a hard fail. A
control that leaks today is a perf bug tomorrow.

---

## Related

- Loop walkthrough: [`harness/docs/ai-build-loop.md`](../../harness/docs/ai-build-loop.md)
- Report schema:    [`harness/docs/ai-loop-report.schema.json`](../../harness/docs/ai-loop-report.schema.json)
- Drop-in skill:    [`harness/docs/ai-loop-skill.md`](../../harness/docs/ai-loop-skill.md)
