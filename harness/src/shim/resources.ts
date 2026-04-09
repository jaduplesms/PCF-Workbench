let resxStrings: Record<string, string> = {};

/** Load RESX strings parsed at build time. */
export function setResxStrings(strings: Record<string, string>): void {
  resxStrings = strings;
}

/** Cache of preloaded resource base64 data */
const resourceCache: Record<string, string> = {};
let preloadDone = false;

/**
 * Preload all image/font resources from the bundle directory.
 * Fetches a resource list from the server and caches them as base64.
 * Call this before the control loads so getResource returns from cache instantly.
 */
export async function preloadBundleResources(): Promise<void> {
  if (preloadDone) return;
  preloadDone = true;

  try {
    const resp = await fetch('/api/bundle-resources');
    if (!resp.ok) return;
    const files: string[] = await resp.json();

    // Fetch all resources in parallel
    await Promise.all(files.map(file => fetchAndCache(file)));
    console.log(`[pcf-workbench] Preloaded ${Object.keys(resourceCache).length} resources`);
  } catch {
    // Non-fatal — resources will be fetched on demand
  }
}

/** Fetch a resource and cache it */
async function fetchAndCache(id: string): Promise<string | null> {
  const candidates = [
    `/pcf-bundle/${id}`,
    `/pcf-bundle/images/${id}`,
    `/pcf-bundle/strings/${id}`,
    `/pcf-bundle/fonts/${id}`,
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url);
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || ct.includes('text/html')) continue;
      const blob = await r.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resourceCache[id] = base64;
      return base64;
    } catch {
      continue;
    }
  }
  return null;
}

export function createResourcesShim() {
  return {
    getResource(id: string, success: (data: string) => void, failure: (err?: any) => void): void {
      // Return from cache SYNCHRONOUSLY — the callback fires immediately
      // so setState happens during componentDidMount before any re-render
      if (resourceCache[id]) {
        console.log(`[pcf-workbench] getResource('${id}') CACHE HIT (${resourceCache[id].length} chars) — calling success synchronously`);
        try {
          success(resourceCache[id]);
          console.log(`[pcf-workbench] getResource('${id}') success callback returned`);
        } catch (e) {
          console.error(`[pcf-workbench] getResource('${id}') success callback THREW:`, e);
        }
        return;
      }
      console.warn(`[pcf-workbench] getResource('${id}') CACHE MISS — fetching async`);

      // Fallback: fetch async (unlikely if preloadBundleResources ran)
      fetchAndCache(id).then(base64 => {
        if (base64) {
          success(base64);
        } else {
          console.warn(`[pcf-workbench] getResource('${id}') — not found`);
          failure();
        }
      });
    },
    getString(id: string): string {
      return resxStrings[id] ?? id;
    },
  };
}
