// Writes the credits data, src/credits/credits.json, from the licence manifest. Run: pnpm credits
//
// assets/LICENSES.json is validated first (see README, "Credits"); nothing is written
// if it breaks the licence policy. A test fails while credits.json is out of date.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCredits, formatCredits } from './licenses/credits.ts';
import { parseManifest } from './licenses/manifest.ts';

const MANIFEST = fileURLToPath(new URL('../assets/LICENSES.json', import.meta.url));
const OUT = fileURLToPath(new URL('../src/credits/credits.json', import.meta.url));

try {
  const manifest = parseManifest(JSON.parse(await readFile(MANIFEST, 'utf8')));
  const credits = buildCredits(manifest);
  await writeFile(OUT, formatCredits(credits));
  const counts = credits.sections.map(({ kind, items }) => `${items.length} ${kind}`);
  console.log(`assets/LICENSES.json → src/credits/credits.json (${counts.join(', ')})`);
} catch (error) {
  console.error(`assets/LICENSES.json: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
