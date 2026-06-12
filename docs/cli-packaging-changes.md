# PCF Workbench — CLI & npm Packaging Improvements

## Goal

Make PCF Workbench runnable from **any folder on the file system** without needing to `cd` into the harness directory or set environment variables manually before each run.

---

## What Was Changed

### 1. `harness/bin/pcf-harness.ts` — CLI entrypoint

**Before**

- `start` command required `--path <dir>` (mandatory option)
- Only supported single-control mode — always set `PCF_CONTROL_PATH`
- Workspace/gallery mode was only reachable via raw `$env:PCF_WORKSPACE_ROOT` env var

**After**

- Both `start` and `loop` accept an optional positional `[path]` argument
- `--path` is now an optional flag with the same meaning as the positional (kept for backward compatibility)
- If no path is provided, the current working directory is used as the default
- **Auto-detection**: if the resolved path contains a `ControlManifest.Input.xml` (or `.xml`), it starts in single-control mode; otherwise it starts in workspace/gallery mode
- The correct environment variable is set automatically (`PCF_CONTROL_PATH` or `PCF_WORKSPACE_ROOT`); the other is cleared so there's no stale state
- Startup output now shows the detected mode and resolved path

**Backward compatibility**: existing scripts using `pcf-harness --path /my/control` continue to work unchanged.

### 2. `harness/package.json` — npm publish metadata

Added fields required for a well-formed npm package:

| Field            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `engines`        | `node >= 18`                                                              |
| `repository`     | GitHub repo URL                                                           |
| `homepage`       | README URL                                                                |
| `bugs`           | GitHub issues URL                                                         |
| `keywords`       | pcf, power-apps, power-platform, dataverse, dev-tools, …                  |
| `files`          | `bin/`, `src/`, `public/`, `index.html`, `vite.config.ts`, tsconfig files |
| `prepublishOnly` | Runs typecheck + build before publish                                     |

`tsx` was moved from `devDependencies` to `dependencies`. The `bin/pcf-harness.js` shim delegates to `pcf-harness.ts` at runtime via `tsx` (rather than pre-compiling to JS), so `tsx` must be present in the installed package.

### 3. `harness/.npmignore` — publish exclusions

Created to exclude from the published package:

- `tests/` and `__visual__/` (Playwright specs and screenshots)
- `scripts/` (gallery-builder dev utilities)
- `docs/` (internal design notes)
- `*.tsbuildinfo` (transient build artifacts)
- `playwright.config.ts`

### 4. `README.md` — updated Quick Start

Added a new "Start with the CLI" section before the legacy env-var instructions that shows:

- Running with no arguments (cwd default)
- Passing an explicit path (positional or `--path`)
- Optional `npm link` for global installation

---

## How to Use After This Change

### From the harness folder (development)

```powershell
cd PCF-Workbench\harness

# Current folder as workspace (gallery mode)
npm run harness

# Explicit path — workspace or single control, auto-detected
npm run harness -- start C:\path\to\my\pcf-workspace
npm run harness -- start C:\path\to\MyControl\MyControl
```

### Global command via npm link (local dev install)

```powershell
cd PCF-Workbench\harness
npm link

# Then from any folder:
pcf-harness                              # uses current folder
pcf-harness C:\path\to\pcf-workspace     # explicit path
pcf-harness --path C:\path\to\control    # --path still works
```

### Publishing to npm

```bash
cd harness
npm version patch   # or minor / major
npm publish         # prepublishOnly runs typecheck + build first
```

After publishing, users can run:

```bash
npx pcf-harness                         # uses current folder
npx pcf-harness C:\path\to\workspace    # explicit workspace
```

> **Note:** package name and bin command are both `pcf-harness` to avoid conflict with pre-existing npm package [`pcf-workbench`](https://www.npmjs.com/package/pcf-workbench).

---

## Architecture Note — Why Vite Dev Server, Not Static

The harness serves the React app via `createServer` from Vite (dev mode), not from a pre-built static folder. This means the full `src/` TypeScript source must be included in the published package so Vite can compile on the fly. This is intentional: it enables hot reload and keeps the package self-contained without a separate build step for users.
