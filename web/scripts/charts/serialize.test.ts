// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatJson } from './serialize.ts';

describe('formatJson', () => {
  it('puts each object of an array on its own line and keeps small values inline', () => {
    const value = {
      id: 'x',
      license: { source: 'https://example.com', author: 'A' },
      notes: [
        { t: 0, pitches: [60] },
        { t: 5, pitches: [62] },
      ],
      nested: { tiles: [{ t: 0 }], empty: [] },
      skipped: undefined,
    };
    expect(formatJson(value)).toBe(
      [
        '{',
        '  "id": "x",',
        '  "license": {"source":"https://example.com","author":"A"},',
        '  "notes": [',
        '    {"t":0,"pitches":[60]},',
        '    {"t":5,"pitches":[62]}',
        '  ],',
        '  "nested": {',
        '    "tiles": [',
        '      {"t":0}',
        '    ],',
        '    "empty": []',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(JSON.parse(formatJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });
});
