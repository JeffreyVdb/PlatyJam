// The song catalog (catalog.json), generated from the charts in public/songs/ by `pnpm charts`.
// Song select reads it so it never downloads a chart to list the songs. Shared by the game
// and that script: keep it free of DOM and Node APIs, and of relative imports without a
// `.ts` extension, like src/chart/schema.ts.
import { en } from 'zod/locales';
import * as z from 'zod/mini';

z.config(en());

const count = z.int().check(z.nonnegative());

export const CatalogDifficultySchema = z.object({
  tiles: count,
  /** Tiles per second of song at 1×, rounded to 2 decimals. */
  notesPerSecond: z.number().check(z.nonnegative()),
});

export const CatalogSongSchema = z.object({
  /** The chart id: `songs/<id>.json`. */
  id: z.string().check(z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  title: z.string(),
  composer: z.string(),
  arranger: z.string(),
  /** Chart ms at 1×. */
  durationMs: count,
  bpm: z.number().check(z.positive()),
  difficulties: z.object({
    easy: CatalogDifficultySchema,
    normal: CatalogDifficultySchema,
    hard: CatalogDifficultySchema,
  }),
});

export const CatalogSchema = z.object({
  $comment: z.optional(z.string()),
  /** Gentlest first: by Normal notes per second, then id. */
  songs: z.array(CatalogSongSchema),
});

export type CatalogSong = z.infer<typeof CatalogSongSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** Validates parsed JSON as a catalog. Throws an `Error` listing every problem. */
export function parseCatalog(json: unknown): Catalog {
  const result = z.safeParse(CatalogSchema, json);
  if (!result.success) throw new Error(`Invalid catalog:\n${z.prettifyError(result.error)}`);
  return result.data;
}
