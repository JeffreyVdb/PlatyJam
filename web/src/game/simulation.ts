import { LANES, type Tile, tileEnd } from '../chart/schema';
import type { TileSizing } from '../scene/lane-layout';
import { MAX_EVENT_LAG_MS } from './input';
import { headDeadline, judgeHead, tailReleaseIsSuccessful } from './judgment';
import { createScore, type Score, scoreUnit } from './scoring';
import type { Failure, FailMode, Judgment, JudgmentEvent } from './session-contract';

/**
 * The gameplay rules as a pure, event-ordered state machine: tile selection,
 * judgment, miss expiry, holds, scoring, fail modes and completion. No clocks, DOM
 * or audio: callers feed it timestamped inputs (chart ms) and "time has reached T"
 * steps, and it reports every judged unit through `onJudgment`.
 *
 * Determinism: outcomes depend only on the inputs' timestamps, never on how often
 * `advance` runs. Each input first finalizes every expiry and hold completion whose
 * time lies strictly before it (in time order), then is judged. `advance(T)` only
 * finalizes what lies before T; the caller keeps T behind any input that may still
 * arrive (see `finalizationHorizon`).
 */

/** Head state per tile. `clear` is Tiles' (`tiles-simulation.ts`), the others Rhythm's. */
export const HEAD = { pending: 0, perfect: 1, good: 2, missed: 3, clear: 4 } as const;
/** Tail state per tile (holds only; taps stay `none`). */
export const TAIL = {
  none: 0,
  pending: 1,
  /** Bound to an input; the hold is filling. */
  holding: 2,
  /** Paused while holding: progress kept, waiting to be reclaimed. */
  suspended: 3,
  perfect: 4,
  missed: 5,
  /** Tiles: the hold filled up. */
  clear: 6,
} as const;

/**
 * Tiles: where a pointer press landed along its lane, as the chart ms a tile drawn
 * there has, and how far either side of a tile (chart ms) a press still counts.
 */
export interface TileAim {
  ms: number;
  reachMs: number;
}

export type SimulationStatus = 'running' | 'failed' | 'complete';

/**
 * How long, in real ms, the simulation waits beyond "now" before it finalizes a
 * Miss or a hold completion, so an input still in flight (dispatched after the
 * frame that would otherwise finalize it) is judged first. It equals the oldest
 * event timestamp the input layer accepts: any input it judges by its own
 * timestamp arrives before that timestamp is finalized, at every frame rate.
 */
export const FINALIZE_GRACE_MS = MAX_EVENT_LAG_MS;

/**
 * The time up to which a frame may finalize: the song time at which an input
 * happening now would count, less the grace. Rhythm's inputs count at
 * `timeline.judgeSongTime(performance.now())`, so calibrated input latency is
 * included; Tiles' at `timeline.shownSongTime(performance.now())`, the board as shown.
 */
export function finalizationHorizon(inputNowSongMs: number, tempo: number): number {
  return inputNowSongMs - FINALIZE_GRACE_MS * tempo;
}

export interface SimulationOptions {
  /** One difficulty's tiles, sorted by (t, lane) as the chart guarantees. */
  tiles: readonly Tile[];
  tempo: number;
  failMode: FailMode;
  /** `chart.durationMs`: the run completes once time passes it and every unit resolved. */
  durationMs: number;
  /** Called for every judged unit. The event object is reused: copy what you keep. */
  onJudgment?: (event: Readonly<JudgmentEvent>) => void;
}

export interface Simulation {
  readonly status: SimulationStatus;
  /** Set once `status` is `failed`. */
  readonly failure: Failure | undefined;
  /** Song ms at which the run failed or completed. */
  readonly endMs: number | undefined;
  readonly score: Readonly<Score>;
  /** The latest time finalized. */
  readonly horizon: number;
  /** Per tile: a `HEAD` value. */
  readonly heads: Readonly<Uint8Array>;
  /** Per tile: a `TAIL` value. */
  readonly tails: Readonly<Uint8Array>;
  /** Per hold: song ms at which holding stopped (release or completion); NaN before. */
  readonly holdEndMs: Readonly<Float64Array>;
  /**
   * Per tile: song ms at which its note starts once its head was hit or claimed (Rhythm:
   * the hit; Tiles: see `TILES_RULES.melody`); NaN before.
   */
  readonly noteStartMs: Readonly<Float64Array>;

  /**
   * A lane was pressed at chart ms `songMs`. `input` names the finger or key. `aim` is
   * where a pointer landed along the lane; Tiles uses it, Rhythm judges lanes only.
   */
  press(input: string, lane: number, songMs: number, aim?: TileAim): void;
  /** That input was released. */
  release(input: string, songMs: number): void;
  /** Time reached `songMs`: finalize expiries and completions before it. */
  advance(songMs: number): void;

  /**
   * Play paused: suspend held tiles (progress kept) and forget every input. Call
   * `advance` up to the pause first, so holds already past their tail complete.
   */
  pause(): void;
  /** During the countdown: binds `input` to the suspended hold in `lane`, if any. */
  reclaim(input: string, lane: number): boolean;
  /** During the countdown: `input` let go again, so its hold waits once more. */
  unclaim(input: string): void;
  /** Lanes with a suspended hold that nobody has reclaimed. */
  suspendedLanes(): number[];
  /** Lanes with a hold reclaimed during this countdown. */
  reclaimedLanes(): number[];
  /** Play continues at `songMs`: holds not reclaimed become tail Misses. */
  resume(songMs: number): void;
  /**
   * Tiles: where the stage loses a tile, past the line in scroll windows (the bottom
   * edge of the screen, so it changes with the screen's shape). Rhythm has no exit
   * line and ignores it.
   */
  setExitAlong(along: number): void;
  /** Tiles: how tall tiles are drawn (`tileSizing`). Rhythm ignores it. */
  setTileSizing(sizing: Readonly<TileSizing>): void;
}

export function createSimulation({
  tiles,
  tempo,
  failMode,
  durationMs,
  onJudgment,
}: SimulationOptions): Simulation {
  const count = tiles.length;
  const heads = new Uint8Array(count);
  const tails = new Uint8Array(count);
  const holdEndMs = new Float64Array(count).fill(Number.NaN);
  const noteStartMs = new Float64Array(count).fill(Number.NaN);
  const score = createScore();

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
  const laneCursor = new Array<number>(LANES).fill(0);
  // Heads expire in chart order (deadline = t + constant), so one cursor finds the next.
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
    tails[hold] = judgment === 'miss' ? TAIL.missed : TAIL.perfect;
    holdEndMs[hold] = Math.min(songMs, tileEnd(tile));
    judge('tail', judgment, tile.lane, hold, songMs);
    if (judgment === 'miss') fail({ kind: 'missedTile', lane: tile.lane, tileIndex: hold }, songMs);
  };

  const expireHead = (index: number) => {
    const tile = tileAt(index);
    const deadline = headDeadline(tile.t, tempo);
    heads[index] = HEAD.missed;
    const isHold = tile.dur !== undefined;
    judge(isHold ? 'head' : 'tap', 'miss', tile.lane, index, deadline);
    if (isHold && failMode === 'relaxed') {
      // The whole hold is missed: it can never be grabbed.
      tails[index] = TAIL.missed;
      judge('tail', 'miss', tile.lane, index, deadline);
    }
    fail({ kind: 'missedTile', lane: tile.lane, tileIndex: index }, deadline);
  };

  const nextPendingHead = () => {
    while (expiryCursor < count && heads[expiryCursor] !== HEAD.pending) expiryCursor += 1;
    return expiryCursor < count ? expiryCursor : -1;
  };

  /**
   * Finalizes, in time order, head expiries with deadline < `limit` (a head is
   * still hittable at its deadline) and hold completions at or before `limit`.
   * Returns whether the run is still going.
   */
  const finalize = (limit: number): boolean => {
    while (status === 'running') {
      const head = nextPendingHead();
      const deadline = head < 0 ? Infinity : headDeadline(tileAt(head).t, tempo);
      let hold = -1;
      let end = Infinity;
      for (const index of active) {
        const e = tileEnd(tileAt(index));
        if (e < end) {
          end = e;
          hold = index;
        }
      }
      const expires = deadline < limit;
      const completes = hold >= 0 && end <= limit;
      if (!expires && !completes) break;
      // An expiry at its deadline comes "just after" it; a completion at its end.
      if (completes && (!expires || end <= deadline)) finishTail(hold, 'perfect', end);
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

    press(input, lane, songMs) {
      if (status !== 'running' || !finalize(songMs)) return;
      const lanes = laneTiles[lane];
      if (!lanes) return;
      let cursor = laneCursor[lane] ?? 0;
      while (cursor < lanes.length && heads[lanes[cursor] ?? 0] !== HEAD.pending) cursor += 1;
      laneCursor[lane] = cursor;
      const index = lanes[cursor];
      const tile = index === undefined ? undefined : tiles[index];
      const judgment = tile ? judgeHead(tile.t, songMs, tempo) : undefined;

      if (index === undefined || !tile || !judgment) {
        // Before t = 0 a stray press is ignored rather than penalized.
        if (songMs < 0) return;
        judge('empty', 'miss', lane, -1, songMs);
        fail({ kind: 'emptyTap', lane }, songMs);
        return;
      }

      heads[index] = judgment === 'perfect' ? HEAD.perfect : HEAD.good;
      noteStartMs[index] = songMs;
      if (tile.dur === undefined) {
        judge('tap', judgment, lane, index, songMs);
        return;
      }
      judge('head', judgment, lane, index, songMs);
      tails[index] = TAIL.holding;
      active.push(index);
      bound.set(input, index);
    },

    release(input, songMs) {
      if (status !== 'running' || !finalize(songMs)) return;
      const hold = bound.get(input);
      if (hold === undefined) return;
      const end = tileEnd(tileAt(hold));
      finishTail(hold, tailReleaseIsSuccessful(end, songMs, tempo) ? 'perfect' : 'miss', songMs);
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

    setExitAlong() {
      // Rhythm loses a tile at the end of its window, wherever the stage draws it.
    },

    setTileSizing() {
      // Rhythm draws every tile alike.
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
