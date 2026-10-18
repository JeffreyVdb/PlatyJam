// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type Chart } from '../../src/chart/schema.ts';
import { clusterNotes, compareNotes } from './clusters.ts';
import { DEFAULT_THRESHOLDS, parseSongConfig, thresholdsFor, type SongConfig } from './config.ts';
import { buildDifficulty, convertMidi } from './convert.ts';
import { placeTiles } from './lanes.ts';
import { laneRuleIssues } from './rules.ts';
import { formatJson } from './serialize.ts';
import {
  midiBytes,
  realisticPiece,
  seededRandom,
  type FixtureNote,
  type FixtureTrack,
} from './test-midi.ts';
import type { TimedNote } from './timing.ts';

const baseConfig = {
  title: 'Fixture',
  composer: 'Nobody',
  arranger: 'Nobody',
  license: { source: 'https://example.com/fixture', license: 'Public Domain', author: 'Nobody' },
};

function config(extra: Record<string, unknown> = {}): SongConfig {
  return parseSongConfig({ ...baseConfig, ...extra });
}

function convert(tracks: FixtureTrack[], extra: Record<string, unknown> = {}) {
  return convertMidi(midiBytes(tracks), config(extra), 'fixture');
}

const melody = (notes: FixtureNote[]): FixtureTrack[] => [{ name: 'melody', notes }];

/** Every rule the converter promises, checked on every difficulty. */
function expectLaneRules(chart: Chart, song: SongConfig = config()) {
  for (const name of DIFFICULTIES) {
    const { minLaneGapMs } = thresholdsFor(song, name);
    expect(laneRuleIssues(chart.difficulties[name].tiles, minLaneGapMs), name).toEqual([]);
  }
}

/** (t, pitch) of every melody note: as tile or in the difficulty's accompaniment. */
function melodyNotes(chart: Chart, name: (typeof DIFFICULTIES)[number]): string[] {
  const { tiles, accompaniment = [] } = chart.difficulties[name];
  return [
    ...tiles.flatMap((tile) => tile.pitches.map((pitch) => `${tile.t}:${pitch}`)),
    ...accompaniment.map((note) => `${note.t}:${note.pitch}`),
  ].sort();
}

// Adversarial melodies, each a few bars at 120 BPM (a quarter note is 500 ms).
const ADVERSARIAL: Record<string, FixtureNote[]> = {
  'a dense run of 32nd notes': Array.from({ length: 64 }, (_, i) => ({
    beat: i / 8,
    len: 1 / 8,
    pitch: 60 + (i % 12),
  })),
  'chords of 3 to 5 notes': [3, 4, 5, 3, 5, 4].flatMap((size, i) =>
    Array.from({ length: size }, (_, k) => ({ beat: i, len: 1, pitch: 60 + i + k * 4 })),
  ),
  'holds followed closely by other notes': [0, 1, 2, 3].flatMap((bar) => [
    { beat: bar * 4, len: 3.9, pitch: 67 },
    { beat: bar * 4 + 3.95, len: 0.05, pitch: 67 },
    { beat: bar * 4 + 1, len: 0.5, pitch: 71 },
    { beat: bar * 4 + 1, len: 0.5, pitch: 64 },
    { beat: bar * 4 + 2, len: 2, pitch: 72 },
    { beat: bar * 4 + 2, len: 2, pitch: 60 },
    { beat: bar * 4 + 3, len: 0.25, pitch: 74 },
  ]),
  'one pitch repeated': Array.from({ length: 48 }, (_, i) => ({
    beat: i / 4,
    len: i % 8 === 0 ? 2 : 0.2,
    pitch: 69,
  })),
  'wide leaps': Array.from({ length: 32 }, (_, i) => ({
    beat: i / 2,
    len: 0.5,
    pitch: i % 2 === 0 ? 48 + (i % 5) : 84 - (i % 7),
  })),
  'grace notes before the beat': Array.from({ length: 16 }, (_, i) => [
    { beat: i - 0.06, len: 0.05, pitch: 74 },
    { beat: i, len: 1, pitch: 72 },
  ])
    .flat()
    .filter((note) => note.beat >= 0),
  'long chords under moving notes': [0, 4, 8].flatMap((beat) => [
    { beat, len: 4, pitch: 60 },
    { beat, len: 4, pitch: 64 },
    { beat, len: 4, pitch: 67 },
    ...Array.from({ length: 8 }, (_, i) => ({ beat: beat + i / 2, len: 0.5, pitch: 72 + i })),
    { beat: beat + 2, len: 1.5, pitch: 70 },
  ]),
};

describe('convertMidi lane rules', () => {
  it.each(Object.entries(ADVERSARIAL))('keeps every rule on %s', (_, notes) => {
    const { chart } = convert(melody(notes));
    expectLaneRules(chart);
    for (const name of DIFFICULTIES) {
      expect(chart.difficulties[name].tiles.length, name).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(ADVERSARIAL))(
    'plays every melody note on every difficulty with %s',
    (_, notes) => {
      const { chart } = convert(melody(notes));
      const hard = melodyNotes(chart, 'hard');
      expect(melodyNotes(chart, 'normal')).toEqual(hard);
      expect(melodyNotes(chart, 'easy')).toEqual(hard);
    },
  );

  it('keeps every rule on the realistic piece', () => {
    expectLaneRules(convert(realisticPiece()).chart);
  });

  it('keeps every rule with no lane gap and tiny thresholds', () => {
    const tight = { minIntervalMs: 0, minLaneGapMs: 0, holdMinMs: 1, doubles: 'all' };
    const extra = { difficulties: { easy: tight, normal: tight, hard: tight } };
    for (const notes of Object.values(ADVERSARIAL)) {
      expectLaneRules(convert(melody(notes), extra).chart, config(extra));
    }
  });

  it('puts the lower note of a double on the left', () => {
    const { chart } = convert(
      melody([
        { beat: 0, len: 1, pitch: 60 },
        { beat: 0, len: 1, pitch: 72 },
      ]),
    );
    expect(chart.difficulties.hard.tiles.map((t) => [t.lane, t.pitches[0]])).toEqual([
      [expect.any(Number), 60],
      [expect.any(Number), 72],
    ]);
    const [low, high] = chart.difficulties.hard.tiles;
    expect(low?.lane).toBeLessThan(high?.lane ?? 0);
  });

  it('sends chord notes beyond the double to the accompaniment', () => {
    const chord = [60, 64, 67, 72].map((pitch) => ({ beat: 0, len: 1, pitch }));
    const { chart } = convert(melody(chord));
    expect(chart.difficulties.hard.tiles.map((t) => t.pitches)).toEqual([[60], [72]]);
    expect(chart.difficulties.hard.accompaniment?.map((n) => n.pitch)).toEqual([64, 67]);
    expect(chart.difficulties.easy.tiles.map((t) => t.pitches)).toEqual([[72]]);
  });
});

describe('hard is the full melody', () => {
  it('turns a placeable run of 32nd notes into one tile per note', () => {
    const run = [60, 62, 64, 65].map((pitch, i) => ({ beat: i / 8, len: 1 / 16, pitch }));
    const { hard } = convert(melody(run)).chart.difficulties;
    expect(hard.tiles.map(({ t, lane, pitches }) => [t, lane, pitches])).toEqual([
      [0, 0, [60]],
      [63, 1, [62]],
      [125, 2, [64]],
      [188, 3, [65]],
    ]);
    expect(hard.accompaniment).toBeUndefined();
  });

  it('only leaves out the notes lane placement cannot fit', () => {
    // Dense random chords every 31–90 ms: closer than any thinning interval.
    const random = seededRandom(11);
    const notes: TimedNote[] = [];
    for (let t = 0; t < 8000; t += 31 + Math.floor(random() * 60)) {
      const size = 1 + Math.floor(random() * 3);
      for (let k = 0; k < size; k++) {
        const dur = random() < 0.2 ? 1000 : 60;
        notes.push({ t, dur, pitch: 48 + Math.floor(random() * 36), vel: 80, tick: t });
      }
    }
    const clusters = clusterNotes(notes, 30, () => 'any');
    const pitchRange = { low: 48, high: 83 };
    const { tiles, leftover } = placeTiles(clusters, { ...DEFAULT_THRESHOLDS.hard, pitchRange });
    const accompaniment = [...leftover]
      .sort(compareNotes)
      .map(({ t, pitch, dur, vel }) => ({ t, pitch, dur, vel }));
    expect(buildDifficulty(clusters, DEFAULT_THRESHOLDS.hard, pitchRange)).toEqual({
      tiles,
      accompaniment,
    });
  });
});

describe('convertMidi determinism', () => {
  it('gives deep-equal charts and identical JSON for the same input', () => {
    const bytes = midiBytes(realisticPiece());
    const first = convertMidi(bytes, config(), 'fixture');
    const second = convertMidi(midiBytes(realisticPiece()), config(), 'fixture');
    expect(second.chart).toEqual(first.chart);
    expect(formatJson(second.chart)).toBe(formatJson(first.chart));
  });

  it('does not depend on the order notes were added to the file', () => {
    const tracks = realisticPiece();
    const reversed = tracks.map((track) => ({ ...track, notes: [...track.notes].reverse() }));
    expect(formatJson(convert(reversed).chart)).toBe(formatJson(convert(tracks).chart));
  });
});

describe('convertMidi difficulty density', () => {
  function expectClearSteps(chart: Chart, stats: ReturnType<typeof convertMidi>['stats']) {
    const { easy, normal, hard } = stats;
    expect(easy.tiles).toBe(chart.difficulties.easy.tiles.length);
    expect(normal.tiles).toBeLessThanOrEqual(0.8 * hard.tiles);
    expect(easy.tiles).toBeLessThanOrEqual(0.6 * normal.tiles);
    expect(easy.nps).toBeLessThan(normal.nps);
    expect(normal.nps).toBeLessThan(hard.nps);
    expect(easy.doubles).toBe(0);
    expect(normal.doubles).toBeLessThan(hard.doubles);
  }

  it('makes easy, normal and hard clearly different on the realistic piece', () => {
    const { chart, stats } = convert(realisticPiece());
    expectClearSteps(chart, stats);
  });

  it('makes easy, normal and hard clearly different on the sample song, as committed', async () => {
    const dir = new URL('../../songs-src/andre-sonatine/', import.meta.url);
    const song = parseSongConfig(JSON.parse(await readFile(new URL('song.json', dir), 'utf8')));
    const { chart, stats } = convertMidi(
      await readFile(new URL('andre-sonatine.mid', dir)),
      song,
      'andre-sonatine',
    );
    expectClearSteps(chart, stats);
    expectLaneRules(chart, song);
    // `pnpm charts` must reproduce the committed chart byte for byte.
    const committed = await readFile(
      new URL('../../public/songs/andre-sonatine.json', import.meta.url),
      'utf8',
    );
    expect(committed).toBe(`${formatJson(chart)}\n`);
  });
});

describe('convertMidi timing and metadata', () => {
  it('starts at the first note, accompaniment included, in integer ms', () => {
    const { chart } = convert([
      { name: 'melody', notes: [{ beat: 2, len: 1, pitch: 72 }] },
      { name: 'bass', channel: 1, notes: [{ beat: 1, len: 2, pitch: 48 }] },
    ]);
    expect(chart.accompaniment).toEqual([{ t: 0, pitch: 48, dur: 1000, vel: 88 }]);
    expect(chart.difficulties.hard.tiles).toEqual([{ t: 500, lane: 0, pitches: [72], vel: 88 }]);
    expect(chart.durationMs).toBe(1000);
  });

  it('follows tempo changes', () => {
    const bytes = midiBytes(
      melody([0, 1, 2, 3].map((beat) => ({ beat, len: 1, pitch: 60 + beat * 2 }))),
      {
        tempos: [
          { beat: 0, bpm: 120 },
          { beat: 2, bpm: 60 },
        ],
      },
    );
    const { chart } = convertMidi(bytes, config(), 'fixture');
    expect(chart.difficulties.hard.tiles.map((tile) => tile.t)).toEqual([0, 500, 1000, 2000]);
    expect(chart.bpm).toBe(120);
  });

  it('turns velocities into MIDI velocities 1–127', () => {
    // The file stores 7 bits, so 0.01 reads back as 1/127 and 0.5 as 63/127.
    const notes = [0.01, 0.5, 1].map((velocity, beat) => ({ beat, len: 1, pitch: 60, velocity }));
    const { chart } = convert(melody(notes));
    expect(chart.difficulties.hard.tiles.map((tile) => tile.vel)).toEqual([1, 63, 127]);
  });

  it('snaps onsets that are slightly off the grid, and leaves triplets alone', () => {
    const { chart } = convert(
      melody([
        { beat: 0, len: 1, pitch: 60 },
        { beat: 1.02, len: 1, pitch: 62 },
        { beat: 2 + 1 / 3, len: 1 / 3, pitch: 64 },
      ]),
    );
    expect(chart.difficulties.hard.tiles.map((tile) => tile.t)).toEqual([0, 500, 1167]);
  });

  it('copies the metadata, licence and audio file', () => {
    const extra = {
      leadInMs: 3000,
      audio: { src: 'songs/fixture.m4a' },
      license: { ...baseConfig.license, licenseUrl: 'https://example.com/licence' },
    };
    const { chart } = convert(melody([{ beat: 0, len: 1, pitch: 60 }]), extra);
    expect(chart).toMatchObject({
      version: 1,
      id: 'fixture',
      title: 'Fixture',
      leadInMs: 3000,
      audio: { src: 'songs/fixture.m4a', offsetMs: 0 },
      license: { licenseUrl: 'https://example.com/licence' },
    });
  });
});

describe('convertMidi melody selection', () => {
  const tracks: FixtureTrack[] = [
    {
      name: 'piano',
      channel: 0,
      notes: [
        { beat: 0, len: 1, pitch: 72 },
        { beat: 0, len: 1, pitch: 48 },
      ],
    },
    { name: 'flute', channel: 2, notes: [{ beat: 1, len: 1, pitch: 79 }] },
    { name: 'drums', channel: 9, notes: [{ beat: 0, len: 0.5, pitch: 36 }] },
  ];
  const tilePitches = (extra: Record<string, unknown>) =>
    convert(tracks, extra).chart.difficulties.hard.tiles.map((tile) => tile.pitches[0]);

  it('takes the first track with notes by default and ignores drums', () => {
    const { chart, tracks: info } = convert(tracks);
    expect(chart.difficulties.hard.tiles.map((tile) => tile.pitches[0])).toEqual([48, 72]);
    expect(chart.accompaniment.map((note) => note.pitch)).toEqual([79]);
    expect(info.map((track) => track.percussion)).toEqual([false, false, true]);
  });

  it('selects by track index, name or channel', () => {
    expect(tilePitches({ melody: { track: 1 } })).toEqual([79]);
    expect(tilePitches({ melody: { trackName: 'flute' } })).toEqual([79]);
    expect(tilePitches({ melody: { channel: 2 } })).toEqual([79]);
  });

  it('splits one track at a pitch', () => {
    const { chart } = convert(tracks, { melody: { track: 0, splitPitch: 60 } });
    expect(chart.difficulties.hard.tiles.map((tile) => tile.pitches[0])).toEqual([72]);
    expect(chart.accompaniment.map((note) => note.pitch)).toEqual([48, 79]);
  });

  it('keeps drums only when asked', () => {
    const { chart } = convert(tracks, { includePercussion: true });
    expect(chart.accompaniment.map((note) => note.pitch)).toEqual([36, 79]);
  });

  it('fails when the selection matches nothing', () => {
    expect(() => convert(tracks, { melody: { trackName: 'violin' } })).toThrow(/matches no notes/);
  });
});
