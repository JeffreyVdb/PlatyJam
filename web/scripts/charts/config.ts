import * as z from 'zod';
import type { DifficultyName } from '../../src/chart/schema.ts';

/**
 * Metric positions, weakest first. A note's strength is the strongest one its onset
 * falls on: `downbeat` (first beat of a bar), `strong` (the middle beat of a bar with
 * an even number of beats: beat 3 in 4/4, beat 2 in 2/2, beat 4 in 6/8), `beat`,
 * `half-beat` (eighths in 4/4), `quarter-beat` (sixteenths in 4/4), `any`.
 */
export const STRENGTHS = [
  'any',
  'quarter-beat',
  'half-beat',
  'beat',
  'strong',
  'downbeat',
] as const;
export type Strength = (typeof STRENGTHS)[number];

/** Per-difficulty knobs of the converter. */
export const ThresholdsSchema = z.strictObject({
  /** Keep only melody onsets at least this strong. */
  minStrength: z.enum(STRENGTHS),
  /**
   * Minimum time between two kept onsets, ms. Where onsets are closer, the stronger
   * one (then the earlier one) is kept and the other goes to the accompaniment.
   * 0 keeps every onset: Hard's default, so only the lane rules leave notes out.
   */
  minIntervalMs: z.int().min(0),
  /** Which chords become doubles: all, those on a beat, those on a strong beat, or none. */
  doubles: z.enum(['all', 'beats', 'strong', 'none']),
  /** Notes at least this long become holds, ms. */
  holdMinMs: z.int().min(1),
  /** Minimum time from the end of a tile to the next tile in the same lane, ms. */
  minLaneGapMs: z.int().min(0),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const DEFAULT_THRESHOLDS: Record<DifficultyName, Thresholds> = {
  easy: {
    minStrength: 'strong',
    minIntervalMs: 450,
    doubles: 'none',
    holdMinMs: 500,
    minLaneGapMs: 250,
  },
  normal: {
    minStrength: 'any',
    minIntervalMs: 280,
    doubles: 'strong',
    holdMinMs: 700,
    minLaneGapMs: 150,
  },
  hard: {
    minStrength: 'any',
    minIntervalMs: 0,
    doubles: 'all',
    holdMinMs: 800,
    minLaneGapMs: 100,
  },
};

const MidiChannel = z.int().min(0).max(15);

/** `song.json` in `songs-src/<id>/`. */
export const SongConfigSchema = z.strictObject({
  title: z.string().min(1),
  composer: z.string().min(1),
  arranger: z.string().min(1),
  license: z.strictObject({
    source: z.url(),
    license: z.string().min(1),
    licenseUrl: z.url().optional(),
    author: z.string().min(1),
  }),
  /** The MIDI file in the song directory. Default: the only `.mid`/`.midi` file there. */
  midi: z.string().optional(),
  leadInMs: z.int().min(0).default(2000),
  /**
   * A recording to play with the song: `src` is under the app base (the file lives in
   * `public/`, e.g. `songs/<id>.m4a`), `offsetMs` is its position at chart t = 0.
   */
  audio: z.strictObject({ src: z.string().min(1), offsetMs: z.int().default(0) }).optional(),
  /** A test song: in the debug catalog (`?debug`), never in song select for players. */
  debug: z.boolean().optional(),
  /**
   * Which notes become tiles. A track is a melody track when it matches every
   * selector given (index in the file, name, 0-based channel); with none, the first
   * track with notes. With `splitPitch`, only its notes at or above that pitch are
   * melody and the rest are accompaniment. Every other note is accompaniment.
   */
  melody: z
    .strictObject({
      track: z.int().min(0).optional(),
      trackName: z.string().optional(),
      channel: MidiChannel.optional(),
      splitPitch: z.int().min(0).max(127).optional(),
    })
    .prefault({}),
  /** Keep drum tracks (channel 10) in the accompaniment. Off: the piano would play them. */
  includePercussion: z.boolean().default(false),
  quantize: z
    .strictObject({
      /** Grid steps per quarter note: 4 snaps to sixteenths. */
      grid: z.int().min(1).default(4),
      /** Snap only onsets (and ends) within this fraction of a grid step. */
      tolerance: z.number().min(0).max(0.5).default(0.25),
    })
    .prefault({}),
  /** Melody onsets closer than this are one chord, ms. */
  mergeWindowMs: z.int().min(0).default(30),
  difficulties: z
    .strictObject({
      easy: ThresholdsSchema.partial().optional(),
      normal: ThresholdsSchema.partial().optional(),
      hard: ThresholdsSchema.partial().optional(),
    })
    .prefault({}),
});
export type SongConfig = z.infer<typeof SongConfigSchema>;

/** Validates a parsed `song.json`. Throws an `Error` listing every problem. */
export function parseSongConfig(json: unknown): SongConfig {
  const result = SongConfigSchema.safeParse(json);
  if (!result.success) throw new Error(z.prettifyError(result.error));
  return result.data;
}

/** The defaults for a difficulty with the song's overrides applied. */
export function thresholdsFor(config: SongConfig, name: DifficultyName): Thresholds {
  return { ...DEFAULT_THRESHOLDS[name], ...config.difficulties[name] };
}
