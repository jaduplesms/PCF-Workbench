#!/usr/bin/env tsx
/**
 * Debug utility: decrypt and pretty-print the PAC MSAL token cache.
 *
 * The on-disk cache (`tokencache_msalv3.dat`) is DPAPI-encrypted under the
 * current Windows user, so you cannot open it in a text editor. This script
 * decrypts it through the same persistence layer the harness uses, then dumps
 * a structural view — section entry counts plus the cache *keys* for each
 * section — so you can spot duplicate / ambiguous entries (the root cause of
 * MSAL `multiple_matching_appMetadata` / `multiple_matching_tokens` errors).
 *
 * Secret values (`secret`, refresh-token bodies) are redacted by default so the
 * output is safe to paste into a bug report. Pass `--raw` to include them, and
 * `--json` to emit the full decrypted JSON instead of the summary.
 *
 * Usage (from the harness/ directory):
 *   npx tsx scripts/dump-pac-cache.ts
 *   npx tsx scripts/dump-pac-cache.ts --json > cache.json   # full, redacted
 *   npx tsx scripts/dump-pac-cache.ts --raw                 # include secrets
 *
 * Must run as the same Windows user that ran `pac auth` (DPAPI scope).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PersistenceCreator,
  DataProtectionScope,
} from '@azure/msal-node-extensions';

function pacCacheDir(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Microsoft', 'PowerAppsCli');
  }
  return path.join(os.homedir(), '.local', 'share', 'Microsoft', 'PowerAppsCli');
}

function pacTokenCachePath(): string {
  return path.join(pacCacheDir(), 'tokencache_msalv3.dat');
}

/** Redact obvious secret fields so the dump is safe to share. */
function redact(cache: any): any {
  const clone = JSON.parse(JSON.stringify(cache));
  for (const section of ['AccessToken', 'RefreshToken', 'IdToken']) {
    for (const entry of Object.values<any>(clone[section] ?? {})) {
      if (entry && typeof entry === 'object' && 'secret' in entry) {
        entry.secret = `«redacted ${String(entry.secret).length} chars»`;
      }
    }
  }
  return clone;
}

async function main() {
  const raw = process.argv.includes('--raw');
  const asJson = process.argv.includes('--json');

  const cachePath = pacTokenCachePath();
  if (!fs.existsSync(cachePath)) {
    console.error(`No PAC token cache found at:\n  ${cachePath}`);
    console.error(`Run \`pac auth create -env <orgUrl>\` first.`);
    process.exit(1);
  }

  const persistence = await PersistenceCreator.createPersistence({
    cachePath,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: 'Microsoft.Developer.IdentityService',
    accountName: 'MSALCache',
    usePlaintextFileOnLinux: false,
  });

  let contents: string | null;
  try {
    contents = await persistence.load();
  } catch (e) {
    console.error(`Failed to decrypt the cache. Are you the same Windows user that ran \`pac auth\`?`);
    console.error(String((e as Error).message));
    process.exit(2);
  }
  if (!contents) {
    console.error('Cache decrypted but is empty.');
    process.exit(0);
  }

  const cache = JSON.parse(contents);

  if (asJson) {
    console.log(JSON.stringify(raw ? cache : redact(cache), null, 2));
    return;
  }

  // Structural summary — counts + keys per section.
  console.log(`\nPAC MSAL token cache: ${cachePath}\n`);
  const sections = ['AccessToken', 'RefreshToken', 'IdToken', 'Account', 'AppMetadata'];
  for (const name of sections) {
    const section = cache[name] ?? {};
    const keys = Object.keys(section);
    console.log(`── ${name} (${keys.length}) ${'─'.repeat(Math.max(0, 40 - name.length))}`);
    for (const key of keys) {
      console.log(`   ${key}`);
    }
    console.log('');
  }

  // Highlight the appMetadata duplicate-environment situation, since that's the
  // exact condition behind multiple_matching_appMetadata.
  const appMeta = Object.values<any>(cache.AppMetadata ?? {});
  const byClient = new Map<string, string[]>();
  for (const m of appMeta) {
    if (!m?.client_id) continue;
    const list = byClient.get(m.client_id) ?? [];
    list.push(m.environment);
    byClient.set(m.client_id, list);
  }
  for (const [clientId, envs] of byClient) {
    if (envs.length > 1) {
      console.log(
        `⚠ client_id ${clientId} has ${envs.length} AppMetadata entries across environments: ${envs.join(', ')}`,
      );
      console.log(`  → this is what triggers MSAL "multiple_matching_appMetadata".`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
