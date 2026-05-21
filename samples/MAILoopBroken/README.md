# MAILoopBroken — deliberately broken PCF for the AI loop demo

This is a **deliberately broken** PCF control used as the WARN/FAIL
fixture for the
[MAI Loop Demo](../MAILoopDemo/README.md). Do not use it as a starter
template — it intentionally leaks resources and crashes during render.

## What's wrong with it

| Bug | Location | Symptom |
| --- | --- | --- |
| `setInterval` never cleared | `MAILoopBroken/index.ts` (`init`) | `report.leaks` includes `timer — setInterval(1000ms) not cleared`. |
| `window.addEventListener('resize')` never removed | `MAILoopBroken/index.ts` (`init`) | `report.leaks` includes `eventListener — window.addEventListener("resize") not removed`. |
| Undefined-prop deref in render | `MAILoopBroken/HelloWorld.tsx` (`render`) | `pageErrors[0]` = `"Cannot read properties of undefined (reading 'value')"`, control fails to render. |

`destroy()` is intentionally empty — it should clear the interval and
remove the listener.

## Build it

```bash
cd samples/MAILoopBroken
npm install
npm run build
```

## Run the loop against it

```bash
cd ../../harness
npm run harness -- loop \
  --path ../samples/MAILoopBroken/MAILoopBroken \
  --out ../samples/MAILoopDemo/out-fail \
  --skip-build
```

Expected: `[summary] FAIL — control did not render` (exit code `1`),
with the four leaks above plus the render crash. To capture a WARN
instead, comment out the `crashMe!.value` line in `HelloWorld.tsx` and
rebuild — render succeeds but the leaks remain.

## Why it lives in-tree

Without this fixture the loop's leak/error detection is unverifiable
end-to-end. Shipping a real broken control means every loop change
gets tested against both the happy path (`ConformanceTester`) and the
sad path (this).
