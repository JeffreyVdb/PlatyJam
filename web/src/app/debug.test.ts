import { describe, expect, it } from 'vitest';
import { isDebugEnabled } from './debug';

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
