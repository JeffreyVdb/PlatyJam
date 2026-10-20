import { describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import {
  DEFAULT_TILES_FRAME,
  firstVisibleTile,
  laneForPoint,
  longestHold,
  MIN_TILE_PX,
  TILE_HEIGHTS,
  tileDepth,
  tileSizing,
  type TileSizing,
  tileSpan,
  tileSpans,
} from './lane-layout';

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

  it('keeps lane edges on the visible dividers, whatever the slack', () => {
    const bounds = { halfWidth: 2, slack: 0.15, far: 14, near: 2 };
    // Dividers at -1, 0 and 1: a touch either side lands in the lane it is drawn in.
    expect(laneForPoint(-1.02, 0, bounds)).toBe(0);
    expect(laneForPoint(-0.98, 0, bounds)).toBe(1);
    expect(laneForPoint(-0.02, 0, bounds)).toBe(1);
    expect(laneForPoint(0.02, 0, bounds)).toBe(2);
    expect(laneForPoint(0.98, 0, bounds)).toBe(2);
    expect(laneForPoint(1.02, 0, bounds)).toBe(3);
    // The slack gives the outer lanes a margin beyond their drawn edges, and no more.
    expect(laneForPoint(-2.1, 0, bounds)).toBe(0);
    expect(laneForPoint(2.1, 0, bounds)).toBe(3);
    expect(laneForPoint(-2.2, 0, bounds)).toBeUndefined();
    expect(laneForPoint(2.2, 0, bounds)).toBeUndefined();
  });
});

describe('Tiles tile sizing', () => {
  const at = (t: number, lane: number, dur?: number): Tile => ({
    t,
    lane,
    pitches: [60],
    vel: 80,
    ...(dur === undefined ? {} : { dur }),
  });
  // A phone in portrait at Normal speed: the screen is 1 / 0.74 windows tall.
  const windowMs = 1600;
  const frame = DEFAULT_TILES_FRAME;
  const screenMs = (1 + frame.exitAlong) * windowMs;
  const normal = tileSizing('normal', frame);
  const big = tileSizing('big', frame);
  const ms = (windows: number) => windows * windowMs;
  /** Spans both ways: the one-tile function and the one-pass one agree. */
  const spans = (tiles: Tile[], sizing: TileSizing) => {
    const all = Array.from(tileSpans(tiles, windowMs, sizing));
    expect(all).toEqual(tiles.map((_, i) => tileSpan(tiles, i, windowMs, sizing)));
    return all;
  };

  it('sizes tiles as fractions of the screen height, Big taller than Normal', () => {
    expect(ms(normal.base)).toBeCloseTo(screenMs * TILE_HEIGHTS.normal.base, 6);
    expect(ms(normal.floor)).toBeCloseTo(screenMs * TILE_HEIGHTS.normal.floor, 6);
    expect(ms(big.base)).toBeCloseTo(screenMs / 3, 6);
    expect(ms(big.floor)).toBeCloseTo(screenMs / 4, 6);
    // About 540 ms, 210 px of a 844 px phone, and never under 170 px.
    expect(ms(normal.base)).toBeCloseTo(540.5, 0);
    expect((normal.floor / (1 + frame.exitAlong)) * frame.heightPx).toBeCloseTo(168.8, 1);
    expect(big.base).toBeGreaterThan(normal.base);
    expect(big.floor).toBeGreaterThan(normal.floor);
    // A hairline seam: 2 px.
    expect((normal.seam * frame.heightPx) / (1 + frame.exitAlong)).toBeCloseTo(2, 6);
  });

  it('keeps the floor a thumb tall on a very short screen', () => {
    const px = (sizing: TileSizing, frame: { exitAlong: number; heightPx: number }) => ({
      floor: (sizing.floor / (1 + frame.exitAlong)) * frame.heightPx,
      base: (sizing.base / (1 + frame.exitAlong)) * frame.heightPx,
    });
    // A phone on its side: a fifth of the height is already more than a thumb.
    const sideways = { exitAlong: 0.28, widthPx: 844, heightPx: 390 };
    expect(px(tileSizing('normal', sideways), sideways).floor).toBeCloseTo(78, 6);
    const sliver = { exitAlong: 0.28, widthPx: 500, heightPx: 200 };
    expect(px(tileSizing('normal', sliver), sliver)).toEqual({
      floor: expect.closeTo(MIN_TILE_PX, 6) as number,
      base: expect.closeTo(MIN_TILE_PX, 6) as number,
    });
  });

  it('builds a staircase: each tile reaches up to the next start, in any lane', () => {
    // 480 ms apart: between the floor (432 ms) and the base (540 ms).
    const tiles = [at(0, 0), at(480, 1), at(960, 2), at(1440, 3), at(1920, 0)];
    expect(spans(tiles, normal)).toEqual([480, 480, 480, 480, ms(normal.base)]);
    // Big's floor is above that: its tiles overlap their neighbours instead.
    expect(spans(tiles, big)[0]).toBeCloseTo(ms(big.floor), 9);
  });

  it('caps a tile at the base height when the next one is far away', () => {
    const tiles = [at(0, 0), at(2000, 1)];
    expect(spans(tiles, normal)[0]).toBeCloseTo(ms(normal.base), 9);
    expect(spans(tiles, big)[0]).toBeCloseTo(ms(big.base), 9);
  });

  it('never draws a tile shorter than the floor, overlapping in other lanes instead', () => {
    const tiles = [at(0, 0), at(100, 1), at(200, 2), at(300, 3)];
    const drawn = spans(tiles, normal);
    expect(drawn.slice(0, 3)).toEqual([ms(normal.floor), ms(normal.floor), ms(normal.floor)]);
    expect(drawn[0]).toBeGreaterThan(100);
    expect(spans(tiles, big)[0]).toBeCloseTo(ms(big.floor), 9);
  });

  it('never lets two tiles of one lane overlap: that cap wins over the floor', () => {
    const tiles = [at(0, 0), at(100, 0), at(200, 1)];
    const [first] = spans(tiles, normal);
    expect(first).toBeCloseTo(100 - ms(normal.seam), 9);
    expect(first).toBeLessThan(ms(normal.floor));
  });

  it('gives both tiles of a double the same span, up to the next start', () => {
    const tiles = [at(0, 0), at(0, 2), at(500, 1)];
    expect(spans(tiles, normal).slice(0, 2)).toEqual([500, 500]);
  });

  it('draws a long tile at least as tall as its note, but not into its lane’s next tile', () => {
    const tiles = [at(0, 2, 1500), at(300, 1), at(1600, 2), at(1700, 2, 100)];
    const [long, , , short] = spans(tiles, normal);
    expect(long).toBe(1500);
    // A short long tile is still a staircase tile.
    expect(short).toBeCloseTo(ms(normal.base), 9);
    const crowded = [at(0, 2, 1500), at(1000, 2)];
    expect(spans(crowded, normal)[0]).toBeCloseTo(1000 - ms(normal.seam), 9);
  });

  it('keeps every tile of a dense passage in its lane, and every tile visible from the floor', () => {
    // A Hard-like run: 92 ms apart, lanes cycling.
    const tiles = Array.from({ length: 40 }, (_, i) => at(i * 92, [0, 1, 2, 3, 2, 1][i % 6] ?? 0));
    const drawn = spans(tiles, normal);
    tiles.forEach((tile, i) => {
      const next = tiles.slice(i + 1).find((other) => other.lane === tile.lane);
      if (next) expect(tile.t + (drawn[i] ?? 0)).toBeLessThan(next.t);
      expect(drawn[i]).toBeGreaterThan(0);
    });
  });
});
