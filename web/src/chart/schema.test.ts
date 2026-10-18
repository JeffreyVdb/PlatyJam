import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AccompanimentNote } from '../audio/scheduler';
import { loadChart } from './load';
import { parseChart, tileIssues, type Chart, type Note, type Tile } from './schema';

function chart(tiles: Tile[], extra: Partial<Chart> = {}): Chart {
  const difficulty = { tiles };
  return {
    version: 1,
    id: 'test-song',
    title: 'Test',
    composer: 'Nobody',
    arranger: 'Nobody',
    bpm: 120,
    durationMs: 4000,
    leadInMs: 2000,
    license: { source: 'https://example.com/song', license: 'Public Domain', author: 'Nobody' },
    accompaniment: [{ t: 0, pitch: 48, dur: 500, vel: 80 }],
    difficulties: { easy: difficulty, normal: difficulty, hard: difficulty },
    ...extra,
  };
}

const tap = (t: number, lane: number, pitch = 60): Tile => ({ t, lane, pitches: [pitch], vel: 90 });
const hold = (t: number, lane: number, dur: number): Tile => ({ ...tap(t, lane), dur });

describe('chart types', () => {
  it('chart notes are accompaniment notes for the audio engine', () => {
    expectTypeOf<Note>().toExtend<AccompanimentNote>();
  });
});

describe('parseChart', () => {
  it('accepts a valid chart and returns it', () => {
    const valid = chart([tap(0, 0), tap(0, 2), hold(500, 1, 400), tap(600, 3), tap(900, 1)]);
    expect(parseChart(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it('accepts per-difficulty accompaniment and an audio file', () => {
    const valid = chart([tap(0, 0)], { audio: { src: 'songs/x.m4a', offsetMs: -120 } });
    valid.difficulties.easy.accompaniment = [{ t: 0, pitch: 72, dur: 200, vel: 64 }];
    expect(parseChart(valid)).toEqual(valid);
  });

  it.each([
    ['version', { version: 2 }],
    ['id', { id: 'Not A Slug' }],
    ['license.source', { license: { source: 'nope', license: 'PD', author: 'x' } }],
    ['accompaniment[0].vel', { accompaniment: [{ t: 0, pitch: 60, dur: 100, vel: 0.5 }] }],
    ['accompaniment[0].pitch', { accompaniment: [{ t: 0, pitch: 128, dur: 100, vel: 64 }] }],
  ])('rejects a bad %s', (path, extra) => {
    expect(() => parseChart({ ...chart([tap(0, 0)]), ...extra })).toThrow(`at ${path}`);
  });

  it.each([
    ['a lane out of range', [tap(0, 4)]],
    ['a fractional time', [tap(0.5, 0)]],
    ['a tile without pitches', [{ ...tap(0, 0), pitches: [] }]],
    ['a hold of zero length', [hold(0, 0, 0)]],
  ])('rejects %s', (_, tiles) => {
    expect(() => parseChart(chart(tiles))).toThrow(/Invalid chart/);
  });

  it('names the difficulty and tile in the message', () => {
    expect(() => parseChart(chart([tap(100, 0), tap(0, 1)]))).toThrow(
      /sorted by t, then lane[\s\S]*difficulties\.easy\.tiles\[1\]/,
    );
  });

  it('rejects input that is not a chart at all', () => {
    expect(() => parseChart(null)).toThrow(/Invalid chart/);
  });
});

describe('tileIssues', () => {
  it('passes holds that end exactly where the next tile in the lane starts', () => {
    expect(tileIssues([hold(0, 0, 500), tap(500, 0)])).toEqual([]);
  });

  it('rejects unsorted tiles', () => {
    expect(tileIssues([tap(500, 0), tap(0, 1)])[0]?.message).toMatch(/sorted/);
    expect(tileIssues([tap(0, 2), tap(0, 1)])[0]?.message).toMatch(/sorted/);
  });

  it('rejects two taps sharing t and lane', () => {
    expect(tileIssues([tap(0, 1), tap(0, 1)])).toEqual([
      { index: 1, message: 'two tiles share t 0 and lane 1' },
    ]);
  });

  it('rejects a tile inside a hold in the same lane', () => {
    expect(tileIssues([hold(0, 2, 500), tap(499, 2)])[0]?.message).toMatch(/lane 2 starts before/);
  });

  it('counts a hold started earlier as active', () => {
    expect(tileIssues([hold(0, 0, 1000), tap(500, 1), tap(500, 2)])).toEqual([
      { index: 2, message: '3 tiles active at 500; at most 2 allowed' },
    ]);
    expect(tileIssues([hold(0, 0, 1000), hold(200, 1, 1000), tap(500, 2)])[0]?.index).toBe(2);
  });

  it('allows two holds, and a new tile once one of them ended', () => {
    expect(tileIssues([hold(0, 0, 500), hold(0, 3, 1000), tap(500, 1)])).toEqual([]);
  });

  it('rejects three tiles at the same time', () => {
    expect(tileIssues([tap(0, 0), tap(0, 1), tap(0, 2)])[0]?.message).toMatch(/3 tiles active/);
  });
});

describe('loadChart', () => {
  const respond =
    (body: string, status = 200) =>
    () =>
      Promise.resolve(new Response(body, { status }));

  it('fetches and parses a chart', async () => {
    const valid = chart([tap(0, 0)]);
    await expect(
      loadChart('songs/test-song.json', respond(JSON.stringify(valid))),
    ).resolves.toEqual(valid);
  });

  it('rejects with the URL and status when the request fails', async () => {
    await expect(loadChart('songs/missing.json', respond('', 404))).rejects.toThrow(
      'Could not load chart songs/missing.json: HTTP 404',
    );
  });

  it('rejects an invalid chart with the reason', async () => {
    await expect(loadChart('songs/bad.json', respond('{"version":1}'))).rejects.toThrow(
      /songs\/bad\.json: Invalid chart/,
    );
  });

  it('rejects a body that is not JSON', async () => {
    await expect(loadChart('songs/bad.json', respond('<html>'))).rejects.toThrow(/not JSON/);
  });
});
