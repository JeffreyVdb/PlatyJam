// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LICENSES, parseManifest, recordingFile, recordingProblems } from './manifest.ts';

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

  it('lets a test song, which the credits leave out, have a licence that needs no credit only', () => {
    const cc0 = {
      ...song,
      debug: true,
      license: 'CC0 1.0',
      licenseUrl: LICENSES['CC0 1.0'].url,
    };
    expect(parseManifest(manifest(cc0)).entries).toHaveLength(1);
    expect(parseManifest(manifest({ ...cc0, license: 'Public Domain' })).entries).toHaveLength(1);
    const by = { ...cc0, license: 'CC BY 4.0', licenseUrl: LICENSES['CC BY 4.0'].url };
    expect(() => parseManifest(manifest(by))).toThrow(/debug song is not credited/);
    // The same licence is fine for a song that is credited.
    expect(parseManifest(manifest({ ...by, debug: false })).entries).toHaveLength(1);
  });

  it('requires a composer and an arranger for songs, and a retrieval date', () => {
    expect(() => parseManifest(manifest({ ...song, composer: undefined }))).toThrow(/composer/);
    expect(() => parseManifest(manifest({ ...song, retrieved: '18/10/2026' }))).toThrow(
      /retrieved/,
    );
  });
});

describe('recordingProblems', () => {
  const covered = { ...song, paths: [...song.paths, 'public/songs/some-song.m4a'] };
  const chart = (src: string) => ({ id: 'some-song', audio: { src } });

  it('passes a chart without a recording, whatever its entry lists', () => {
    expect(recordingProblems(parseManifest(manifest(song)), [{ id: 'some-song' }])).toEqual([]);
  });

  it('passes a recording that the song entry lists', () => {
    const m = parseManifest(manifest(covered));
    expect(recordingProblems(m, [chart('songs/some-song.m4a')])).toEqual([]);
  });

  it('passes a recording inside a listed directory', () => {
    const m = parseManifest(manifest({ ...song, paths: [...song.paths, 'public/songs/audio/'] }));
    expect(recordingProblems(m, [chart('songs/audio/some-song.m4a')])).toEqual([]);
  });

  it('fails a recording that no path of the song entry covers', () => {
    const m = parseManifest(manifest(song));
    expect(recordingProblems(m, [chart('songs/some-song.m4a')])).toEqual([
      'some-song: the recording public/songs/some-song.m4a is not listed in the paths of its manifest entry',
    ]);
  });

  it("fails a recording that only another entry's paths cover", () => {
    const other = { ...song, id: 'other-song', paths: ['public/songs/some-song.m4a'] };
    const m = parseManifest(manifest(song, other));
    expect(recordingProblems(m, [chart('songs/some-song.m4a')])).toHaveLength(1);
  });

  it('does not take a longer file name, or a sibling directory, for a match', () => {
    const m = parseManifest(
      manifest({
        ...song,
        paths: [...song.paths, 'public/songs/some-song.m4a', 'public/songs/a/'],
      }),
    );
    expect(recordingProblems(m, [chart('songs/some-song.m4a.bak')])).toHaveLength(1);
    expect(recordingProblems(m, [chart('songs/ab/x.m4a')])).toHaveLength(1);
  });

  it('fails a chart whose song has no manifest entry', () => {
    const m = parseManifest(manifest(sample));
    expect(recordingProblems(m, [chart('songs/some-song.m4a')])).toEqual([
      'some-song: chart names the recording public/songs/some-song.m4a but has no song entry in the manifest',
    ]);
  });

  it('fails a recording that is not a file we ship', () => {
    const m = parseManifest(manifest(covered));
    expect(recordingProblems(m, [chart('https://example.com/a.m4a')])).toHaveLength(1);
  });

  it('reports every problem', () => {
    const m = parseManifest(manifest(song));
    const charts = [chart('songs/a.m4a'), { id: 'some-song', audio: { src: 'songs/b.m4a' } }];
    expect(recordingProblems(m, charts)).toHaveLength(2);
  });
});

describe('recordingFile', () => {
  it('puts a relative or root-relative src under public/', () => {
    expect(recordingFile('songs/a.m4a')).toBe('public/songs/a.m4a');
    expect(recordingFile('/songs/a.m4a')).toBe('public/songs/a.m4a');
  });

  it('has no file for a URL', () => {
    expect(recordingFile('https://example.com/a.m4a')).toBeNull();
    expect(recordingFile('blob:abc')).toBeNull();
  });
});
