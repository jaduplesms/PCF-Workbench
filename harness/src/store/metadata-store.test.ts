import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMetadata,
  getEntityMetadata,
  loadMetadata,
  replaceAllMetadata,
  setEntityMetadata,
} from './metadata-store';

describe('metadata-store provenance', () => {
  beforeEach(() => clearMetadata());

  it('loads snapshot provenance from the metadata envelope', () => {
    loadMetadata({
      schemaVersion: 1,
      generatedAt: '2026-07-01T00:00:00.000Z',
      source: {
        kind: 'dataverse-snapshot',
        orgUrl: 'https://example.crm.dynamics.com',
      },
      value: [{
        LogicalName: 'account',
        DisplayName: { UserLocalizedLabel: { Label: 'Account' } },
        PrimaryIdAttribute: 'accountid',
        PrimaryNameAttribute: 'name',
        Attributes: [{
          LogicalName: 'name',
          AttributeType: 'String',
          DisplayName: { UserLocalizedLabel: { Label: 'Account Name' } },
        }],
      }],
    });

    expect(getEntityMetadata('account')).toMatchObject({
      displayName: 'Account',
      primaryIdAttribute: 'accountid',
      primaryNameAttribute: 'name',
      provenance: {
        kind: 'snapshot',
        orgUrl: 'https://example.crm.dynamics.com',
        capturedAt: '2026-07-01T00:00:00.000Z',
      },
      columns: {
        name: { displayName: 'Account Name', type: 'String' },
      },
    });
  });

  it('merges loaded entities without clobbering unrelated metadata', () => {
    setEntityMetadata('contact', {
      displayName: 'Contact',
      columns: {},
      provenance: { kind: 'manual' },
    });

    loadMetadata({
      value: [{
        LogicalName: 'account',
        DisplayName: { UserLocalizedLabel: { Label: 'Account' } },
        Attributes: [],
      }],
    });

    expect(getEntityMetadata('contact')?.displayName).toBe('Contact');
    expect(getEntityMetadata('account')?.displayName).toBe('Account');
  });

  it('marks generated simple metadata as inferred by default', () => {
    loadMetadata({
      incident: {
        displayName: 'Case',
        columns: { title: { displayName: 'Title', type: 'String' } },
      },
    });

    expect(getEntityMetadata('incident')?.provenance).toEqual({ kind: 'inferred' });
  });

  it('marks legacy scenario metadata as inferred when replacing the store', () => {
    replaceAllMetadata({
      contact: {
        displayName: 'Contact',
        columns: {},
      },
    });

    expect(getEntityMetadata('contact')?.provenance).toEqual({ kind: 'inferred' });
  });
});
