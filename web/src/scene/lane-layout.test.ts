import { describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import { firstVisibleTile, laneForPoint, longestHold, tileDepth } from './lane-layout';

const tile = (t: number, dur?: number): Tile => ({
  t,
  lane: 0,
  pitches: [60],
  vel: 80,
  ...(dur === undefined ? {} : { dur }),
});

describe('lane layout', () => {
  it('places a tile by song time: the hit line at 0, the lane top a scroll window ahead', () => {
    // 1600 real ms at 1.5x shows 2400 chart ms over 14 units.
    const window = 1600 * 1.5;
    expect(tileDepth(5000, 5000, window, 14)).toBe(-0);
    expect(tileDepth(7400, 5000, window, 14)).toBe(-14);
    expect(tileDepth(4400, 5000, window, 14)).toBe(3.5);
  });

  it('starts drawing after tiles that have ended, never after one still on screen', () => {
    const tiles = [tile(0), tile(100, 3000), tile(200), tile(4000), tile(5000)];
    const longest = longestHold(tiles);
    expect(longest).toBe(3000);
    for (const from of [0, 150, 2900, 3100, 4500, 9000]) {
      const first = firstVisibleTile(tiles, from, longest);
      // Everything skipped ended before `from`...
      expect(tiles.slice(0, first).every((t) => t.t + (t.dur ?? 0) < from)).toBe(true);
      // ...and the hold that is still sounding at 2900 is not skipped.
      if (from === 2900) expect(first).toBeLessThanOrEqual(1);
    }
    expect(firstVisibleTile(tiles, 9000, longest)).toBe(5);
  });

  it('maps a point on the highway to its lane, and anything else to none', () => {
    const half = 2; // four lanes of width 1, centred on x = 0
    expect(laneForPoint(-1.9, -3, { halfWidth: half, far: 14, near: 2 })).toBe(0);
    expect(laneForPoint(-0.01, 0, { halfWidth: half, far: 14, near: 2 })).toBe(1);
    expect(laneForPoint(0.01, 1.5, { halfWidth: half, far: 14, near: 2 })).toBe(2);
    expect(laneForPoint(1.99, -13, { halfWidth: half, far: 14, near: 2 })).toBe(3);
    expect(laneForPoint(2.3, 0, { halfWidth: half, far: 14, near: 2 })).toBeUndefined();
    expect(laneForPoint(0.5, 2.5, { halfWidth: half, far: 14, near: 2 })).toBeUndefined();
    expect(laneForPoint(0.5, -15, { halfWidth: half, far: 14, near: 2 })).toBeUndefined();
  });
});
