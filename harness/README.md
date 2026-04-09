# PCF Workbench

An enhanced development and testing environment for Power App Component Framework (PCF) controls, replacing the built-in `pcf-scripts start` harness with offline simulation, network conditioning, performance monitoring, and a control gallery.

## Quick Start

### Gallery Mode (browse all controls)
```bash
cd PCFBuilderFramework/harness
PCF_WORKSPACE_ROOT="C:/Claude.Code" npx vite --port 8181
```
Opens a gallery showing all PCF controls in the workspace with metadata, badges, and deep-link to open each one.

### Single Control Mode
```bash
# Via environment variable
PCF_CONTROL_PATH="../BookingStatusTransitionControl/BookingStatusTransitionControl" npx vite --port 8181

# Via CLI
node bin/pcf-harness.js --path ../BookingStatusTransitionControl/BookingStatusTransitionControl --port 8181
```

### Prerequisites
- The PCF control must be built first: `npm run build` in the control's project directory
- The compiled `bundle.js` must exist in `out/controls/{Name}/`

## Features

### Control Gallery
- Scans workspace for all PCF controls (built and unbuilt)
- Shows cards with: name, version, type (standard/virtual), platform libraries, features, property count
- Badges for: data.json, test scenarios, build status
- Click "Open" to switch to harness mode for that control
- Click "PCF Dev Harness" in the harness top bar to return to gallery

### Harness Panels (right sidebar, icon tabs)

| Icon | Panel | Purpose |
|------|-------|---------|
| Gear | **Props** | Control Info Card + Page Context + auto-generated property editors |
| Database | **Data** | View/edit mock entity data from data.json |
| Beaker | **Tests** | Save/load/export/import test scenarios |
| Plug | **Network** | Online / Offline / Slow 3G / Fast 3G / Custom latency |
| Phone | **Device** | Desktop / iPhone 14 / Pixel 7 / iPad presets |
| Gauge | **Perf** | Render timeline, heap timeline, top requests by duration/size, failed calls |

### Console Panel (bottom)
- Timestamped log of all ComponentFramework API calls
- Category filter badges: lifecycle, webAPI, navigation, device, mode, utils, data, scenario
- Click a badge to hide/show that category

### ComponentFramework Shim
Full mock implementation of the PCF Context interface:
- **webAPI**: retrieveMultipleRecords, retrieveRecord, createRecord, updateRecord, deleteRecord with OData $filter/$select/$top/$orderby parsing, latency injection, offline rejection
- **client**: isOffline(), getFormFactor(), isNetworkAvailable() — driven by Network/Device panels
- **device**: captureImage, getBarcodeValue, getCurrentPosition — mock implementations
- **mode**: isControlDisabled, allocatedWidth/Height — driven by harness UI
- **navigation**: openForm, openUrl, openAlertDialog — logs to console
- **formatting**: formatCurrency, formatDate, etc. — Intl-based implementations
- **resources**: getString() with RESX file parsing
- **fluentDesignLanguage**: tokenTheme for light/dark mode
- **page**: entityId, entityTypeName — configurable in Props panel

### Virtual (React) Control Support
- Detects `<platform-library name="React">` in manifest
- Loads React 16 or 18 UMD as versioned globals (`window.Reactv16`, `window.ReactDOMv16`)
- Provides Fluent UI v8 component stubs (Stack, Text, Dropdown, TextField, Checkbox, etc.)
- Renders `updateView()` React elements via the correct versioned ReactDOM

### Hot Reload
- Watches `out/controls/*/bundle.js` for changes
- When you rebuild the PCF project (`npm run build`), the harness auto-destroys and re-initialises the control

## Project Files

### Control-Side Files
Place these in your PCF control directory (alongside `ControlManifest.Input.xml`):

| File | Purpose |
|------|---------|
| `data.json` | Mock entity data for WebAPI calls. Structure: `{ "tableName": [{ ...record }] }` |
| `test-scenarios.json` | Pre-configured test scenarios (properties, page context, network mode, device preset) |
| `thumbnail.png` | Gallery thumbnail (auto-captured or manual) |
| `harness-meta.json` | Auto-generated metadata (thumbnail, last tested timestamp) |

### data.json Example
```json
{
  "bookingstatus": [
    { "bookingstatusid": "abc-123", "name": "Scheduled", "msdyn_statuscolor": "#0078D4" },
    { "bookingstatusid": "def-456", "name": "In Progress", "msdyn_statuscolor": "#FF8C00" }
  ],
  "jdp_bookingstatustransition": [
    { "jdp_validstatefrom": "Scheduled", "jdp_validstateto": "In Progress, Canceled" }
  ]
}
```

### test-scenarios.json Example
```json
[
  {
    "name": "Happy Path - Scheduled",
    "savedAt": "2026-04-03T00:00:00Z",
    "propertyValues": {
      "value": [{"id": "abc-123", "name": "Scheduled", "entityType": "bookingstatus"}],
      "transitionTable": "jdp_bookingstatustransition",
      "fromStateFieldName": "jdp_validstatefrom",
      "toStateFieldName": "jdp_validstateto"
    },
    "pageEntityId": "",
    "pageEntityTypeName": "",
    "networkMode": "online",
    "devicePreset": "desktop",
    "isControlDisabled": false
  }
]
```

## Architecture

```
harness/
  bin/pcf-harness.ts          # CLI entry point
  src/
    App.tsx                    # Gallery or Harness mode router
    ui/
      gallery/Gallery.tsx      # Control catalog with cards
      HarnessShell.tsx         # Harness layout (toolbar + panels + viewport)
      panels/                  # PropertyEditor, DataPanel, ScenariosPanel, NetworkPanel,
                               # DevicePanel, PerformancePanel, ConsolePanel, ControlInfoCard
    shim/                      # ComponentFramework mock (context-factory, web-api, client,
                               # device, mode, navigation, formatting, resources, fluent-design)
    loader/
      bundle-loader.ts         # Script injection + registerControl interceptor
      control-host.ts          # PCF lifecycle management (init/updateView/destroy)
      platform-libs.ts         # React UMD loading + Fluent UI stubs
    store/
      harness-store.ts         # Zustand state (properties, network, device, metrics, logs)
      data-store.ts            # In-memory entity data
    parser/
      manifest-parser.ts       # ControlManifest.Input.xml parser
      resx-parser.ts           # RESX localization file parser
    scanner/
      workspace-scanner.ts     # Finds all PCF controls in workspace
    vite-plugin/
      pcf-plugin.ts            # Vite plugin: virtual module, static serving, gallery API,
                               # control switching, bundle watching, thumbnail saving
```

## Roadmap

### Completed
- [x] Control gallery with workspace scanning
- [x] Single-control harness with all panels
- [x] Standard (DOM) and Virtual (React) control support
- [x] Network conditioning (online/offline/3G)
- [x] Device emulation presets
- [x] Performance monitoring (render timeline, heap, top requests)
- [x] Test scenarios (save/load/export/import)
- [x] Mock data editor
- [x] RESX localization
- [x] Hot reload on bundle changes
- [x] CLI entry point

### Planned
- [ ] Auto-generate sample data.json and test-scenarios.json during control scaffolding
- [ ] Auto-capture viewport thumbnails for gallery
- [ ] Form simulator: host multiple controls with shared context
- [ ] Playwright integration for automated screenshot capture
- [ ] Performance regression detection across test runs
