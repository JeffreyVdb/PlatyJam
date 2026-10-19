import { LANES, type Tile } from '../chart/schema';

/**
 * Where tiles go on the highway: a pure function of song time, never of frames.
 * World z is 0 at the hit line and negative up the lane; `farDepth` units show
 * `windowMs` chart ms (the scroll duration times the tempo).
 */
export function tileDepth(t: number, songMs: number, windowMs: number, farDepth: number): number {
  return -((t - songMs) / windowMs) * farDepth;
}

/** The longest hold in a tile list, chart ms (0 when there is none). */
export function longestHold(tiles: readonly Tile[]): number {
  let longest = 0;
  for (const tile of tiles) longest = Math.max(longest, tile.dur ?? 0);
  return longest;
}

/**
 * A start index for drawing: every tile before it ended before `fromMs`. Tiles are
 * sorted by start and none lasts longer than `longest`, so that holds for every tile
 * starting before `fromMs − longest`. A binary search, so it also works when the
 * display time moves backwards (the fail rewind) or jumps (a restart).
 */
export function firstVisibleTile(tiles: readonly Tile[], fromMs: number, longest: number): number {
  const target = fromMs - longest;
  let lo = 0;
  let hi = tiles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((tiles[mid]?.t ?? Infinity) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface HighwayBounds {
  /** Half the highway's width, world units. */
  halfWidth: number;
  /** How far the lanes run up from the hit line. */
  far: number;
  /** How far the touchable surface reaches below the hit line. */
  near: number;
}

/** The lane under a point on the highway plane (x across, z along), or undefined. */
export function laneForPoint(x: number, z: number, bounds: HighwayBounds): number | undefined {
  if (Math.abs(x) > bounds.halfWidth || z < -bounds.far || z > bounds.near) return undefined;
  const lane = Math.floor(((x + bounds.halfWidth) / (2 * bounds.halfWidth)) * LANES);
  return Math.min(LANES - 1, Math.max(0, lane));
}
