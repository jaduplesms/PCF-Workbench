/**
 * Platform library orchestration for the harness.
 *
 * Responsibilities:
 *  - Alias the loaded React/ReactDOM under the versioned globals deployed PCF
 *    bundles expect, and polyfill modern React APIs (see `react-aliases.ts`).
 *  - For each Fluent UI major actually referenced by the bundle, load the real
 *    UMD via `/__pcf/fluent-cdn` (see `fluent-real-loader.ts`) and fall back to
 *    a lightweight stub (`fluent-stub.ts`) per-major when that fails.
 *
 * Split out of a single ~900-line file during the MTD sweep (move-only).
 */

import type { ManifestResources } from '../types/manifest';
import { setupReactAliases, getReactDOMGlobal } from './react-aliases';
import { tryLoadRealFluent } from './fluent-real-loader';
import { createFluentStub } from './fluent-stub';

export { getReactDOMGlobal };

/**
 * Set up versioned global aliases and Fluent UI stubs.
 * Must be called BEFORE the PCF bundle script is loaded.
 */
export async function loadPlatformLibraries(resources: ManifestResources): Promise<void> {
  const libs = resources.platformLibraries;
  if (!libs || libs.length === 0) return;

  const w = window as any;

  setupReactAliases(libs);

  // Set up Fluent UI — load every major actually referenced by the bundle.
  //
  // M9 fix: previously we loaded a single Fluent version (from the manifest)
  // and aliased it under every versioned global name. That worked for controls
  // that used only one Fluent line but BROKE deployed controls that mix v8 + v9
  // (e.g. ColorPicker uses v8 color utils + v9 UI). Calling v9-style APIs like
  // `FluentUIReactv940.shorthands.gap()` against an aliased v8 namespace blew
  // up with "Cannot read properties of undefined (reading 'gap')".
  //
  // The Vite plugin pre-scans the bundle for FluentUIReactv<N> references and
  // populates `resources.fluentNeeds` with the majors and versions to load.
  // We honour that here. If the manifest declares Fluent but the scan didn't
  // run (older code path / older extracted control) we fall back to a
  // single-version load.
  const fluentLib = libs.find(l => l.name === 'Fluent');
  const needs = resources.fluentNeeds;
  const targets: { major: 'v8' | 'v9'; version: string }[] = [];
  if (needs?.v8) targets.push({ major: 'v8', version: needs.v8 });
  if (needs?.v9) targets.push({ major: 'v9', version: needs.v9 });
  if (targets.length === 0 && fluentLib) {
    const major: 'v8' | 'v9' = fluentLib.version.split('.')[0] === '9' ? 'v9' : 'v8';
    targets.push({ major, version: fluentLib.version });
  }

  if (targets.length === 0) return;

  const results = await Promise.all(
    targets.map(async t => ({ ...t, ok: await tryLoadRealFluent(t.major, t.version) })),
  );
  for (const r of results) {
    if (r.ok) {
      console.log(`[pcf-workbench] Fluent ${r.major} ${r.version} loaded from /__pcf/fluent-cdn`);
      continue;
    }
    // CDN unavailable for this major (offline, npm install failed, etc.) —
    // fall back to the lightweight stub for ONLY this major's globals.
    // Don't touch the other major's globals (they may have loaded fine).
    const stub = createFluentStub(w);
    const stubGlobals = r.major === 'v9'
      ? ['FluentUIReactv940', 'FluentUIReactv946']
      : ['FluentUIReact', 'FluentUIReactv8290', 'FluentUIReactv81211'];
    console.warn(`[pcf-workbench] Fluent ${r.major} setup: real UMD unavailable, falling back to stub — exposing ${stubGlobals.join(', ')}`);
    for (const name of stubGlobals) {
      if (!w[name]) w[name] = stub;
      else console.warn(`[pcf-workbench] Fluent UI global window.${name} already exists — keeping existing.`);
    }
  }
}
