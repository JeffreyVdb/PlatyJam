import { LANES, type Tile } from '../chart/schema';
import type { TileSize } from '../game/session-contract';

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
  /** Half the width of the four lanes, world units: where the visible dividers sit. */
  halfWidth: number;
  /** How far beyond the outer lane edges a touch still counts, for the outer lanes. */
  slack?: number;
  /** How far the lanes run up from the hit line. */
  far: number;
  /** How far the touchable surface reaches below the hit line. */
  near: number;
}

/**
 * The lane under a point on the highway plane (x across, z along), or undefined.
 * Lane edges are the visible dividers; the slack only widens the outer lanes.
 */
export function laneForPoint(x: number, z: number, bounds: HighwayBounds): number | undefined {
  const reach = bounds.halfWidth + (bounds.slack ?? 0);
  if (Math.abs(x) > reach || z < -bounds.far || z > bounds.near) return undefined;
  const lane = Math.floor(((x + bounds.halfWidth) / (2 * bounds.halfWidth)) * LANES);
  return Math.min(LANES - 1, Math.max(0, lane));
}

// ---- Tiles: the flat view's line and tile heights (PLA-18) ----

/**
 * Tiles' notional line, as a fraction of the screen height from the top: a tile's
 * bottom edge reaches it at the tile's time, and the scroll window maps the top of
 * the screen onto it. A landscape screen is short and the HUD takes a larger share of
 * its top, so the line sits lower there to keep about as much read-ahead in view.
 * Tune both on the iPad and a phone.
 */
export const FLAT_LINE_PORTRAIT = 0.74;
export const FLAT_LINE_LANDSCAPE = 0.78;

/**
 * Tile heights per size, as fractions of the screen height: a tile reaches up to the
 * next tile's start (a staircase), within `[floor, base]`. Tiles is about touching a
 * tile, not timing it, so the floor is high: a tile is always big enough to press
 * with confidence, and on dense passages neighbouring lanes overlap instead (the
 * next tile's tint shows the order).
 */
export const TILE_HEIGHTS: Readonly<Record<TileSize, { base: number; floor: number }>> = {
  normal: { base: 1 / 4, floor: 1 / 5 },
  big: { base: 1 / 3, floor: 1 / 4 },
};

/** No tile is drawn shorter than this, CSS px, however short the screen. */
export const MIN_TILE_PX = 56;
/** The gap left between two tiles of one lane, CSS px, so that they never touch. */
export const TILE_SEAM_PX = 2;

/**
 * What Tiles needs to know of the screen, from the stage (`GameStage.tilesFrame`):
 * where tiles are lost, in scroll windows past the line (the bottom edge of the
 * screen), and the screen's size in CSS px. The screen is `1 + exitAlong` scroll
 * windows tall.
 */
export interface TilesFrame {
  exitAlong: number;
  widthPx: number;
  heightPx: number;
}

/** A phone in portrait, until the stage says. */
export const DEFAULT_TILES_FRAME: Readonly<TilesFrame> = {
  exitAlong: (1 - FLAT_LINE_PORTRAIT) / FLAT_LINE_PORTRAIT,
  widthPx: 390,
  heightPx: 844,
};

/** Tile heights in scroll windows: the base, the floor and the seam within a lane. */
export interface TileSizing {
  base: number;
  floor: number;
  seam: number;
}

/** The sizing for a tile size on a screen. */
export function tileSizing(size: TileSize, frame: Readonly<TilesFrame>): TileSizing {
  const heights = TILE_HEIGHTS[size];
  const screen = 1 + frame.exitAlong;
  const perPx = screen / Math.max(1, frame.heightPx);
  const floor = Math.max(heights.floor * screen, MIN_TILE_PX * perPx);
  return { base: Math.max(heights.base * screen, floor), floor, seam: TILE_SEAM_PX * perPx };
}

function spanOf(
  tile: Tile,
  nextStart: number,
  nextInLane: number,
  windowMs: number,
  { base, floor, seam }: TileSizing,
): number {
  // Up to the next tile's start in any lane, within [floor, base]; a long tile at
  // least as tall as its note. Never into the next tile of its own lane, though:
  // that cap wins over the floor.
  let span = Math.max(Math.min(nextStart - tile.t, base * windowMs), floor * windowMs);
  if (tile.dur !== undefined) span = Math.max(span, tile.dur);
  return Math.max(0, Math.min(span, nextInLane - tile.t - seam * windowMs));
}

/**
 * How tall tile `index` is drawn, in chart ms from its bottom edge (at its time) to
 * its top. The drawing and the hit test both use it, so a tile is pressable exactly
 * where it is drawn, and drawn (red once lost, translucent once cleared) until its
 * top has left the screen.
 */
export function tileSpan(
  tiles: readonly Tile[],
  index: number,
  windowMs: number,
  sizing: Readonly<TileSizing>,
): number {
  const tile = tiles[index];
  if (!tile) return 0;
  let nextStart = Infinity;
  let nextInLane = Infinity;
  for (let k = index + 1; k < tiles.length; k += 1) {
    const other = tiles[k];
    if (!other) break;
    if (nextStart === Infinity && other.t > tile.t) nextStart = other.t;
    if (other.lane === tile.lane) {
      nextInLane = other.t;
      break;
    }
    // Tiles are sorted by time: past the base, nothing further can shorten this one.
    if (
      nextStart !== Infinity &&
      other.t - tile.t > Math.max(sizing.base * windowMs, tile.dur ?? 0)
    ) {
      break;
    }
  }
  return spanOf(tile, nextStart, nextInLane, windowMs, sizing);
}

/** `tileSpan` of every tile, in one pass from the end. */
export function tileSpans(
  tiles: readonly Tile[],
  windowMs: number,
  sizing: Readonly<TileSizing>,
): Float64Array {
  const spans = new Float64Array(tiles.length);
  const laterInLane = new Array<number>(LANES).fill(Infinity);
  let laterStart = Infinity;
  for (let i = tiles.length - 1; i >= 0; i -= 1) {
    const tile = tiles[i];
    if (!tile) continue;
    const after = tiles[i + 1];
    // The first start after this tile's: a double's partner shares its time.
    if (after && after.t > tile.t) laterStart = after.t;
    spans[i] = spanOf(tile, laterStart, laterInLane[tile.lane] ?? Infinity, windowMs, sizing);
    laterInLane[tile.lane] = tile.t;
  }
  return spans;
}
