// @vitest-environment node
import midiPkg from '@tonejs/midi';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeSong } from './compose.ts';
import { generateSongMidi } from './midi.ts';
import { parseSongParams, type SongParams } from './params.ts';

const { Midi } = midiPkg;

const SOURCES = fileURLToPath(new URL('../../songs-src/', import.meta.url));

const params: SongParams = { seed: 1, key: 'D', bpm: 120, form: 'AABA', phraseBars: 8 };

describe('generateSongMidi', () => {
  it('gives byte-identical files for the same parameters', () => {
    expect(generateSongMidi(params)).toEqual(generateSongMidi({ ...params }));
  });

  it('gives different notes for a different seed', () => {
    const notes = (seed: number) =>
      new Midi(generateSongMidi({ ...params, seed })).tracks[0]?.notes.map((n) => n.midi);
    expect(notes(2)).not.toEqual(notes(1));
  });

  it('writes the melody and the accompaniment as separate tracks, melody first', () => {
    const midi = new Midi(generateSongMidi(params));
    const song = composeSong(params);
    expect(midi.tracks.map((t) => [t.name, t.channel])).toEqual([
      ['melody', 0],
      ['accompaniment', 1],
    ]);
    expect(midi.tracks[0]?.notes).toHaveLength(song.melody.length);
    expect(midi.tracks[1]?.notes).toHaveLength(song.accompaniment.length);
    expect(midi.header.tempos[0]?.bpm).toBeCloseTo(120, 3);
    expect(midi.header.timeSignatures[0]?.timeSignature).toEqual([4, 4]);
  });
});

/** Every song in songs-src/ with a generate.json, and its parameters. */
async function generatedSongs() {
  const songs = [];
  for (const entry of await readdir(SOURCES, { withFileTypes: true })) {
    const dir = `${SOURCES}${entry.name}/`;
    if (!entry.isDirectory() || !(await readdir(dir)).includes('generate.json')) continue;
    const params = parseSongParams(JSON.parse(await readFile(`${dir}generate.json`, 'utf8')));
    songs.push({ id: entry.name, dir, params });
  }
  return songs;
}

describe('committed generated songs', () => {
  it('regenerate byte for byte from their generate.json', async () => {
    const songs = await generatedSongs();
    expect(songs.length).toBeGreaterThan(0);
    for (const { id, dir, params: songParams } of songs) {
      const committed = new Uint8Array(await readFile(`${dir}${id}.mid`));
      expect(generateSongMidi(songParams), id).toEqual(committed);
    }
  });

  it('last between 60 and 90 seconds', async () => {
    for (const { id, params: songParams } of await generatedSongs()) {
      const { durationSeconds } = composeSong(songParams);
      expect(durationSeconds, id).toBeGreaterThanOrEqual(60);
      expect(durationSeconds, id).toBeLessThanOrEqual(90);
    }
  });
});
