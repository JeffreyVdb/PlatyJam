import * as z from 'zod';

interface LicenseInfo {
  /** How the credits name it. */
  label: string;
  /** True for licences that forbid commercial use. */
  nonCommercial: boolean;
  /** The licence's own deed; an entry must link exactly this. Absent: any URL. */
  url?: string;
}

/**
 * Every licence PlatyJam may ship, by the name `assets/LICENSES.json` and `song.json`
 * use. Anything else fails, so share-alike (BY-SA), no-derivatives (ND) and unknown
 * licences cannot get in: they are simply not here. Add a licence only after checking
 * that it allows copying and changing the work with attribution.
 */
export const LICENSES = {
  // Public domain dedications differ per source (e.g. Mutopia's), so any URL will do.
  'Public Domain': { label: 'Public domain', nonCommercial: false },
  'CC0 1.0': {
    label: 'CC0 1.0',
    nonCommercial: false,
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  },
  'CC BY 3.0': {
    label: 'CC BY 3.0',
    nonCommercial: false,
    url: 'https://creativecommons.org/licenses/by/3.0/',
  },
  'CC BY 3.0 US': {
    label: 'CC BY 3.0 US',
    nonCommercial: false,
    url: 'https://creativecommons.org/licenses/by/3.0/us/',
  },
  'CC BY 4.0': {
    label: 'CC BY 4.0',
    nonCommercial: false,
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  'CC BY-NC 3.0': {
    label: 'CC BY-NC 3.0',
    nonCommercial: true,
    url: 'https://creativecommons.org/licenses/by-nc/3.0/',
  },
  'CC BY-NC 4.0': {
    label: 'CC BY-NC 4.0',
    nonCommercial: true,
    url: 'https://creativecommons.org/licenses/by-nc/4.0/',
  },
  'OFL-1.1': {
    label: 'SIL Open Font License 1.1',
    nonCommercial: false,
    url: 'https://openfontlicense.org/open-font-license-official-text/',
  },
} as const satisfies Record<string, LicenseInfo>;
export type LicenseName = keyof typeof LICENSES;

/** Licences that need no credit, the only ones a `debug` song (not in the credits) may have. */
const DEBUG_LICENSES: readonly string[] = ['CC0 1.0', 'Public Domain'];

export function isLicenseName(name: string): name is LicenseName {
  return Object.hasOwn(LICENSES, name);
}

/** A path relative to `web/`, inside it: no leading `/`, no `..`. */
const RepoPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))/, 'must be a path inside web/');

const common = {
  /** Stable slug; for a song, its `songs-src/<id>/` directory. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  /** Who made the thing we ship: typesetter, sequencer, sample or font makers. */
  author: z.string().min(1),
  /** Where it came from. */
  source: z.url(),
  /** A name from `LICENSES`. */
  license: z.string().min(1),
  licenseUrl: z.url(),
  /** True exactly when the licence forbids commercial use. */
  nonCommercial: z.boolean(),
  /** What we changed, or that it is unmodified. */
  modifications: z.string().min(1),
  /** When it was downloaded or made (ISO date). */
  retrieved: z.iso.date(),
  /** Files and directories (ending in `/`) it covers, relative to `web/`. */
  paths: z.array(RepoPath).min(1),
};

export const EntrySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('song'),
      ...common,
      composer: z.string().min(1),
      arranger: z.string().min(1),
      /** A test song (`debug` in its `song.json`): shipped, but not named in the credits. */
      debug: z.boolean().optional(),
    }),
    z.strictObject({ kind: z.literal('sample'), ...common }),
    z.strictObject({ kind: z.literal('font'), ...common }),
  ])
  .superRefine((entry, ctx) => {
    if (!isLicenseName(entry.license)) {
      ctx.addIssue({
        code: 'custom',
        path: ['license'],
        message: `licence "${entry.license}" is not on the allowlist (${Object.keys(LICENSES).join(', ')}); share-alike, no-derivatives and unknown licences are not allowed`,
      });
      return;
    }
    // The credits screen leaves a test song out, so only a licence that asks for no
    // attribution can ship that way.
    if (entry.kind === 'song' && entry.debug && !DEBUG_LICENSES.includes(entry.license)) {
      ctx.addIssue({
        code: 'custom',
        path: ['debug'],
        message: `a debug song is not credited, so its licence must be one of ${DEBUG_LICENSES.join(', ')}, not ${entry.license}`,
      });
    }
    const info: LicenseInfo = LICENSES[entry.license];
    if (entry.nonCommercial !== info.nonCommercial) {
      ctx.addIssue({
        code: 'custom',
        path: ['nonCommercial'],
        message: `nonCommercial must be ${info.nonCommercial} for ${entry.license}`,
      });
    }
    if (info.url !== undefined && entry.licenseUrl !== info.url) {
      ctx.addIssue({
        code: 'custom',
        path: ['licenseUrl'],
        message: `licenseUrl must be ${info.url} for ${entry.license}`,
      });
    }
  });
export type Entry = z.infer<typeof EntrySchema>;
export type SongEntry = Extract<Entry, { kind: 'song' }>;

/** `assets/LICENSES.json`: everything shipped that someone else made, or that we license. */
export const ManifestSchema = z
  .strictObject({
    $comment: z.string().optional(),
    entries: z.array(EntrySchema),
  })
  .superRefine(({ entries }, ctx) => {
    const seen = new Set<string>();
    entries.forEach(({ id }, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'id'],
          message: `duplicate id "${id}"`,
        });
      }
      seen.add(id);
    });
  });
export type Manifest = z.infer<typeof ManifestSchema>;

/** Validates a parsed `assets/LICENSES.json`. Throws an `Error` listing every problem. */
export function parseManifest(json: unknown): Manifest {
  const result = ManifestSchema.safeParse(json);
  if (!result.success) throw new Error(z.prettifyError(result.error));
  return result.data;
}

/** What the recording check needs of a chart. */
export interface RecordingChart {
  id: string;
  audio?: { src: string } | undefined;
}

/** True when `path` (a file, or a directory ending in `/`) covers `file`. */
const covers = (path: string, file: string) =>
  path === file || (path.endsWith('/') && file.startsWith(path));

/**
 * The file in `web/` a chart's `audio.src` names: `src` is under the app base, which
 * is `public/` (`songs/a.m4a` is `public/songs/a.m4a`). Null for a URL with a scheme,
 * which is not a file we ship.
 */
export function recordingFile(src: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(src)) return null;
  return `public/${src.replace(/^\/+/, '')}`;
}

/**
 * Every recording a chart names that its song's manifest entry does not cover in
 * `paths`, so that a recording cannot ship without its credit. One message per
 * problem; empty when every recording is listed.
 */
export function recordingProblems(manifest: Manifest, charts: readonly RecordingChart[]): string[] {
  const problems: string[] = [];
  for (const { id, audio } of charts) {
    if (!audio) continue;
    const entry = manifest.entries.find((e) => e.kind === 'song' && e.id === id);
    const file = recordingFile(audio.src);
    if (file === null) {
      problems.push(`${id}: audio.src "${audio.src}" is not a file under public/`);
    } else if (!entry) {
      problems.push(
        `${id}: chart names the recording ${file} but has no song entry in the manifest`,
      );
    } else if (!entry.paths.some((path) => covers(path, file))) {
      problems.push(
        `${id}: the recording ${file} is not listed in the paths of its manifest entry`,
      );
    }
  }
  return problems;
}
