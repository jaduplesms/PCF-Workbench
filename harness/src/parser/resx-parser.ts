import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'data',
});

/**
 * Parse a .resx XML file into a key-value map of localized strings.
 */
export function parseResx(xmlContent: string): Record<string, string> {
  const result: Record<string, string> = {};

  try {
    const parsed = parser.parse(xmlContent);
    const dataEntries = parsed?.root?.data;
    if (!Array.isArray(dataEntries)) return result;

    for (const entry of dataEntries) {
      const name = entry['@_name'];
      const value = entry.value;
      if (name && value != null) {
        result[name] = String(value);
      }
    }
  } catch (err) {
    console.warn('[pcf-workbench] Failed to parse RESX:', err);
  }

  return result;
}
