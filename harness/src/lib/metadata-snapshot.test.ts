import { describe, expect, it } from 'vitest';
import { collectMetadataSnapshotScope } from './metadata-snapshot';

describe('collectMetadataSnapshotScope', () => {
  it('collects scenario entities, normalized lookup columns, and annotation targets', () => {
    const scope = collectMetadataSnapshotScope({
      account: [{
        accountid: 'a1',
        name: 'Acme',
        _primarycontactid_value: 'c1',
        '_primarycontactid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'contact',
        'name@OData.Community.Display.V1.FormattedValue': 'Acme',
      }],
    });

    expect(Array.from(scope.entities.get('account') ?? []).sort()).toEqual([
      'accountid',
      'name',
      'primarycontactid',
    ]);
    expect(scope.entities.has('contact')).toBe(true);
    expect(Array.from(scope.annotatedLookupTargets)).toEqual(['contact']);
  });

  it('keeps empty entity tables in scope', () => {
    const scope = collectMetadataSnapshotScope({ incident: [] });
    expect(scope.entities.has('incident')).toBe(true);
    expect(scope.entities.get('incident')?.size).toBe(0);
  });
});
