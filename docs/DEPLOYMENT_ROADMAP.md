# PCF Workbench — Deployment Roadmap

## The Problem

Today, deploying a PCF control with its form configuration requires multiple disconnected steps:

1. Build the control (`npm run build`)
2. Push the binary (`pac pcf push`)
3. Manually configure the control on a form in the Power Apps maker
4. Bind each property to the correct column
5. Set static values and related field references
6. Export the solution
7. Import into test/production environments

The harness solves the **design and testing** part brilliantly — you can configure all properties, test with mock data, validate with real Dataverse metadata, and iterate rapidly. But there's no bridge from the harness to the live environment.

**The gap: your carefully designed configuration in the harness can't be deployed without manual form editing.**

---

## Phase 1: Export Configuration (MVP)

**Goal:** Design in the harness, export a deployable solution.

### What it does

A new "Export Solution" button in the harness that generates a Dataverse solution `.zip` containing:

1. **The PCF control bundle** (from `out/`)
2. **A form customization XML** that configures the control on a specified entity form with all property bindings

### How it works

1. User designs the card in the harness (binds columns, sets related fields, chooses layout)
2. User clicks "Export Solution" in a new **Deploy** panel
3. Harness prompts for:
   - **Publisher prefix** (e.g., `cli`)
   - **Target entity** (e.g., `bookableresourcebooking`)
   - **Target form name** (e.g., "Booking and Work Order")
   - **Solution name** (e.g., `InfoCardBookingForm`)
4. Harness generates:
   - `solution.xml` with solution metadata
   - `customizations.xml` with:
     - Control registration (`<control>` element)
     - Form XML with `<controlDescription>` binding each property to its column or static value
   - `[Content_Types].xml`
5. Downloads as a `.zip` — ready to import via `pac solution import`

### Technical approach

- Read the current property values from the harness store
- For `$columnName` values → generate `<property name="..." type="..." usage="bound">columnName</property>`
- For `@fieldName` values → generate `<property name="..." type="SingleLine.Text" usage="input" static="true">@fieldName</property>`
- For static values → generate `<property name="..." type="..." usage="input" static="true">value</property>`
- Wrap in the standard Dataverse solution XML structure
- Use JSZip or similar to create the `.zip` client-side

### Implementation location

- New panel in `HarnessShell.tsx`: **Deploy** tab (rocket icon)
- New module: `harness/src/export/solution-exporter.ts`
- Template files: `harness/src/export/templates/` (solution.xml, customizations.xml)

### Effort estimate

Medium — 3-5 days. Most work is generating correct form XML that Dynamics accepts.

---

## Phase 2: Direct Push from Harness

**Goal:** One-click deploy from harness to Dynamics environment.

### What it does

Two new buttons in the Deploy panel:

1. **Push Control** — runs `pac pcf push --publisher-prefix <prefix>` from the harness
2. **Push Configuration** — updates the target form in Dataverse via the Web API to add/configure the PCF control
3. **Push All** — does both in sequence

### How it works

1. User authenticates via PAC CLI (already configured from existing workflow)
2. **Push Control**: Harness runs `pac pcf push` using the project's `.pcfproj`
3. **Push Configuration**: Harness calls the Dataverse Web API to:
   - Retrieve the target form XML (`GET /api/data/v9.2/systemforms(...)`)
   - Modify the XML to add/update the PCF control binding
   - Update the form (`PATCH /api/data/v9.2/systemforms(...)`)
   - Publish customizations (`POST /api/data/v9.2/PublishAllXml`)
4. User sees real-time progress in the Deploy panel

### Technical approach

- Use PAC CLI for control push (via `child_process.exec` in the Vite plugin)
- Use Dataverse Web API for form updates (requires auth token — either from PAC CLI or browser session)
- Form XML manipulation using `fast-xml-parser` (already a dependency)
- Environment selection from `pac auth list`

### Prerequisites

- PAC CLI authenticated (`pac auth list` shows active profile)
- Target environment accessible
- User has System Customizer or System Administrator role

### Effort estimate

Large — 5-8 days. Form XML manipulation is complex, and auth token handling needs care.

---

## Phase 3: Full CI/CD Pipeline

**Goal:** Automated build, test, and deploy on every commit.

### What it does

GitHub Actions workflows that:

1. **On PR**: Build control → run tests → validate manifest → report bundle size
2. **On merge to main**: Build → package solution → deploy to dev environment
3. **On release tag**: Deploy to test → manual approval → deploy to production

### Pipeline components

#### GitHub Actions Workflow (`.github/workflows/pcf-deploy.yml`)

```yaml
name: PCF Deploy
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 18 }
      - run: npm ci
      - run: npm run build
      - run: npm test
      # Report bundle size as PR comment
      - uses: actions/github-script@v7
        if: github.event_name == 'pull_request'
        with:
          script: |
            const fs = require('fs');
            const size = fs.statSync('out/controls/.../bundle.js').size;
            github.rest.issues.createComment({
              ...context.repo, issue_number: context.issue.number,
              body: `Bundle size: ${(size/1024).toFixed(1)} KB`
            });

  deploy-dev:
    if: github.ref == 'refs/heads/main'
    needs: build
    runs-on: windows-latest
    environment: development
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      # Install PAC CLI
      - run: |
          dotnet tool install -g Microsoft.PowerApps.CLI.Tool
          pac auth create --url ${{ secrets.DATAVERSE_URL }} \
            --clientId ${{ secrets.CLIENT_ID }} \
            --clientSecret ${{ secrets.CLIENT_SECRET }} \
            --tenant ${{ secrets.TENANT_ID }}
      # Push control
      - run: pac pcf push --publisher-prefix ${{ vars.PUBLISHER_PREFIX }}
      # Import form configuration solution
      - run: pac solution import --path ./deploy/FormConfig.zip --publish-changes

  deploy-prod:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: windows-latest
    environment: production
    steps:
      # Same as dev but with production secrets
      ...
```

#### Solution Packager Integration

- Store unpacked solution in `deploy/` directory (version controlled)
- `deploy/solution.xml` — solution metadata
- `deploy/customizations.xml` — form configurations
- GitHub Action packs → deploys

#### Environment Configuration

- GitHub Secrets: `DATAVERSE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`
- GitHub Variables: `PUBLISHER_PREFIX`
- GitHub Environments: `development`, `test`, `production` (with manual approval gates)

### Effort estimate

Large — 5-10 days. Requires service principal setup, GitHub Actions authoring, and testing across environments.

---

## Implementation Order

| Phase | Feature | Effort | Value |
|-------|---------|--------|-------|
| 1a | Export solution ZIP from harness | 3 days | High — eliminates manual form config |
| 1b | Import exported solution via PAC CLI | 1 day | High — completes the export flow |
| 2a | Push control from harness (pac pcf push) | 2 days | Medium — saves context switching |
| 2b | Push form configuration via Web API | 4 days | High — one-click deploy |
| 3a | GitHub Actions build/test workflow | 2 days | Medium — CI foundation |
| 3b | GitHub Actions deploy workflow | 3 days | High — automated CD |
| 3c | Multi-environment with approval gates | 2 days | Medium — production safety |

**Total: ~17 days across all phases**

---

## Architecture

```
PCF Workbench (Harness)
  ├── Design & Test (existing)
  │     ├── Property Editor (column binding, @related, static)
  │     ├── Test Scenarios (save/load/export)
  │     └── Device Emulation & Network Conditioning
  │
  ├── Phase 1: Export
  │     ├── Solution Exporter (generates .zip)
  │     └── Form XML Generator (customizations.xml)
  │
  ├── Phase 2: Direct Push
  │     ├── PAC CLI Integration (pcf push)
  │     └── Dataverse Web API (form update + publish)
  │
  └── Phase 3: CI/CD
        ├── GitHub Actions Templates
        ├── Solution Packager Scripts
        └── Environment Manager
```

---

## Dependencies

- **Phase 1**: JSZip (npm package, ~100KB) for client-side ZIP generation
- **Phase 2**: PAC CLI (already installed), Dataverse Web API access
- **Phase 3**: GitHub Actions, Azure AD service principal for Dataverse auth

---

## Status

- [x] Phase 0: Design & Test (complete — PCF Workbench)
- [ ] Phase 1: Export Configuration
- [ ] Phase 2: Direct Push
- [ ] Phase 3: CI/CD Pipeline
