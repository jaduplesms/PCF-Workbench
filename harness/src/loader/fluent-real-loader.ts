/**
 * Loads a Fluent UMD bundle through the in-process `/__pcf/fluent-cdn` Vite
 * middleware. The middleware does a one-off `npm install` of the requested
 * package + esbuild bundle on first request; subsequent requests are cached
 * under `harness/.fluent-cache/`.
 *
 * Extracted from the original platform-libs.ts during the MTD sweep
 * (move-only; behaviour unchanged).
 */
export async function tryLoadRealFluent(major: 'v8' | 'v9', version: string): Promise<boolean> {
  const w = window as any;
  const canonical = major === 'v9' ? 'FluentUIReactv940' : 'FluentUIReact';

  // Already loaded by a previous control switch?
  if (w.__pcfwbFluentReal?.[major] && w[canonical]) return true;

  const url = `/__pcf/fluent-cdn/${major}/${version}/bundle.js`;
  console.log(`[pcf-workbench] Fluent: requesting real UMD ${url} (first request may take 10-60s for npm install + esbuild)`);

  return new Promise<boolean>(resolve => {
    const existing = document.querySelector(`script[data-pcf-fluent-cdn="${major}-${version}"]`);
    if (existing) {
      // Another loader is already in flight — re-check after a tick.
      setTimeout(() => resolve(!!(w.__pcfwbFluentReal?.[major] && w[canonical])), 100);
      return;
    }
    const s = document.createElement('script');
    s.src = url;
    s.setAttribute('data-pcf-fluent-cdn', `${major}-${version}`);
    s.onload = () => {
      if (w.__pcfwbFluentReal?.[major] && w[canonical]) resolve(true);
      else {
        console.warn(`[pcf-workbench] Fluent CDN script loaded but window.${canonical} or marker missing.`);
        resolve(false);
      }
    };
    s.onerror = () => {
      console.warn(`[pcf-workbench] Fluent CDN load failed for ${url}. Falling back to stub.`);
      resolve(false);
    };
    document.head.appendChild(s);
  });
}
