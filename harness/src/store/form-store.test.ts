import { beforeEach, describe, expect, it } from 'vitest';
import type { ManifestConfig } from '../types/manifest';
import { getEntityData, loadEntityData } from './data-store';
import { clearMetadata, loadMetadata } from './metadata-store';
import {
  getAttributeState,
  seedFormState,
  setLookupAttributeValue,
} from './form-store';

const manifest: ManifestConfig = {
  namespace: 'Test',
  constructor: 'LookupControl',
  version: '1.0.0',
  controlType: 'virtual',
  displayNameKey: 'Lookup control',
  descriptionKey: '',
  properties: [],
  dataSets: [],
  typeGroups: {},
  featureUsage: [],
  resources: {
    code: [],
    css: [],
    images: [],
    platformLibraries: [],
  },
};

describe('form-store lookup attributes', () => {
  beforeEach(() => {
    clearMetadata();
    loadEntityData({});
  });

  it('seeds OData lookup columns as Xrm lookup arrays with friendly names', () => {
    loadEntityData({
      bookableresourcebooking: [{
        bookableresourcebookingid: 'booking-1',
        _msdyn_workorder_value: 'work-order-47',
        '_msdyn_workorder_value@OData.Community.Display.V1.FormattedValue': 'WO-00047',
        '_msdyn_workorder_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'msdyn_workorder',
      }],
    });

    seedFormState(
      manifest,
      'bookableresourcebooking',
      'booking-1',
      'Booking',
    );

    expect(getAttributeState('msdyn_workorder')).toMatchObject({
      attributeType: 'lookup',
      lookupTarget: 'msdyn_workorder',
      formattedValue: 'WO-00047',
      value: [{
        id: 'work-order-47',
        name: 'WO-00047',
        entityType: 'msdyn_workorder',
      }],
    });
  });

  it('updates lookup identity, display name, target, and dirty state together', () => {
    loadMetadata({
      bookableresourcebooking: {
        displayName: 'Booking',
        columns: {
          msdyn_workorder: {
            displayName: 'Work Order',
            type: 'Lookup.Simple',
            targets: ['msdyn_workorder'],
          },
        },
      },
    });
    loadEntityData({
      bookableresourcebooking: [{
        bookableresourcebookingid: 'booking-1',
        _msdyn_workorder_value: 'work-order-47',
      }],
    });
    seedFormState(manifest, 'bookableresourcebooking', 'booking-1', 'Booking');

    expect(setLookupAttributeValue('msdyn_workorder', {
      id: 'work-order-99',
      name: 'WO-00099',
      entityType: 'msdyn_workorder',
    })).toBe(true);

    expect(getAttributeState('msdyn_workorder')).toMatchObject({
      isDirty: true,
      lookupTarget: 'msdyn_workorder',
      formattedValue: 'WO-00099',
      value: [{
        id: 'work-order-99',
        name: 'WO-00099',
        entityType: 'msdyn_workorder',
      }],
    });
    expect(getEntityData('bookableresourcebooking')[0]).toMatchObject({
      _msdyn_workorder_value: 'work-order-99',
      '_msdyn_workorder_value@OData.Community.Display.V1.FormattedValue': 'WO-00099',
      '_msdyn_workorder_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'msdyn_workorder',
    });
  });
});
