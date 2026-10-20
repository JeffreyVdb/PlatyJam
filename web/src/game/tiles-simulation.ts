import { LANES, type Tile, tileEnd } from '../chart/schema';
import { createScore, scoreUnit } from './scoring';
import type { Failure, Judgment, JudgmentEvent } from './session-contract';
import {
  HEAD,
  type SimulationOptions,
  type Simulation,
  type SimulationStatus,
  TAIL,
  type TileAim,
} from './simulation';

/**
 * Tiles' rules as a pure, event-ordered state machine, beside Rhythm's
 * (`simulation.ts`) and with the same interface, determinism and finalization:
 * misses and hold completions are finalized in time order, strictly before each
 * input and up to each `advance`.
 *
 * Timing doesn't matter. A tile can be claimed from the moment it appears at the top
 * of the lane until its head has crossed the stage's exit line, but only in order:
 * the earliest unclaimed tile, or both tiles of an unclaimed double. A pointer press
 * claims the tile it lands on (`TileAim`); a key claims the next tile in its lane. A
 * press on no tile at all is an empty tap. Every cleared unit (tap, hold head, hold
 * tail) is judged `clear`.
 *
 * A long tile fills from its note's start (`noteStartMs`) for its `dur` and clears
 * when full, or when its top leaves the screen first; letting go before that is a
 * tail Miss. Pause, countdown and reclaim work as in Rhythm.
 */

/**
 * The two open choices of the Tiles rules, pinned here so they are easy to flip.
 *
 * - `laterTile`: a press on a tile while an earlier one is unclaimed. `notYet`
 *   ignores it (no penalty; the stage shakes the tile). `emptyTap` would count it
 *   as a tap on the water: a Miss.
 * - `melody`: when a claimed tile's note starts. `onBeat` is `max(claim, tile.t)`:
 *   a tile claimed early waits for its beat, so the tune stays in time, and a late
 *   one sounds at once. `atTap` would play every note at the claim, as in Rhythm.
 */
export interface TilesRules {
  laterTile: 'notYet' | 'emptyTap';
  melody: 'onBeat' | 'atTap';
}

export const TILES_RULES: Readonly<TilesRules> = { laterTile: 'notYet', melody: 'onBeat' };

/**
 * Where a tile is lost until the stage says (`setExitAlong`), in scroll windows past
 * the hit line: about the handheld layout's.
 */
export const DEFAULT_EXIT_ALONG = 0.13;

/**
 * Real ms a cleared tile pops for on the stage (its flash), and so how long a press
 * on it is still a harmless second press (a double-tap, a bouncing finger). After
 * that the tile is gone, and a press where it was is a tap on the water.
 */
export const POP_MS = 180;

/** Chart ms at which a tile at `t` appears at the top of the lane. */
export function appearTime(t: number, scrollDurationMs: number, tempo: number): number {
  return t - scrollDurationMs * tempo;
}

/**
 * Chart ms at which a tile at `t` has crossed the exit line, `exitAlong` scroll
 * windows past the hit line. A function of the scroll duration in force, so a
 * speed that changes during a song only has to change what it is given.
 */
export function exitTime(
  t: number,
  exitAlong: number,
  scrollDurationMs: number,
  tempo: number,
): number {
  return t + exitAlong * scrollDurationMs * tempo;
}

export interface TilesSimulationOptions extends SimulationOptions {
  /** Real ms a tile takes from the top of the lane to the hit line. */
  scrollDurationMs: number;
  /** Where a tile is lost, in scroll windows past the hit line (`setExitAlong` changes it). */
  exitAlong: number;
  /** Defaults to `TILES_RULES`. */
  rules?: Partial<TilesRules>;
  /** A press on a tile that is not next yet, ignored under `laterTile: 'notYet'`. */
  onNotYet?: (lane: number, tileIndex: number) => void;
}

export function createTilesSimulation({
  tiles,
  tempo,
  failMode,
  durationMs,
  scrollDurationMs,
  exitAlong: initialExitAlong,
  rules,
  onJudgment,
  onNotYet,
}: TilesSimulationOptions): Simulation {
  const { laterTile, melody } = { ...TILES_RULES, ...rules };
  const count = tiles.length;
  const heads = new Uint8Array(count);
  const tails = new Uint8Array(count);
  const holdEndMs = new Float64Array(count).fill(Number.NaN);
  const noteStartMs = new Float64Array(count).fill(Number.NaN);
  /** When a tile cleared and began to pop: a tap at its claim, a long tile when full. */
  const clearedMs = new Float64Array(count).fill(Number.NaN);
  const score = createScore();
  let exitAlong = initialExitAlong;

  const laneTiles: number[][] = Array.from({ length: LANES }, () => []);
  let unresolved = 0;
  tiles.forEach((tile, index) => {
    laneTiles[tile.lane]?.push(index);
    unresolved += 1;
    if (tile.dur !== undefined) {
      tails[index] = TAIL.pending;
      unresolved += 1;
    }
  });
  /** Per lane: the first unclaimed head (heads in a lane resolve in order). */
  const laneCursor = new Array<number>(LANES).fill(0);
  /** Per lane: no tile before it can be pressed again (its top has left the screen). */
  const laneFloor = new Array<number>(LANES).fill(0);
  // Heads are lost in chart order (exit = t + constant), so one cursor finds the next,
  // and that tile is also the earliest unclaimed one: the next to claim.
  let expiryCursor = 0;
  /** Holds currently `holding`, in no particular order. */
  const active: number[] = [];
  /** Hold index per bound input. */
  const bound = new Map<string, number>();
  /** Inputs that reclaimed a hold during this pause. */
  const reclaimed = new Map<string, number>();

  let status: SimulationStatus = 'running';
  let failure: Failure | undefined;
  let endMs: number | undefined;
  let horizon = -Infinity;

  const event: JudgmentEvent = {
    unit: 'tap',
    judgment: 'miss',
    lane: 0,
    tileIndex: -1,
    songMs: 0,
    combo: 0,
  };

  const tileAt = (index: number): Tile => {
    const tile = tiles[index];
    if (!tile) throw new Error(`no tile ${index}`);
    return tile;
  };

  const exitOf = (t: number) => exitTime(t, exitAlong, scrollDurationMs, tempo);
  /** When a claimed hold clears: full, or its top off the screen, whichever comes first. */
  const holdDoneAt = (hold: number) => {
    const tile = tileAt(hold);
    return Math.min((noteStartMs[hold] ?? tile.t) + (tile.dur ?? 0), exitOf(tileEnd(tile)));
  };

  const judge = (
    unit: JudgmentEvent['unit'],
    judgment: Judgment,
    lane: number,
    tileIndex: number,
    songMs: number,
  ) => {
    scoreUnit(score, judgment);
    if (unit !== 'empty') unresolved -= 1;
    event.unit = unit;
    event.judgment = judgment;
    event.lane = lane;
    event.tileIndex = tileIndex;
    event.songMs = songMs;
    event.combo = score.combo;
    onJudgment?.(event);
  };

  const fail = (reason: Failure, songMs: number) => {
    if (failMode !== 'classic' || status !== 'running') return;
    status = 'failed';
    failure = reason;
    endMs = songMs;
  };

  const unbind = (hold: number) => {
    const at = active.indexOf(hold);
    if (at >= 0) active.splice(at, 1);
    for (const [input, index] of bound) if (index === hold) bound.delete(input);
  };

  const finishTail = (hold: number, judgment: Judgment, songMs: number) => {
    const tile = tileAt(hold);
    unbind(hold);
    tails[hold] = judgment === 'miss' ? TAIL.missed : TAIL.clear;
    holdEndMs[hold] = songMs;
    if (judgment !== 'miss') clearedMs[hold] = songMs;
    judge('tail', judgment, tile.lane, hold, songMs);
    if (judgment === 'miss') fail({ kind: 'missedTile', lane: tile.lane, tileIndex: hold }, songMs);
  };

  const expireHead = (index: number) => {
    const tile = tileAt(index);
    const lost = exitOf(tile.t);
    heads[index] = HEAD.missed;
    const isHold = tile.dur !== undefined;
    judge(isHold ? 'head' : 'tap', 'miss', tile.lane, index, lost);
    if (isHold && failMode === 'relaxed') {
      // The whole long tile is missed: it can never be claimed.
      tails[index] = TAIL.missed;
      judge('tail', 'miss', tile.lane, index, lost);
    }
    fail({ kind: 'missedTile', lane: tile.lane, tileIndex: index }, lost);
  };

  const nextPendingHead = () => {
    while (expiryCursor < count && heads[expiryCursor] !== HEAD.pending) expiryCursor += 1;
    return expiryCursor < count ? expiryCursor : -1;
  };

  /** Whether `index` is next: an unclaimed tile with no earlier one waiting. */
  const isNext = (index: number) => {
    const next = nextPendingHead();
    return heads[index] === HEAD.pending && next >= 0 && tileAt(next).t === tileAt(index).t;
  };

  /**
   * Finalizes, in time order, heads lost before `limit` (a head can still be claimed
   * at its exit time) and hold completions at or before `limit`. Returns whether the
   * run is still going.
   */
  const finalize = (limit: number): boolean => {
    while (status === 'running') {
      const head = nextPendingHead();
      const lost = head < 0 ? Infinity : exitOf(tileAt(head).t);
      let hold = -1;
      let done = Infinity;
      for (const index of active) {
        const at = holdDoneAt(index);
        if (at < done) {
          done = at;
          hold = index;
        }
      }
      const expires = lost < limit;
      const completes = hold >= 0 && done <= limit;
      if (!expires && !completes) break;
      // A loss at its exit time comes "just after" it; a completion at its time.
      if (completes && (!expires || done <= lost)) finishTail(hold, 'clear', done);
      else expireHead(head);
    }
    return status === 'running';
  };

  const checkComplete = () => {
    if (status === 'running' && unresolved === 0 && horizon >= durationMs) {
      status = 'complete';
      endMs = Math.max(durationMs, horizon);
    }
  };

  /**
   * Whether a tile no longer waiting is still on the stage to be pressed: one lost
   * (drawn red) or a long tile being held, or a cleared one while it pops.
   */
  const stillThere = (index: number, songMs: number) => {
    const cleared = clearedMs[index] ?? Number.NaN;
    return Number.isNaN(cleared) || songMs - cleared < POP_MS * tempo;
  };

  /** The tile a pointer press lands on: the next one if it can, else any other still there. */
  const tileUnder = (lane: number, { ms, reachMs }: TileAim, songMs: number) => {
    const indices = laneTiles[lane] ?? [];
    let floor = laneFloor[lane] ?? 0;
    // A tile whose top has left the screen stays gone: start the search after it.
    while (floor < indices.length && exitOf(tileEnd(tileAt(indices[floor] ?? 0))) < songMs) {
      floor += 1;
    }
    laneFloor[lane] = floor;
    let pending = -1;
    let other = -1;
    for (let k = floor; k < indices.length; k += 1) {
      const index = indices[k] ?? 0;
      const tile = tileAt(index);
      if (tile.t - reachMs > ms) break;
      if (tileEnd(tile) + reachMs < ms) continue;
      if (isNext(index)) return index;
      if (heads[index] === HEAD.pending) {
        if (pending < 0) pending = index;
      } else if (other < 0 && stillThere(index, songMs)) {
        other = index;
      }
    }
    return pending >= 0 ? pending : other;
  };

  /** A key's tile: the next unclaimed one in its lane, once it has appeared. */
  const nextInLane = (lane: number, songMs: number) => {
    const indices = laneTiles[lane] ?? [];
    let cursor = laneCursor[lane] ?? 0;
    while (cursor < indices.length && heads[indices[cursor] ?? 0] !== HEAD.pending) cursor += 1;
    laneCursor[lane] = cursor;
    const index = indices[cursor];
    if (index === undefined) return -1;
    return appearTime(tileAt(index).t, scrollDurationMs, tempo) <= songMs ? index : -1;
  };

  const claim = (input: string, index: number, songMs: number) => {
    const tile = tileAt(index);
    heads[index] = HEAD.clear;
    noteStartMs[index] = melody === 'onBeat' ? Math.max(songMs, tile.t) : songMs;
    if (tile.dur === undefined) {
      clearedMs[index] = songMs;
      judge('tap', 'clear', tile.lane, index, songMs);
      return;
    }
    judge('head', 'clear', tile.lane, index, songMs);
    tails[index] = TAIL.holding;
    active.push(index);
    bound.set(input, index);
  };

  const emptyTap = (lane: number, songMs: number) => {
    // Before t = 0 a stray press is ignored rather than penalized.
    if (songMs < 0) return;
    judge('empty', 'miss', lane, -1, songMs);
    fail({ kind: 'emptyTap', lane }, songMs);
  };

  return {
    get status() {
      return status;
    },
    get failure() {
      return failure;
    },
    get endMs() {
      return endMs;
    },
    score,
    get horizon() {
      return horizon;
    },
    heads,
    tails,
    holdEndMs,
    noteStartMs,

    press(input, lane, songMs, aim) {
      if (status !== 'running' || !finalize(songMs)) return;
      const index = aim ? tileUnder(lane, aim, songMs) : nextInLane(lane, songMs);
      if (index < 0) {
        emptyTap(lane, songMs);
      } else if (isNext(index)) {
        claim(input, index, songMs);
      } else if (heads[index] !== HEAD.pending) {
        // A tile already claimed (still popping, or a long tile filling) or already
        // lost, still on the stage: pressing it again is harmless.
      } else if (laterTile === 'notYet') {
        onNotYet?.(lane, index);
      } else {
        emptyTap(lane, songMs);
      }
    },

    release(input, songMs) {
      if (status !== 'running' || !finalize(songMs)) return;
      const hold = bound.get(input);
      // Still bound, so not yet full: `finalize` clears it at its time.
      if (hold !== undefined) finishTail(hold, 'miss', songMs);
    },

    advance(songMs) {
      if (status !== 'running' || songMs <= horizon) return;
      horizon = songMs;
      finalize(songMs);
      checkComplete();
    },

    pause() {
      for (const hold of active) tails[hold] = TAIL.suspended;
      active.length = 0;
      bound.clear();
      reclaimed.clear();
    },

    reclaim(input, lane) {
      if (status !== 'running' || bound.has(input)) return false;
      const hold = laneTiles[lane]?.find((index) => tails[index] === TAIL.suspended);
      if (hold === undefined) return false;
      tails[hold] = TAIL.holding;
      active.push(hold);
      bound.set(input, hold);
      reclaimed.set(input, hold);
      return true;
    },

    unclaim(input) {
      const hold = reclaimed.get(input);
      if (hold === undefined) return;
      reclaimed.delete(input);
      unbind(hold);
      tails[hold] = TAIL.suspended;
    },

    suspendedLanes() {
      return lanesWhere(TAIL.suspended);
    },

    reclaimedLanes() {
      return [...reclaimed.values()].map((hold) => tileAt(hold).lane).sort();
    },

    resume(songMs) {
      reclaimed.clear();
      // In chart order; a Classic run ends at the first Miss.
      for (let index = 0; index < count && status === 'running'; index += 1) {
        if (tails[index] === TAIL.suspended) finishTail(index, 'miss', songMs);
      }
    },

    setExitAlong(along) {
      exitAlong = along;
    },
  };

  function lanesWhere(state: number): number[] {
    const lanes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if (tails[index] === state) lanes.push(tileAt(index).lane);
    }
    return lanes.sort();
  }
}
