import type { Catalog, CatalogSong } from '../../src/catalog/schema.ts';
import { type Chart, DIFFICULTIES, type DifficultyName } from '../../src/chart/schema.ts';

const notesPerSecond = (tiles: number, durationMs: number) =>
  durationMs > 0 ? Math.round((tiles / (durationMs / 1000)) * 100) / 100 : 0;

function toSong(chart: Chart): CatalogSong {
  const difficulty = (name: DifficultyName) => {
    const tiles = chart.difficulties[name].tiles.length;
    return { tiles, notesPerSecond: notesPerSecond(tiles, chart.durationMs) };
  };
  const [easy, normal, hard] = DIFFICULTIES.map(difficulty);
  if (!easy || !normal || !hard) throw new Error(`${chart.id}: missing a difficulty`);
  return {
    id: chart.id,
    title: chart.title,
    composer: chart.composer,
    arranger: chart.arranger,
    durationMs: chart.durationMs,
    bpm: chart.bpm,
    difficulties: { easy, normal, hard },
  };
}

/**
 * The song catalog for song select, from every chart. Pure and deterministic: the
 * gentlest song first (by Normal notes per second, then id), no timestamps.
 */
export function buildCatalog(charts: readonly Chart[]): Catalog {
  const songs = charts
    .map(toSong)
    .sort(
      (a, b) =>
        a.difficulties.normal.notesPerSecond - b.difficulties.normal.notesPerSecond ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return {
    $comment:
      'Generated from public/songs/ by `pnpm charts`. Do not edit: change the songs and run it again.',
    songs,
  };
}

/** The file contents of `src/catalog/catalog.json`. */
export function formatCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
