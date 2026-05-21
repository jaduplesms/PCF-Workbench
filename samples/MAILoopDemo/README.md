# MAI Loop Demo — worked examples

This folder is a tutorial fixture for the
[AI-Assisted PCF Build Loop](../../harness/docs/ai-build-loop.md). It
ships **three real reports** captured from `pcf-harness loop` runs:

| Status | Report | Screenshot | Source control |
| --- | --- | --- | --- |
| `pass` | `report-pass-conformance.json` | `screenshot-pass-conformance.png` | [`ConformanceTester`](../ConformanceTester/) — a clean control that exercises every shim surface. |
| `warn` | `report-warn-leaks.json` | `screenshot-warn.png` | [`MAILoopBroken`](../MAILoopBroken/) with the render bug commented out — leaves the two leaks intact. |
| `fail` | `report-fail-render.json` | `screenshot-fail.png` | [`MAILoopBroken`](../MAILoopBroken/) as-shipped — render crash *and* leaks. |

`MAILoopBroken` is deliberately broken: it registers a `setInterval`
and a `window` resize listener in `init()` that `destroy()` never
cleans up, and its `render()` dereferences an undefined prop. The loop
must catch all of it.

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

Diff `out/report.json` against `report-pass-conformance.json`:

| Field | Expected | Tolerance |
| --- | --- | --- |
| `summary.status` | `pass` | exact |
| `summary.errors` | `0` | exact |
| `harness.ok` | `true` | exact |
| `harness.report.lifecycle.initCalled` | `true` | exact |
| `harness.report.performance.renderCount` | `1` | ±0 |
| `harness.consoleErrors.length` | `0` | exact |
| `harness.pageErrors.length` | `0` | exact |

If anything in the **exact** rows drifts, you've found a regression.

---

## Reproducing the FAIL exhibit

```bash
cd samples/MAILoopBroken
npm install
npm run build
cd ../../harness
npm run harness -- loop \
  --path ../samples/MAILoopBroken/MAILoopBroken \
  --out ../samples/MAILoopDemo/out-fail \
  --skip-build
```

Expected last lines:

```
  [summary] FAIL — control did not render
```

The report (compare to `report-fail-render.json`) will contain:

- `summary.status = "fail"`, `summary.errors = 3` (one `pageError`,
  two matching `consoleErrors`)
- `harness.pageErrors[0]` =
  `"Cannot read properties of undefined (reading 'value')"`
- `harness.report.leaks` (4 entries):
  - `eventListener — window.addEventListener("resize") not removed`
  - `timer — setInterval(1000ms) not cleared`
  - `observer — ResizeObserver.disconnect() not called`
  - `observer — MutationObserver.disconnect() not called`

### How an agent should read this

1. `summary.status = fail` → must act.
2. `summary.errors > 0` and `pageErrors[0]` names the throw — open the
   control's `render()`, find the `undefined.value` access (`crashMe!.value`).
3. `lifecycle.events[1].error` confirms the throw happened during the
   first `updateView`, not later.
4. Each `leaks[]` entry maps directly to an unclean resource — audit
   `destroy()` for matching `clearInterval` / `removeEventListener`
   /`disconnect()` calls.
5. Apply the smallest fixes (guard the property access; stash the
   `setInterval` id and clear it in destroy; remove the resize
   listener; disconnect observers).
6. Re-run the loop. Expect `status = pass` if the diagnosis was right.

---

## Reproducing the WARN exhibit

`warn` means render succeeded with no console errors **but** at least
one resource leak was detected. To capture this from `MAILoopBroken`,
temporarily disable the render bug in
`samples/MAILoopBroken/MAILoopBroken/HelloWorld.tsx` (comment out the
`crashMe!.value` line), rebuild, then re-run the loop. You'll get the
same leak inventory minus the observers that the React unmount path
clears once render succeeds:

```
  [summary] WARN — 3 resource leak(s)
```

`warn` returns exit code `1` — CI must treat it as a hard fail. A
control that leaks today is a perf bug tomorrow.

---

## Related

- Loop walkthrough: [`harness/docs/ai-build-loop.md`](../../harness/docs/ai-build-loop.md)
- Report schema:    [`harness/docs/ai-loop-report.schema.json`](../../harness/docs/ai-loop-report.schema.json)
- Drop-in skill:    [`harness/docs/ai-loop-skill.md`](../../harness/docs/ai-loop-skill.md)
- Broken fixture:   [`samples/MAILoopBroken/`](../MAILoopBroken/)
