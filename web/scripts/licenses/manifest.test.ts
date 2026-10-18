// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LICENSES, parseManifest } from './manifest.ts';

const song = {
  id: 'some-song',
  kind: 'song',
  title: 'Some Song',
  composer: 'Composer',
  arranger: 'Arranger',
  author: 'Typesetter',
  source: 'https://example.com/some-song',
  license: 'Public Domain',
  licenseUrl: 'https://example.com/legal',
  nonCommercial: false,
  modifications: 'None.',
  retrieved: '2026-10-18',
  paths: ['songs-src/some-song/'],
};

const sample = {
  id: 'some-sample',
  kind: 'sample',
  title: 'Some samples',
  author: 'Sampler',
  source: 'https://example.com/samples',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  nonCommercial: false,
  modifications: 'None.',
  retrieved: '2026-10-18',
  paths: ['public/samples/'],
};

const manifest = (...entries: unknown[]) => ({ entries });

describe('parseManifest', () => {
  it('accepts songs, samples and fonts under allowed licences', () => {
    const font = {
      ...sample,
      id: 'some-font',
      kind: 'font',
      license: 'OFL-1.1',
      licenseUrl: LICENSES['OFL-1.1'].url,
    };
    expect(parseManifest(manifest(song, sample, font)).entries).toHaveLength(3);
  });

  it('rejects share-alike and no-derivatives licences: they are not on the allowlist', () => {
    for (const license of ['CC BY-SA 4.0', 'CC BY-SA 3.0', 'CC BY-ND 4.0', 'CC BY-NC-SA 4.0']) {
      const entry = {
        ...sample,
        license,
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      };
      expect(() => parseManifest(manifest(entry)), license).toThrow(/not on the allowlist/);
    }
  });

  it('rejects unknown and empty licences', () => {
    expect(() => parseManifest(manifest({ ...sample, license: 'Free to use' }))).toThrow(
      /not on the allowlist/,
    );
    expect(() => parseManifest(manifest({ ...sample, license: '' }))).toThrow(/license/);
    expect(() => parseManifest(manifest({ ...sample, license: undefined }))).toThrow(/license/);
  });

  it('requires the NC flag exactly when the licence is non-commercial', () => {
    const nc = {
      ...sample,
      license: 'CC BY-NC 4.0',
      licenseUrl: LICENSES['CC BY-NC 4.0'].url,
    };
    expect(parseManifest(manifest({ ...nc, nonCommercial: true })).entries).toHaveLength(1);
    expect(() => parseManifest(manifest(nc))).toThrow(/nonCommercial must be true/);
    expect(() => parseManifest(manifest({ ...sample, nonCommercial: true }))).toThrow(
      /nonCommercial must be false/,
    );
  });

  it("requires a Creative Commons licence's own URL", () => {
    expect(() =>
      parseManifest(
        manifest({ ...sample, licenseUrl: 'https://creativecommons.org/licenses/by/3.0/' }),
      ),
    ).toThrow(/licenseUrl/);
  });

  it('rejects duplicate ids, unknown fields and paths outside web/', () => {
    expect(() => parseManifest(manifest(song, song))).toThrow(/duplicate id "some-song"/);
    expect(() => parseManifest(manifest({ ...sample, licence: 'x' }))).toThrow(/licence/);
    expect(() => parseManifest(manifest({ ...sample, paths: ['../secrets'] }))).toThrow(/paths/);
    expect(() => parseManifest(manifest({ ...sample, paths: ['/etc/passwd'] }))).toThrow(/paths/);
  });

  it('requires a composer and an arranger for songs, and a retrieval date', () => {
    expect(() => parseManifest(manifest({ ...song, composer: undefined }))).toThrow(/composer/);
    expect(() => parseManifest(manifest({ ...song, retrieved: '18/10/2026' }))).toThrow(
      /retrieved/,
    );
  });
});
