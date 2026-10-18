import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_GRID,
  deriveOffsets,
  interquartileRange,
  median,
  summarizePhase,
  tapErrors,
} from './calibration';

describe('median and interquartileRange', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('measures the spread of the middle half (linear quartiles)', () => {
    // Q1 = 3.25, Q3 = 7.75 for 1..10.
    expect(interquartileRange([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(4.5, 9);
    expect(interquartileRange([7, 7, 7, 7])).toBe(0);
  });
});

describe('tapErrors', () => {
  const grid = { beatMs: 600, countInBeats: 4, scoredBeats: 16 };

  it('signs each tap against the nearest scored beat: positive is late', () => {
    // Beat 4 is at 2400 ms, beat 5 at 3000 ms.
    expect(tapErrors([2430, 2950], grid)).toEqual([30, -50]);
  });

  it('ignores taps nearest a count-in beat or past the last beat', () => {
    // 2050 is nearest beat 3 (count-in); 12_100 is nearest beat 20 (after beat 19).
    expect(tapErrors([1200, 2050, 2399, 12_100], grid)).toEqual([-1]);
  });

  it('keeps only the first tap on a beat (a double tap)', () => {
    expect(tapErrors([3010, 3090, 3590], grid)).toEqual([10, -10]);
  });

  it('uses the shipped grid: 100 BPM, 4-beat count-in, 16 scored beats', () => {
    expect(CALIBRATION_GRID).toEqual({ beatMs: 600, countInBeats: 4, scoredBeats: 16 });
  });
});

describe('summarizePhase', () => {
  const settling = [200, -200, 150, 90];

  it('drops the first four taps as settling, then takes the median', () => {
    const result = summarizePhase([...settling, 30, 32, 28, 31, 29, 30, 35, 25]);
    expect(result).toEqual({
      ok: true,
      offsetMs: 30,
      iqrMs: expect.any(Number) as number,
      taps: 8,
    });
  });

  it('rejects taps more than 120 ms off before counting', () => {
    const result = summarizePhase([...settling, 30, 30, 30, 30, 30, 30, 30, 30, 121, -125]);
    expect(result).toMatchObject({ ok: true, offsetMs: 30, taps: 8 });
  });

  it('needs at least eight taps after filtering', () => {
    expect(summarizePhase([...settling, 30, 30, 30, 30, 30, 30, 30, 200])).toEqual({
      ok: false,
      reason: 'too-few-taps',
      taps: 7,
    });
  });

  it('calls a spread wider than 60 ms inconsistent', () => {
    const result = summarizePhase([...settling, -60, -50, -40, 0, 10, 40, 50, 60]);
    expect(result).toMatchObject({ ok: false, reason: 'inconsistent', taps: 8 });
  });
});

describe('deriveOffsets', () => {
  it('sets I from the seen phase and A from the difference', () => {
    // Sound 50 ms late, input 30 ms late: heard 80, seen 30.
    expect(deriveOffsets({ seenMs: 30, heardMs: 80 })).toEqual({
      audioOffsetMs: 50,
      inputOffsetMs: 30,
    });
  });

  it('allows a negative audio offset (taps to sound land earlier than to sight)', () => {
    expect(deriveOffsets({ seenMs: 40, heardMs: 10 })).toEqual({
      audioOffsetMs: -30,
      inputOffsetMs: 40,
    });
  });

  it('clamps to the sane range', () => {
    expect(deriveOffsets({ seenMs: 400, heardMs: 1200 })).toEqual({
      audioOffsetMs: 400,
      inputOffsetMs: 250,
    });
    expect(deriveOffsets({ seenMs: -300, heardMs: -900 })).toEqual({
      audioOffsetMs: -150,
      inputOffsetMs: -150,
    });
  });

  it('rounds to whole ms', () => {
    expect(deriveOffsets({ seenMs: 20.4, heardMs: 61.2 })).toEqual({
      audioOffsetMs: 41,
      inputOffsetMs: 20,
    });
  });
});
