import { LANES, MAX_ACTIVE_TILES, type Tile } from '../../src/chart/schema.ts';
import type { Cluster } from './clusters.ts';
import type { Thresholds } from './config.ts';
import { compareStrength, type TimedNote } from './timing.ts';

export interface PlaceOptions extends Pick<Thresholds, 'doubles' | 'holdMinMs' | 'minLaneGapMs'> {
  /** Lowest and highest melody pitch: the first tile's lane follows its place in this range. */
  pitchRange: { low: number; high: number };
}

export interface Placement {
  /** Sorted by (t, lane). */
  tiles: Tile[];
  /** Notes that did not become tiles: chord notes beyond a double, dropped doubles, demoted notes. */
  leftover: TimedNote[];
}

interface Placed {
  t: number;
  lane: number;
  /** Set on holds. */
  dur: number | undefined;
  note: TimedNote;
}

/** Lanes to move for a melodic interval: steps move one lane, wider leaps two or three. */
export function laneStep(semitones: number): number {
  const size = Math.abs(semitones);
  return size <= 4 ? 1 : size <= 9 ? 2 : 3;
}

/**
 * Turns the kept clusters of one difficulty into tiles, in time order:
 *
 * - The highest note is the tile. The lowest of the others makes a double when the
 *   `doubles` policy allows it; the rest of the chord goes to `leftover`.
 * - Notes at least `holdMinMs` long become holds.
 * - Lanes follow the pitch contour: a higher pitch moves right, a lower one left, the
 *   same pitch stays in its lane; wider leaps move further. At an edge the motion
 *   bounces back and keeps that way until the contour turns. A double puts its
 *   lower note left of the higher one.
 * - A lane is free `minLaneGapMs` after its previous tile ends. A hold in the way is
 *   trimmed to end that gap before the new tile, and holds are trimmed so that at
 *   most two tiles are active at once. A hold trimmed below half of `holdMinMs`
 *   becomes a tap.
 * - When no lane fits, the double is dropped, then the note itself goes to `leftover`.
 */
export function placeTiles(clusters: readonly Cluster[], options: PlaceOptions): Placement {
  const { doubles, holdMinMs, minLaneGapMs: gap, pitchRange } = options;
  const minHoldMs = Math.max(1, Math.ceil(holdMinMs / 2));
  const placed: Placed[] = [];
  const laneLast: (Placed | undefined)[] = Array.from({ length: LANES }, () => undefined);
  const leftover: TimedNote[] = [];
  let prev: { lane: number; pitch: number } | undefined;
  let lastSign = 0;
  let flipped = false;

  const end = (p: Placed) => p.t + (p.dur ?? 0);
  const trim = (p: Placed, until: number) => {
    const dur = until - p.t;
    p.dur = p.dur !== undefined && dur >= minHoldMs ? Math.min(p.dur, dur) : undefined;
  };
  const isFree = (lane: number, t: number) => {
    const last = laneLast[lane];
    return !last || end(last) + gap <= t;
  };
  const isTrimmable = (lane: number, t: number) => {
    const last = laneLast[lane];
    return last?.dur !== undefined && last.t + gap <= t;
  };
  const usable = (lane: number, t: number, allowTrim: boolean) =>
    isFree(lane, t) || (allowTrim && isTrimmable(lane, t));
  const claim = (lane: number, note: TimedNote, t: number) => {
    const last = laneLast[lane];
    if (last && !isFree(lane, t)) trim(last, t - gap);
    const tile: Placed = { t, lane, dur: note.dur >= holdMinMs ? note.dur : undefined, note };
    placed.push(tile);
    laneLast[lane] = tile;
  };
  /** First [main, lower] lane pair that fits: free lanes first, then by trimming holds. */
  const findPair = (
    t: number,
    mains: number[],
    lowerTarget: (m: number) => number,
    repeat?: number,
  ) => {
    for (const allowTrim of [false, true]) {
      for (const m of mains) {
        if (m === 0 || !usable(m, t, allowTrim || m === repeat)) continue;
        const s = laneOrder(lowerTarget(m), -1).find(
          (lane) => lane < m && usable(lane, t, allowTrim),
        );
        if (s !== undefined) return [m, s] as const;
      }
    }
    return undefined;
  };

  for (const cluster of clusters) {
    const { t } = cluster;
    const [main, ...rest] = cluster.notes;
    if (!main) continue;
    const wantsDouble =
      doubles === 'all' ||
      (doubles === 'beats' && compareStrength(cluster.strength, 'beat') >= 0) ||
      (doubles === 'strong' && compareStrength(cluster.strength, 'strong') >= 0);
    const second = wantsDouble ? rest.pop() : undefined;
    leftover.push(...rest);

    // Make room: earlier holds still sounding at t count towards the two active tiles.
    const holds = laneLast
      .filter((p): p is Placed => p?.dur !== undefined && end(p) > t)
      .sort((a, b) => a.t - b.t || a.lane - b.lane);
    const needed = second ? 2 : 1;
    while (holds.length + needed > MAX_ACTIVE_TILES) {
      const hold = holds.shift();
      if (hold) trim(hold, t - gap);
    }

    // Contour: where the main note would like to go.
    const interval = prev ? main.pitch - prev.pitch : 0;
    const sign = Math.sign(interval);
    let flip: boolean = sign !== 0 && sign !== lastSign ? false : flipped;
    let dir = flip ? -sign : sign;
    let target: number;
    if (!prev) {
      const span = pitchRange.high - pitchRange.low + 1;
      target = Math.min(LANES - 1, Math.floor(((main.pitch - pitchRange.low) / span) * LANES));
    } else {
      target = prev.lane + dir * laneStep(interval);
      if (target < 0 || target >= LANES) {
        const edge = target < 0 ? 0 : LANES - 1;
        if (prev.lane !== edge) target = edge;
        else {
          flip = !flip;
          dir = -dir;
          target = clampLane(prev.lane + dir * laneStep(interval));
        }
      }
    }
    const order = laneOrder(target, dir);
    /** A repeated pitch stays in its lane, trimming its own hold if need be. */
    const repeatLane = prev && interval === 0 ? prev.lane : undefined;

    let mainLane: number | undefined;
    if (second) {
      const low = second;
      const pair = findPair(t, order, (m) => m - laneStep(main.pitch - low.pitch), repeatLane);
      if (pair) {
        mainLane = pair[0];
        claim(pair[0], main, t);
        claim(pair[1], low, t);
      } else {
        leftover.push(low);
      }
    }
    if (mainLane === undefined) {
      mainLane =
        order.find((lane) => usable(lane, t, lane === repeatLane)) ??
        order.find((lane) => usable(lane, t, true));
      if (mainLane === undefined) {
        leftover.push(main);
        continue;
      }
      claim(mainLane, main, t);
    }
    prev = { lane: mainLane, pitch: main.pitch };
    if (sign !== 0) lastSign = sign;
    flipped = flip;
  }

  const tiles = placed
    .map(({ t, lane, dur, note }): Tile => ({
      t,
      lane,
      ...(dur === undefined ? {} : { dur }),
      pitches: [note.pitch],
      vel: note.vel,
    }))
    .sort((a, b) => a.t - b.t || a.lane - b.lane);
  return { tiles, leftover };
}

function clampLane(lane: number): number {
  return Math.min(LANES - 1, Math.max(0, lane));
}

/** All lanes, nearest to `target` first; at equal distance, the one in direction `dir` first. */
function laneOrder(target: number, dir: number): number[] {
  const t = clampLane(target);
  return Array.from({ length: LANES }, (_, lane) => lane).sort(
    (a, b) => Math.abs(a - t) - Math.abs(b - t) || (b - t) * dir - (a - t) * dir || a - b,
  );
}
