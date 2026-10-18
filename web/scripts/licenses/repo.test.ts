// @vitest-environment node
// The real manifest against the repository: it covers every song, agrees with each
// song's song.json and built chart, and every path it lists exists.
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseChart } from '../../src/chart/schema.ts';
import { parseSongConfig } from '../charts/config.ts';
import { parseManifest, type SongEntry } from './manifest.ts';

const WEB = fileURLToPath(new URL('../../', import.meta.url));

const manifest = parseManifest(JSON.parse(await readFile(`${WEB}assets/LICENSES.json`, 'utf8')));
const songs = manifest.entries.filter((entry): entry is SongEntry => entry.kind === 'song');
const songDirs = (await readdir(`${WEB}songs-src/`, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** The fields song.json and the chart repeat from the manifest. */
function licenseOf(entry: SongEntry) {
  return {
    source: entry.source,
    license: entry.license,
    licenseUrl: entry.licenseUrl,
    author: entry.author,
  };
}

describe('assets/LICENSES.json', () => {
  it('has exactly one song entry per songs-src/ directory', () => {
    expect(songs.map((entry) => entry.id).sort()).toEqual([...songDirs].sort());
  });

  it("agrees with each song's song.json", async () => {
    for (const entry of songs) {
      const json: unknown = JSON.parse(
        await readFile(`${WEB}songs-src/${entry.id}/song.json`, 'utf8'),
      );
      const config = parseSongConfig(json);
      expect(
        {
          title: config.title,
          composer: config.composer,
          arranger: config.arranger,
          license: config.license,
        },
        entry.id,
      ).toEqual({
        title: entry.title,
        composer: entry.composer,
        arranger: entry.arranger,
        license: licenseOf(entry),
      });
    }
  });

  it("agrees with each song's built chart", async () => {
    for (const entry of songs) {
      const chart = parseChart(
        JSON.parse(await readFile(`${WEB}public/songs/${entry.id}.json`, 'utf8')),
      );
      expect(chart.license, entry.id).toEqual(licenseOf(entry));
      expect([chart.title, chart.composer, chart.arranger], entry.id).toEqual([
        entry.title,
        entry.composer,
        entry.arranger,
      ]);
    }
  });

  it("lists each song's source directory and chart", () => {
    for (const entry of songs) {
      expect(entry.paths, entry.id).toEqual(
        expect.arrayContaining([`songs-src/${entry.id}/`, `public/songs/${entry.id}.json`]),
      );
    }
  });

  it('lists only paths that exist', async () => {
    for (const entry of manifest.entries) {
      for (const path of entry.paths) {
        await expect(access(`${WEB}${path}`), `${entry.id}: ${path}`).resolves.toBeUndefined();
      }
    }
  });

  it('covers the piano samples and the font', () => {
    expect(manifest.entries.filter((entry) => entry.kind !== 'song').map((e) => e.id)).toEqual([
      'fluidr3-gm-acoustic-grand-piano',
      'shantell-sans',
    ]);
  });
});
