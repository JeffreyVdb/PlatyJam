import { describe, expect, it } from 'vitest';
import { debugOutputLatency, isDebugEnabled } from './debug';

describe('isDebugEnabled', () => {
  it('turns on for ?debug with or without a value', () => {
    expect(isDebugEnabled('?debug')).toBe(true);
    expect(isDebugEnabled('?debug=1')).toBe(true);
    expect(isDebugEnabled('?song=a&debug')).toBe(true);
  });

  it('stays off otherwise', () => {
    expect(isDebugEnabled('')).toBe(false);
    expect(isDebugEnabled('?debugger')).toBe(false);
  });
});

describe('debugOutputLatency', () => {
  it('reads the faked latency in ms from ?debug&latency=', () => {
    expect(debugOutputLatency('?debug&latency=250')).toBe(250);
    expect(debugOutputLatency('?latency=40.5&debug')).toBe(40.5);
  });

  it('has no effect without ?debug', () => {
    expect(debugOutputLatency('?latency=250')).toBeUndefined();
  });

  it.each([
    '',
    '?debug',
    '?debug&latency=',
    '?debug&latency=abc',
    '?debug&latency=0',
    '?debug&latency=-5',
  ])('ignores a missing or unusable value (%s)', (search) => {
    expect(debugOutputLatency(search)).toBeUndefined();
  });
});
