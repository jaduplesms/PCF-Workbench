/**
 * Pure repair for PAC's MSAL token cache. Kept dependency-free (like
 * `msal-cache-detect.ts`) so unit tests can import it without dragging in
 * `@azure/msal-node` → `keytar`, which needs `libsecret-1.so.0` on Linux CI.
 *
 * PAC's cache accumulates duplicate `AppMetadata` entries that share a
 * `client_id` but differ only by aliased authority environment (e.g.
 * `login.microsoftonline.com` vs `login.windows.net`) — this happens after
 * authenticating the same first-party client against more than one tenant.
 * MSAL matches AppMetadata by environment-alias-set + clientId, so the pair
 * both satisfy a single lookup and MSAL throws `multiple_matching_appMetadata`.
 * `pac auth clear` doesn't fix it because it removes PAC *profiles*, not the
 * MSAL cache file these entries live in.
 *
 * AppMetadata only carries per-client FOCI (`family_id`) data, never
 * per-account state, so collapsing to a single entry per `client_id` is
 * lossless and resolves the ambiguity.
 *
 * See https://aka.ms/msal.js/errors#multiple_matching_appmetadata
 */

/** Canonical authority host to prefer when collapsing aliased duplicates. */
const CANONICAL_ENVIRONMENT = 'login.microsoftonline.com';

/**
 * Returns a serialized MSAL cache with duplicate AppMetadata entries collapsed
 * to one per `client_id`. Returns the input string untouched when there's
 * nothing to collapse (or it isn't parseable), so callers can cheaply detect a
 * no-op with `cleaned !== serialized`.
 */
export function dedupeAppMetadata(serialized: string): string {
  let cache: any;
  try {
    cache = JSON.parse(serialized);
  } catch {
    return serialized;
  }
  const appMeta = cache?.AppMetadata;
  if (!appMeta || typeof appMeta !== 'object') return serialized;

  const byClient = new Map<string, string[]>();
  for (const key of Object.keys(appMeta)) {
    const clientId = appMeta[key]?.client_id;
    if (typeof clientId !== 'string') continue;
    const group = byClient.get(clientId) ?? [];
    group.push(key);
    byClient.set(clientId, group);
  }

  let changed = false;
  for (const group of byClient.values()) {
    if (group.length <= 1) continue;
    // Prefer the canonical environment entry; fall back to the first key.
    const keep =
      group.find((k) => appMeta[k]?.environment === CANONICAL_ENVIRONMENT) ?? group[0];
    for (const k of group) {
      if (k !== keep) {
        delete appMeta[k];
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(cache) : serialized;
}
