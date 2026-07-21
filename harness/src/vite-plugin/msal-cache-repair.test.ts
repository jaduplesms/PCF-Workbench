// Tests for the AppMetadata de-duplication that repairs PAC's MSAL cache.
//
// The duplicate-AppMetadata-across-aliased-environments state is what makes
// MSAL throw `multiple_matching_appMetadata` during silent token acquisition,
// blocking the Live (PAC) data source. `forceRefresh` can't help (it only
// bypasses the access-token cache, not AppMetadata), so this dedupe is the
// actual fix — lock it against regressions.

import { dedupeAppMetadata } from './msal-cache-repair';

const CLIENT = '9cee029c-6210-4654-90bb-17e6e9d36617';

function cacheWithAppMetadata(entries: Record<string, any>): string {
  return JSON.stringify({
    AccessToken: {},
    RefreshToken: {},
    Account: {},
    AppMetadata: entries,
  });
}

describe('dedupeAppMetadata', () => {
  it('collapses aliased duplicates to a single canonical entry per client_id', () => {
    const input = cacheWithAppMetadata({
      [`appmetadata-login.windows.net-${CLIENT}`]: {
        environment: 'login.windows.net',
        client_id: CLIENT,
      },
      [`appmetadata-login.microsoftonline.com-${CLIENT}`]: {
        environment: 'login.microsoftonline.com',
        client_id: CLIENT,
      },
    });

    const out = JSON.parse(dedupeAppMetadata(input));
    const keys = Object.keys(out.AppMetadata);
    expect(keys).toEqual([`appmetadata-login.microsoftonline.com-${CLIENT}`]);
  });

  it('prefers the canonical environment when both are present', () => {
    const input = cacheWithAppMetadata({
      [`appmetadata-login.microsoftonline.com-${CLIENT}`]: {
        environment: 'login.microsoftonline.com',
        client_id: CLIENT,
      },
      [`appmetadata-login.windows.net-${CLIENT}`]: {
        environment: 'login.windows.net',
        client_id: CLIENT,
      },
    });
    const out = JSON.parse(dedupeAppMetadata(input));
    expect(out.AppMetadata[`appmetadata-login.microsoftonline.com-${CLIENT}`]).toBeDefined();
    expect(out.AppMetadata[`appmetadata-login.windows.net-${CLIENT}`]).toBeUndefined();
  });

  it('keeps distinct client_ids untouched', () => {
    const other = '00000000-0000-0000-0000-000000000000';
    const input = cacheWithAppMetadata({
      [`appmetadata-login.microsoftonline.com-${CLIENT}`]: {
        environment: 'login.microsoftonline.com',
        client_id: CLIENT,
      },
      [`appmetadata-login.microsoftonline.com-${other}`]: {
        environment: 'login.microsoftonline.com',
        client_id: other,
      },
    });
    const out = JSON.parse(dedupeAppMetadata(input));
    expect(Object.keys(out.AppMetadata).sort()).toEqual(
      [
        `appmetadata-login.microsoftonline.com-${CLIENT}`,
        `appmetadata-login.microsoftonline.com-${other}`,
      ].sort(),
    );
  });

  it('returns the exact same string (no-op) when there is nothing to collapse', () => {
    const input = cacheWithAppMetadata({
      [`appmetadata-login.microsoftonline.com-${CLIENT}`]: {
        environment: 'login.microsoftonline.com',
        client_id: CLIENT,
      },
    });
    expect(dedupeAppMetadata(input)).toBe(input);
  });

  it('is a no-op for an empty AppMetadata section', () => {
    const input = cacheWithAppMetadata({});
    expect(dedupeAppMetadata(input)).toBe(input);
  });

  it('returns the input untouched when it is not valid JSON', () => {
    expect(dedupeAppMetadata('not json')).toBe('not json');
  });

  it('tolerates a cache with no AppMetadata section', () => {
    const input = JSON.stringify({ AccessToken: {}, Account: {} });
    expect(dedupeAppMetadata(input)).toBe(input);
  });
});
