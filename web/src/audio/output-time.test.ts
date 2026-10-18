import { describe, expect, it } from 'vitest';
import { contextTimeAt } from './output-time';

describe('contextTimeAt', () => {
  it('maps a performance time through the output timestamp', () => {
    const sample = {
      currentTime: 10.04,
      nowMs: 5000,
      timestamp: { contextTime: 10, performanceTime: 4990 },
    };
    // 30 ms after the timestamp's frame was presented.
    expect(contextTimeAt(5020, sample)).toBeCloseTo(10.03, 9);
    // An input event that happened before the timestamp was taken.
    expect(contextTimeAt(4900, sample)).toBeCloseTo(9.91, 9);
  });

  it('falls back to currentTime when getOutputTimestamp is missing', () => {
    const sample = { currentTime: 3, nowMs: 1000 };
    expect(contextTimeAt(1000, sample)).toBe(3);
    expect(contextTimeAt(900, sample)).toBeCloseTo(2.9, 9);
  });

  it('falls back to currentTime before the first rendered block (zeros)', () => {
    const sample = {
      currentTime: 0.5,
      nowMs: 2000,
      timestamp: { contextTime: 0, performanceTime: 0 },
    };
    expect(contextTimeAt(2100, sample)).toBeCloseTo(0.6, 9);
  });

  it('falls back when the timestamp has missing members', () => {
    const sample = { currentTime: 1, nowMs: 100, timestamp: {} };
    expect(contextTimeAt(100, sample)).toBe(1);
  });

  it('falls back when the timestamp disagrees with currentTime by more than 0.5 s', () => {
    const stale = {
      currentTime: 20,
      nowMs: 10_000,
      // Says the output is at 18.9 s now: 1.1 s behind currentTime.
      timestamp: { contextTime: 18.9, performanceTime: 10_000 },
    };
    expect(contextTimeAt(10_000, stale)).toBe(20);
  });

  it('trusts a timestamp that lags currentTime by a normal output latency', () => {
    const sample = {
      currentTime: 20,
      nowMs: 10_000,
      timestamp: { contextTime: 19.95, performanceTime: 10_000 },
    };
    expect(contextTimeAt(10_000, sample)).toBeCloseTo(19.95, 9);
  });
});
