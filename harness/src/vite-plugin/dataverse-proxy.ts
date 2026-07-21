import type { Connect, Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { URL } from 'node:url';

import * as liveCache from './live-cache';
import { dedupeAppMetadata } from './msal-cache-repair';

import {
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type ICachePlugin,
  type TokenCacheContext,
  InteractionRequiredAuthError,
} from '@azure/msal-node';
import {
  PersistenceCreator,
  PersistenceCachePlugin,
  DataProtectionScope,
} from '@azure/msal-node-extensions';

/* -------------------------------------------------------------------------- */
/* PAC profile + cache shapes                                                 */
/* -------------------------------------------------------------------------- */

/** Subset of fields the harness uses from authprofiles_v2.json. */
export interface PacProfile {
  Kind: string;
  User: string;
  AadObjectId: string;
  Authority: string;
  Resource: string;          // org URL, e.g. https://contoso.crm.dynamics.com/
  TenantId: string;
  EnvironmentId?: string;
  EnvironmentType?: string;
  EnvironmentGeo?: string;
  FriendlyName?: string;
  OrganizationUniqueName?: string;
  ExpiresOn?: string;
}

interface PacAuthProfilesFile {
  Profiles: PacProfile[];
  Current?: Record<string, PacProfile>;
}

/** Public-shape returned to the browser. Strips any potentially sensitive
 *  fields — tokens never leave the Node process. */
export interface PublicProfile {
  user: string;
  orgUrl: string;
  tenantId: string;
  authority: string;
  friendlyName: string;
  environmentType: string | null;
  environmentGeo: string | null;
  isCurrent: boolean;
}

/* -------------------------------------------------------------------------- */
/* PAC paths                                                                  */
/* -------------------------------------------------------------------------- */

function pacCacheDir(): string {
  // PAC stores everything in %LOCALAPPDATA%\Microsoft\PowerAppsCli on Windows.
  // macOS / Linux paths can be added later; M2.P1 is Windows-only.
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
      ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Microsoft', 'PowerAppsCli');
  }
  // Best-effort fallbacks (untested) — keep failing loudly rather than silently.
  return path.join(os.homedir(), '.local', 'share', 'Microsoft', 'PowerAppsCli');
}

function pacProfilesPath(): string {
  return path.join(pacCacheDir(), 'authprofiles_v2.json');
}

function pacTokenCachePath(): string {
  return path.join(pacCacheDir(), 'tokencache_msalv3.dat');
}

/* -------------------------------------------------------------------------- */
/* Profile reader                                                             */
/* -------------------------------------------------------------------------- */

interface ProfileSnapshot {
  profiles: PacProfile[];
  currentResource: string | null;
}

function loadProfiles(): ProfileSnapshot {
  const file = pacProfilesPath();
  if (!fs.existsSync(file)) {
    throw new ProxyError(
      'pac-not-found',
      `PAC profile file not found at ${file}. Install PAC CLI and run \`pac auth create -env <orgUrl>\`.`,
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ProxyError('pac-read-failed', `Cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: PacAuthProfilesFile;
  try {
    parsed = JSON.parse(raw) as PacAuthProfilesFile;
  } catch (e) {
    throw new ProxyError('pac-schema', `authprofiles_v2.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed.Profiles)) {
    throw new ProxyError('pac-schema', 'authprofiles_v2.json: missing Profiles[]. PAC may have changed format.');
  }
  const current = parsed.Current?.UNIVERSAL ?? Object.values(parsed.Current ?? {})[0] ?? null;
  return {
    profiles: parsed.Profiles,
    currentResource: current ? normalizeOrgUrl(current.Resource) : null,
  };
}

export function normalizeOrgUrl(input: string): string {
  // Strip trailing slash; lowercase host so comparisons are stable.
  const u = new URL(input);
  if (u.protocol !== 'https:') {
    throw new ProxyError('bad-org-url', `Org URL must be https: ${input}`);
  }
  return `${u.protocol}//${u.host.toLowerCase()}`;
}

function findProfile(profiles: PacProfile[], orgUrl: string): PacProfile | null {
  const target = normalizeOrgUrl(orgUrl);
  return profiles.find((p) => {
    try { return normalizeOrgUrl(p.Resource) === target; }
    catch { return false; }
  }) ?? null;
}

function toPublic(p: PacProfile, currentResource: string | null): PublicProfile {
  const orgUrl = normalizeOrgUrl(p.Resource);
  return {
    user: p.User,
    orgUrl,
    tenantId: p.TenantId,
    authority: p.Authority,
    friendlyName: p.FriendlyName?.trim() || p.OrganizationUniqueName || orgUrl,
    environmentType: p.EnvironmentType ?? null,
    environmentGeo: p.EnvironmentGeo ?? null,
    isCurrent: orgUrl === currentResource,
  };
}

/* -------------------------------------------------------------------------- */
/* MSAL                                                                       */
/* -------------------------------------------------------------------------- */

interface CacheInspection {
  /** All client IDs found in AccessToken / RefreshToken entries. */
  clientIds: Set<string>;
  /** All home_account_ids → authority hints we can map to. */
  homeAccountIds: Set<string>;
}

/** Decrypts the PAC MSAL cache and pulls the client_id(s). PAC uses one
 *  client ID, but defensive-code as if there could be more than one. */
async function inspectCache(): Promise<CacheInspection> {
  const cachePath = pacTokenCachePath();
  if (!fs.existsSync(cachePath)) {
    throw new ProxyError(
      'pac-no-cache',
      `PAC token cache not found at ${cachePath}. Run \`pac auth create -env <orgUrl>\` first.`,
    );
  }
  const persistence = await PersistenceCreator.createPersistence({
    cachePath,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    // serviceName/accountName ignored on Windows DPAPI but required on macOS/Linux.
    serviceName: 'Microsoft.Developer.IdentityService',
    accountName: 'MSALCache',
    usePlaintextFileOnLinux: false,
  });
  let raw: string | null;
  try {
    raw = await persistence.load();
  } catch (e) {
    throw new ProxyError(
      'pac-cache-decrypt',
      `Failed to decrypt PAC token cache. The Vite plugin must run as the same Windows user that ran \`pac auth\`. (${(e as Error).message})`,
    );
  }
  if (!raw) {
    throw new ProxyError('pac-no-cache', 'PAC token cache is empty. Run `pac auth create -env <orgUrl>`.');
  }

  let cache: any;
  try {
    cache = JSON.parse(raw);
  } catch (e) {
    throw new ProxyError('pac-cache-schema', `Decrypted PAC cache is not valid JSON: ${(e as Error).message}`);
  }

  const clientIds = new Set<string>();
  const homeAccountIds = new Set<string>();
  const sections: Array<Record<string, any>> = [
    cache.AccessToken ?? {},
    cache.RefreshToken ?? {},
    cache.IdToken ?? {},
  ];
  for (const section of sections) {
    for (const entry of Object.values(section)) {
      const e = entry as Record<string, unknown>;
      if (typeof e.client_id === 'string') clientIds.add(e.client_id);
      if (typeof e.home_account_id === 'string') homeAccountIds.add(e.home_account_id);
    }
  }
  for (const entry of Object.values(cache.Account ?? {})) {
    const e = entry as Record<string, unknown>;
    if (typeof e.home_account_id === 'string') homeAccountIds.add(e.home_account_id);
  }

  if (clientIds.size === 0) {
    throw new ProxyError(
      'pac-cache-schema',
      'PAC token cache contained no client_id entries. Cache format may have changed.',
    );
  }
  return { clientIds, homeAccountIds };
}

/** Per-PCA cache so we don't keep rebuilding MSAL for the same (clientId, authority).
 *  Keyed by `${clientId}|${authority}`. */
const pcaCache = new Map<string, PublicClientApplication>();
let cachePluginPromise: Promise<ICachePlugin> | null = null;

/** Wraps an inner cache plugin (PersistenceCachePlugin) and sanitizes the
 *  deserialized cache before MSAL reads it. The repair happens in-memory: the
 *  on-disk `.dat` is only rewritten if MSAL itself mutates the cache
 *  (`cacheHasChanged`), in which case the inner plugin persists the cleaned
 *  copy — so a corrupt cache self-heals on the next token write rather than
 *  being destructively edited behind the user's back. */
class SanitizingCachePlugin implements ICachePlugin {
  constructor(private readonly inner: ICachePlugin) {}

  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    await this.inner.beforeCacheAccess(ctx);
    const serialized = ctx.tokenCache.serialize();
    const cleaned = dedupeAppMetadata(serialized);
    if (cleaned !== serialized) ctx.tokenCache.deserialize(cleaned);
  }

  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    await this.inner.afterCacheAccess(ctx);
  }
}

async function getCachePlugin(): Promise<ICachePlugin> {
  if (!cachePluginPromise) {
    cachePluginPromise = (async () => {
      const persistence = await PersistenceCreator.createPersistence({
        cachePath: pacTokenCachePath(),
        dataProtectionScope: DataProtectionScope.CurrentUser,
        serviceName: 'Microsoft.Developer.IdentityService',
        accountName: 'MSALCache',
        usePlaintextFileOnLinux: false,
      });
      return new SanitizingCachePlugin(new PersistenceCachePlugin(persistence));
    })();
  }
  return cachePluginPromise;
}

async function getPca(clientId: string, authority: string): Promise<PublicClientApplication> {
  const key = `${clientId}|${authority}`;
  const existing = pcaCache.get(key);
  if (existing) return existing;
  const cachePlugin = await getCachePlugin();
  const config: Configuration = {
    auth: { clientId, authority },
    cache: { cachePlugin },
    system: {
      // Suppress MSAL's noisy info-level logs; we redact + emit our own.
      loggerOptions: { logLevel: 0, piiLoggingEnabled: false, loggerCallback: () => {} },
    },
  };
  const pca = new PublicClientApplication(config);
  pcaCache.set(key, pca);
  return pca;
}

// The pure detector lives in its own file so unit tests can import it without
// pulling in @azure/msal-node → keytar (libsecret on Linux CI).
import { isMsalCacheCorruptError } from './msal-cache-detect';
export { isMsalCacheCorruptError };

let cachedClientId: string | null = null;
async function detectClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;
  const inspection = await inspectCache();
  // PAC uses a single first-party client. If multiple ever appear, prefer
  // the one that the most cache entries reference — for now just pick first.
  cachedClientId = [...inspection.clientIds][0]!;
  return cachedClientId;
}

async function findAccountForProfile(
  pca: PublicClientApplication,
  profile: PacProfile,
): Promise<AccountInfo | null> {
  const accounts = await pca.getTokenCache().getAllAccounts();
  // Match by tenant + username (case-insensitive). homeAccountId would be more
  // precise but PAC profile data doesn't surface it directly.
  const userLower = profile.User.toLowerCase();
  return (
    accounts.find(
      (a) =>
        a.tenantId.toLowerCase() === profile.TenantId.toLowerCase() &&
        a.username.toLowerCase() === userLower,
    ) ?? null
  );
}

/** `acquireTokenSilent`, but resilient to PAC's duplicated access-token cache.
 *
 *  PAC's MSAL cache accumulates duplicate AccessToken entries after repeated
 *  `pac auth create` runs against the same org. The default silent flow reads
 *  the access-token cache first and throws `multiple_matching_tokens` when it
 *  finds more than one. `pac auth clear` removes PAC *profiles* but leaves
 *  those token entries behind, so it doesn't help — which is why the old
 *  "run `pac auth clear`" message was misleading.
 *
 *  `forceRefresh: true` skips the access-token cache lookup entirely and mints
 *  a fresh token from the refresh token, sidestepping the duplicates without
 *  any manual cleanup. We only pay that network round-trip on the retry path,
 *  so the happy path stays cache-fast. */
async function acquireSilentResilient(
  pca: PublicClientApplication,
  account: AccountInfo,
  scopes: string[],
): Promise<AuthenticationResult | null> {
  try {
    return await pca.acquireTokenSilent({ account, scopes });
  } catch (e) {
    if (isMsalCacheCorruptError(e)) {
      // Bypass the ambiguous AT cache; use the refresh token to get a fresh one.
      return await pca.acquireTokenSilent({ account, scopes, forceRefresh: true });
    }
    throw e;
  }
}

/** Acquires a Dataverse access token for the supplied org URL using PAC's
 *  cached account. Throws `ProxyError('pac-reauth-required')` if MSAL needs
 *  interaction we cannot provide. */
export async function acquireDataverseToken(orgUrl: string): Promise<{
  token: string;
  expiresOn: Date | null;
  account: { username: string; tenantId: string };
  profile: PublicProfile;
}> {
  const { profiles, currentResource } = loadProfiles();
  const profile = findProfile(profiles, orgUrl);
  if (!profile) {
    throw new ProxyError(
      'pac-profile-missing',
      `No PAC profile found for ${orgUrl}. Run \`pac auth create -env ${orgUrl}\`.`,
      { org: orgUrl },
    );
  }
  const clientId = await detectClientId();
  const pca = await getPca(clientId, profile.Authority);
  const account = await findAccountForProfile(pca, profile);
  if (!account) {
    throw new ProxyError(
      'pac-reauth-required',
      `PAC cache has a profile for ${orgUrl} but no matching MSAL account. Run \`pac auth create -env ${orgUrl}\`.`,
      { org: orgUrl },
    );
  }
  const scopes = [`${normalizeOrgUrl(orgUrl)}/user_impersonation`];
  let result: AuthenticationResult | null;
  try {
    result = await acquireSilentResilient(pca, account, scopes);
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      throw new ProxyError(
        'pac-reauth-required',
        `Refresh token expired for ${orgUrl}. Run \`pac auth create -env ${orgUrl}\`.`,
        { org: orgUrl },
      );
    }
    if (isMsalCacheCorruptError(e)) {
      // We already retried with forceRefresh inside acquireSilentResilient, so
      // reaching here means even the refresh-token path is ambiguous — a
      // genuinely corrupt cache. `pac auth clear` won't fix this (it leaves the
      // MSAL token cache behind); the user must delete the MSAL cache file.
      const code = (e as { errorCode?: string }).errorCode;
      throw new ProxyError(
        'pac-cache-corrupt',
        `The MSAL token cache for ${orgUrl} has duplicate entries that re-authentication did not resolve (MSAL: ${code ?? 'unknown'}). ` +
          `\`pac auth clear\` does not fix this because it leaves the MSAL token cache in place. ` +
          `Close all PAC processes, delete the cache file at ${pacTokenCachePath()}, then run \`pac auth create -env ${orgUrl}\`.`,
        { org: orgUrl, msalCode: code, cachePath: pacTokenCachePath() },
      );
    }
    throw new ProxyError(
      'pac-token-failed',
      `acquireTokenSilent failed for ${orgUrl}: ${(e as Error).message}`,
      { org: orgUrl },
    );
  }
  if (!result?.accessToken) {
    throw new ProxyError('pac-token-failed', `acquireTokenSilent returned no token for ${orgUrl}.`, { org: orgUrl });
  }
  return {
    token: result.accessToken,
    expiresOn: result.expiresOn,
    account: { username: account.username, tenantId: account.tenantId },
    profile: toPublic(profile, currentResource),
  };
}

export async function listPublicProfiles(): Promise<{ profiles: PublicProfile[]; current: string | null }> {
  const { profiles, currentResource } = loadProfiles();
  return {
    profiles: profiles.map((p) => toPublic(p, currentResource)),
    current: currentResource,
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type ProxyErrorCode =
  | 'pac-not-found'
  | 'pac-read-failed'
  | 'pac-schema'
  | 'pac-no-cache'
  | 'pac-cache-decrypt'
  | 'pac-cache-schema'
  | 'pac-profile-missing'
  | 'pac-reauth-required'
  | 'pac-token-failed'
  | 'pac-cache-corrupt'
  | 'bad-org-url'
  | 'bad-request'
  | 'method-not-allowed'
  | 'forbidden'
  | 'upstream-error';

export class ProxyError extends Error {
  constructor(
    public readonly code: ProxyErrorCode,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
  toResponse(): { status: number; body: { error: ProxyErrorCode; message: string; meta?: Record<string, unknown> } } {
    const status = httpStatusFor(this.code);
    return { status, body: { error: this.code, message: this.message, meta: this.meta } };
  }
}

function httpStatusFor(code: ProxyErrorCode): number {
  switch (code) {
    case 'pac-not-found':
    case 'pac-no-cache':
    case 'pac-profile-missing':
      return 404;
    case 'pac-reauth-required':
      return 401;
    case 'pac-cache-corrupt':
      // User action required (run `pac auth clear`); semantically the same
      // bucket as reauth from a UX standpoint, so 401 keeps the client banner
      // logic identical.
      return 401;
    case 'forbidden':
      return 403;
    case 'method-not-allowed':
      return 405;
    case 'bad-org-url':
    case 'bad-request':
      return 400;
    case 'pac-read-failed':
    case 'pac-schema':
    case 'pac-cache-decrypt':
    case 'pac-cache-schema':
    case 'pac-token-failed':
      return 500;
    case 'upstream-error':
      return 502;
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP middleware                                                            */
/* -------------------------------------------------------------------------- */

/** Path under which all proxy endpoints live. */
export const PROXY_BASE = '/__pcf/dv';

/** Annotations every live request gets so the InfoCard etc. behave the same
 *  as offline (FormattedValue, lookuplogicalname, associatednavigationproperty). */
const DEFAULT_PREFER =
  'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname,Microsoft.Dynamics.CRM.associatednavigationproperty"';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof ProxyError) {
    const r = e.toResponse();
    return sendJson(res, r.status, r.body);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return sendJson(res, 500, { error: 'upstream-error', message: msg });
}

/** Logs without leaking tokens or bodies. */
function logProxy(method: string, urlPath: string, status: number, bytes: number): void {
  // eslint-disable-next-line no-console
  console.log(`[dv-proxy] ${method} ${urlPath} → ${status} ${bytes}b`);
}

/** Forwards a Dataverse request. M2.P4: GET (reads) + POST/PATCH/DELETE
 *  (writes) — the client wraps writes in a confirm dialog before sending. */
async function forwardToDataverse(
  req: IncomingMessage,
  res: ServerResponse,
  orgUrl: string,
  upstreamPath: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    throw new ProxyError(
      'method-not-allowed',
      `Method ${method} not allowed by Dataverse proxy.`,
    );
  }

  /* ---- M2.P7: cache fast-path for GETs ----------------------------------- */
  const directive = liveCache.parseCacheDirective(req.headers['x-pcf-cache']);
  if (method === 'GET' && directive !== 'bypass') {
    const cached = liveCache.getCached(orgUrl, method, upstreamPath);
    if (cached) {
      res.statusCode = cached.status;
      for (const [h, v] of Object.entries(cached.headers)) res.setHeader(h, v);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-PCF-Cache', 'hit');
      const buf = Buffer.from(cached.body, 'base64');
      res.end(buf);
      logProxy('GET', upstreamPath, cached.status, buf.byteLength);
      return;
    }
    if (directive === 'only') {
      res.statusCode = 504;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-PCF-Cache', 'miss');
      res.end(JSON.stringify({
        error: 'cache-miss',
        message: 'x-pcf-cache: only requested but no cached entry exists for this request',
      }));
      logProxy('GET', upstreamPath, 504, 0);
      return;
    }
  }
  if (method === 'GET' && directive === 'bypass') {
    liveCache.noteBypass();
  }

  const auth = await acquireDataverseToken(orgUrl);
  const target = new URL(upstreamPath, normalizeOrgUrl(orgUrl) + '/');

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    Prefer: DEFAULT_PREFER,
  };
  // Allow caller to override Prefer (e.g. maxpagesize). We always include the
  // default annotations though, so merge rather than replace.
  const callerPrefer = req.headers['prefer'];
  if (typeof callerPrefer === 'string' && callerPrefer.length > 0) {
    upstreamHeaders.Prefer = `${DEFAULT_PREFER}, ${callerPrefer}`;
  }
  // Writes carry a JSON body and need Content-Type. Reads do not.
  const hasBody = method === 'POST' || method === 'PATCH';
  if (hasBody) {
    upstreamHeaders['Content-Type'] = 'application/json';
    // POST creating a record returns the new entity URL via OData-EntityId
    // header by default. We also ask for return=representation so the client
    // gets the created/updated row back without an extra GET.
    upstreamHeaders.Prefer = `${upstreamHeaders.Prefer}, return=representation`;
  }
  // If-Match is required by Dataverse for unconditional update/delete; pass
  // through whatever the client sent (defaults to '*' from dv-client).
  const ifMatch = req.headers['if-match'];
  if (typeof ifMatch === 'string') upstreamHeaders['If-Match'] = ifMatch;

  // Buffer request body for POST/PATCH (small payloads expected).
  const bodyBuf: Buffer | undefined = hasBody ? await readRequestBody(req) : undefined;

  await new Promise<void>((resolve, reject) => {
    const upstream = https.request(
      {
        method,
        hostname: target.hostname,
        path: target.pathname + target.search,
        headers: upstreamHeaders,
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502;
        const bodyChunks: Buffer[] = [];
        upRes.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
        upRes.on('end', () => {
          const body = Buffer.concat(bodyChunks);
          res.statusCode = status;
          // Pass through content-type / OData headers but never set-cookie.
          // OData-EntityId is critical for create — it carries the new id.
          const passthroughHeaders: Record<string, string> = {};
          for (const h of ['content-type', 'odata-version', 'preference-applied', 'odata-entityid', 'location', 'etag']) {
            const v = upRes.headers[h];
            if (typeof v === 'string') {
              res.setHeader(h, v);
              passthroughHeaders[h] = v;
            }
          }
          res.setHeader('Cache-Control', 'no-store');

          /* ---- M2.P7: write-through + invalidation -------------------- */
          if (method === 'GET' && status >= 200 && status < 300) {
            liveCache.putCached(orgUrl, method, upstreamPath, status, passthroughHeaders, body);
            res.setHeader('X-PCF-Cache', directive === 'bypass' ? 'bypass' : 'miss');
          } else if (method !== 'GET' && status >= 200 && status < 300) {
            const entitySet = liveCache.extractEntitySet(upstreamPath);
            if (entitySet) {
              const cleared = liveCache.invalidateEntitySet(orgUrl, entitySet);
              if (cleared > 0) {
                res.setHeader('X-PCF-Cache', `invalidated:${cleared}`);
              }
            }
          }

          res.end(body);
          logProxy(method, upstreamPath, status, body.byteLength);
          resolve();
        });
      },
    );
    upstream.on('error', (e) => {
      reject(new ProxyError('upstream-error', `Upstream request failed: ${e.message}`));
    });
    if (bodyBuf) upstream.write(bodyBuf);
    upstream.end();
  });
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

interface ProxyOptions {
  /** Per-session secret required in `x-pcf-session` header. Plugin sets this
   *  before mounting middlewares; security checks happen in a sibling
   *  `security-middleware.ts` (added in next todo). */
  sessionSecret: string;
}

let optionsRef: ProxyOptions | null = null;

export function setProxyOptions(opts: ProxyOptions): void {
  optionsRef = opts;
}

/** Returns the connect middleware that handles all `/__pcf/dv/*` routes.
 *  Security middleware should be applied BEFORE this in the stack. */
export function dataverseProxyMiddleware(): Connect.NextHandleFunction {
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? '';
    if (!url.startsWith(PROXY_BASE)) return next();

    try {
      // GET /__pcf/dv/profiles
      if (url === `${PROXY_BASE}/profiles`) {
        if (req.method !== 'GET') throw new ProxyError('method-not-allowed', 'GET only');
        const data = await listPublicProfiles();
        sendJson(res, 200, data);
        logProxy('GET', '/profiles', 200, 0);
        return;
      }

      // GET /__pcf/dv/whoami?org=<url>
      if (url.startsWith(`${PROXY_BASE}/whoami`)) {
        const u = new URL(url, 'http://localhost');
        const org = u.searchParams.get('org');
        if (!org) throw new ProxyError('bad-request', 'Missing ?org=<url>');
        return await forwardToDataverse(req, res, org, '/api/data/v9.2/WhoAmI');
      }

      // ALL /__pcf/dv/api/<rest...>?org=<url>
      if (url.startsWith(`${PROXY_BASE}/api/`)) {
        const u = new URL(url, 'http://localhost');
        const org = u.searchParams.get('org');
        if (!org) throw new ProxyError('bad-request', 'Missing ?org=<url>');
        u.searchParams.delete('org');
        // Reconstruct upstream path: drop our prefix, keep the rest of the
        // OData path + remaining query.
        const upstreamPath = u.pathname.replace(`${PROXY_BASE}/api`, '/api') + (u.search || '');
        return await forwardToDataverse(req, res, org, upstreamPath);
      }

      // GET/DELETE /__pcf/dv/cache — M2.P7 admin endpoint
      if (url === `${PROXY_BASE}/cache` || url.startsWith(`${PROXY_BASE}/cache?`)) {
        if (req.method === 'GET') {
          sendJson(res, 200, liveCache.getStats());
          logProxy('GET', '/cache', 200, 0);
          return;
        }
        if (req.method === 'DELETE') {
          const removed = liveCache.clearAll();
          sendJson(res, 200, { cleared: removed, stats: liveCache.getStats() });
          logProxy('DELETE', '/cache', 200, 0);
          return;
        }
        throw new ProxyError('method-not-allowed', 'GET or DELETE only');
      }

      // Unknown sub-route under /__pcf/dv/*
      sendJson(res, 404, { error: 'bad-request', message: `Unknown proxy route ${url}` });
    } catch (e) {
      sendError(res, e);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin factory                                                             */
/* -------------------------------------------------------------------------- */

/** Vite plugin: mounts the dataverse proxy under /__pcf/dv. Security wrapping
 *  (per-session secret + Origin/Host allowlist) is added by the sibling
 *  security middleware in the next todo. */
export function dataverseProxy(): Plugin {
  return {
    name: 'pcf-dataverse-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(dataverseProxyMiddleware());
    },
  };
}

// Export internals for unit tests.
export const __test__ = {
  loadProfiles,
  inspectCache,
  detectClientId,
  pacCacheDir,
  pacProfilesPath,
  pacTokenCachePath,
};
