// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { velocityToMidi } from './extract.ts';
import { quantizeTick, strengthAt, timeNotes, type Meter } from './timing.ts';

const sixteenths = { step: 120, tolerance: 0.25 };

describe('quantizeTick', () => {
  it('snaps onsets within the tolerance and leaves the rest', () => {
    expect(quantizeTick(482, sixteenths)).toBe(480);
    expect(quantizeTick(445, sixteenths)).toBe(445);
    expect(quantizeTick(330, sixteenths)).toBe(360);
    // Eighth-note triplets (160 ticks) are 40 ticks off the grid: kept.
    expect(quantizeTick(160, sixteenths)).toBe(160);
  });
});

describe('timeNotes', () => {
  const at120 = (tick: number) => (tick / 480) * 500;

  it('converts quantized ticks to integer ms', () => {
    const [note] = timeNotes([{ pitch: 60, tick: 483, durTicks: 237, vel: 90 }], at120, sixteenths);
    expect(note).toEqual({ t: 500, dur: 250, pitch: 60, vel: 90, tick: 480 });
  });

  it('rounds start and end, so a note ending at the next onset never overlaps it', () => {
    const third = (tick: number) => (tick / 480) * 333.33;
    const notes = timeNotes(
      [
        { pitch: 60, tick: 0, durTicks: 160, vel: 90 },
        { pitch: 62, tick: 160, durTicks: 160, vel: 90 },
      ],
      third,
      sixteenths,
    );
    expect((notes[0]?.t ?? 0) + (notes[0]?.dur ?? 0)).toBe(notes[1]?.t);
  });

  it('keeps a very short note at least 1 ms long', () => {
    const [note] = timeNotes([{ pitch: 60, tick: 478, durTicks: 4, vel: 90 }], at120, sixteenths);
    expect(note?.dur).toBeGreaterThanOrEqual(1);
  });
});

describe('strengthAt', () => {
  const meter = (sigs: [number, number, number][]): Meter => ({
    ppq: 480,
    timeSignatures: sigs.map(([ticks, n, d]) => ({ ticks, timeSignature: [n, d] })),
  });
  const q = 480;

  it('defaults to 4/4', () => {
    const m = meter([]);
    expect([0, q, 2 * q, 3 * q, 4 * q].map((t) => strengthAt(t, m))).toEqual([
      'downbeat',
      'beat',
      'strong',
      'beat',
      'downbeat',
    ]);
    expect(strengthAt(q / 2, m)).toBe('half-beat');
    expect(strengthAt(q / 4, m)).toBe('quarter-beat');
    expect(strengthAt(q / 3, m)).toBe('any');
  });

  it('counts half notes in 2/2', () => {
    const m = meter([[0, 2, 2]]);
    expect([0, q, 2 * q, 3 * q, 4 * q].map((t) => strengthAt(t, m))).toEqual([
      'downbeat',
      'half-beat',
      'strong',
      'half-beat',
      'downbeat',
    ]);
  });

  it('has no strong beat in 3/4', () => {
    const m = meter([[0, 3, 4]]);
    expect([0, q, 2 * q, 3 * q].map((t) => strengthAt(t, m))).toEqual([
      'downbeat',
      'beat',
      'beat',
      'downbeat',
    ]);
  });

  it('counts dotted beats in 6/8', () => {
    const m = meter([[0, 6, 8]]);
    const e = q / 2;
    expect([0, e, 2 * e, 3 * e, 6 * e].map((t) => strengthAt(t, m))).toEqual([
      'downbeat',
      'half-beat',
      'half-beat',
      'strong',
      'downbeat',
    ]);
  });

  it('follows time signature changes', () => {
    // Two bars of 3/4, then 2/4 from tick 2880.
    const m = meter([
      [0, 3, 4],
      [2880, 2, 4],
    ]);
    expect(strengthAt(2880, m)).toBe('downbeat');
    expect(strengthAt(2880 + q, m)).toBe('strong');
    expect(strengthAt(2880 + 2 * q, m)).toBe('downbeat');
  });
});

describe('velocityToMidi', () => {
  it('scales 0–1 to 1–127 and never returns 0', () => {
    expect([0, 0.001, 0.5, 0.709, 1, 1.2].map(velocityToMidi)).toEqual([1, 1, 64, 90, 127, 127]);
  });
});
