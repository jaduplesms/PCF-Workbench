import { useEffect, useRef, useCallback, useState } from 'react';
import { makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button } from '@fluentui/react-components';
import { ArrowClockwise24Regular, Camera24Regular } from '@fluentui/react-icons';
import { useHarnessStore } from '../../store/harness-store';
import { ControlHost, type ControlHostState } from '../../loader/control-host';
import type { ManifestConfig } from '../../types/manifest';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    flexShrink: 0,
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    flex: 1,
  },
  viewportWrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    backgroundColor: '#f0f0f0',
    overflow: 'auto',
    padding: '16px',
  },
  viewport: {
    backgroundColor: '#ffffff',
    boxShadow: tokens.shadow4,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    position: 'relative' as const,
    containerType: 'inline-size',
    containerName: 'pcf-viewport',
  } as any,
  controlContainer: {
    width: '100%',
    minHeight: '48px',
    overflow: 'auto',
    height: '100%',
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '24px',
  },
  error: {
    margin: '16px',
  },
});

interface Props {
  manifest: ManifestConfig;
  bundlePath: string;
  cssFiles: string[];
  controlDir: string;
}

const THUMB_WIDTH = 680;
const THUMB_HEIGHT = 320;

/**
 * Capture a pixel-perfect thumbnail by cloning the element into
 * an offscreen iframe, collecting all stylesheets, and using
 * html2canvas-free native rendering.
 *
 * Falls back to a simpler inline-style clone if needed.
 */
/**
 * Convert an image element's src to a data URI so it won't taint the canvas.
 * Skips same-origin images (they're safe) and silently removes ones that fail.
 */
async function inlineImage(img: HTMLImageElement): Promise<void> {
  const src = img.getAttribute('src');
  if (!src || src.startsWith('data:')) return;
  try {
    const resp = await fetch(src);
    const blob = await resp.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    img.setAttribute('src', dataUrl);
  } catch {
    // Can't fetch — remove image to avoid tainting
    img.removeAttribute('src');
  }
}

/** Strip external url() references from CSS text to prevent canvas tainting. */
function sanitizeCss(css: string): string {
  // Remove @font-face blocks that reference external URLs
  css = css.replace(/@font-face\s*\{[^}]*url\s*\(\s*["']?https?:\/\/[^}]*\}/gi, '');
  // Replace remaining external url(...) references with none
  css = css.replace(/url\s*\(\s*["']?https?:\/\/[^)]*\)/gi, 'url()');
  return css;
}

async function captureThumbnail(element: HTMLElement, controlDir: string): Promise<void> {
  try {
    // Collect all stylesheets as text, stripping external URLs to prevent tainting
    const styleTexts: string[] = [];
    for (const sheet of document.styleSheets) {
      try {
        const rules = Array.from(sheet.cssRules);
        styleTexts.push(sanitizeCss(rules.map(r => r.cssText).join('\n')));
      } catch {
        // Cross-origin sheets can't be read — skip
      }
    }

    // Clone the element and inline any cross-origin images
    const clone = element.cloneNode(true) as HTMLElement;
    const imgs = Array.from(clone.querySelectorAll('img'));
    await Promise.all(imgs.map(inlineImage));

    // Build SVG foreignObject with embedded styles
    const width = element.scrollWidth || element.offsetWidth;
    const height = element.scrollHeight || element.offsetHeight;

    const svgHtml = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden;background:white;">
            <style>${styleTexts.join('\n')}</style>
            ${clone.outerHTML}
          </div>
        </foreignObject>
      </svg>`;

    const svgBlob = new Blob([svgHtml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG render failed'));
      img.src = url;
    });

    // Draw to canvas and scale to thumbnail size
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = THUMB_HEIGHT;
    const ctx = thumbCanvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);

    // Scale to fit width, crop from top
    const scale = THUMB_WIDTH / width;
    const scaledHeight = height * scale;
    const yOffset = scaledHeight < THUMB_HEIGHT ? (THUMB_HEIGHT - scaledHeight) / 2 : 0;
    ctx.drawImage(img, 0, 0, width, height, 0, yOffset, THUMB_WIDTH, scaledHeight);

    URL.revokeObjectURL(url);

    const dataUrl = thumbCanvas.toDataURL('image/jpeg', 0.9);
    console.log(`[pcf-workbench] Capturing thumbnail for: ${controlDir} (${(dataUrl.length / 1024).toFixed(0)} KB)`);

    const resp = await fetch('/api/save-thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controlDir, thumbnail: dataUrl }),
    });
    const result = await resp.json();
    if (result.ok) {
      console.log(`[pcf-workbench] Thumbnail saved: ${result.path}`);
    } else {
      console.warn(`[pcf-workbench] Thumbnail save failed:`, result.error);
    }
  } catch (err) {
    console.warn('[pcf-workbench] Thumbnail capture failed:', err);
    console.warn('[pcf-workbench] Tip: You can also take a manual screenshot and save it as thumbnail.jpg in the control directory');
  }
}

export function ControlViewport({ manifest, bundlePath, cssFiles, controlDir }: Props) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<ControlHost | null>(null);
  const [hostState, setHostState] = useState<ControlHostState>({ isLoaded: false, error: null });

  const viewportWidth = useHarnessStore(s => s.viewportWidth);
  const viewportHeight = useHarnessStore(s => s.viewportHeight);
  const propertyValues = useHarnessStore(s => s.propertyValues);
  const networkMode = useHarnessStore(s => s.networkMode);
  const isControlDisabled = useHarnessStore(s => s.isControlDisabled);
  const formFactor = useHarnessStore(s => s.formFactor);
  const isDarkMode = useHarnessStore(s => s.isDarkMode);
  const pageEntityId = useHarnessStore(s => s.pageEntityId);
  const pageEntityTypeName = useHarnessStore(s => s.pageEntityTypeName);

  // Initialize control host
  useEffect(() => {
    if (!containerRef.current) return;

    // Load control CSS into a scoped @layer to prevent Bootstrap from overriding harness styles.
    // Harness styles (unlayered) always win over layered styles per CSS cascade rules.
    // The control CSS applies inside the control container via specificity.
    const loadControlCss = async () => {
      // Remove any previously injected control CSS
      document.querySelectorAll('[data-pcf-css]').forEach(el => el.remove());

      // Establish layer order: control CSS goes in pcf-control layer (lowest priority).
      // Harness Fluent UI styles are unlayered (highest priority) and won't be affected
      // by Bootstrap resets. Control CSS applies normally to control elements since
      // harness atomic classes don't match control selectors.
      const layerOrder = document.createElement('style');
      layerOrder.setAttribute('data-pcf-css', 'layer-order');
      layerOrder.textContent = '@layer pcf-control;';
      document.head.insertBefore(layerOrder, document.head.firstChild);

      // Fetch all CSS files, wrap in @layer, and convert @media width queries
      // to @container queries so they respond to the viewport container size
      // (not the browser window) for device emulation.
      for (const cssFile of cssFiles) {
        try {
          const resp = await fetch(cssFile);
          if (!resp.ok) continue;
          let cssText = await resp.text();
          // Convert @media width queries to @container queries
          // @media (max-width: 768px) → @container pcf-viewport (max-width: 768px)
          // @media (min-width: 768px) → @container pcf-viewport (min-width: 768px)
          cssText = cssText.replace(
            /@media\s+only\s+screen\s+and\s*\(((?:max|min)-width:\s*\d+px)\)/g,
            '@container pcf-viewport ($1)'
          );
          cssText = cssText.replace(
            /@media\s*\(((?:max|min)-width:\s*\d+px)\)/g,
            '@container pcf-viewport ($1)'
          );
          const style = document.createElement('style');
          style.setAttribute('data-pcf-css', 'true');
          style.textContent = `@layer pcf-control {\n${cssText}\n}`;
          document.head.appendChild(style);
        } catch {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = cssFile;
          link.setAttribute('data-pcf-css', 'true');
          document.head.appendChild(link);
        }
      }
    };
    loadControlCss();

    const host = new ControlHost(
      manifest,
      useHarnessStore.getState,
      bundlePath,
      setHostState,
    );
    hostRef.current = host;
    host.load(containerRef.current);

    return () => {
      // Clean up control CSS on unmount
      document.querySelectorAll('link[data-pcf-css]').forEach(el => el.remove());
      host.destroy();
      hostRef.current = null;
    };
  }, [manifest, bundlePath]); // Only reload on manifest/bundle change

  // Listen for bundle changes (hot reload from Vite plugin file watcher)
  useEffect(() => {
    if (import.meta.hot) {
      import.meta.hot.on('pcf-bundle-changed', () => {
        console.log('[pcf-workbench] Bundle changed — reloading control');
        hostRef.current?.reload();
      });
    }
  }, []);


  const handleCaptureThumbnail = useCallback(() => {
    if (containerRef.current && controlDir) {
      captureThumbnail(containerRef.current, controlDir);
    }
  }, [controlDir]);

  // Trigger updateView when properties, network, device, or mode change.
  // Debounce to prevent cascading re-renders (especially for virtual controls
  // where ReactDOM.render can trigger synchronous state updates).
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hostRef.current?.isLoaded()) return;
    // Debounce: wait 50ms for rapid changes to settle
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(() => {
      hostRef.current?.callUpdateView();
    }, 50);
    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [propertyValues, networkMode, isControlDisabled, formFactor, isDarkMode, pageEntityId, pageEntityTypeName]);

  const handleReload = useCallback(() => {
    hostRef.current?.reload();
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.title}>
          {manifest.namespace}.{manifest.constructor} v{manifest.version}
          <span style={{ fontWeight: 'normal', marginLeft: 8, opacity: 0.6, fontSize: 12 }}>
            {manifest.controlType}
          </span>
        </span>
        <Button
          appearance="subtle"
          icon={<Camera24Regular />}
          onClick={handleCaptureThumbnail}
          title="Capture thumbnail for gallery"
        />
        <Button
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={handleReload}
          title="Reload control"
        />
      </div>

      <div className={styles.viewportWrapper}>
        <div
          className={styles.viewport}
          style={{ width: viewportWidth, height: viewportHeight }}
        >
          {hostState.error && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{hostState.error}</MessageBarBody>
            </MessageBar>
          )}
          {!hostState.isLoaded && !hostState.error && (
            <div className={styles.center}>
              <Spinner label="Loading control..." />
            </div>
          )}
          <div ref={containerRef} className={styles.controlContainer} />
        </div>
      </div>
    </div>
  );
}
