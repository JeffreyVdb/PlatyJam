// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BAR, composeSong, type GenNote } from './compose.ts';
import { KEYS, parseSongParams, type SongParams } from './params.ts';

const params: SongParams = {
  seed: 1,
  key: 'F',
  bpm: 120,
  form: 'AABA',
  phraseBars: 8,
};

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const inKey = (key: SongParams['key'], pitch: number) =>
  MAJOR.includes((((pitch - KEYS[key]) % 12) + 12) % 12);

/** Notes of bars [from, to), with ticks relative to bar `from`. */
function bars(notes: readonly GenNote[], from: number, to: number) {
  return notes
    .filter((note) => note.tick >= from * BAR && note.tick < to * BAR)
    .map((note) => ({ ...note, tick: note.tick - from * BAR }));
}

const seeds = Array.from({ length: 40 }, (_, i) => i * 7919 + 3);
const keys = Object.keys(KEYS) as SongParams['key'][];

describe('composeSong', () => {
  it('keeps every note in the key, for many seeds and keys', () => {
    for (const [i, seed] of seeds.entries()) {
      const key = keys[i % keys.length] ?? 'C';
      const song = composeSong({ ...params, seed, key });
      for (const note of [...song.melody, ...song.accompaniment]) {
        expect(inKey(key, note.pitch), `seed ${seed} ${key} pitch ${note.pitch}`).toBe(true);
      }
    }
  });

  it('keeps both hands in a comfortable piano range', () => {
    for (const seed of seeds) {
      const { melody, accompaniment, range } = composeSong({ ...params, seed });
      for (const { pitch } of melody) {
        expect(pitch).toBeGreaterThanOrEqual(range.low);
        expect(pitch).toBeLessThanOrEqual(range.high);
      }
      expect(range.low).toBeGreaterThanOrEqual(53);
      expect(range.high).toBeLessThanOrEqual(86);
      for (const { pitch } of accompaniment) {
        expect(pitch).toBeGreaterThanOrEqual(33);
        expect(pitch).toBeLessThanOrEqual(range.low + 4);
      }
    }
  });

  it('ends on the tonic, in the melody and the bass, after every other note', () => {
    for (const [i, seed] of seeds.entries()) {
      const key = keys[i % keys.length] ?? 'C';
      const { melody, accompaniment } = composeSong({ ...params, seed, key });
      const lastTick = Math.max(...melody.map((note) => note.tick));
      const top = Math.max(...melody.filter((n) => n.tick === lastTick).map((n) => n.pitch));
      expect((top - KEYS[key] + 120) % 12).toBe(0);
      const bass = Math.min(
        ...accompaniment.filter((n) => n.tick === lastTick).map((n) => n.pitch),
      );
      expect((bass - KEYS[key] + 120) % 12).toBe(0);
      expect(Math.max(...[...melody, ...accompaniment].map((n) => n.tick))).toBe(lastTick);
    }
  });

  it('repeats the A phrase note for note, except for the final cadence bar', () => {
    const { melody, accompaniment } = composeSong(params);
    // AABA, 8 bars each: A at bars 0, 8 and 24.
    expect(bars(melody, 8, 16)).toEqual(bars(melody, 0, 8));
    expect(bars(melody, 24, 31)).toEqual(bars(melody, 0, 7));
    expect(bars(accompaniment, 24, 31)).toEqual(bars(accompaniment, 0, 7));
    expect(bars(melody, 16, 24)).not.toEqual(bars(melody, 0, 8));
  });

  it('is as long as the form says, at the given tempo', () => {
    const song = composeSong(params);
    expect(song.bars).toBe(32);
    expect(song.durationSeconds).toBe(64);
    const end = Math.max(...[...song.melody, ...song.accompaniment].map((n) => n.tick + n.dur));
    expect(end).toBe(32 * BAR);
  });

  it('is deterministic, and the seed changes the tune', () => {
    expect(composeSong(params)).toEqual(composeSong(params));
    const pitches = (seed: number) => composeSong({ ...params, seed }).melody.map((n) => n.pitch);
    expect(pitches(2)).not.toEqual(pitches(1));
  });

  it('never overlaps two melody notes of the same pitch', () => {
    for (const seed of seeds) {
      const { melody } = composeSong({ ...params, seed });
      const sorted = [...melody].sort((a, b) => a.pitch - b.pitch || a.tick - b.tick);
      sorted.forEach((note, i) => {
        const next = sorted[i + 1];
        if (next?.pitch === note.pitch) expect(note.tick + note.dur).toBeLessThanOrEqual(next.tick);
      });
    }
  });
});

describe('parseSongParams', () => {
  it('accepts valid parameters', () => {
    expect(parseSongParams(params)).toEqual(params);
  });

  it('rejects unknown fields, unknown keys and malformed forms', () => {
    expect(() => parseSongParams({ ...params, tempo: 100 })).toThrow(/tempo/);
    expect(() => parseSongParams({ ...params, key: 'H' })).toThrow(/key/);
    expect(() => parseSongParams({ ...params, form: 'BABA' })).toThrow(/form/);
    expect(() => parseSongParams({ ...params, form: 'AAB' })).toThrow(/form/);
    expect(() => parseSongParams({ ...params, seed: -1 })).toThrow(/seed/);
  });
});
