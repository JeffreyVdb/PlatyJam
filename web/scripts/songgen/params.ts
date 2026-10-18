import * as z from 'zod';

/** Major keys the generator writes in, by the pitch class of their tonic. */
export const KEYS = { C: 0, G: 7, D: 2, A: 9, F: 5, Bb: 10, Eb: 3 } as const;
export type KeyName = keyof typeof KEYS;

/**
 * `generate.json` in `songs-src/<id>/`: everything the generator needs to write that
 * song's MIDI file again, byte for byte.
 */
export const SongParamsSchema = z.strictObject({
  /** Seeds the PRNG; every random choice follows from it. */
  seed: z.int().min(0).max(0xffffffff),
  key: z.enum(Object.keys(KEYS) as [KeyName, ...KeyName[]]),
  /** Quarter notes per minute, constant for the whole song (4/4). */
  bpm: z.int().min(60).max(160),
  /**
   * Phrase order, e.g. `AABA`: the same letter is the same music. It starts and ends
   * with A, the phrase that comes home to the tonic.
   */
  form: z.string().regex(/^A[AB]{0,6}A$/),
  /** Bars per phrase. */
  phraseBars: z.union([z.literal(4), z.literal(8)]),
});
export type SongParams = z.infer<typeof SongParamsSchema>;

/** Validates a parsed `generate.json`. Throws an `Error` listing every problem. */
export function parseSongParams(json: unknown): SongParams {
  const result = SongParamsSchema.safeParse(json);
  if (!result.success) throw new Error(z.prettifyError(result.error));
  return result.data;
}
