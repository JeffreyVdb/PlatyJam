// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCredits } from '../../src/credits/schema.ts';
import { buildCredits, formatCredits } from './credits.ts';
import { parseManifest } from './manifest.ts';

const WEB = fileURLToPath(new URL('../../', import.meta.url));

const base = {
  source: 'https://example.com/source',
  license: 'Public Domain',
  licenseUrl: 'https://example.com/legal',
  nonCommercial: false,
  modifications: 'Unmodified.',
  retrieved: '2026-10-18',
  paths: ['assets/'],
};

const fixture = parseManifest({
  entries: [
    { ...base, kind: 'font', id: 'a-font', title: 'A Font', author: 'Type Foundry' },
    {
      ...base,
      kind: 'song',
      id: 'zebra-song',
      title: 'Zebra',
      composer: 'Z. Composer',
      arranger: 'Z. Arranger',
      author: 'Z. Typesetter',
    },
    {
      ...base,
      kind: 'song',
      id: 'aardvark-song',
      title: 'Aardvark',
      composer: 'A. Composer',
      arranger: 'A. Arranger',
      author: 'A. Typesetter',
      license: 'CC BY-NC 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      nonCommercial: true,
    },
  ],
});

describe('buildCredits', () => {
  it('groups the entries into songs, sounds and fonts, sorted by id, without empty sections', () => {
    const { sections } = buildCredits(fixture);
    expect(sections.map(({ kind, items }) => [kind, items.map((item) => item.id)])).toEqual([
      ['songs', ['aardvark-song', 'zebra-song']],
      ['fonts', ['a-font']],
    ]);
  });

  it('leaves test songs out: they are not shown to players', () => {
    const song = fixture.entries.find((entry) => entry.id === 'zebra-song');
    if (song?.kind !== 'song') throw new Error('fixture');
    const manifest = parseManifest({
      entries: [song, { ...song, id: 'debug-song', title: 'Debug', debug: true }],
    });
    const [songs] = buildCredits(manifest).sections;
    expect(songs?.items.map((item) => item.id)).toEqual(['zebra-song']);
  });

  it('writes display-ready fields, with a note only for non-commercial licences', () => {
    const [songs] = buildCredits(fixture).sections;
    expect(songs?.title).toBe('Songs');
    expect(songs?.items).toEqual([
      {
        id: 'aardvark-song',
        title: 'Aardvark',
        byline: 'A. Composer · A. Typesetter',
        license: { label: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
        source: 'https://example.com/source',
        changes: 'Unmodified.',
        note: 'Non-commercial use only.',
      },
      {
        id: 'zebra-song',
        title: 'Zebra',
        byline: 'Z. Composer · Z. Typesetter',
        license: { label: 'Public domain', url: 'https://example.com/legal' },
        source: 'https://example.com/source',
        changes: 'Unmodified.',
      },
    ]);
  });

  it('names a recording artist once when the author repeats the composer', () => {
    const song = fixture.entries.find((entry) => entry.id === 'zebra-song');
    if (song?.kind !== 'song') throw new Error('fixture');
    const manifest = parseManifest({
      entries: [
        { ...song, composer: 'An Artist', author: 'An Artist' },
        { ...song, id: 'b-song', composer: 'An Artist', author: 'An Artist (example.com)' },
      ],
    });
    const [songs] = buildCredits(manifest).sections;
    expect(songs?.items.map((item) => item.byline)).toEqual([
      'An Artist (example.com)',
      'An Artist',
    ]);
  });

  it('is valid credits data and deterministic', () => {
    const credits = buildCredits(fixture);
    expect(parseCredits(credits)).toEqual(credits);
    expect(formatCredits(buildCredits(fixture))).toBe(formatCredits(credits));
  });
});

describe('src/credits/credits.json', () => {
  it('is up to date with assets/LICENSES.json (run `pnpm credits`)', async () => {
    const manifest = parseManifest(
      JSON.parse(await readFile(`${WEB}assets/LICENSES.json`, 'utf8')),
    );
    const committed = await readFile(`${WEB}src/credits/credits.json`, 'utf8');
    expect(committed).toBe(formatCredits(buildCredits(manifest)));
    parseCredits(JSON.parse(committed));
  });
});
