// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, parseSongConfig, thresholdsFor } from './config.ts';

const minimal = {
  title: 'Song',
  composer: 'Composer',
  arranger: 'Arranger',
  license: { source: 'https://example.com', license: 'Public Domain', author: 'Someone' },
};

describe('parseSongConfig', () => {
  it('fills in the defaults', () => {
    expect(parseSongConfig(minimal)).toEqual({
      ...minimal,
      leadInMs: 2000,
      melody: {},
      includePercussion: false,
      quantize: { grid: 4, tolerance: 0.25 },
      mergeWindowMs: 30,
      difficulties: {},
    });
  });

  it('rejects unknown fields, so a typo does not go unnoticed', () => {
    expect(() => parseSongConfig({ ...minimal, leadIn: 1000 })).toThrow(/leadIn/);
    expect(() => parseSongConfig({ ...minimal, difficulties: { easy: { holdMs: 1 } } })).toThrow(
      /holdMs/,
    );
  });

  it('requires the licence fields', () => {
    expect(() => parseSongConfig({ ...minimal, license: { source: 'https://x.y' } })).toThrow(
      /license\.license/,
    );
  });
});

describe('thresholdsFor', () => {
  it('applies per-difficulty overrides over the defaults', () => {
    const config = parseSongConfig({ ...minimal, difficulties: { easy: { holdMinMs: 900 } } });
    expect(thresholdsFor(config, 'easy')).toEqual({ ...DEFAULT_THRESHOLDS.easy, holdMinMs: 900 });
    expect(thresholdsFor(config, 'hard')).toEqual(DEFAULT_THRESHOLDS.hard);
  });
});
