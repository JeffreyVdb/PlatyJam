// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../../src/catalog/schema.ts';
import { type Chart, parseChart } from '../../src/chart/schema.ts';
import { buildCatalog, formatCatalog } from './catalog.ts';

const WEB = fileURLToPath(new URL('../../', import.meta.url));

function chart(id: string, durationMs: number, tiles: Record<string, number>): Chart {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ t: i * 10, lane: i % 4, pitches: [60], vel: 80 }));
  return {
    version: 1,
    id,
    title: `Title ${id}`,
    composer: `Composer ${id}`,
    arranger: `Arranger ${id}`,
    bpm: 90,
    durationMs,
    leadInMs: 2000,
    license: { source: 'https://example.com', license: 'Public Domain', author: 'Someone' },
    accompaniment: [],
    difficulties: {
      easy: { tiles: make(tiles.easy ?? 0) },
      normal: { tiles: make(tiles.normal ?? 0) },
      hard: { tiles: make(tiles.hard ?? 0) },
    },
  };
}

describe('buildCatalog', () => {
  it('lists each song with its metadata and per-difficulty tile counts', () => {
    const { songs } = buildCatalog([chart('solo', 4000, { easy: 2, normal: 6, hard: 9 })]);
    expect(songs).toEqual([
      {
        id: 'solo',
        title: 'Title solo',
        composer: 'Composer solo',
        arranger: 'Arranger solo',
        durationMs: 4000,
        bpm: 90,
        difficulties: {
          easy: { tiles: 2, notesPerSecond: 0.5 },
          normal: { tiles: 6, notesPerSecond: 1.5 },
          hard: { tiles: 9, notesPerSecond: 2.25 },
        },
      },
    ]);
  });

  it('puts the gentlest song first: by Normal notes per second, then by id', () => {
    const { songs } = buildCatalog([
      chart('busy', 1000, { normal: 5 }),
      chart('b-calm', 1000, { normal: 1 }),
      chart('a-calm', 2000, { normal: 2 }),
    ]);
    expect(songs.map((song) => song.id)).toEqual(['a-calm', 'b-calm', 'busy']);
  });

  it('is valid catalog data and deterministic', () => {
    const charts = [chart('one', 1000, { normal: 1 }), chart('two', 1000, { normal: 2 })];
    const catalog = buildCatalog(charts);
    expect(parseCatalog(catalog)).toEqual(catalog);
    expect(formatCatalog(buildCatalog([...charts].reverse()))).toBe(formatCatalog(catalog));
  });
});

describe('src/catalog/catalog.json', () => {
  it('is up to date with public/songs/ (run `pnpm charts`)', async () => {
    const dir = `${WEB}public/songs/`;
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const charts = await Promise.all(
      files.map(async (name) => parseChart(JSON.parse(await readFile(`${dir}${name}`, 'utf8')))),
    );
    const committed = await readFile(`${WEB}src/catalog/catalog.json`, 'utf8');
    expect(committed).toBe(formatCatalog(buildCatalog(charts)));
    parseCatalog(JSON.parse(committed));
  });
});
