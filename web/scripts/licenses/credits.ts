import {
  CREDIT_SECTIONS,
  type Credit,
  type Credits,
  type CreditSectionKind,
} from '../../src/credits/schema.ts';
import { isLicenseName, LICENSES, type Entry, type Manifest } from './manifest.ts';

const SECTION_OF: Record<Entry['kind'], CreditSectionKind> = {
  song: 'songs',
  sample: 'sounds',
  font: 'fonts',
};

const SECTION_TITLES: Record<CreditSectionKind, string> = {
  songs: 'Songs',
  sounds: 'Sounds',
  fonts: 'Fonts',
};

/**
 * The credits data for the credits screen, from the licence manifest. Pure and
 * deterministic: sections in a fixed order, items sorted by id, no timestamps.
 */
export function buildCredits(manifest: Manifest): Credits {
  const sections = CREDIT_SECTIONS.map((kind) => ({
    kind,
    title: SECTION_TITLES[kind],
    items: manifest.entries
      .filter((entry) => SECTION_OF[entry.kind] === kind && !(entry.kind === 'song' && entry.debug))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(toCredit),
  }));
  return {
    $comment:
      'Generated from assets/LICENSES.json by `pnpm credits`. Do not edit: change the manifest and run it again.',
    sections: sections.filter((section) => section.items.length > 0),
  };
}

/** The file contents of `src/credits/credits.json`. */
export function formatCredits(credits: Credits): string {
  return `${JSON.stringify(credits, null, 2)}\n`;
}

function toCredit(entry: Entry): Credit {
  // parseManifest() has already rejected these; this keeps the types honest.
  if (!isLicenseName(entry.license)) throw new Error(`${entry.id}: unknown licence`);
  const { label } = LICENSES[entry.license];
  const credit: Credit = {
    id: entry.id,
    title: entry.title,
    byline: entry.kind === 'song' ? `${entry.composer} · ${entry.author}` : entry.author,
    license: { label, url: entry.licenseUrl },
    source: entry.source,
    changes: entry.modifications,
  };
  if (entry.nonCommercial) credit.note = 'Non-commercial use only.';
  return credit;
}
