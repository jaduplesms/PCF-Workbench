/**
 * React global aliasing + lazy polyfills for compatibility with deployed PCF
 * bundles compiled against Fluent v8/v9 (which expect versioned React globals
 * like Reactv940, Reactv16, etc.) and modern React APIs (useId,
 * useSyncExternalStore, useInsertionEffect) that may not exist on the loaded
 * React version.
 *
 * Extracted from the original platform-libs.ts during the MTD sweep
 * (move-only; behaviour unchanged).
 */

import type { ManifestResources } from '../types/manifest';

/**
 * Mirror the loaded React/ReactDOM under all versioned globals that deployed
 * Fluent bundles probe for, and polyfill modern React APIs (useId,
 * useSyncExternalStore, useInsertionEffect) that Fluent v9 controls assume
 * exist regardless of the React major actually loaded.
 *
 * No-op if no React platform library is declared or window.React is missing.
 */
export function setupReactAliases(libs: ManifestResources['platformLibraries']): void {
  const w = window as any;
  const reactLib = libs.find(l => l.name === 'React');
  if (!reactLib || !w.React) return;

  const major = reactLib.version.split('.')[0];
  const reactGlobal = `Reactv${major}`;
  const reactDomGlobal = `ReactDOMv${major}`;

  w[reactGlobal] = w.React;
  w[reactDomGlobal] = w.ReactDOM;
  console.log(`[pcf-workbench] React ${major} aliased: window.${reactGlobal}, window.${reactDomGlobal}`);

  // Deployed bundles compiled against Fluent v8/v9 reference React via versioned
  // globals like Reactv940 / Reactv8290 (the React instance bundled with that
  // Fluent version), not window.React. Alias the loaded React under all known
  // versioned globals so bundles find what they expect regardless of manifest drift.
  const versionedReactGlobals = ['Reactv16', 'Reactv17', 'Reactv18', 'Reactv940', 'Reactv8290', 'Reactv81211'];
  const versionedReactDomGlobals = ['ReactDOMv16', 'ReactDOMv17', 'ReactDOMv18', 'ReactDOMv940', 'ReactDOMv8290', 'ReactDOMv81211'];
  for (const name of versionedReactGlobals) if (!w[name]) w[name] = w.React;
  for (const name of versionedReactDomGlobals) if (!w[name]) w[name] = w.ReactDOM;

  // Polyfill React 18-only APIs that Fluent v9 controls expect even on React 16/17.
  // The platform (UCI) provides similar polyfills implicitly; deployed bundles assume
  // they exist. Without these, controls crash on first render with cryptic errors.
  if (typeof w.React.useId !== 'function') {
    let _idCounter = 0;
    w.React.useId = () => w.React.useMemo(() => `:pcfwb-${(_idCounter++).toString(36)}:`, []);
    console.log(`[pcf-workbench] Polyfilled React.useId for compatibility with Fluent v9`);
  }
  if (typeof w.React.useSyncExternalStore !== 'function') {
    // Minimal polyfill — sufficient for Fluent v9's internal use
    w.React.useSyncExternalStore = (subscribe: any, getSnapshot: any) => {
      const [value, setValue] = w.React.useState(getSnapshot());
      w.React.useEffect(() => {
        const handler = () => setValue(getSnapshot());
        handler();
        return subscribe(handler);
      }, [subscribe, getSnapshot]);
      return value;
    };
    console.log(`[pcf-workbench] Polyfilled React.useSyncExternalStore`);
  }
  if (typeof w.React.useInsertionEffect !== 'function') {
    w.React.useInsertionEffect = w.React.useLayoutEffect ?? w.React.useEffect;
    console.log(`[pcf-workbench] Polyfilled React.useInsertionEffect → useLayoutEffect`);
  }
}

/**
 * Get the versioned ReactDOM global for rendering virtual control output.
 */
export function getReactDOMGlobal(resources: ManifestResources): any | null {
  const reactLib = resources.platformLibraries.find(l => l.name === 'React');
  if (!reactLib) return null;
  const major = reactLib.version.split('.')[0];
  const globalName = `ReactDOMv${major}`;
  return (window as any)[globalName] ?? (window as any).ReactDOM ?? null;
}
