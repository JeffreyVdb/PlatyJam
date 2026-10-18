// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Cluster } from './clusters.ts';
import type { Strength } from './config.ts';
import { placeTiles, type PlaceOptions } from './lanes.ts';
import { laneRuleIssues } from './rules.ts';

const options: PlaceOptions = {
  doubles: 'all',
  holdMinMs: 800,
  minLaneGapMs: 100,
  pitchRange: { low: 60, high: 72 },
};

/** One cluster per entry: [t, pitches (any order), dur?, strength?]. */
function clusters(
  entries: [t: number, pitches: number[], dur?: number, strength?: Strength][],
): Cluster[] {
  return entries.map(([t, pitches, dur = 200, strength = 'beat']) => ({
    t,
    strength,
    notes: [...pitches].sort((a, b) => b - a).map((pitch) => ({ t, dur, pitch, vel: 80, tick: t })),
  }));
}

const melody = (pitches: number[], spacing = 500) =>
  clusters(pitches.map((pitch, i) => [i * spacing, [pitch]]));
const lanes = (placement: ReturnType<typeof placeTiles>) =>
  placement.tiles.map((tile) => tile.lane);

describe('placeTiles contour', () => {
  it('starts at the lane matching the pitch, then moves right as the melody rises', () => {
    expect(lanes(placeTiles(melody([60, 62, 64, 65]), options))).toEqual([0, 1, 2, 3]);
  });

  it('moves left as the melody falls and stays put on a repeated pitch', () => {
    expect(lanes(placeTiles(melody([72, 71, 71, 69, 67]), options))).toEqual([3, 2, 2, 1, 0]);
  });

  it('moves further on wider leaps', () => {
    expect(lanes(placeTiles(melody([60, 67, 60, 72]), options))).toEqual([0, 2, 0, 3]);
  });

  it('bounces off an edge and keeps going until the contour turns', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72, 74, 72];
    expect(lanes(placeTiles(melody(scale), options))).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 1]);
  });
});

describe('placeTiles chords', () => {
  it('makes a double of the highest and lowest note, lower on the left', () => {
    const { tiles, leftover } = placeTiles(clusters([[0, [60, 64, 67, 72]]]), options);
    // An octave apart: the lanes are as far apart as for a melodic leap of an octave.
    expect(tiles.map((tile) => [tile.lane, tile.pitches])).toEqual([
      [0, [60]],
      [3, [72]],
    ]);
    expect(leftover.map((note) => note.pitch)).toEqual([67, 64]);
  });

  it('puts a close double in neighbouring lanes', () => {
    const { tiles } = placeTiles(clusters([[0, [69, 72]]]), options);
    expect(tiles.map((tile) => tile.lane)).toEqual([2, 3]);
  });

  it('follows the doubles policy', () => {
    const chords = clusters([
      [0, [60, 67], 200, 'downbeat'],
      [500, [62, 69], 200, 'beat'],
      [1000, [64, 71], 200, 'half-beat'],
    ]);
    const count = (doubles: PlaceOptions['doubles']) =>
      placeTiles(chords, { ...options, doubles }).tiles.length;
    expect([count('all'), count('beats'), count('strong'), count('none')]).toEqual([6, 5, 4, 3]);
  });
});

describe('placeTiles holds', () => {
  it('makes long notes holds', () => {
    const { tiles } = placeTiles(
      clusters([
        [0, [60], 800],
        [1000, [62], 799],
      ]),
      options,
    );
    expect(tiles.map((tile) => tile.dur)).toEqual([800, undefined]);
  });

  it('trims a hold so a repeated pitch can follow in its lane', () => {
    const { tiles } = placeTiles(
      clusters([
        [0, [60], 1000],
        [600, [60]],
      ]),
      options,
    );
    expect(tiles).toMatchObject([
      { t: 0, lane: 0, dur: 500 },
      { t: 600, lane: 0 },
    ]);
  });

  it('turns a hold trimmed below half its threshold into a tap', () => {
    const { tiles } = placeTiles(
      clusters([
        [0, [60], 1000],
        [300, [60]],
      ]),
      options,
    );
    expect(tiles[0]).not.toHaveProperty('dur');
    expect(tiles[1]).toMatchObject({ t: 300, lane: 0 });
  });

  it('trims a hold so no more than two tiles are active', () => {
    const { tiles } = placeTiles(
      clusters([
        [0, [60, 72], 2000],
        [500, [66]],
      ]),
      options,
    );
    expect(tiles.map((tile) => [tile.t, tile.dur])).toEqual([
      [0, 400],
      [0, 2000],
      [500, undefined],
    ]);
    expect(laneRuleIssues(tiles, options.minLaneGapMs)).toEqual([]);
  });

  it('leaves a sounding hold alone when a free lane exists', () => {
    const { tiles } = placeTiles(
      clusters([
        [0, [60], 2000],
        [500, [64]],
        [1000, [62]],
      ]),
      options,
    );
    expect(tiles[0]?.dur).toBe(2000);
    expect(laneRuleIssues(tiles, options.minLaneGapMs)).toEqual([]);
  });
});

describe('placeTiles when no lane fits', () => {
  it('moves the note to the leftovers rather than break the lane gap', () => {
    const placement = placeTiles(melody([60, 62, 64, 65, 67], 100), {
      ...options,
      minLaneGapMs: 1000,
    });
    expect(lanes(placement)).toEqual([0, 1, 2, 3]);
    expect(placement.leftover.map((note) => [note.t, note.pitch])).toEqual([[400, 67]]);
  });

  it('drops the double before the note', () => {
    const placement = placeTiles(
      clusters([
        [0, [60]],
        [100, [62]],
        [200, [64]],
        [300, [72, 65]],
      ]),
      {
        ...options,
        minLaneGapMs: 1000,
      },
    );
    expect(placement.tiles.map((tile) => tile.pitches[0])).toEqual([60, 62, 64, 72]);
    expect(placement.leftover.map((note) => note.pitch)).toEqual([65]);
  });
});
