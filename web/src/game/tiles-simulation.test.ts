import { describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import type { TileSizing } from '../scene/lane-layout';
import { MAX_EVENT_LAG_MS } from './input';
import { accuracyOf, earnsPerfectBadge } from './scoring';
import type { FailMode, JudgmentEvent } from './session-contract';
import { finalizationHorizon, HEAD, type Simulation, TAIL, type TileAim } from './simulation';
import {
  appearTime,
  createTilesSimulation,
  exitTime,
  TILES_RULES,
  type TilesRules,
} from './tiles-simulation';

const tap = (t: number, lane: number): Tile => ({ t, lane, pitches: [60], vel: 90 });
const hold = (t: number, lane: number, dur: number): Tile => ({
  t,
  lane,
  dur,
  pitches: [64],
  vel: 90,
});

// A tile shows 1000 chart ms ahead of the line (at 1×) and is lost 200 ms past it.
const SCROLL_MS = 1000;
const EXIT_ALONG = 0.2;
/**
 * Tiles as thin as their notes (a tap a line, a long tile its length), so these rules
 * read in chart time alone; how tall the stage draws them is tested with `sizing`.
 */
const THIN: TileSizing = { base: 0, floor: 0, seam: 0 };
/** A pointer press aimed at chart ms `ms`, counting 40 ms either side of a tile. */
const at = (ms: number): TileAim => ({ ms, reachMs: 40 });

interface Options {
  tempo?: number;
  failMode?: FailMode;
  durationMs?: number;
  rules?: Partial<TilesRules>;
  sizing?: TileSizing;
}

function setup(
  tiles: Tile[],
  { tempo = 1, failMode = 'classic', durationMs, rules, sizing = THIN }: Options = {},
) {
  const log: JudgmentEvent[] = [];
  const notYet: string[] = [];
  const sim = createTilesSimulation({
    tiles,
    tempo,
    failMode,
    durationMs: durationMs ?? Math.max(0, ...tiles.map((t) => t.t + (t.dur ?? 0))),
    scrollDurationMs: SCROLL_MS,
    exitAlong: EXIT_ALONG,
    sizing,
    rules,
    onJudgment: (event) => log.push({ ...event }),
    onNotYet: (lane, tileIndex) => notYet.push(`${lane}#${tileIndex}`),
  });
  /** `unit:judgment@lane#tile`, compact enough to compare whole runs. */
  const summary = () => log.map((e) => `${e.unit}:${e.judgment}@${e.lane}#${e.tileIndex}`);
  return { sim, log, notYet, summary };
}

const status = (sim: Simulation) => sim.status;

describe('tiles simulation', () => {
  it('pins the open rules: later tiles are "not yet", and notes keep the beat', () => {
    expect(TILES_RULES).toEqual({ laterTile: 'notYet', melody: 'onBeat' });
  });

  describe('when a tile can be claimed', () => {
    it('places appearance and exit on the scroll window, scaled by the tempo', () => {
      expect(appearTime(5000, 1000, 1)).toBe(4000);
      expect(appearTime(5000, 1000, 1.5)).toBe(3500);
      expect(exitTime(5000, 0.2, 1000, 1)).toBe(5200);
      expect(exitTime(5000, 0.2, 1000, 1.5)).toBe(5300);
      expect(exitTime(5000, 0.2, 2000, 1)).toBe(5400);
    });

    it('clears a tile tapped anywhere on it, at any time while it is on screen', () => {
      for (const pressAt of [100, 600, 1000, 1150, 1200]) {
        const { sim, summary } = setup([tap(1000, 2)]);
        // Wherever the finger lands on it: its head, or just beside it.
        sim.press('p', 2, pressAt, at(1000 + 30));
        expect(summary()).toEqual(['tap:clear@2#0']);
        expect(sim.heads[0]).toBe(HEAD.clear);
      }
    });

    it('scores every cleared unit 100 × the combo multiplier, with no timing grades', () => {
      const tiles = Array.from({ length: 12 }, (_, i) => tap(1000 + i * 100, i % 4));
      const { sim } = setup(tiles);
      tiles.forEach((tile, i) => {
        sim.press(`p${i}`, tile.lane, 500 + i * 100, at(tile.t));
      });
      // Ten at 1×, then two at 2×.
      expect(sim.score.score).toBe(10 * 100 + 2 * 200);
      expect(sim.score).toMatchObject({ clear: 12, perfect: 0, good: 0, miss: 0, combo: 12 });
      expect(accuracyOf(sim.score)).toBe(100);
    });

    it('takes taps only in order: a later tile is "not yet", with no penalty', () => {
      const { sim, summary, notYet } = setup([tap(1000, 0), tap(1300, 3)]);
      sim.press('a', 3, 900, at(1300));
      expect(summary()).toEqual([]);
      expect(notYet).toEqual(['3#1']);
      expect(sim.heads[1]).toBe(HEAD.pending);
      expect(sim.status).toBe('running');
      sim.press('b', 0, 950, at(1000));
      sim.press('c', 3, 960, at(1300));
      expect(summary()).toEqual(['tap:clear@0#0', 'tap:clear@3#1']);
    });

    it('can count a later tile as an empty tap instead (laterTile: emptyTap)', () => {
      const { sim, summary, notYet } = setup([tap(1000, 0), tap(1300, 3)], {
        rules: { laterTile: 'emptyTap' },
      });
      sim.press('a', 3, 900, at(1300));
      expect(notYet).toEqual([]);
      expect(summary()).toEqual(['empty:miss@3#-1']);
      expect(sim.failure).toEqual({ kind: 'emptyTap', lane: 3, at: 1300 });
    });

    it('takes both tiles of a double, in either order', () => {
      for (const [first, second] of [
        [0, 2],
        [2, 0],
      ] as const) {
        const { sim, summary, notYet } = setup([tap(1000, 0), tap(1000, 2), tap(1400, 1)]);
        sim.press('a', 1, 700, at(1400));
        sim.press('b', first, 700, at(1000));
        sim.press('c', 1, 710, at(1400));
        sim.press('d', second, 720, at(1000));
        sim.press('e', 1, 730, at(1400));
        expect(notYet).toEqual(['1#2', '1#2']);
        expect(summary().map((s) => s.split('@')[0])).toEqual([
          'tap:clear',
          'tap:clear',
          'tap:clear',
        ]);
      }
    });

    it('counts a tap on empty space as an empty tap: a Miss that ends Classic', () => {
      const { sim, summary } = setup([tap(1000, 0), tap(1500, 0)]);
      // Between the two tiles, beyond the slack of either.
      sim.press('a', 0, 900, at(1250));
      expect(summary()).toEqual(['empty:miss@0#-1']);
      expect(status(sim)).toBe('failed');
      // Where along the lane it was, for the stage to mark.
      expect(sim.failure).toEqual({ kind: 'emptyTap', lane: 0, at: 1250 });
      expect(sim.endMs).toBe(900);
    });

    it('counts a press within the slack around a tile as on it, and just beyond as empty space', () => {
      const hits = setup([tap(1000, 1)]);
      hits.sim.press('a', 1, 900, at(1000 - 40));
      expect(hits.summary()).toEqual(['tap:clear@1#0']);
      const misses = setup([tap(1000, 1)]);
      misses.sim.press('a', 1, 900, at(1000 - 41));
      expect(misses.summary()).toEqual(['empty:miss@1#-1']);
    });

    it('ignores an empty tap during the lead-in, but takes tiles already on screen', () => {
      const { sim, summary } = setup([tap(300, 0)]);
      sim.press('a', 3, -500, at(-200));
      expect(summary()).toEqual([]);
      sim.press('b', 0, -500, at(300));
      expect(summary()).toEqual(['tap:clear@0#0']);
    });

    it('lets a cleared tile be pressed again harmlessly while it rides off the screen', () => {
      const { sim, summary } = setup([tap(1000, 0), tap(1600, 0)]);
      sim.press('a', 0, 800, at(1000));
      sim.press('b', 0, 820, at(1000));
      // Long after its pop: it is still drawn, translucent, until it leaves at 1200.
      sim.press('c', 0, 1190, at(1000));
      expect(summary()).toEqual(['tap:clear@0#0']);
      expect(sim.status).toBe('running');
    });

    it('counts a press where a cleared tile was, once it has left the screen, as an empty tap', () => {
      const classic = setup([tap(1000, 0), tap(1600, 1)]);
      classic.sim.press('a', 0, 100, at(1000));
      classic.sim.release('a', 120);
      classic.sim.press('b', 0, 1210, at(1000));
      expect(classic.summary()).toEqual(['tap:clear@0#0', 'empty:miss@0#-1']);
      expect(classic.sim.failure).toEqual({ kind: 'emptyTap', lane: 0, at: 1000 });

      const relaxed = setup([tap(1000, 0), tap(1600, 1)], { failMode: 'relaxed' });
      relaxed.sim.press('a', 0, 100, at(1000));
      relaxed.sim.press('b', 0, 800, at(900));
      expect(relaxed.summary()).toEqual(['tap:clear@0#0', 'empty:miss@0#-1']);
      expect(relaxed.sim.status).toBe('running');
      expect(relaxed.sim.score.combo).toBe(0);
      relaxed.sim.press('c', 1, 900, at(1600));
      expect(relaxed.summary().at(-1)).toBe('tap:clear@1#1');
    });

    it('claims the next tile in a key’s lane, once it has appeared', () => {
      const { sim, summary, notYet } = setup([tap(1000, 0), tap(1200, 1), tap(2500, 1)]);
      // Lane 1's tile is up, but lane 0's comes first.
      sim.press('kF', 1, 300);
      expect(notYet).toEqual(['1#1']);
      sim.press('kD', 0, 300);
      sim.press('kF', 1, 310);
      expect(summary()).toEqual(['tap:clear@0#0', 'tap:clear@1#1']);
      // 2500 appears at 1500: pressing lane 1 before then is an empty tap.
      sim.press('kF', 1, 1400);
      expect(summary().at(-1)).toBe('empty:miss@1#-1');
    });
  });

  describe('falling off', () => {
    it('misses an unclaimed tile once its head crosses the exit line', () => {
      const { sim, summary } = setup([tap(1000, 2)], { failMode: 'relaxed' });
      sim.advance(1200);
      expect(summary()).toEqual([]);
      // Still claimable at its exit time.
      sim.press('a', 2, 1200, at(1000));
      expect(summary()).toEqual(['tap:clear@2#0']);

      const lost = setup([tap(1000, 2)], { failMode: 'relaxed' });
      lost.sim.advance(1201);
      expect(lost.summary()).toEqual(['tap:miss@2#0']);
      expect(lost.log[0]?.songMs).toBe(1200);
    });

    it('ends a Classic run at the tile that fell, at its exit time', () => {
      const { sim } = setup([tap(1000, 2), tap(1100, 0)]);
      sim.advance(1500);
      expect(sim.status).toBe('failed');
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 2, tileIndex: 0 });
      expect(sim.endMs).toBe(1200);
    });

    it('breaks the combo in Relaxed and plays on', () => {
      const { sim, summary } = setup([tap(1000, 0), tap(1100, 1), tap(1500, 2)], {
        failMode: 'relaxed',
      });
      sim.press('a', 0, 900, at(1000));
      sim.advance(1400);
      expect(sim.score.combo).toBe(0);
      sim.press('b', 2, 1400, at(1500));
      sim.advance(2000);
      expect(summary()).toEqual(['tap:clear@0#0', 'tap:miss@1#1', 'tap:clear@2#2']);
      expect(sim.status).toBe('complete');
      expect(accuracyOf(sim.score)).toBeCloseTo((100 * 2) / 3);
      expect(earnsPerfectBadge('cleared', sim.score)).toBe(false);
    });

    it('finalizes a tile lost before a press, then judges the press on what is left', () => {
      const { sim, summary } = setup([tap(1000, 0), tap(1300, 1)], { failMode: 'relaxed' });
      // Tile 0 is lost at 1200, so at 1250 tile 1 is next.
      sim.press('a', 1, 1250, at(1300));
      expect(summary()).toEqual(['tap:miss@0#0', 'tap:clear@1#1']);
    });

    it('moves the exit line with the stage layout', () => {
      const { sim, summary } = setup([tap(1000, 0)], { failMode: 'relaxed' });
      sim.setExitAlong(0.5);
      sim.advance(1400);
      expect(summary()).toEqual([]);
      sim.advance(1501);
      expect(summary()).toEqual(['tap:miss@0#0']);
    });

    it('earns the Perfect badge with no Miss', () => {
      const { sim } = setup([tap(1000, 0), hold(1500, 1, 300)]);
      sim.press('a', 0, 800, at(1000));
      sim.press('b', 1, 900, at(1700));
      sim.advance(2000);
      expect(sim.status).toBe('complete');
      expect(sim.score).toMatchObject({ clear: 3, miss: 0 });
      expect(earnsPerfectBadge('cleared', sim.score)).toBe(true);
    });
  });

  describe('when notes start', () => {
    it('starts an early claim’s note on its beat, and a late one at the claim', () => {
      const { sim } = setup([tap(1000, 0), tap(1500, 1)]);
      sim.press('a', 0, 400, at(1000));
      sim.press('b', 1, 1600, at(1500));
      expect([...sim.noteStartMs]).toEqual([1000, 1600]);
    });

    it('can start every note at the claim instead (melody: atTap)', () => {
      const { sim } = setup([tap(1000, 0)], { rules: { melody: 'atTap' } });
      sim.press('a', 0, 400, at(1000));
      expect([...sim.noteStartMs]).toEqual([400]);
    });

    it('never starts the note of a tile that was not claimed', () => {
      const { sim } = setup([tap(1000, 0)], { failMode: 'relaxed' });
      sim.advance(2000);
      expect(sim.noteStartMs[0]).toBeNaN();
    });
  });

  describe('long tiles', () => {
    it('are claimed anywhere along them, fill from the note start and clear when full', () => {
      const { sim, summary } = setup([hold(1000, 1, 500)]);
      // On the body, early.
      sim.press('a', 1, 500, at(1400));
      expect(summary()).toEqual(['head:clear@1#0']);
      expect(sim.tails[0]).toBe(TAIL.holding);
      sim.advance(1499);
      expect(sim.tails[0]).toBe(TAIL.holding);
      sim.advance(1500);
      expect(summary()).toEqual(['head:clear@1#0', 'tail:clear@1#0']);
      expect(sim.tails[0]).toBe(TAIL.clear);
      expect(sim.holdEndMs[0]).toBe(1500);
      // Done: letting go now changes nothing.
      sim.release('a', 1600);
      expect(summary()).toHaveLength(2);
    });

    it('fill for their dur from a late claim', () => {
      const { sim, log } = setup([hold(1000, 1, 100)]);
      sim.press('a', 1, 1100, at(1000));
      sim.advance(1300);
      expect(log.map((e) => [e.unit, e.judgment, e.songMs])).toEqual([
        ['head', 'clear', 1100],
        ['tail', 'clear', 1200],
      ]);
    });

    it('clear when their top leaves the screen before they are full', () => {
      const { sim, log } = setup([hold(1000, 1, 500)]);
      sim.press('a', 1, 1100, at(1000));
      // Full at 1600; the layout changes and its top (1500) now leaves at 1550.
      sim.setExitAlong(0.05);
      sim.advance(2000);
      expect(log.map((e) => [e.unit, e.judgment, e.songMs])).toEqual([
        ['head', 'clear', 1100],
        ['tail', 'clear', 1550],
      ]);
    });

    it('can be pressed again while held, and until they have left once full', () => {
      const { sim, summary } = setup([hold(1000, 0, 300), tap(2000, 1)], {
        failMode: 'relaxed',
      });
      sim.press('a', 0, 900, at(1000));
      sim.press('b', 0, 1100, at(1250));
      sim.release('b', 1110);
      sim.advance(1300);
      expect(summary()).toEqual(['head:clear@0#0', 'tail:clear@0#0']);
      // Its top (1300) leaves the screen at 1500.
      sim.press('c', 0, 1499, at(1100));
      expect(summary()).toHaveLength(2);
      sim.press('d', 0, 1501, at(1100));
      expect(summary().at(-1)).toBe('empty:miss@0#-1');
    });

    it('fail when let go before they are full', () => {
      const { sim, summary } = setup([hold(1000, 1, 500), tap(2000, 0)]);
      sim.press('a', 1, 800, at(1000));
      sim.release('a', 1499);
      expect(summary()).toEqual(['head:clear@1#0', 'tail:miss@1#0']);
      expect(sim.status).toBe('failed');
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 1, tileIndex: 0 });
      expect(sim.holdEndMs[0]).toBe(1499);
    });

    it('fail when let go before even their beat', () => {
      const { sim, summary } = setup([hold(1000, 1, 500)], { failMode: 'relaxed' });
      sim.press('a', 1, 600, at(1000));
      sim.release('a', 700);
      expect(summary()).toEqual(['head:clear@1#0', 'tail:miss@1#0']);
      expect(sim.status).toBe('running');
    });

    it('are lost whole in Relaxed when never claimed, once their top has left', () => {
      const { sim, summary } = setup([hold(1000, 1, 500)], { failMode: 'relaxed' });
      // One block: its top (1500) leaves the screen at 1700, and until then it is there.
      sim.advance(1699);
      expect(summary()).toEqual([]);
      sim.advance(1701);
      expect(summary()).toEqual(['head:miss@1#0', 'tail:miss@1#0']);
    });

    it('leave both fingers free: a long tile held while the next tiles are tapped', () => {
      const { sim, summary } = setup([hold(1000, 0, 800), tap(1200, 2), tap(1400, 3)]);
      sim.press('a', 0, 900, at(1000));
      sim.press('b', 2, 950, at(1200));
      sim.release('b', 960);
      sim.press('c', 3, 1000, at(1400));
      sim.advance(1900);
      expect(summary()).toEqual([
        'head:clear@0#0',
        'tap:clear@2#1',
        'tap:clear@3#2',
        'tail:clear@0#0',
      ]);
    });

    it('are reclaimed after a pause and still fill', () => {
      const { sim, summary } = setup([hold(1000, 1, 500)]);
      sim.press('a', 1, 900, at(1000));
      sim.advance(1200);
      sim.pause();
      expect(sim.suspendedLanes()).toEqual([1]);
      expect(sim.reclaim('b', 1)).toBe(true);
      expect(sim.reclaimedLanes()).toEqual([1]);
      sim.resume(1200);
      sim.advance(1500);
      expect(summary()).toEqual(['head:clear@1#0', 'tail:clear@1#0']);
    });

    it('fail at resume when not reclaimed', () => {
      const { sim, summary } = setup([hold(1000, 1, 500)]);
      sim.press('a', 1, 900, at(1000));
      sim.advance(1200);
      sim.pause();
      sim.resume(1200);
      expect(summary()).toEqual(['head:clear@1#0', 'tail:miss@1#0']);
      expect(sim.status).toBe('failed');
    });
  });

  describe('drawn as tall blocks (sizing)', () => {
    // Tiles reach up to the next start, within 250 to 500 ms; a 10 ms seam in a lane.
    const SIZED: TileSizing = { base: 0.5, floor: 0.25, seam: 0.01 };
    const sized = (tiles: Tile[], options: Options = {}) =>
      setup(tiles, { sizing: SIZED, ...options });

    it('claims a tile pressed anywhere from its bottom edge to its top, slack included', () => {
      // The tile spans 1000 to 1400 (the next start); the slack is 40 ms either side.
      for (const ms of [960, 1000, 1200, 1399, 1400, 1439]) {
        const { sim, summary } = sized([tap(1000, 0), tap(1400, 1)]);
        sim.press('p', 0, 900, at(ms));
        expect(summary(), `pressed at ${ms}`).toEqual(['tap:clear@0#0']);
      }
      for (const ms of [959, 1441]) {
        const { sim, summary } = sized([tap(1000, 0), tap(1400, 1)]);
        sim.press('p', 0, 900, at(ms));
        expect(summary(), `pressed at ${ms}`).toEqual(['empty:miss@0#-1']);
      }
    });

    it('tells staircase neighbours apart by lane', () => {
      const { sim, summary, notYet } = sized([tap(1000, 0), tap(1300, 1), tap(1600, 2)]);
      // Level with the first tile's top, in the next lane: the second tile, not yet.
      sim.press('a', 1, 900, at(1310));
      expect(notYet).toEqual(['1#1']);
      sim.press('b', 0, 900, at(1290));
      sim.press('c', 1, 900, at(1310));
      expect(summary()).toEqual(['tap:clear@0#0', 'tap:clear@1#1']);
    });

    it('loses a tile once its top has left the screen, a short one before a tall one', () => {
      // The first is floored to 250 ms (top 1250); the second is capped by its lane's
      // next tile to 40 ms (top 1140), so it leaves first.
      const { sim, log } = sized([tap(1000, 0), tap(1100, 1), tap(1150, 1)], {
        failMode: 'relaxed',
      });
      sim.advance(1339);
      expect(log).toEqual([]);
      sim.advance(1341);
      expect(log.map((e) => [e.tileIndex, e.judgment, e.songMs])).toEqual([[1, 'miss', 1340]]);
      // The earlier tile is still on screen, and still next.
      sim.press('a', 0, 1400, at(1200));
      expect(log.map((e) => [e.tileIndex, e.judgment])).toContainEqual([0, 'clear']);
      // The last reaches the base, 500 ms: its top leaves at 1850.
      sim.advance(1900);
      expect(log.map((e) => [e.tileIndex, e.judgment])).toEqual([
        [1, 'miss'],
        [0, 'clear'],
        [2, 'miss'],
      ]);
    });

    it('ends Classic at the tile that left first', () => {
      const { sim } = sized([tap(1000, 0), tap(1100, 1), tap(1150, 1)]);
      sim.advance(2000);
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 1, tileIndex: 1 });
      expect(sim.endMs).toBeCloseTo(1340, 9);
    });

    it('takes new heights from the stage, which move where tiles end', () => {
      const { sim, summary } = sized([tap(1000, 0), tap(3000, 1)], { failMode: 'relaxed' });
      sim.setTileSizing({ base: 0.3, floor: 0.25, seam: 0.01 });
      // Its top is now at 1300, lost at 1500.
      sim.advance(1499);
      expect(summary()).toEqual([]);
      sim.advance(1501);
      expect(summary()).toEqual(['tap:miss@0#0']);
    });

    it('fills a long tile drawn taller than its note over the note, and clears when full', () => {
      const { sim, log } = sized([hold(1000, 2, 200), tap(3000, 1)]);
      // Drawn 500 ms tall (the base): pressed near its top, it is still claimed.
      sim.press('a', 2, 900, at(1450));
      sim.advance(1300);
      expect(log.map((e) => [e.unit, e.judgment, e.songMs])).toEqual([
        ['head', 'clear', 900],
        ['tail', 'clear', 1200],
      ]);
    });
  });

  describe('frame-rate independence', () => {
    type Input =
      | { kind: 'press'; input: string; lane: number; at: number; aim?: number }
      | { kind: 'release'; input: string; at: number };

    // A dense passage: a double, early and late claims, a "not yet", keys, long tiles
    // (one let go early), presses on a tile already cleared, during its pop and after
    // it while it rides off, an empty tap and a tile that falls off.
    const tiles = [
      tap(1000, 0),
      tap(1000, 2),
      tap(1150, 0),
      hold(1300, 1, 600),
      tap(1400, 3),
      tap(1700, 3),
      hold(2000, 2, 400),
      tap(2100, 0),
      tap(2250, 0),
      tap(2600, 1),
      tap(2800, 3),
    ];
    const inputs: Input[] = [
      { kind: 'press', input: 'p1', lane: 0, at: 300, aim: 1000 },
      { kind: 'press', input: 'p2', lane: 0, at: 320, aim: 1150 },
      { kind: 'press', input: 'p3', lane: 2, at: 340, aim: 1010 },
      { kind: 'release', input: 'p1', at: 360 },
      { kind: 'release', input: 'p2', at: 370 },
      { kind: 'release', input: 'p3', at: 380 },
      { kind: 'press', input: 'p4', lane: 0, at: 700, aim: 1150 },
      { kind: 'press', input: 'p5', lane: 0, at: 720, aim: 1150 },
      { kind: 'release', input: 'p4', at: 760 },
      { kind: 'release', input: 'p5', at: 780 },
      { kind: 'press', input: 'kJ', lane: 1, at: 1200 },
      { kind: 'press', input: 'p6', lane: 3, at: 1450, aim: 1400 },
      { kind: 'release', input: 'p6', at: 1500 },
      // Tile 1700 in lane 3 is never pressed: it falls off at 1900.
      { kind: 'release', input: 'kJ', at: 1950 },
      { kind: 'press', input: 'p7', lane: 2, at: 1990, aim: 2200 },
      { kind: 'release', input: 'p7', at: 2250 },
      { kind: 'press', input: 'p8', lane: 0, at: 2260, aim: 2100 },
      { kind: 'press', input: 'p9', lane: 0, at: 2280, aim: 2250 },
      { kind: 'press', input: 'p10', lane: 1, at: 2400, aim: 2430 },
      { kind: 'press', input: 'p11', lane: 1, at: 2410, aim: 2600 },
      { kind: 'press', input: 'p13', lane: 1, at: 2500, aim: 2600 },
      { kind: 'press', input: 'p14', lane: 1, at: 2620, aim: 2600 },
      { kind: 'press', input: 'p12', lane: 3, at: 2900, aim: 2800 },
    ];

    /**
     * Frames tick at `fps`; `now` is the song time an input made now would get. Each
     * input is dispatched `lagMs` real ms after it happened (in timestamp order), and
     * each frame finalizes up to the horizon. Returns the log.
     */
    const simulate = (fps: number, failMode: FailMode, tempo = 1, lagMs = 20) => {
      const run = setup(tiles, { failMode, tempo, durationMs: 3000 });
      const frame = 1000 / fps;
      const queue = [...inputs].sort((a, b) => a.at - b.at);
      for (let now = 0; now < 4000; now += frame) {
        while (queue[0] && queue[0].at + lagMs * tempo <= now) {
          const next = queue.shift();
          if (next?.kind === 'press') {
            run.sim.press(
              next.input,
              next.lane,
              next.at,
              next.aim === undefined ? undefined : at(next.aim),
            );
          } else if (next) {
            run.sim.release(next.input, next.at);
          }
        }
        run.sim.advance(finalizationHorizon(now, tempo));
      }
      return {
        log: run.summary(),
        notYet: run.notYet,
        score: { ...run.sim.score },
        status: run.sim.status,
        notes: [...run.sim.noteStartMs],
      };
    };

    it.each(['classic', 'relaxed'] as const)(
      'gives identical %s outcomes at 30, 60 and 120 fps',
      (mode) => {
        const at60 = simulate(60, mode);
        expect(simulate(30, mode)).toEqual(at60);
        expect(simulate(120, mode)).toEqual(at60);
        expect(simulate(60, mode, 1, 0)).toEqual(at60);
      },
    );

    // Every lag the input layer accepts, at every tempo.
    it.each(
      (['classic', 'relaxed'] as const).flatMap((mode) =>
        [0.75, 1, 1.5].flatMap((tempo) =>
          [0, 120, MAX_EVENT_LAG_MS].map((lagMs) => [mode, tempo, lagMs] as const),
        ),
      ),
    )('gives identical %s outcomes at %sx with %s ms of dispatch lag', (mode, tempo, lagMs) => {
      const reference = simulate(60, mode, tempo, 0);
      for (const fps of [30, 60, 120]) expect(simulate(fps, mode, tempo, lagMs)).toEqual(reference);
    });

    it('plays the passage as expected in Relaxed', () => {
      const { log, notYet, status, notes } = simulate(60, 'relaxed');
      expect(log).toEqual([
        'tap:clear@0#0',
        // 1150 is not next while the double's other tile waits.
        'tap:clear@2#1',
        'tap:clear@0#2',
        'head:clear@1#3',
        'tap:clear@3#4',
        // Full at 1900, the moment tile 5 falls off: the completion comes first.
        'tail:clear@1#3',
        'tap:miss@3#5',
        'head:clear@2#6',
        'tail:miss@2#6',
        'tap:clear@0#7',
        'tap:clear@0#8',
        // 2430 in lane 1 is empty space; then tile 9 is claimed early, pressed again
        // while it pops, and once more as it rides off: harmless.
        'empty:miss@1#-1',
        'tap:clear@1#9',
        'tap:clear@3#10',
      ]);
      expect(notYet).toEqual(['0#2']);
      expect(status).toBe('complete');
      // Early claims start on the beat, late ones at the claim; the lost tile never.
      expect(notes.slice(0, 5)).toEqual([1000, 1000, 1150, 1300, 1450]);
      expect(notes[5]).toBeNaN();
    });

    it('stops at the first tile that falls off in Classic', () => {
      const { log, status } = simulate(60, 'classic');
      expect(log.at(-1)).toBe('tap:miss@3#5');
      expect(status).toBe('failed');
    });
  });
});
