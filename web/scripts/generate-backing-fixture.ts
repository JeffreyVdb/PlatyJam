// Renders the test recording of the debug song. Run: pnpm backing-fixture   (needs ffmpeg)
//
// public/songs/debug-backing.m4a: a click on every beat at the chart's BPM, higher and
// louder on the downbeat, over a steady D4 tone (the song's key). Played with the chart
// it lets drift be heard (the clicks against the tiles and the piano) and tuning be
// heard (the tone against the notes, at every speed). Pure synthesis, so CC0.
// Run `pnpm generate-song debug-backing` and `pnpm charts debug-backing` first.
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseChart } from '../src/chart/schema.ts';

const run = promisify(execFile);
const WEB = fileURLToPath(new URL('../', import.meta.url));
const ID = 'debug-backing';
/** The recording runs past the last note, as a real one would. */
const TAIL_MS = 2000;
const D4_HZ = 293.66;

/** The ffmpeg `aevalsrc` expression for a click on every beat over the tone. */
export function fixtureExpression(bpm: number): string {
  const beat = (60 / bpm).toFixed(6);
  const downbeat = `lt(mod(t,4*${beat}),${beat})`;
  const click = `(0.3+0.3*${downbeat})*sin(2*PI*(660+220*${downbeat})*t)*exp(-60*mod(t,${beat}))`;
  const tone = `0.1*sin(2*PI*${D4_HZ}*t)`;
  return `${click}+${tone}`;
}

const chart = parseChart(
  JSON.parse(await readFile(`${WEB}public/songs/${ID}.json`, 'utf8')) as unknown,
);
if (!chart.audio) throw new Error(`${ID}: the chart names no audio; set it in song.json`);
const out = `${WEB}public/${chart.audio.src}`;
const seconds = (chart.durationMs + TAIL_MS) / 1000;

await mkdir(dirname(out), { recursive: true });
// Mono AAC at 32 kbit/s, bit-exact (no encoder version in the file): a few hundred KB.
await run('ffmpeg', [
  ...['-y', '-v', 'error', '-fflags', '+bitexact', '-flags:a', '+bitexact'],
  ...['-f', 'lavfi', '-i', `aevalsrc='${fixtureExpression(chart.bpm)}':s=44100:d=${seconds}`],
  ...['-ac', '1', '-c:a', 'aac', '-b:a', '32k', out],
]);
console.log(`${ID}: ${chart.bpm} BPM, ${seconds.toFixed(1)} s → public/${chart.audio.src}`);
