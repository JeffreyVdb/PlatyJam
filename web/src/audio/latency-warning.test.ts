import { describe, expect, it } from 'vitest';
import {
  appendSample,
  approximateMs,
  BAND_TOLERANCE_MS,
  DELAYED_OUTPUT_MS,
  judgeOutput,
  type LatencySample,
  shouldWarn,
  typicalLatency,
  VERDICT_SAMPLES,
} from './latency-warning';

const repeat = (ms: LatencySample, count = VERDICT_SAMPLES) =>
  Array.from({ length: count }, () => ms);

describe('judgeOutput', () => {
  it('calls the output delayed after enough readings at the threshold or above', () => {
    expect(judgeOutput(repeat(DELAYED_OUTPUT_MS))).toBe('delayed');
    expect(judgeOutput(repeat(DELAYED_OUTPUT_MS + 200))).toBe('delayed');
  });

  it('calls it on time after enough readings below the threshold', () => {
    expect(judgeOutput(repeat(DELAYED_OUTPUT_MS - 1))).toBe('onTime');
    expect(judgeOutput(repeat(11.6))).toBe('onTime');
  });

  it('is unsure until enough readings arrived', () => {
    expect(judgeOutput([])).toBe('unsure');
    expect(judgeOutput(repeat(DELAYED_OUTPUT_MS + 100, VERDICT_SAMPLES - 1))).toBe('unsure');
    expect(judgeOutput(repeat(5, VERDICT_SAMPLES - 1))).toBe('unsure');
  });

  it('is unsure while the readings straddle the threshold (settling after a route change)', () => {
    const window = [DELAYED_OUTPUT_MS + 100, DELAYED_OUTPUT_MS - 10, DELAYED_OUTPUT_MS + 100];
    expect(judgeOutput(window)).toBe('unsure');
  });

  it('never counts an unknown reading toward either verdict', () => {
    for (let unknownAt = 0; unknownAt < VERDICT_SAMPLES; unknownAt += 1) {
      for (const ms of [DELAYED_OUTPUT_MS + 100, 5]) {
        const window = repeat(ms);
        window[unknownAt] = undefined;
        expect(judgeOutput(window)).toBe('unsure');
      }
    }
    expect(judgeOutput(repeat(undefined))).toBe('unsure');
  });

  it('judges only the most recent readings', () => {
    expect(judgeOutput([undefined, 5, ...repeat(300)])).toBe('delayed');
    expect(judgeOutput([300, 300, ...repeat(5)])).toBe('onTime');
  });
});

describe('appendSample', () => {
  it('keeps the latest readings only, without changing the window it was given', () => {
    const first = [1, 2, 3];
    const next = appendSample(first, 4);
    expect(next).toEqual([2, 3, 4]);
    expect(first).toEqual([1, 2, 3]);
  });

  it('lets a delayed output turn on time one reading at a time', () => {
    let window: LatencySample[] = repeat(300);
    const seen: string[] = [];
    for (let i = 0; i < VERDICT_SAMPLES; i += 1) {
      window = appendSample(window, 10);
      seen.push(judgeOutput(window));
    }
    expect(seen).toEqual([...repeat('unsure', VERDICT_SAMPLES - 1), 'onTime']);
  });
});

describe('typicalLatency', () => {
  it('is the median of the known readings', () => {
    expect(typicalLatency([100, undefined, 300, 200])).toBe(200);
    expect(typicalLatency([100, 200])).toBe(150);
  });

  it('is unknown when no reading is known', () => {
    expect(typicalLatency([])).toBeUndefined();
    expect(typicalLatency(repeat(undefined))).toBeUndefined();
  });
});

describe('shouldWarn', () => {
  const delayed = DELAYED_OUTPUT_MS + 100;

  it('warns for a delayed output nobody silenced', () => {
    expect(shouldWarn('delayed', delayed, null)).toBe(true);
  });

  it('never warns for an output that is on time or unsure', () => {
    expect(shouldWarn('onTime', 5, null)).toBe(false);
    expect(shouldWarn('unsure', delayed, null)).toBe(false);
    expect(shouldWarn('delayed', undefined, null)).toBe(false);
  });

  it('stays quiet within the band of the delay the player silenced', () => {
    expect(shouldWarn('delayed', delayed, delayed)).toBe(false);
    expect(shouldWarn('delayed', delayed + BAND_TOLERANCE_MS, delayed)).toBe(false);
    expect(shouldWarn('delayed', delayed - BAND_TOLERANCE_MS, delayed)).toBe(false);
  });

  it('asks again when the delay moved out of the band', () => {
    expect(shouldWarn('delayed', delayed + BAND_TOLERANCE_MS + 1, delayed)).toBe(true);
    expect(shouldWarn('delayed', delayed - BAND_TOLERANCE_MS - 1, delayed)).toBe(true);
  });
});

describe('approximateMs', () => {
  it.each([
    [187, 190],
    [184, 180],
    [80, 80],
    [4, 10],
    [0, 10],
  ])('%s ms reads as about %s ms', (ms, expected) => {
    expect(approximateMs(ms)).toBe(expected);
  });
});
