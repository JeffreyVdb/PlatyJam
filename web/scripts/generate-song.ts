// Writes the MIDI file of each generated song from its parameters. Run: pnpm generate-song [id…]
//
// A generated song's songs-src/<id>/ holds a generate.json (see README, "The song
// generator"); this writes songs-src/<id>/<id>.mid from it. The same parameters always
// give the same bytes. Then run `pnpm charts` to rebuild its chart.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { composeSong } from './songgen/compose.ts';
import { generateSongMidi } from './songgen/midi.ts';
import { parseSongParams } from './songgen/params.ts';

const SOURCES = fileURLToPath(new URL('../songs-src/', import.meta.url));

async function generate(id: string): Promise<void> {
  const dir = `${SOURCES}${id}/`;
  const params = parseSongParams(JSON.parse(await readFile(`${dir}generate.json`, 'utf8')));
  await writeFile(`${dir}${id}.mid`, generateSongMidi(params));
  const song = composeSong(params);
  console.log(
    `${id}: generate.json → songs-src/${id}/${id}.mid (seed ${params.seed}, ${params.key} major, ${params.form}, ${song.bars} bars, ${song.durationSeconds.toFixed(1)} s, ${song.melody.length} melody notes)`,
  );
}

const requested = process.argv.slice(2);
const available: string[] = [];
for (const entry of await readdir(SOURCES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if ((await readdir(`${SOURCES}${entry.name}`)).includes('generate.json')) {
    available.push(entry.name);
  }
}
available.sort();
const unknown = requested.filter((id) => !available.includes(id));
if (unknown.length > 0) {
  console.error(
    `No generate.json for: ${unknown.join(', ')}. Generated songs: ${available.join(', ') || 'none'}`,
  );
  process.exit(1);
}

let failed = 0;
for (const id of requested.length > 0 ? requested : available) {
  try {
    await generate(id);
  } catch (error) {
    failed += 1;
    console.error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) process.exitCode = 1;
