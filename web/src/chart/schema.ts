// Chart format v1, shared by the game and the MIDI converter (scripts/midi-to-chart.ts).
// Keep it free of DOM and Node APIs, and of relative imports without a `.ts` extension:
// Node loads this file directly when it runs the converter.
import { en } from 'zod/locales';
import * as z from 'zod/mini';

// zod/mini ships without messages; English costs ~1.5 kB gzipped and makes errors readable.
z.config(en());

/** Number of lanes on the stage. */
export const LANES = 4;

/** At most this many tiles may be active (tapped or held) at any instant. */
export const MAX_ACTIVE_TILES = 2;

const ms = z.int().check(z.minimum(0));
const positiveMs = z.int().check(z.minimum(1));
const pitch = z.int().check(z.minimum(0), z.maximum(127));
/** MIDI velocity. */
const velocity = z.int().check(z.minimum(1), z.maximum(127));

/** An auto-played note. Same shape as the audio engine's `AccompanimentNote`. */
export const NoteSchema = z.object({
  /** Start, chart ms. */
  t: ms,
  pitch,
  /** Length, chart ms. */
  dur: positiveMs,
  vel: velocity,
});

/** A tile the player taps, or holds when it has a `dur`. Two tiles with the same `t` are a double. */
export const TileSchema = z.object({
  /** Start, chart ms. */
  t: ms,
  /** 0 (left) to 3 (right). */
  lane: z.int().check(z.minimum(0), z.maximum(LANES - 1)),
  /** Present only on holds: how long to hold, chart ms. */
  dur: z.optional(positiveMs),
  /** Notes played when the tile is hit. */
  pitches: z.array(pitch).check(z.minLength(1)),
  vel: velocity,
});

export type Note = z.infer<typeof NoteSchema>;
export type Tile = z.infer<typeof TileSchema>;

/** End of a tile: a tap ends where it starts, a hold `dur` later. */
export function tileEnd(tile: Pick<Tile, 't' | 'dur'>): number {
  return tile.t + (tile.dur ?? 0);
}

export interface TileIssue {
  /** Index of the offending tile. */
  index: number;
  message: string;
}

/**
 * Checks the lane invariants every chart must keep: tiles sorted by (t, lane), no
 * two tiles sharing t and lane, each tile in a lane starting at or after the end of
 * the previous one there, and at most two tiles active at any instant (a tap is
 * active at its `t`, a hold over [t, t + dur)).
 */
export function tileIssues(tiles: readonly Pick<Tile, 't' | 'lane' | 'dur'>[]): TileIssue[] {
  const issues: TileIssue[] = [];
  const laneEnd: number[] = [];
  tiles.forEach((tile, index) => {
    const prev = tiles[index - 1];
    if (prev && (tile.t < prev.t || (tile.t === prev.t && tile.lane < prev.lane))) {
      issues.push({ index, message: 'tiles must be sorted by t, then lane' });
    } else if (prev?.t === tile.t && prev.lane === tile.lane) {
      issues.push({ index, message: `two tiles share t ${tile.t} and lane ${tile.lane}` });
    }
    const free = laneEnd[tile.lane];
    if (free !== undefined && tile.t < free) {
      issues.push({
        index,
        message: `tile at ${tile.t} in lane ${tile.lane} starts before the previous one there ends at ${free}`,
      });
    }
    laneEnd[tile.lane] = Math.max(free ?? 0, tileEnd(tile));
  });

  // The most tiles are active at some tile's start, so checking each start suffices.
  let holdEnds: number[] = [];
  for (let first = 0; first < tiles.length;) {
    const t = tiles[first]?.t ?? 0;
    let next = first;
    while (tiles[next]?.t === t) next += 1;
    holdEnds = holdEnds.filter((end) => end > t);
    const active = holdEnds.length + (next - first);
    if (active > MAX_ACTIVE_TILES) {
      issues.push({
        index: next - 1,
        message: `${active} tiles active at ${t}; at most ${MAX_ACTIVE_TILES} allowed`,
      });
    }
    for (let i = first; i < next; i += 1) {
      const tile = tiles[i];
      if (tile?.dur !== undefined) holdEnds.push(tileEnd(tile));
    }
    first = next;
  }
  return issues;
}

export const DifficultySchema = z.object({
  tiles: z.array(TileSchema).check(
    z.superRefine((tiles, ctx) => {
      for (const { index, message } of tileIssues(tiles)) {
        ctx.addIssue({ code: 'custom', message, path: [index], input: tiles[index] });
      }
    }),
  ),
  /**
   * Melody notes this difficulty did not turn into tiles. The game plays them with
   * the chart's `accompaniment`, so every difficulty sounds like the whole song.
   */
  accompaniment: z.optional(z.array(NoteSchema)),
});

export type Difficulty = z.infer<typeof DifficultySchema>;

export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type DifficultyName = (typeof DIFFICULTIES)[number];

export const ChartSchema = z.object({
  version: z.literal(1),
  /** Slug; the chart lives at `songs/<id>.json`. */
  id: z.string().check(z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  title: z.string(),
  composer: z.string(),
  arranger: z.string(),
  /** Initial tempo in beats per minute. Informational: all times are in ms. */
  bpm: z.number().check(z.positive()),
  /** End of the last tile or note, chart ms. */
  durationMs: ms,
  /** How long the game waits before t = 0 so the first tiles can scroll in, ms. */
  leadInMs: ms,
  license: z.object({
    /** Where the music (MIDI, score) came from. */
    source: z.url(),
    /** Licence name, e.g. "Public Domain". */
    license: z.string(),
    licenseUrl: z.optional(z.url()),
    /** Who made the source (typesetter, sequencer). */
    author: z.string(),
  }),
  /**
   * An optional recording played in sync: `src` is under the app base, `offsetMs` is
   * its position at t = 0.
   */
  audio: z.optional(z.object({ src: z.string(), offsetMs: z.int() })),
  /** A test song: listed by the debug catalog (`?debug`) only, never in song select. */
  debug: z.optional(z.boolean()),
  /** Auto-played on every difficulty. */
  accompaniment: z.array(NoteSchema),
  difficulties: z.object({
    easy: DifficultySchema,
    normal: DifficultySchema,
    hard: DifficultySchema,
  }),
});

export type Chart = z.infer<typeof ChartSchema>;

/** Validates parsed JSON as a chart. Throws an `Error` listing every problem. */
export function parseChart(json: unknown): Chart {
  const result = z.safeParse(ChartSchema, json);
  if (!result.success) throw new Error(`Invalid chart:\n${z.prettifyError(result.error)}`);
  return result.data;
}
