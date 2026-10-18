// Builds every song in songs-src/ into public/songs/<id>.json. Run: pnpm charts [id…]
//
// Each songs-src/<id>/ holds a MIDI file and a song.json (see README, "Adding a song").
// A chart is validated before it is written; any failure exits non-zero.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DIFFICULTIES } from '../src/chart/schema.ts';
import { parseSongConfig } from './charts/config.ts';
import { convertMidi } from './charts/convert.ts';
import { formatJson } from './charts/serialize.ts';

const SOURCES = fileURLToPath(new URL('../songs-src/', import.meta.url));
const OUT = fileURLToPath(new URL('../public/songs/', import.meta.url));

async function buildSong(id: string): Promise<void> {
  const dir = `${SOURCES}${id}/`;
  const config = parseSongConfig(JSON.parse(await readFile(`${dir}song.json`, 'utf8')));
  const midiName = config.midi ?? (await findMidi(dir));
  const { chart, stats, tracks } = convertMidi(await readFile(`${dir}${midiName}`), config, id);
  await writeFile(`${OUT}${id}.json`, `${formatJson(chart)}\n`);

  console.log(
    `${id}: ${midiName} → public/songs/${id}.json (${(chart.durationMs / 1000).toFixed(1)} s)`,
  );
  for (const track of tracks) {
    const role = track.melody ? 'melody' : track.percussion ? 'percussion' : 'accompaniment';
    console.log(
      `  track ${track.index} "${track.name}" channel ${track.channel}: ${track.notes} notes, ${role}`,
    );
  }
  for (const name of DIFFICULTIES) {
    const s = stats[name];
    console.log(
      `  ${name.padEnd(6)} ${String(s.tiles).padStart(4)} tiles, ${String(s.holds).padStart(3)} holds, ${String(s.doubles).padStart(3)} doubles, ${s.nps.toFixed(2)} notes/s`,
    );
  }
}

async function findMidi(dir: string): Promise<string> {
  const midis = (await readdir(dir)).filter((name) => /\.midi?$/i.test(name)).sort();
  if (midis.length !== 1 || !midis[0]) {
    throw new Error(
      `expected one .mid file in ${dir}, found ${midis.length}; set "midi" in song.json`,
    );
  }
  return midis[0];
}

const requested = process.argv.slice(2);
const available = (await readdir(SOURCES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const unknown = requested.filter((id) => !available.includes(id));
if (unknown.length > 0) {
  console.error(`Unknown song: ${unknown.join(', ')}. Available: ${available.join(', ')}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
let failed = 0;
for (const id of requested.length > 0 ? requested : available) {
  try {
    await buildSong(id);
  } catch (error) {
    failed += 1;
    console.error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) {
  console.error(`${failed} song(s) failed; their charts were not written.`);
  process.exitCode = 1;
}
