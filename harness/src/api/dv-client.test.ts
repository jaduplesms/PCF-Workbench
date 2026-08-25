/**
 * Unit tests for the pure helpers in dv-client.ts.
 *
 * Discipline: we only test the side-effect-free building blocks
 * (`mapSavedQueryToView`, `mapUserQueryToView`, `sortAndDedupeViews`).
 * `liveListViews` itself is a thin orchestrator over `dvGet` + `fetch` +
 * a DOM-bound session-secret lookup and is covered by Playwright at the
 * harness layer rather than by node-env unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  mapSavedQueryToView,
  mapUserQueryToView,
  normalizeProxyErrorBody,
  sortAndDedupeViews,
  type RawSavedQuery,
  type RawUserQuery,
} from './dv-client';
import type { ViewDefinition } from '../types/dataset-binding';

describe('normalizeProxyErrorBody', () => {
  it('preserves the harness flat proxy error shape', () => {
    expect(normalizeProxyErrorBody(
      { error: 'pac-profile-missing', message: 'Profile not found', meta: { org: 'x' } },
      401,
      'Unauthorized',
    )).toEqual({
      error: 'pac-profile-missing',
      message: 'Profile not found',
      meta: { org: 'x' },
    });
  });

  it('normalizes a Dataverse nested OData error', () => {
    expect(normalizeProxyErrorBody(
      {
        error: {
          code: '0x80060888',
          message: "Could not find a property named 'DefaultValue'.",
        },
      },
      400,
      'Bad Request',
    )).toMatchObject({
      error: '0x80060888',
      message: "Could not find a property named 'DefaultValue'.",
    });
  });

  it('handles legacy OData message objects', () => {
    expect(normalizeProxyErrorBody(
      { error: { code: '', message: { lang: 'en-US', value: 'Invalid query' } } },
      400,
      'Bad Request',
    )).toMatchObject({
      error: 'dataverse-error',
      message: 'Invalid query',
    });
  });
});

const SIMPLE_FETCH = `
<fetch>
  <entity name="product">
    <attribute name="name" />
    <attribute name="productnumber" />
    <order attribute="name" descending="false" />
  </entity>
</fetch>`;

describe('mapSavedQueryToView', () => {
  it('builds a system ViewDefinition from a savedquery with fetchxml', () => {
    const raw: RawSavedQuery = {
      savedqueryid: 'AAAA1111-0000-0000-0000-000000000001',
      name: 'Active Products',
      fetchxml: SIMPLE_FETCH,
      isdefault: true,
      returnedtypecode: 'product',
    };

    const view = mapSavedQueryToView(raw, 'product');

    expect(view.viewId).toBe('savedquery:AAAA1111-0000-0000-0000-000000000001');
    expect(view.displayName).toBe('Active Products');
    expect(view.viewType).toBe('system');
    expect(view.entityType).toBe('product');
    expect(view.columns.map(c => c.name)).toEqual(['name', 'productnumber']);
    expect(view.columns[0].sortDirection).toBe('asc');
    expect(view.fetchXml).toBe(SIMPLE_FETCH);
  });

  it('falls back to returnedtypecode when fetchxml has no entity', () => {
    const view = mapSavedQueryToView(
      { savedqueryid: 'id-1', name: 'X', returnedtypecode: 'account' },
      'fallback_entity',
    );
    expect(view.entityType).toBe('account');
    expect(view.columns).toEqual([]);
    expect(view.fetchXml).toBeUndefined();
  });

  it('falls back to the provided fallbackEntity when both fetchxml and returnedtypecode are missing', () => {
    const view = mapSavedQueryToView({ savedqueryid: 'id-2' }, 'fallback_entity');
    expect(view.entityType).toBe('fallback_entity');
    expect(view.displayName).toBe('Untitled system view');
  });

  it('handles malformed fetchxml without throwing', () => {
    const view = mapSavedQueryToView(
      { savedqueryid: 'id-3', name: 'Broken', fetchxml: '<not really xml' },
      'product',
    );
    expect(view.entityType).toBe('product');
    expect(view.columns).toEqual([]);
  });

  it('trims whitespace-only names to the placeholder', () => {
    const view = mapSavedQueryToView({ savedqueryid: 'id-4', name: '   ' }, 'product');
    expect(view.displayName).toBe('Untitled system view');
  });
});

describe('mapUserQueryToView', () => {
  it('builds a personal ViewDefinition from a userquery', () => {
    const raw: RawUserQuery = {
      userqueryid: 'BBBB2222-0000-0000-0000-000000000001',
      name: 'My Recent Products',
      fetchxml: SIMPLE_FETCH,
    };

    const view = mapUserQueryToView(raw, 'product');

    expect(view.viewId).toBe('userquery:BBBB2222-0000-0000-0000-000000000001');
    expect(view.viewType).toBe('personal');
    expect(view.displayName).toBe('My Recent Products');
    expect(view.entityType).toBe('product');
    expect(view.columns).toHaveLength(2);
  });

  it('uses the personal-view placeholder when name is missing', () => {
    const view = mapUserQueryToView({ userqueryid: 'id-5' }, 'product');
    expect(view.displayName).toBe('Untitled personal view');
  });
});

describe('sortAndDedupeViews', () => {
  const sys = (id: string, name: string): ViewDefinition => ({
    viewId: `savedquery:${id}`,
    displayName: name,
    entityType: 'product',
    viewType: 'system',
    columns: [],
  });
  const usr = (id: string, name: string): ViewDefinition => ({
    viewId: `userquery:${id}`,
    displayName: name,
    entityType: 'product',
    viewType: 'personal',
    columns: [],
  });

  it('puts system views before personal views', () => {
    const result = sortAndDedupeViews([usr('u1', 'A'), sys('s1', 'Z')]);
    expect(result.map(v => v.viewId)).toEqual(['savedquery:s1', 'userquery:u1']);
  });

  it('sorts alphabetically within each group, case-insensitive', () => {
    const result = sortAndDedupeViews([
      sys('s1', 'beta'),
      sys('s2', 'Alpha'),
      usr('u1', 'zulu'),
      usr('u2', 'Yankee'),
    ]);
    expect(result.map(v => v.displayName)).toEqual(['Alpha', 'beta', 'Yankee', 'zulu']);
  });

  it('floats the default system view to the very top regardless of name', () => {
    const result = sortAndDedupeViews(
      [sys('s1', 'Alpha'), sys('s2', 'beta'), sys('s3', 'Charlie')],
      'savedquery:s3',
    );
    expect(result[0].viewId).toBe('savedquery:s3');
    // The remaining system views stay alphabetical
    expect(result.slice(1).map(v => v.displayName)).toEqual(['Alpha', 'beta']);
  });

  it('dedupes by viewId — later entries win', () => {
    const result = sortAndDedupeViews([
      sys('s1', 'Old name'),
      sys('s1', 'New name'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('New name');
  });

  it('returns an empty array on empty input', () => {
    expect(sortAndDedupeViews([])).toEqual([]);
  });

  it('ignores a defaultSystemViewId that does not match any view', () => {
    const result = sortAndDedupeViews(
      [sys('s1', 'Alpha'), sys('s2', 'beta')],
      'savedquery:does-not-exist',
    );
    expect(result.map(v => v.displayName)).toEqual(['Alpha', 'beta']);
  });
});
