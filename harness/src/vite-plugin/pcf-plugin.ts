import type { Plugin, ViteDevServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest } from '../parser/manifest-parser';
import { parseResx } from '../parser/resx-parser';
import { scanWorkspace } from '../scanner/workspace-scanner';
import type { ManifestConfig } from '../types/manifest';
import {
  extractDeployedControl,
  listCachedExtracts,
  deleteCachedExtract,
  listDeployedControlsCatalog,
  ExtractError,
  safeName as extractSafeName,
} from './extract-control';
import { getSessionSecret } from './dataverse-security';
import crypto from 'node:crypto';
import {
  BuildWatcher,
  findProjectRootForBuild,
  projectHasBuildScript,
  type BuildStatus,
} from './build-watcher';

const VIRTUAL_ID = 'virtual:pcf-manifest';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

interface PcfPluginState {
  manifest: ManifestConfig | null;
  controlDir: string;
  projectRoot: string;
  outDir: string;
  cssFiles: string[];
  hasDataJson: boolean;
  /** RESX strings bucketed by LCID. 1033 is default; 0 holds strings from
   *  RESX files whose filename has no recognizable LCID. */
  resxStrings: Record<number, Record<string, string>>;
  isGalleryMode: boolean;
  workspaceRoot: string;
  /** True when the server was started in gallery mode (no PCF_CONTROL_PATH) */
  launchedAsGallery: boolean;
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
  // Deployed layout: bundle.js sits next to ControlManifest.xml — the
  // control directory IS the out directory.
  if (fs.existsSync(path.join(controlDir, 'bundle.js'))) {
    return controlDir;
  }
  throw new Error(
    `Could not find compiled bundle. Run 'npm run build' in the PCF project first.\n` +
    `Searched from: ${controlDir}`
  );
}

/** Pinned defaults when the bundle references a Fluent major that the manifest
 *  doesn't declare a version for. Keep these on stable, widely-deployed lines —
 *  Fluent v8 LTS-ish and the v9 release series UCI shipped during M9 testing. */
const FLUENT_DEFAULT_VERSION: Record<'v8' | 'v9', string> = {
  v8: '8.121.1',
  v9: '9.46.0',
};

/**
 * Scan the compiled bundle for `FluentUIReactv<digits>` global references and
 * return the set of Fluent majors needed (with a chosen npm version per major).
 *
 * Why this is necessary (M9 finding): a deployed bundle's manifest is not a
 * reliable source of truth for which Fluent versions it actually imports.
 * Production controls routinely use v8 utilities (color, styling) alongside
 * v9 components in the same bundle while the manifest declares only one.
 *
 * Version selection rule per major:
 *   1. If the manifest's Fluent platform-library entry matches this major, use
 *      that version (best fidelity to what the control was built against).
 *   2. Otherwise use FLUENT_DEFAULT_VERSION[major].
 *
 * Returns undefined if the bundle references no Fluent globals at all.
 */
function detectFluentNeeds(
  outDir: string,
  manifest: ManifestConfig,
): { v8?: string; v9?: string } | undefined {
  const bundlePath = path.join(outDir, 'bundle.js');
  if (!fs.existsSync(bundlePath)) return undefined;
  let source: string;
  try {
    source = fs.readFileSync(bundlePath, 'utf-8');
  } catch {
    return undefined;
  }

  const matches = source.matchAll(/FluentUIReactv(\d+)/g);
  const majors = new Set<'v8' | 'v9'>();
  for (const m of matches) {
    const lead = m[1][0];
    if (lead === '8') majors.add('v8');
    else if (lead === '9') majors.add('v9');
  }
  if (majors.size === 0) return undefined;

  const declaredFluent = manifest.resources.platformLibraries.find(l => l.name === 'Fluent');
  const declaredMajor: 'v8' | 'v9' | null = declaredFluent
    ? declaredFluent.version.split('.')[0] === '9' ? 'v9' : 'v8'
    : null;

  const out: { v8?: string; v9?: string } = {};
  for (const m of majors) {
    out[m] = (declaredMajor === m && declaredFluent)
      ? declaredFluent.version
      : FLUENT_DEFAULT_VERSION[m];
  }
  console.log(
    `[pcf-workbench] Fluent needs (from bundle scan): ${Object.entries(out).map(([k, v]) => `${k}@${v}`).join(', ')}`
  );
  return out;
}

/**
 * Reconcile the manifest's React platform-library version with what Fluent
 * v9 needs at runtime.
 *
 * Why: deployed manifests routinely declare React 16 but bundle a recent
 * Fluent v9 (≥ 9.40) that needs React 17/18's useSyncExternalStore
 * dispatcher. The harness's React 16 polyfill of useSyncExternalStore is
 * incomplete (it cannot replicate the internal dispatcher object with
 * `.set`), so Fluent crashes in commit with "Cannot read properties of
 * undefined (reading 'set')". Real UCI has the same issue — controls that
 * ship this combination are de-facto broken in production too, but it's
 * masked by hosting environment. We have to be pragmatic.
 *
 * Resolution order (first match wins):
 *   1. Bundle uses Fluent v9 ≥ 9.40 AND declared React major < 18 →
 *      upgrade to React 18.3.1 (override the manifest to make the control
 *      actually run; warn loudly).
 *   2. Manifest declares React explicitly → respect it.
 *   3. Bundle uses Fluent v9 ≥ 9.40 (no React declared) → React 18.3.1.
 *   4. Default → React 16.14.0 (matches UCI production).
 */
function resolveReactVersion(
  manifest: ManifestConfig,
): { version: string; source: 'manifest' | 'fluent-upgrade' | 'default' } {
  const declared = manifest.resources.platformLibraries.find(l => l.name === 'React');
  const fluentV9 = manifest.resources.fluentNeeds?.v9;
  const fluentNeedsR18 = (() => {
    if (!fluentV9) return false;
    const [maj, minRaw] = fluentV9.split('.');
    return maj === '9' && Number(minRaw ?? '0') >= 40;
  })();

  if (fluentNeedsR18) {
    const declaredMajor = declared ? Number(declared.version.split('.')[0]) : NaN;
    if (!declared || declaredMajor < 18) {
      return { version: '18.3.1', source: 'fluent-upgrade' };
    }
  }
  if (declared) return { version: declared.version, source: 'manifest' };
  return { version: '16.14.0', source: 'default' };
}

function loadControl(state: PcfPluginState): void {
  if (!state.controlDir) return;

  const inputManifest = path.join(state.controlDir, 'ControlManifest.Input.xml');
  const deployedManifest = path.join(state.controlDir, 'ControlManifest.xml');
  const manifestPath = fs.existsSync(inputManifest)
    ? inputManifest
    : fs.existsSync(deployedManifest)
      ? deployedManifest
      : null;
  if (!manifestPath) {
    throw new Error(
      `Manifest not found. Looked for:\n  ${inputManifest}\n  ${deployedManifest}`,
    );
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

  // M9 — detect Fluent majors actually referenced by the compiled bundle.
  // Deployed controls routinely mix Fluent v8 and v9: the manifest may declare
  // only one but the bundle imports both (e.g. v8 color utils + v9 UI). Without
  // this scan, the loader can only load one major, which leaves the other major's
  // globals undefined → cryptic runtime crashes (e.g. "undefined.gap" when v8 is
  // aliased over v9 calls to shorthands.gap).
  state.manifest.resources.fluentNeeds = detectFluentNeeds(state.outDir, state.manifest);
  const { version: effReact, source: effReactSource } = resolveReactVersion(state.manifest);
  state.manifest.resources.effectiveReactVersion = effReact;
  state.manifest.resources.effectiveReactSource = effReactSource;
  console.log(
    `[pcf-workbench] React version: ${effReact} (source: ${effReactSource})` +
    (effReactSource === 'fluent-upgrade'
      ? ` — bumped to React 18 because Fluent v9 ≥ 9.40 needs the real useSyncExternalStore dispatcher` +
        (state.manifest.resources.platformLibraries.find(l => l.name === 'React')
          ? ` (manifest declared React ${state.manifest.resources.platformLibraries.find(l => l.name === 'React')!.version} — overridden to keep the control functional)`
          : '')
      : '')
  );

  // RESX — bucketed by LCID parsed from filename like `name.1033.resx`.
  // Files without a 4-digit LCID stem fall into bucket 0 (treated as default).
  state.resxStrings = {};
  function scanResxRecursive(dir: string) {
    if (!fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          scanResxRecursive(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.resx')) {
          const m = entry.name.match(/\.(\d{4})\.resx$/);
          const lcid = m ? Number(m[1]) : 0;
          const parsed = parseResx(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
          if (!state.resxStrings[lcid]) state.resxStrings[lcid] = {};
          Object.assign(state.resxStrings[lcid], parsed);
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
  const lcidBuckets = Object.keys(state.resxStrings).map(Number);
  const totalResx = lcidBuckets.reduce((n, l) => n + Object.keys(state.resxStrings[l]).length, 0);
  if (totalResx > 0) {
    console.log(`[pcf-workbench] RESX: ${totalResx} strings across ${lcidBuckets.length} locale${lcidBuckets.length === 1 ? '' : 's'} [${lcidBuckets.sort((a, b) => a - b).join(', ')}]`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EntityDefinitions / metadata.json helpers (used by the /api/data middleware)
// ────────────────────────────────────────────────────────────────────────────

/** Collect raw Dataverse EntityDefinitions from metadata.json files on disk. */
function collectEntityDefinitions(state: PcfPluginState): any[] {
  const out: any[] = [];
  const searchDirs = [state.controlDir, state.projectRoot];
  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const files: string[] = [];
    const metaPath = path.join(dir, 'metadata.json');
    if (fs.existsSync(metaPath)) files.push(metaPath);
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith('EntityDefinitions_') && file.endsWith('.json')) {
          files.push(path.join(dir, file));
        }
      }
    } catch { /* skip */ }
    for (const filePath of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        for (const ent of extractEntities(raw)) {
          if (!ent?.LogicalName || seen.has(ent.LogicalName)) continue;
          seen.add(ent.LogicalName);
          out.push(ent);
        }
      } catch { /* skip invalid */ }
    }
  }
  return out;
}

/**
 * Pull raw EntityDefinitions out of any metadata.json shape we accept:
 *  - { value: [entity, …] }              Dataverse API response
 *  - [{ value: […] }, …]                 array of such responses
 *  - { LogicalName, Attributes, … }      a bare entity
 *  - { entityName: { displayName, columns } }   simple format (synthesised)
 */
function extractEntities(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.flatMap(extractEntities);
  if (Array.isArray(raw.value)) return raw.value;
  if (raw.LogicalName && Array.isArray(raw.Attributes)) return [raw];
  // Simple format → synthesise minimal Dataverse-shaped entities
  if (typeof raw === 'object') {
    const synth: any[] = [];
    for (const [logicalName, val] of Object.entries(raw)) {
      const v = val as any;
      if (!v || typeof v !== 'object' || !v.columns) continue;
      synth.push({
        LogicalName: logicalName,
        DisplayName: { UserLocalizedLabel: { Label: v.displayName ?? logicalName, LanguageCode: 1033 } },
        PrimaryIdAttribute: v.primaryIdAttribute,
        PrimaryNameAttribute: v.primaryNameAttribute,
        _pcfWorkbenchProvenance: v.provenance,
        Attributes: Object.entries(v.columns).map(([col, c]) => {
          const cc = c as any;
          const attr: any = {
            LogicalName: col,
            AttributeType: cc.type ?? 'String',
            DisplayName: { UserLocalizedLabel: { Label: cc.displayName ?? col, LanguageCode: 1033 } },
            RequiredLevel: { Value: 'None' },
            AttributeOf: null,
          };
          if (Array.isArray(cc.options)) {
            attr.OptionSet = {
              Options: cc.options.map((o: any) => ({
                Value: o.value,
                Label: { UserLocalizedLabel: { Label: o.text, LanguageCode: 1033 } },
              })),
            };
          }
          if (Array.isArray(cc.targets)) attr.Targets = cc.targets;
          if (cc.defaultValue !== undefined) attr.DefaultValue = cc.defaultValue;
          return attr;
        }),
      });
    }
    return synth;
  }
  return [];
}

/** Project a Dataverse record to a $select subset. Drops Attributes by default
 *  for entity-level reads unless `keepAttributes` is true. */
function projectColumns(
  record: any,
  selectCols: string[] | null,
  opts: { keepAttributes?: boolean } = {},
): Record<string, any> {
  if (!record) return record;
  if (!selectCols) {
    if (opts.keepAttributes === false) {
      const { Attributes, ...rest } = record;
      return rest;
    }
    return record;
  }
  const result: Record<string, any> = {};
  for (const col of selectCols) {
    if (col in record) result[col] = record[col];
  }
  // Always include MetadataId / LogicalName / @odata.type as Dataverse does
  if ('LogicalName' in record && !('LogicalName' in result)) result.LogicalName = record.LogicalName;
  if ('MetadataId' in record && !('MetadataId' in result)) result.MetadataId = record.MetadataId;
  if ('@odata.type' in record && !('@odata.type' in result)) result['@odata.type'] = record['@odata.type'];
  return result;
}

function write404(res: import('node:http').ServerResponse, message: string): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { code: '0x80060888', message } }));
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
    launchedAsGallery: false,
  };

  let serverRef: ViteDevServer | null = null;

  return {
    name: 'pcfworkbench',

    config() {
      const controlPath = process.env.PCF_CONTROL_PATH;
      const explicitRoot = process.env.PCF_WORKSPACE_ROOT;

      if (explicitRoot) {
        state.workspaceRoot = path.resolve(explicitRoot);
      } else if (controlPath) {
        // Derive workspace root from the control path — walk up until we
        // find a parent that isn't the control itself (heuristic: go up
        // past nested ControlName/ControlName/ structure to the gallery root).
        let candidate = path.resolve(controlPath);
        for (let i = 0; i < 5; i++) {
          const parent = path.dirname(candidate);
          if (parent === candidate) break;
          candidate = parent;
          // Stop if this directory contains multiple child dirs with manifests
          try {
            const children = fs.readdirSync(candidate, { withFileTypes: true })
              .filter(e => e.isDirectory() && !['node_modules', 'out', '.git', '.vs'].includes(e.name));
            let manifestCount = 0;
            for (const child of children) {
              const childPath = path.join(candidate, child.name);
              try {
                const walk = (dir: string, depth: number): boolean => {
                  if (depth > 3) return false;
                  const entries = fs.readdirSync(dir, { withFileTypes: true });
                  for (const e of entries) {
                    if (e.isFile() && (e.name === 'ControlManifest.Input.xml' || e.name === 'ControlManifest.xml')) return true;
                    if (e.isDirectory() && !['node_modules', 'out', '.git'].includes(e.name)) {
                      if (walk(path.join(dir, e.name), depth + 1)) return true;
                    }
                  }
                  return false;
                };
                if (walk(childPath, 0)) manifestCount++;
              } catch { /* skip */ }
              if (manifestCount >= 2) break;
            }
            if (manifestCount >= 2) {
              state.workspaceRoot = candidate;
              break;
            }
          } catch { /* skip */ }
        }
        if (!state.workspaceRoot) {
          // Fallback: use the grandparent of the control path
          state.workspaceRoot = path.resolve(controlPath, '..', '..');
        }
      } else {
        state.workspaceRoot = path.resolve(process.cwd(), '..');
      }

      if (!controlPath) {
        // Gallery mode — no specific control, show the catalog
        state.isGalleryMode = true;
        state.launchedAsGallery = true;
        console.log('[pcf-workbench] Gallery mode — scanning workspace for controls');
        console.log(`[pcf-workbench] Workspace root: ${state.workspaceRoot}`);
        return;
      }
      state.controlDir = path.resolve(controlPath);
      console.log(`[pcf-workbench] Single-control mode — gallery root: ${state.workspaceRoot}`);
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
      const tags: Array<{ tag: string; attrs: Record<string, string>; injectTo: 'head-prepend' }> = [];

      // Inject React UMD scripts BEFORE everything else so globals exist
      // when the PCF bundle loads. The effective version was resolved during
      // loadControl via resolveReactVersion — it reconciles the manifest
      // declaration with Fluent v9 ≥ 9.40's hard requirement on React 17/18.
      //
      // CRITICAL: when we *upgrade* a manifest-declared R<18 control to R18
      // (source: 'fluent-upgrade'), we MUST NOT load a separate React 18 UMD —
      // the harness is already running React 18, and two R18 instances in the
      // same page collide on griffel's shared dispatcher state and unstyle the
      // harness chrome. Instead, main.tsx exposes the harness's bundled React
      // on window.React/window.ReactDOM and react-aliases.ts aliases it under
      // the versioned globals (Reactv16/Reactv17/Reactv18) the control bundle
      // imports as `external`. Single React 18 instance, no clash.
      const effective = state.manifest.resources.effectiveReactVersion ?? '16.14.0';
      const source = state.manifest.resources.effectiveReactSource;
      const major = effective.split('.')[0];
      const reuseHarnessReact = major === '18' && (source === 'fluent-upgrade' || source === 'default');

      if (reuseHarnessReact) {
        // No UMD injection — main.tsx already assigned window.React/ReactDOM
        // from the harness's bundled React 18.
      } else if (major === '16' || major === '17' || major === '18') {
        tags.push(
          { tag: 'script', attrs: { src: `https://unpkg.com/react@${effective}/umd/react.development.js` }, injectTo: 'head-prepend' },
          { tag: 'script', attrs: { src: `https://unpkg.com/react-dom@${effective}/umd/react-dom.development.js` }, injectTo: 'head-prepend' },
        );
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
export const controlDir = ${JSON.stringify(state.controlDir)};
export const launchedAsGallery = ${state.launchedAsGallery};`;
      }
    },

    configureServer(server: ViteDevServer) {
      serverRef = server;

      /* ---------- Build watcher (M9) ---------- */
      // Single-control mode only: when state.controlDir is set and the user
      // hasn't opted out via PCF_NO_WATCH, spawn a build watcher that runs
      // `npm run build` whenever a source file changes. Status events fan
      // out via the SSE endpoint below; the existing Vite watcher already
      // HMR-reloads on out/bundle.js change, closing the loop.
      let buildWatcher: BuildWatcher | null = null;
      const sseClients = new Set<import('node:http').ServerResponse>();
      let lastBuildStatus: BuildStatus = {
        phase: 'idle',
        seq: 0,
        at: new Date().toISOString(),
      };
      const broadcastStatus = (status: BuildStatus) => {
        lastBuildStatus = status;
        const payload = `data: ${JSON.stringify(status)}\n\n`;
        for (const res of sseClients) {
          try { res.write(payload); } catch { /* dead client */ }
        }
      };

      const startBuildWatcher = () => {
        if (buildWatcher) return;
        if (process.env.PCF_NO_WATCH === '1') {
          console.log('[pcf-workbench:build-watch] disabled (PCF_NO_WATCH=1)');
          return;
        }
        if (!state.controlDir) return;
        const projectRoot = findProjectRootForBuild(state.controlDir);
        if (!projectRoot) {
          console.log('[pcf-workbench:build-watch] no package.json found upwards from control dir; watcher disabled');
          return;
        }
        if (!projectHasBuildScript(projectRoot)) {
          console.log('[pcf-workbench:build-watch] project has no `build` script; watcher disabled');
          return;
        }
        buildWatcher = new BuildWatcher({
          projectRoot,
          controlDir: state.controlDir,
          onStatus: broadcastStatus,
        });
        console.log(`[pcf-workbench:build-watch] enabled (project: ${projectRoot})`);
      };
      startBuildWatcher();

      // SSE: stream build status to the harness UI.
      server.middlewares.use('/api/build-watch/events', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify(lastBuildStatus)}\n\n`);
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* */ }
        }, 25000);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
      });

      // Snapshot endpoint for clients that don't speak SSE (or for tests).
      server.middlewares.use('/api/build-watch/status', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: buildWatcher !== null,
          status: lastBuildStatus,
        }));
      });

      // Cleanup on dev server shutdown so the spawned npm child doesn't
      // outlive us. Also catches Ctrl+C via the bin entry point.
      const httpSrv = server.httpServer;
      const dispose = () => {
        if (buildWatcher) {
          buildWatcher.dispose();
          buildWatcher = null;
        }
        for (const res of sseClients) {
          try { res.end(); } catch { /* */ }
        }
        sseClients.clear();
      };
      if (httpSrv) httpSrv.once('close', dispose);
      process.once('beforeExit', dispose);
      process.once('SIGINT', () => { dispose(); process.exit(0); });
      process.once('SIGTERM', () => { dispose(); process.exit(0); });

      // API: Dataverse EntityDefinitions proxy backed by metadata.json
      // ────────────────────────────────────────────────────────────────────
      // Deployed PCFs frequently call the Dataverse Web API directly via
      // fetch (not via context.webAPI) to resolve entity/attribute metadata
      // at form-load time. The harness has metadata.json with the same
      // information; serve those reads here so controls render their bodies
      // instead of stalling on a 404.
      //
      // Supports:
      //   GET /api/data/v9.2/EntityDefinitions(LogicalName='X')
      //       (+ ?$select=… / ?$expand=Attributes(…))
      //   GET /api/data/v9.2/EntityDefinitions(LogicalName='X')/Attributes
      //       (+ ?$select=…)
      //   GET /api/data/v9.2/EntityDefinitions
      //       (+ ?$filter=LogicalName eq 'X' / ?$select=…)
      // Other Web API endpoints fall through to the next middleware (404).
      server.middlewares.use('/api/data', (req, res, next) => {
        if (!req.url || req.method !== 'GET') return next();
        const [pathOnly, search = ''] = req.url.split('?');
        // Supported shapes (vX.X = any version):
        //   /vX.X/EntityDefinitions
        //   /vX.X/EntityDefinitions(LogicalName='X')
        //   /vX.X/EntityDefinitions(LogicalName='X')/Attributes
        //   /vX.X/EntityDefinitions(LogicalName='X')/Attributes(LogicalName='Y')
        //   /vX.X/EntityDefinitions(LogicalName='X')/Attributes/Microsoft.Dynamics.CRM.<Type>AttributeMetadata
        //   /vX.X/EntityDefinitions(LogicalName='X')/Attributes(LogicalName='Y')/Microsoft.Dynamics.CRM.<Type>AttributeMetadata
        const entDefRe = /^\/v\d+\.\d+\/EntityDefinitions(\(LogicalName='([^']+)'\))?(\/Attributes(\(LogicalName='([^']+)'\))?(\/Microsoft\.Dynamics\.CRM\.(\w+))?)?\/?$/;
        const m = pathOnly.match(entDefRe);
        if (!m) return next();
        const requestedLogicalName = m[2] ?? null;
        const attributesPath = !!m[3];
        const requestedAttrLogicalName = m[5] ?? null;
        const typedAttrCast = m[7] ?? null; // e.g. "PicklistAttributeMetadata" / "LookupAttributeMetadata"

        const entities = collectEntityDefinitions(state);
        const params = new URLSearchParams(search);

        // Filter: /EntityDefinitions?$filter=LogicalName eq 'X'
        let filtered = entities;
        if (requestedLogicalName) {
          filtered = entities.filter(e => e.LogicalName === requestedLogicalName);
        } else {
          const filterExpr = params.get('$filter');
          const filterMatch = filterExpr?.match(/LogicalName\s+eq\s+'([^']+)'/i);
          if (filterMatch) filtered = entities.filter(e => e.LogicalName === filterMatch[1]);
        }

        const selectCols = params.get('$select')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
        const expandClause = params.get('$expand') ?? '';
        const expandAttrs = expandClause.toLowerCase().includes('attributes');
        const expandOptionSet = /\boptionset\b/i.test(expandClause);
        const expandGlobalOptionSet = /\bglobaloptionset\b/i.test(expandClause);
        const expandTargets = /\btargets\b/i.test(expandClause);

        const baseUrl = `${req.headers.host ? `http://${req.headers.host}` : ''}/api/data${pathOnly.split('/').slice(0, 2).join('/')}`;

        if (attributesPath) {
          const ent = filtered[0];
          if (!ent) {
            return write404(res, `Entity '${requestedLogicalName}' not found in metadata.json`);
          }
          let attrs: any[] = ent.Attributes ?? [];
          // Filter by single-attr selector
          if (requestedAttrLogicalName) {
            attrs = attrs.filter(a => a.LogicalName === requestedAttrLogicalName);
          }
          // Filter by typed cast (e.g. only Picklist attrs)
          if (typedAttrCast) {
            attrs = attrs.filter(a => typeof a['@odata.type'] === 'string'
              && a['@odata.type'].endsWith(`.${typedAttrCast}`));
          }

          if ((requestedAttrLogicalName || typedAttrCast) && attrs.length === 0) {
            return write404(res, `Attribute not found for ${requestedLogicalName}`);
          }

          // Project & optionally drop heavy nested objects that weren't asked for
          const projected = attrs.map(a => {
            const p = projectColumns(a, selectCols, { keepAttributes: true }) as Record<string, any>;
            // When $expand is used, ensure expanded shapes survive $select projection
            if (expandOptionSet && a.OptionSet !== undefined && !('OptionSet' in p)) p.OptionSet = a.OptionSet;
            if (expandGlobalOptionSet && a.GlobalOptionSet !== undefined && !('GlobalOptionSet' in p)) p.GlobalOptionSet = a.GlobalOptionSet;
            if (expandTargets && a.Targets !== undefined && !('Targets' in p)) p.Targets = a.Targets;
            return p;
          });

          // Single-attribute path returns the single record, not a collection
          if (requestedAttrLogicalName) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(JSON.stringify({
              '@odata.context': `${baseUrl}/$metadata#EntityDefinitions(LogicalName='${ent.LogicalName}')/Attributes${typedAttrCast ? `/Microsoft.Dynamics.CRM.${typedAttrCast}` : ''}/$entity`,
              ...projected[0],
            }));
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({
            '@odata.context': `${baseUrl}/$metadata#EntityDefinitions(LogicalName='${ent.LogicalName}')/Attributes${typedAttrCast ? `/Microsoft.Dynamics.CRM.${typedAttrCast}` : ''}`,
            value: projected,
          }));
          return;
        }

        if (requestedLogicalName) {
          // /EntityDefinitions(LogicalName='X')
          const ent = filtered[0];
          if (!ent) {
            return write404(res, `Entity '${requestedLogicalName}' not found in metadata.json`);
          }
          const projected = projectColumns(ent, selectCols, { keepAttributes: expandAttrs });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({
            '@odata.context': `${baseUrl}/$metadata#EntityDefinitions/$entity`,
            ...projected,
          }));
          return;
        }

        // /EntityDefinitions (collection)
        const out = filtered.map(e => projectColumns(e, selectCols, { keepAttributes: expandAttrs }));
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(JSON.stringify({
          '@odata.context': `${baseUrl}/$metadata#EntityDefinitions`,
          value: out,
        }));
      });

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

      /* -------------------------------------------------------------------- */
      /* M9.P2 chunk 3 — extracted-controls API (Gallery "Deployed" tab)      */
      /* -------------------------------------------------------------------- */
      // Gated by the per-session `x-pcf-session` secret (same as the dv proxy).
      // Cache locations:
      //   1. harness/.pcf-extracted/   — default, set by the CLI + the
      //      in-process extractor (gitignored).
      //   2. samples/_extracted/       — legacy location from M9.P1; still
      //      readable so existing extracts survive the move.
      const harnessRootForExtracts = process.cwd();
      const extractCacheBases = [
        path.join(harnessRootForExtracts, '.pcf-extracted'),
        path.resolve(harnessRootForExtracts, '..', 'samples', '_extracted'),
      ];
      const defaultExtractCacheBase = extractCacheBases[0];

      function checkExtractedSession(req: any, res: any): boolean {
        const presented = req.headers['x-pcf-session'];
        const expected = getSessionSecret();
        if (typeof presented !== 'string') {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'forbidden', message: 'Missing or invalid x-pcf-session header.' }));
          return false;
        }
        const a = Buffer.from(presented, 'utf8');
        const b = Buffer.from(expected, 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'forbidden', message: 'Missing or invalid x-pcf-session header.' }));
          return false;
        }
        return true;
      }

      server.middlewares.use('/api/extracted', (req, res, next) => {
        if (!req.url) return next();
        const urlPath = req.url.split('?')[0];
        const method = req.method ?? 'GET';

        if (!checkExtractedSession(req, res)) return;

        // GET /api/extracted/list
        if (method === 'GET' && (urlPath === '/list' || urlPath === '/' || urlPath === '')) {
          try {
            const extracts = listCachedExtracts(extractCacheBases);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ defaultCacheBase: defaultExtractCacheBase, extracts }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'list-failed', message: err.message }));
          }
          return;
        }

        // GET /api/extracted/list-controls?orgUrl=https://...
        // Returns the catalog of customcontrol rows in the org so the UI can
        // offer a searchable multi-select picker instead of free-text input.
        if (method === 'GET' && urlPath === '/list-controls') {
          (async () => {
            try {
              const qIndex = req.url!.indexOf('?');
              const qs = qIndex >= 0 ? new URLSearchParams(req.url!.slice(qIndex + 1)) : new URLSearchParams();
              const orgUrl = qs.get('orgUrl') ?? '';
              if (!orgUrl) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'bad-request', message: 'orgUrl query parameter is required.' }));
                return;
              }
              const controls = await listDeployedControlsCatalog(orgUrl);
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify({ orgUrl, controls }));
            } catch (err: any) {
              if (err instanceof ExtractError) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: err.code, message: err.message }));
              } else {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'list-controls-failed', message: err?.message ?? String(err) }));
              }
            }
          })();
          return;
        }

        // POST /api/extracted/extract  body: { orgUrl, controlName, outBase? }
        if (method === 'POST' && urlPath === '/extract') {
          let body = '';
          req.on('data', (c: string) => body += c);
          req.on('end', () => {
            (async () => {
              try {
                const parsed = JSON.parse(body || '{}') as { orgUrl?: string; controlName?: string; outBase?: string };
                const { orgUrl, controlName } = parsed;
                if (!orgUrl || !controlName) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(JSON.stringify({ error: 'bad-request', message: 'orgUrl and controlName are required.' }));
                  return;
                }
                // Force the cache to one of the recognized bases so we never
                // accidentally write somewhere arbitrary based on client input.
                const requestedBase = parsed.outBase ? path.resolve(parsed.outBase) : defaultExtractCacheBase;
                const allowedBase = extractCacheBases.find(
                  (b) => path.resolve(b) === requestedBase,
                ) ?? defaultExtractCacheBase;

                console.log(`[pcf-workbench] Extracting "${controlName}" from ${orgUrl} -> ${allowedBase}`);
                const result = await extractDeployedControl({
                  orgUrl,
                  controlName,
                  outBase: allowedBase,
                });
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.end(JSON.stringify({
                  controlDir: result.controlDir,
                  projectRoot: result.projectRoot,
                  meta: result.meta,
                }));
              } catch (err: any) {
                if (err instanceof ExtractError) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(JSON.stringify({ error: err.code, message: err.message }));
                } else {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(JSON.stringify({ error: 'extract-failed', message: err?.message ?? String(err) }));
                }
              }
            })();
          });
          return;
        }

        // POST /api/extracted/delete  body: { safe, cacheBase? }
        if (method === 'POST' && urlPath === '/delete') {
          let body = '';
          req.on('data', (c: string) => body += c);
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}') as { safe?: string; cacheBase?: string };
              const { safe } = parsed;
              if (!safe || safe !== extractSafeName(safe)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'bad-request', message: 'safe must be a sanitized folder name.' }));
                return;
              }
              const requestedBase = parsed.cacheBase ? path.resolve(parsed.cacheBase) : defaultExtractCacheBase;
              const allowedBase = extractCacheBases.find(
                (b) => path.resolve(b) === requestedBase,
              );
              if (!allowedBase) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'bad-request', message: 'cacheBase is not a recognized extract cache.' }));
                return;
              }
              deleteCachedExtract(allowedBase, safe);
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: 'delete-failed', message: err?.message ?? String(err) }));
            }
          });
          return;
        }

        next();
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

        // POST/PUT /test-scenarios.json — write the canonical on-disk fixture
        // so localStorage edits round-trip back into the control's repo and
        // become part of the committed test corpus. Writes to the existing
        // file path if found; otherwise creates one at controlDir.
        //
        // SAFETY: refuses to overwrite an existing file that doesn't look like
        // a TestScenario v2 array. This protects unrelated `test-scenarios.json`
        // files (e.g. Playwright spec configs) that happen to live at the same
        // path and would otherwise be silently destroyed by a boot-time
        // auto-Default save.
        if (urlPath === '/test-scenarios.json' && (req.method === 'POST' || req.method === 'PUT')) {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf-8');
              const parsed = JSON.parse(body);
              // Accept either v3 envelope {schemaVersion, metadata, scenarios}
              // or legacy v2 array of TestScenarios.
              const isV3 = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && Array.isArray((parsed as any).scenarios);
              const isV2 = Array.isArray(parsed);
              if (!isV2 && !isV3) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: false, error: 'body must be a v3 envelope { schemaVersion, metadata?, scenarios } or a v2 TestScenario array' }));
                return;
              }
              const candidates = [
                path.join(state.controlDir, 'test-scenarios.json'),
                path.join(state.projectRoot, 'test-scenarios.json'),
              ];
              const existing = candidates.find(p => fs.existsSync(p));
              if (existing) {
                // Refuse to overwrite if the file on disk isn't a recognizable
                // TestScenario container. Empty array / empty scenarios is fine
                // (legit reset).
                try {
                  const onDisk = JSON.parse(fs.readFileSync(existing, 'utf-8'));
                  const onDiskScenarios = Array.isArray(onDisk)
                    ? onDisk
                    : (onDisk && typeof onDisk === 'object' && Array.isArray((onDisk as any).scenarios)
                        ? (onDisk as any).scenarios
                        : null);
                  const looksLikeScenarios = onDiskScenarios !== null && (onDiskScenarios.length === 0 || onDiskScenarios.every((s: any) =>
                    s && typeof s === 'object' && typeof s.name === 'string' && (
                      'schemaVersion' in s || 'propertyValues' in s || 'savedAt' in s
                    )
                  ));
                  if (!looksLikeScenarios) {
                    res.statusCode = 409;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: false, error: `existing file at ${existing} is not a TestScenario container — refusing to overwrite`, path: existing }));
                    return;
                  }
                } catch {
                  // Existing file is non-JSON — treat as foreign, refuse.
                  res.statusCode = 409;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ ok: false, error: `existing file at ${existing} is not parseable JSON — refusing to overwrite`, path: existing }));
                  return;
                }
              }
              const target = existing ?? candidates[0];
              // Defensive merge: if the incoming v3 envelope has no `metadata`
              // (or an empty metadata block) but the existing file has one,
              // preserve the on-disk metadata. This protects against client
              // load races where the metadata-store hasn't hydrated yet at
              // save time — without this, the first auto-save after a refresh
              // would silently wipe out the carefully-authored entity schemas.
              if (existing && isV3) {
                const incoming = parsed as { metadata?: unknown };
                const incomingMeta = incoming.metadata;
                const incomingEmpty = !incomingMeta
                  || typeof incomingMeta !== 'object'
                  || Array.isArray(incomingMeta)
                  || Object.keys(incomingMeta as Record<string, unknown>).length === 0;
                if (incomingEmpty) {
                  try {
                    const onDisk = JSON.parse(fs.readFileSync(existing, 'utf-8'));
                    const diskMeta = onDisk && typeof onDisk === 'object' && !Array.isArray(onDisk)
                      ? (onDisk as { metadata?: unknown }).metadata
                      : null;
                    if (diskMeta && typeof diskMeta === 'object' && !Array.isArray(diskMeta)
                      && Object.keys(diskMeta as Record<string, unknown>).length > 0) {
                      (parsed as { metadata?: unknown }).metadata = diskMeta;
                    }
                  } catch { /* fall through to plain write */ }
                }
              }
              fs.writeFileSync(target, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, path: target }));
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
            }
          });
          return;
        }

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
        // Serve entity metadata (display names and types)
        // Supports: metadata.json (simple or Dataverse API format)
        //           EntityDefinitions_*.json (raw Dataverse API exports)
        if (urlPath === '/metadata.json') {
          if (req.method === 'POST' || req.method === 'PUT') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            req.on('end', () => {
              try {
                const incoming = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                const incomingEntities = extractEntities(incoming);
                if (incomingEntities.length === 0 || incomingEntities.some((entity) => !entity?.LogicalName)) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ ok: false, error: 'body must contain at least one Dataverse EntityDefinition with LogicalName' }));
                  return;
                }

                const candidates = [
                  path.join(state.controlDir, 'metadata.json'),
                  path.join(state.projectRoot, 'metadata.json'),
                ];
                const existingPath = candidates.find(filePath => fs.existsSync(filePath));
                const target = existingPath ?? candidates[0];
                const byLogicalName = new Map<string, any>();

                if (existingPath) {
                  const existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
                  for (const entity of extractEntities(existing)) {
                    if (entity?.LogicalName) byLogicalName.set(entity.LogicalName, entity);
                  }
                }
                for (const entity of incomingEntities) {
                  byLogicalName.set(entity.LogicalName, entity);
                }

                const metadata = {
                  schemaVersion: 1,
                  generatedAt: incoming.generatedAt ?? new Date().toISOString(),
                  source: incoming.source ?? { kind: 'metadata-merge' },
                  value: Array.from(byLogicalName.values()).sort((a, b) =>
                    String(a.LogicalName).localeCompare(String(b.LogicalName))),
                };
                fs.writeFileSync(target, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  ok: true,
                  path: target,
                  mergedEntities: metadata.value.length,
                  updatedEntities: incomingEntities.length,
                  metadata,
                }));
              } catch (err: any) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
              }
            });
            return;
          }

          // Collect all metadata sources
          const metaFiles: string[] = [];
          const searchDirs = [state.controlDir, state.projectRoot];
          for (const dir of searchDirs) {
            if (!dir || !fs.existsSync(dir)) continue;
            // Check for metadata.json
            const metaPath = path.join(dir, 'metadata.json');
            if (fs.existsSync(metaPath)) metaFiles.push(metaPath);
            // Check for EntityDefinitions_*.json files (raw Dataverse exports)
            try {
              for (const file of fs.readdirSync(dir)) {
                if (file.startsWith('EntityDefinitions_') && file.endsWith('.json')) {
                  metaFiles.push(path.join(dir, file));
                }
              }
            } catch { /* skip */ }
          }

          if (metaFiles.length > 0) {
            // Merge all metadata files into a single array response
            // The client-side loadMetadata() handles both formats
            const merged: any[] = [];
            for (const filePath of metaFiles) {
              try {
                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                merged.push(content);
              } catch { /* skip invalid files */ }
            }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(JSON.stringify(merged));
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.end('[]');
          return;
        }

        // Serve execute-mocks.json (mock responses for Xrm.WebApi.execute / context.webAPI.execute)
        if (urlPath === '/execute-mocks.json') {
          const candidates = [
            path.join(state.controlDir, 'execute-mocks.json'),
            path.join(state.projectRoot, 'execute-mocks.json'),
          ];
          for (const filePath of candidates) {
            if (fs.existsSync(filePath)) {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end('{}');
          return;
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

        // Serve .pcf-audit.json (optional rule ignores / thresholds for Audit panel)
        if (urlPath === '/.pcf-audit.json' || urlPath === '/pcf-audit.json') {
          const auditCandidates = [
            path.join(state.controlDir, '.pcf-audit.json'),
            path.join(state.projectRoot, '.pcf-audit.json'),
          ];
          for (const filePath of auditCandidates) {
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

      // H5 — Serve image / font / generic resources declared by the manifest
      // (<img path="..."/>, plus anything controls fetch from their own
      // directory). Path-restricted to controlDir + outDir to prevent directory
      // traversal. Without this, controls that reference image assets via
      // relative paths get the SPA index.html fallback and fail with cryptic
      // MIME / decode errors.
      server.middlewares.use('/pcf-resource', (req, res, next) => {
        if (!state.controlDir || !req.url) return next();
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        // Block traversal — relative path only, no ..
        if (urlPath.includes('..')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const candidates = [
          path.join(state.controlDir, urlPath),
          state.outDir ? path.join(state.outDir, urlPath) : '',
        ].filter(Boolean);
        for (const filePath of candidates) {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mime: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.svg': 'image/svg+xml',
              '.webp': 'image/webp',
              '.ico': 'image/x-icon',
              '.woff': 'font/woff',
              '.woff2': 'font/woff2',
              '.ttf': 'font/ttf',
              '.otf': 'font/otf',
              '.eot': 'application/vnd.ms-fontobject',
            };
            res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not found', path: urlPath }));
      });

      // Workspace root API — get or change the gallery scan root
      server.middlewares.use('/api/workspace-root', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ root: state.workspaceRoot }));
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: string) => body += chunk);
          req.on('end', () => {
            try {
              const { root } = JSON.parse(body);
              const resolved = path.resolve(root);
              if (!fs.existsSync(resolved)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `Directory not found: ${resolved}` }));
                return;
              }
              state.workspaceRoot = resolved;
              console.log(`[pcf-workbench] Workspace root changed to: ${resolved}`);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, root: resolved }));
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
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

      // H9 — JSON-404 catch-all for unhandled /api/* and /pcf-data/* paths.
      // Without this, unmatched requests fall through to Vite's SPA index
      // handler which returns text/html. Controls that fetch and JSON.parse
      // (e.g. kuldipmaharjan/ImageViewerPCF) crash with "Unexpected token
      // '<', \"<!DOCTYPE \"... is not valid JSON" instead of getting a clean
      // 404 they can handle. Register LAST so all the specific routes above
      // get first dibs.
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const u = req.url.split('?')[0];
        if (u.startsWith('/api/') || u.startsWith('/pcf-data/')) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'not found', path: u }));
          return;
        }
        next();
      });
    },
  };
}
