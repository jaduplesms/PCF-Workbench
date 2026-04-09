# PCF Builder Framework

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Fluent UI](https://img.shields.io/badge/Fluent_UI-v9-0078d4?logo=microsoft&logoColor=white)](https://react.fluentui.dev/)
[![Zustand](https://img.shields.io/badge/Zustand-5-orange)](https://zustand-demo.pmnd.rs/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An enhanced development harness and testing framework for Power Apps Component Framework (PCF) controls. Browse, test, and debug your PCF controls in a rich local environment with device emulation, network conditioning, performance monitoring, and lifecycle analysis -- all without deploying to Dataverse.

---

## Why PCF Builder Framework?

The built-in `pcf-scripts start` test harness is minimal: a single control, no device emulation, no network simulation, and limited debugging tools. PCF Builder Framework replaces it with a full-featured development environment:

| Feature | pcf-scripts start | PCF Builder Framework |
|---|---|---|
| Gallery of all controls | No | Yes |
| Device emulation | No | 4 presets + responsive |
| Network conditioning | No | Offline, 3G, custom latency |
| WebAPI mock with OData filters | No | Yes |
| Performance monitoring | No | Render timeline, heap, DOM |
| Resource leak detection | No | Event listeners, timers, observers |
| Test scenarios | No | Save, load, export, import, auto-generate |
| Dark mode toggle | No | Yes |
| Thumbnail capture | No | Auto-capture to gallery |
| Virtual (React) control support | Basic | Full lifecycle with stable rendering |
| Hot reload | No | Vite file watcher on bundle |

---

## Key Features

### Gallery Mode

Browse all PCF controls in your workspace from a searchable gallery. Each card shows the control name, namespace, version, control type (standard/virtual), property count, platform libraries, build status, package size, and a thumbnail preview. Filter by name, toggle private control visibility, and open any built control directly.

### Device Emulation

Test your controls at real device dimensions with four built-in presets:

| Preset | Resolution | Form Factor |
|---|---|---|
| Desktop | 1280 x 720 | Desktop |
| iPhone 14 Pro | 390 x 844 | Phone |
| Pixel 7 | 412 x 915 | Phone |
| iPad | 820 x 1180 | Tablet |

The viewport is a CSS container query context (`@container pcf-viewport`), so `@media` width queries in your control CSS are automatically converted to `@container` queries for accurate responsive behavior at the emulated size rather than the browser window size.

### Network Conditioning

Simulate real-world network conditions to test offline-first behavior:

- **Online** -- No latency, all WebAPI calls succeed
- **Offline** -- `webAPI.online` calls reject, auto-routing falls back to local store
- **Slow 3G** -- 2000 ms latency per request
- **Fast 3G** -- 500 ms latency per request
- **Custom** -- Set your own latency in milliseconds

The WebAPI shim mirrors the real Dynamics 365 routing model: `context.webAPI` auto-routes between online and offline stores, while `webAPI.online` and `webAPI.offline` target specific stores directly.

### WebAPI Mock with OData Support

A full-featured WebAPI shim (`createRecord`, `updateRecord`, `deleteRecord`, `retrieveRecord`, `retrieveMultipleRecords`) backed by `data.json` files. Supports OData query parameters:

- `$filter` with `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `contains()`, `startswith()`, `endswith()`, `and`, `or`, null comparisons
- `$select` for column projection
- `$orderby` with `asc`/`desc`
- `$top` for result limiting
- `maxPageSize` for paging

All WebAPI calls are logged with timing, response size, and record counts in the performance panel.

### Dataset Shim

Full `ComponentFramework.PropertyTypes.DataSet` implementation for data-set bound controls. Reads records from `data.json`, supports `getValue`, `getFormattedValue`, OData formatted value annotations (`@OData.Community.Display.V1.FormattedValue`), lookup field resolution with `_field_value` patterns, paging metadata, sorting/filtering stubs, and linked entity discovery.

### Test Scenarios

Save and restore complete harness state as named test scenarios:

- **Save** -- Captures property values, page context, network mode, device preset, and disabled state
- **Load** -- Restores all saved state and triggers updateView
- **Export/Import** -- Share scenarios as JSON files across team members
- **Auto-generate** -- Creates skeleton scenarios from the manifest covering all device presets, offline mode, slow 3G, disabled state, empty values, and entity context

Scenarios are loaded from `test-scenarios.json` in the control directory and merged with locally saved scenarios.

### Properties Panel

Type-aware property editors built from the `ControlManifest.Input.xml`. Each property renders with the appropriate input control based on its `of-type` (text fields, number inputs, dropdowns for OptionSet, date pickers, boolean toggles, lookup editors). Changes trigger `updateView` with a 50 ms debounce.

### Performance Monitoring

Real-time metrics tracked across the control lifecycle:

- **Render timeline** -- Duration of each `updateView` call (last 50 renders)
- **DOM node count** -- Elements inside the control container, updated per frame
- **JS heap usage** -- Heap snapshots after each render (last 100)
- **WebAPI call log** -- Method, entity type, duration, response size, record count, OData query (last 100 calls)

### Lifecycle Monitor

Track every PCF lifecycle method (`init`, `updateView`, `getOutputs`, `destroy`, `notifyOutputChanged`) with precise timing. Includes health checks for common issues.

### Resource Leak Detection

After `destroy()` is called, the harness reports resources that were not cleaned up:

- **Event listeners** -- `addEventListener` calls on window, document, or container elements without matching `removeEventListener`
- **Timers** -- `setInterval` and long-lived `setTimeout` (> 5 s) not cleared
- **Observers** -- `MutationObserver`, `ResizeObserver`, `IntersectionObserver` instances not disconnected

### CSS Isolation

Control CSS is loaded into a `@layer pcf-control` to prevent Bootstrap resets and other control styles from breaking the harness UI. Harness styles (unlayered Fluent UI) always take priority via CSS cascade rules, while control styles apply normally within the control container.

### Hot Reload

The Vite plugin watches the `out/` directory for `bundle.js` changes. When you run `npm run build` in your PCF project, the harness detects the new bundle and reloads the control automatically -- no manual refresh needed.

### Thumbnail Capture

Capture pixel-perfect thumbnails of your running control for gallery cards. Uses SVG foreignObject rendering with inlined stylesheets and images, scaled to 680 x 320 px. Supports JPEG, PNG, and GIF output. Thumbnails are saved directly to the control directory.

### getResource Shim

Preloads all image, font, and RESX resources from the bundle output directory at startup. `context.resources.getResource()` returns base64 data synchronously from cache, matching the timing behavior of the real Dynamics 365 runtime. `context.resources.getString()` returns RESX localization strings parsed at build time.

### Fluent UI Platform Library Stubs

For virtual controls that depend on Fluent UI v8 or v9, the harness provides a Proxy-based stub with functional component implementations for common controls (Stack, TextField, Dropdown, Checkbox, Toggle, DatePicker, MessageBar, Modal, Dialog, Spinner, Icon, and more). Includes an icon registry that supports `registerIcons()` with Unicode fallbacks for common Fluent icon names.

### Context Shims

Complete `ComponentFramework.Context` implementation including:

- `context.client` -- `isOffline()`, `getFormFactor()`, `getClient()`, `isNetworkAvailable()`
- `context.device` -- Device capabilities
- `context.mode` -- `isControlDisabled`, `isVisible`, `allocatedWidth/Height`, `label`
- `context.navigation` -- `openForm()`, `openUrl()`, `openAlertDialog()`, `openConfirmDialog()`
- `context.formatting` -- Date, number, and currency formatting
- `context.userSettings` -- User locale, timezone, security roles
- `context.utils` -- Entity metadata and lookup dialogs
- `context.page` -- `entityId`, `entityTypeName` for record-context controls
- `context.fluentDesignLanguage` -- Theme token provider

### Private Controls

Drop a `.pcf-private` marker file in any control directory to hide it from the gallery by default. Toggle visibility with the private controls switch in the gallery toolbar.

### Package Size Tracking

Gallery cards display the total `out/` directory size for each built control, with color-coded warnings for large bundles (yellow > 200 KB, red > 500 KB).

---

## Quick Start

### Prerequisites

- Node.js 18+
- A workspace containing one or more PCF control projects (each with a `ControlManifest.Input.xml` and a compiled `out/` directory)

### Install

```bash
git clone https://github.com/jaduplesms/PCFBuilderFramework.git
cd PCFBuilderFramework/harness
npm install
```

> **No build step required.** Vite compiles TypeScript on-the-fly — just install and run.

### Gallery Mode

Browse all controls in a workspace directory:

```bash
cd PCFBuilderFramework/harness
PCF_WORKSPACE_ROOT="/path/to/your/pcf-controls" npx vite --port 8181
```

### Single Control Mode

Open a specific control directly:

```bash
cd PCFBuilderFramework/harness
PCF_CONTROL_PATH="/path/to/MyControl/MyControl" npx vite --port 8181
```

The harness opens at `http://localhost:8181`.

> **Note:** Controls must be built (`npm run build` in the PCF project) before they can be loaded. The harness runs the compiled `bundle.js` from the `out/` directory, not the TypeScript source.

---

## Project Structure

```
PCFBuilderFramework/
  harness/
    src/
      main.tsx                        # App entry point
      App.tsx                         # Root component (gallery vs harness routing)
      vite-plugin/
        pcf-plugin.ts                 # Vite plugin: manifest parsing, file serving,
                                      #   gallery API, hot reload watcher
      ui/
        HarnessShell.tsx              # Main harness layout (top bar + viewport + panels)
        gallery/
          Gallery.tsx                 # Gallery mode: searchable control catalog
        panels/
          ControlViewport.tsx         # Device-emulated viewport with CSS container queries
          PropertyEditor.tsx          # Type-aware property input editors
          ConsolePanel.tsx            # Lifecycle and WebAPI call log
          NetworkPanel.tsx            # Network mode selector
          DevicePanel.tsx             # Device preset selector
          PerformancePanel.tsx        # Render timeline, heap, WebAPI metrics
          LifecyclePanel.tsx          # Lifecycle event log with health checks
          ScenariosPanel.tsx          # Test scenario save/load/export/import
          DataPanel.tsx               # Entity data viewer
          ControlInfoCard.tsx         # Control metadata display
      store/
        harness-store.ts             # Zustand store (state, device presets, metrics)
        data-store.ts                # In-memory entity data from data.json
      loader/
        control-host.ts              # PCF control lifecycle manager (init/updateView/destroy)
        bundle-loader.ts             # Dynamic script loader for compiled bundles
        platform-libs.ts             # React global aliases + Fluent UI v8/v9 stubs
        resource-tracker.ts          # Monkey-patch based resource leak detector
      shim/
        context-factory.ts           # ComponentFramework.Context builder
        web-api.ts                   # WebAPI mock with OData filter/select/orderby
        resources.ts                 # getResource/getString with preloading cache
        client.ts                    # context.client shim
        device.ts                    # context.device shim
        mode.ts                      # context.mode shim
        navigation.ts                # context.navigation shim
        formatting.ts                # context.formatting shim
        user-settings.ts             # context.userSettings shim
        utils.ts                     # context.utils shim
        fluent-design.ts             # context.fluentDesignLanguage shim
        register.ts                  # Global registration helpers
      parser/
        manifest-parser.ts           # ControlManifest.Input.xml parser
        resx-parser.ts               # RESX localization file parser
      scanner/
        workspace-scanner.ts         # Workspace directory scanner for gallery mode
      types/
        manifest.ts                  # TypeScript types for parsed manifests
    vite.config.ts                   # Vite config with React + PCF plugin
    package.json
    tsconfig.json
```

---

## Control Setup

For a control to work with the harness, it needs a standard PCF project structure:

```
MyControl/
  MyControl/
    ControlManifest.Input.xml        # Required: control metadata and properties
    index.ts                         # PCF lifecycle class
    css/
      MyControl.css                  # Scoped CSS
    generated/
      ManifestTypes.d.ts             # Auto-generated types
  out/
    controls/
      MyControl/
        bundle.js                    # Required: compiled control bundle
        *.css                        # Compiled CSS (if any)
```

### Optional Files

| File | Location | Purpose |
|---|---|---|
| `data.json` | Control dir or project root | Mock entity data for WebAPI and dataset shims |
| `test-scenarios.json` | Control dir or project root | Pre-configured test scenarios |
| `thumbnail.jpg` | Control dir or project root | Gallery card thumbnail (also `.png`, `.gif`) |
| `.pcf-private` | Control dir or project root | Hide from gallery by default |

### data.json Format

```json
{
  "bookableresourcebooking": [
    {
      "bookableresourcebookingid": "00000000-0000-0000-0000-000000000001",
      "name": "Booking 1",
      "starttime": "2025-01-15T09:00:00Z",
      "bookingstatus@OData.Community.Display.V1.FormattedValue": "Scheduled"
    }
  ],
  "account": [
    {
      "accountid": "00000000-0000-0000-0000-000000000010",
      "name": "Contoso Ltd",
      "telephone1": "+1-555-0100"
    }
  ]
}
```

Entity data is keyed by entity logical name. Each array entry represents a record. The WebAPI shim and dataset shim read from this store. OData formatted value annotations are supported for lookup and optionset display names.

---

## Screenshots

> Screenshots coming soon. The harness features a gallery view with searchable control cards, a device-emulated viewport with side panels for properties, data, scenarios, network, device, lifecycle, and performance monitoring.

---

## Contributing

Contributions are welcome. To get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Install dependencies: `cd harness && npm install`
4. Start the dev server: `npm run dev`
5. Make your changes and verify with `npm run typecheck`
6. Submit a pull request

### Development Notes

- The harness UI is built with React 18 and Fluent UI v9
- State management uses Zustand 5 (no providers needed)
- The Vite plugin handles all server-side logic (manifest parsing, file serving, gallery API, hot reload)
- Context shims are modular -- each `shim/*.ts` file handles one aspect of `ComponentFramework.Context`

---

## License

This project is licensed under the [MIT License](LICENSE).

### Licensing Notes

- **All harness code is original** — no Microsoft SDK source code is bundled or redistributed
- **Dependencies** — React, Fluent UI, Vite, Zustand, fast-xml-parser, html2canvas, commander are all MIT licensed
- **TypeScript** is Apache 2.0 licensed
- **Fluent UI stubs** in the harness are original implementations that mimic the Fluent UI API surface for development/testing — they do not contain Microsoft Fluent UI source code
- **PCF controls** loaded into the harness are the user's own work — the harness is a development tool only
- **`@types/powerapps-component-framework`** type definitions used during development are MIT licensed
- This project is **not affiliated with or endorsed by Microsoft** — it is an independent development tool for the Power Apps Component Framework ecosystem
