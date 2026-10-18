// The credits data (credits.json), generated from assets/LICENSES.json by `pnpm credits`.
// Shared by the game and that script: keep it free of DOM and Node APIs, and of relative
// imports without a `.ts` extension, like src/chart/schema.ts.
import { en } from 'zod/locales';
import * as z from 'zod/mini';

z.config(en());

export const CREDIT_SECTIONS = ['songs', 'sounds', 'fonts'] as const;
export type CreditSectionKind = (typeof CREDIT_SECTIONS)[number];

/** One credited work, ready to display. */
export const CreditSchema = z.object({
  /** The manifest entry's id. */
  id: z.string(),
  title: z.string(),
  /** Who made it, e.g. "E. Satie (1866–1925) · Evin Robertson, typeset for the Mutopia Project". */
  byline: z.string(),
  license: z.object({ label: z.string(), url: z.url() }),
  /** Where it came from. */
  source: z.url(),
  /** What PlatyJam changed, or that it is unmodified. */
  changes: z.string(),
  /** Present only for non-commercial licences. */
  note: z.optional(z.string()),
});

export const CreditsSchema = z.object({
  $comment: z.optional(z.string()),
  /** Songs, then sounds, then fonts; a section without items is left out. */
  sections: z.array(
    z.object({
      kind: z.enum(CREDIT_SECTIONS),
      title: z.string(),
      items: z.array(CreditSchema),
    }),
  ),
});

export type Credit = z.infer<typeof CreditSchema>;
export type Credits = z.infer<typeof CreditsSchema>;

/** Validates parsed JSON as credits. Throws an `Error` listing every problem. */
export function parseCredits(json: unknown): Credits {
  const result = z.safeParse(CreditsSchema, json);
  if (!result.success) throw new Error(`Invalid credits:\n${z.prettifyError(result.error)}`);
  return result.data;
}
