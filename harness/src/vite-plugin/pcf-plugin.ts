import type { Plugin, ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest } from '../parser/manifest-parser';
import { parseResx } from '../parser/resx-parser';
import { scanWorkspace } from '../scanner/workspace-scanner';
import type { ManifestConfig } from '../types/manifest';

const VIRTUAL_ID = 'virtual:pcf-manifest';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

interface PcfPluginState {
  manifest: ManifestConfig | null;
  controlDir: string;
  projectRoot: string;
  outDir: string;
  cssFiles: string[];
  hasDataJson: boolean;
  resxStrings: Record<string, string>;
  isGalleryMode: boolean;
  workspaceRoot: string;
}

function resolveOutDir(controlDir: string, manifest: ManifestConfig): string {
  // Walk up from control dir to find the project root (where out/ lives)
  // Control dir is e.g. BookingStatusTransitionControl/BookingStatusTransitionControl/
  // out/ is at BookingStatusTransitionControl/out/controls/BookingStatusTransitionControl/
  let projectRoot = controlDir;
  // Check if out/ exists at this level, otherwise go up
  for (let i = 0; i < 4; i++) {
    const outPath = path.join(projectRoot, 'out', 'controls');
    if (fs.existsSync(outPath)) {
      // Find the subdirectory containing bundle.js
      const entries = fs.readdirSync(outPath);
      for (const entry of entries) {
        const bundlePath = path.join(outPath, entry, 'bundle.js');
        if (fs.existsSync(bundlePath)) {
          return path.join(outPath, entry);
        }
      }
    }
    projectRoot = path.dirname(projectRoot);
  }
  throw new Error(
    `Could not find compiled bundle. Run 'npm run build' in the PCF project first.\n` +
    `Searched from: ${controlDir}`
  );
}

function loadControl(state: PcfPluginState): void {
  if (!state.controlDir) return;

  const manifestPath = path.join(state.controlDir, 'ControlManifest.Input.xml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`ControlManifest.Input.xml not found at: ${manifestPath}`);
  }
  const xmlContent = fs.readFileSync(manifestPath, 'utf-8');
  state.manifest = parseManifest(xmlContent);

  state.outDir = resolveOutDir(state.controlDir, state.manifest);

  // Resolve project root
  state.projectRoot = state.controlDir;
  let searchDir = state.controlDir;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(searchDir, 'out'))) {
      state.projectRoot = searchDir;
      break;
    }
    searchDir = path.dirname(searchDir);
  }

  // Check for data.json
  state.hasDataJson = [
    path.join(state.controlDir, 'data.json'),
    path.join(state.projectRoot, 'data.json'),
  ].some(p => fs.existsSync(p));

  // CSS files
  state.cssFiles = state.manifest.resources.css.map(c => c.path);

  // RESX
  state.resxStrings = {};
  // Scan for RESX files recursively in controlDir and outDir
  function scanResxRecursive(dir: string) {
    if (!fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          scanResxRecursive(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.resx')) {
          Object.assign(state.resxStrings, parseResx(fs.readFileSync(path.join(dir, entry.name), 'utf-8')));
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  scanResxRecursive(state.controlDir);
  if (state.outDir !== state.controlDir) scanResxRecursive(state.outDir);

  state.isGalleryMode = false;

  console.log(`[pcf-workbench] Loaded: ${state.manifest.namespace}.${state.manifest.constructor} v${state.manifest.version}`);
  console.log(`[pcf-workbench] Type: ${state.manifest.controlType}`);
  console.log(`[pcf-workbench] Bundle: ${state.outDir}/bundle.js`);
  console.log(`[pcf-workbench] Project root: ${state.projectRoot}`);
  console.log(`[pcf-workbench] Properties: ${state.manifest.properties.map(p => p.name).join(', ')}`);
  console.log(`[pcf-workbench] data.json: ${state.hasDataJson ? 'found' : 'not found'}`);
  const resxCount = Object.keys(state.resxStrings).length;
  if (resxCount > 0) console.log(`[pcf-workbench] RESX: ${resxCount} strings`);
}

export function pcfPlugin(): Plugin {
  const state: PcfPluginState = {
    manifest: null,
    controlDir: '',
    projectRoot: '',
    outDir: '',
    cssFiles: [],
    hasDataJson: false,
    resxStrings: {},
    isGalleryMode: false,
    workspaceRoot: '',
  };

  let serverRef: ViteDevServer | null = null;

  return {
    name: 'pcf-harness',

    config() {
      const controlPath = process.env.PCF_CONTROL_PATH;
      state.workspaceRoot = process.env.PCF_WORKSPACE_ROOT || path.resolve(process.cwd(), '..');

      if (!controlPath) {
        // Gallery mode — no specific control, show the catalog
        state.isGalleryMode = true;
        console.log('[pcf-workbench] Gallery mode — scanning workspace for controls');
        return;
      }
      state.controlDir = path.resolve(controlPath);
    },

    buildStart() {
      if (!state.controlDir) return;
      loadControl(state);
    },

    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },

    transformIndexHtml() {
      if (!state.manifest) return [];
      const libs = state.manifest.resources.platformLibraries;
      const tags: Array<{ tag: string; attrs: Record<string, string>; injectTo: 'head-prepend' }> = [];

      // Inject React UMD scripts BEFORE everything else so globals exist
      // when the PCF bundle loads
      const reactLib = libs.find(l => l.name === 'React');
      if (reactLib) {
        const major = reactLib.version.split('.')[0];
        if (major === '16') {
          tags.push(
            { tag: 'script', attrs: { src: 'https://unpkg.com/react@16.14.0/umd/react.development.js' }, injectTo: 'head-prepend' },
            { tag: 'script', attrs: { src: 'https://unpkg.com/react-dom@16.14.0/umd/react-dom.development.js' }, injectTo: 'head-prepend' },
          );
        } else if (major === '18') {
          tags.push(
            { tag: 'script', attrs: { src: 'https://unpkg.com/react@18.3.1/umd/react.development.js' }, injectTo: 'head-prepend' },
            { tag: 'script', attrs: { src: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js' }, injectTo: 'head-prepend' },
          );
        }
      }
      return tags;
    },


    load(id: string) {
      if (id === RESOLVED_ID) {
        return `export const manifest = ${JSON.stringify(state.manifest)};
export const bundlePath = "/pcf-bundle/bundle.js";
export const cssFiles = ${JSON.stringify(state.cssFiles.map(f => '/pcf-css/' + f))};
export const hasDataJson = ${state.hasDataJson};
export const resxStrings = ${JSON.stringify(state.resxStrings)};
export const isGalleryMode = ${state.isGalleryMode};
export const controlDir = ${JSON.stringify(state.controlDir)};`;
      }
    },

    configureServer(server: ViteDevServer) {
      serverRef = server;

      // API: switch to a control or back to gallery
      server.middlewares.use('/api/switch-control', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk: string) => body += chunk);
        req.on('end', () => {
          try {
            const { controlDir } = JSON.parse(body);

            if (!controlDir) {
              console.log(`[pcf-workbench] Switching to gallery mode`);
              state.controlDir = '';
              state.manifest = null;
              state.outDir = '';
              state.cssFiles = [];
              state.resxStrings = {};
              state.hasDataJson = false;
              state.isGalleryMode = true;
            } else {
              console.log(`[pcf-workbench] Switching to: ${controlDir}`);
              state.controlDir = path.resolve(controlDir);
              loadControl(state);
            }

            // Invalidate ALL modules in the graph to force fresh virtual module
            server.moduleGraph.invalidateAll();

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));

            // Send full reload after response is sent
            setTimeout(() => {
              server.ws.send({ type: 'full-reload', path: '*' });
            }, 100);
          } catch (err: any) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      // Watch bundle.js for changes and notify client for hot reload
      if (state.outDir) {
        try {
          let debounceTimer: ReturnType<typeof setTimeout> | null = null;
          fs.watch(state.outDir, { recursive: false }, (_eventType, filename) => {
            if (filename === 'bundle.js' || filename === 'ControlManifest.xml') {
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                console.log(`[pcf-workbench] Bundle changed — sending reload signal`);
                server.ws.send({
                  type: 'custom',
                  event: 'pcf-bundle-changed',
                  data: { timestamp: Date.now() },
                });
              }, 500);
            }
          });
          console.log(`[pcf-workbench] Watching for bundle changes: ${state.outDir}`);
        } catch {
          console.warn(`[pcf-workbench] Could not watch bundle directory (hot reload disabled)`);
        }
      }

      // Serve bundle.js and other files from the PCF out directory
      server.middlewares.use('/pcf-bundle', (req, res, next) => {
        if (!state.outDir || !req.url) return next();
        // Strip query string before resolving file path
        const urlPath = req.url.split('?')[0];
        const filePath = path.join(state.outDir, urlPath);
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          const mimeTypes: Record<string, string> = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.xml': 'application/xml',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.otf': 'font/otf',
            '.ttf': 'font/ttf',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
          };
          res.setHeader('Content-Type', mimeTypes[ext] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(filePath).pipe(res);
        } else {
          next();
        }
      });

      // List all resource files in the bundle output (images, fonts, etc.)
      server.middlewares.use('/api/bundle-resources', (req, res) => {
        if (!state.outDir) {
          res.setHeader('Content-Type', 'application/json');
          res.end('[]');
          return;
        }
        const resourceExtsForList = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.otf', '.ttf', '.woff', '.woff2', '.resx']);
        const files: string[] = [];
        function walk(dir: string) {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                walk(path.join(dir, entry.name));
              } else if (resourceExtsForList.has(path.extname(entry.name).toLowerCase())) {
                // Return filename only (getResource uses just the filename)
                files.push(entry.name);
              }
            }
          } catch { /* skip */ }
        }
        walk(state.outDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([...new Set(files)]));
      });

      // Fallback: serve control resources (images, fonts) from outDir for relative path references
      // This handles <img src="images/WorkOrder.svg"> in compiled bundles
      const resourceExts = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.otf', '.ttf', '.woff', '.woff2', '.eot']);
      server.middlewares.use((req, res, next) => {
        if (!state.outDir || !req.url) return next();
        const urlPath = req.url.split('?')[0];
        const ext = path.extname(urlPath).toLowerCase();
        if (!resourceExts.has(ext)) return next();
        const filePath = path.join(state.outDir, urlPath);
        if (fs.existsSync(filePath)) {
          const mimeMap: Record<string, string> = {
            '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
            '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
          };
          res.setHeader('Content-Type', mimeMap[ext] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        next();
      });

      // Serve data.json from control dir or project root
      server.middlewares.use('/pcf-data', (req, res, next) => {
        if (!req.url) return next();
        const urlPath = req.url.split('?')[0];
        if (urlPath === '/data.json' || urlPath === '/') {
          // Search control dir first, then project root
          const candidates = [
            path.join(state.controlDir, 'data.json'),
            path.join(state.projectRoot, 'data.json'),
          ];
          for (const filePath of candidates) {
            if (fs.existsSync(filePath)) {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          }
        }
        // Serve test-scenarios.json
        if (urlPath === '/test-scenarios.json') {
          const scenarioCandidates = [
            path.join(state.controlDir, 'test-scenarios.json'),
            path.join(state.projectRoot, 'test-scenarios.json'),
          ];
          for (const filePath of scenarioCandidates) {
            if (fs.existsSync(filePath)) {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          }
        }

        // Return empty data if no file found
        res.setHeader('Content-Type', 'application/json');
        res.end(urlPath === '/test-scenarios.json' ? '[]' : '{}');
      });

      // Serve CSS from the control source directory
      server.middlewares.use('/pcf-css', (req, res, next) => {
        if (!state.controlDir || !req.url) return next();
        const urlPath = req.url.split('?')[0];
        // Check controlDir first, then outDir (compiled controls have CSS alongside bundle)
        const candidates = [
          path.join(state.controlDir, urlPath),
          state.outDir ? path.join(state.outDir, urlPath) : '',
        ].filter(Boolean);
        for (const filePath of candidates) {
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'text/css');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        next();
      });

      // Gallery API — scan workspace for all PCF controls
      server.middlewares.use('/api/gallery', (req, res, next) => {
        if (!req.url) return next();
        const urlPath = req.url.split('?')[0];

        if (urlPath === '/controls' || urlPath === '/') {
          try {
            const controls = scanWorkspace(state.workspaceRoot);
            // Strip absolute paths for security, send relative + metadata
            const entries = controls.map(c => ({
              namespace: c.manifest.namespace,
              constructor: c.manifest.constructor,
              version: c.manifest.version,
              controlType: c.manifest.controlType,
              displayNameKey: c.manifest.displayNameKey,
              descriptionKey: c.manifest.descriptionKey,
              properties: c.manifest.properties,
              featureUsage: c.manifest.featureUsage,
              platformLibraries: c.manifest.resources.platformLibraries,
              cssCount: c.manifest.resources.css.length,
              hasBuild: c.hasBuild,
              hasDataJson: c.hasDataJson,
              hasTestScenarios: c.hasTestScenarios,
              hasThumbnail: c.hasThumbnail,
              controlDir: c.controlDir,
              lastModified: c.lastModified,
              bundleSize: c.bundleSize,
              packageSize: c.packageSize,
              isPrivate: c.isPrivate,
            }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(entries));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        next();
      });

      // Serve thumbnail images from control directories
      // URL: /api/thumbnail?dir=<controlDir>
      server.middlewares.use('/api/thumbnail', (req, res, next) => {
        if (!req.url) return next();
        const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
        const controlDir = params.get('dir');
        if (!controlDir) { res.statusCode = 400; res.end(); return; }

        try {
          // Check for thumbnail.gif/jpg/png files (gif first for animated thumbnails)
          for (const ext of ['gif', 'jpg', 'jpeg', 'png']) {
            const thumbPath = path.join(controlDir, `thumbnail.${ext}`);
            if (fs.existsSync(thumbPath)) {
              res.setHeader('Content-Type', `image/${ext === 'jpg' ? 'jpeg' : ext}`);
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(thumbPath).pipe(res);
              return;
            }
          }
          // Also check project root (parent directories)
          let searchDir = controlDir;
          for (let i = 0; i < 3; i++) {
            searchDir = path.dirname(searchDir);
            for (const ext of ['gif', 'jpg', 'jpeg', 'png']) {
              const thumbPath = path.join(searchDir, `thumbnail.${ext}`);
              if (fs.existsSync(thumbPath)) {
                res.setHeader('Content-Type', `image/${ext === 'jpg' ? 'jpeg' : ext}`);
                res.setHeader('Cache-Control', 'no-cache');
                fs.createReadStream(thumbPath).pipe(res);
                return;
              }
            }
          }
          res.statusCode = 404;
          res.end();
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });

      // Save thumbnail from harness (POST from auto-capture)
      server.middlewares.use('/api/save-thumbnail', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { controlDir, thumbnail } = JSON.parse(body);
            if (!controlDir || !thumbnail) throw new Error('Missing controlDir or thumbnail');

            // Extract base64 data from data URL and save as thumbnail.jpg
            const match = thumbnail.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!match) throw new Error('Invalid thumbnail data URL');
            const imgBuffer = Buffer.from(match[2], 'base64');
            const ext = match[1] === 'gif' ? 'gif' : match[1] === 'png' ? 'png' : 'jpg';
            const thumbPath = path.join(controlDir, `thumbnail.${ext}`);
            fs.writeFileSync(thumbPath, imgBuffer);
            console.log(`[pcf-workbench] Thumbnail saved: ${thumbPath} (${(imgBuffer.length / 1024).toFixed(0)} KB)`);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: thumbPath }));
          } catch (err: any) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });
    },
  };
}
