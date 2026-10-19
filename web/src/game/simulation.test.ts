import { describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import type { FailMode, JudgmentEvent } from './session-contract';
import { MAX_EVENT_LAG_MS } from './input';
import {
  createSimulation,
  FINALIZE_GRACE_MS,
  finalizationHorizon,
  type Simulation,
  TAIL,
} from './simulation';

const tap = (t: number, lane: number): Tile => ({ t, lane, pitches: [60], vel: 90 });
const hold = (t: number, lane: number, dur: number): Tile => ({
  t,
  lane,
  dur,
  pitches: [64],
  vel: 90,
});

interface Options {
  tempo?: number;
  failMode?: FailMode;
  durationMs?: number;
}

function setup(tiles: Tile[], { tempo = 1, failMode = 'classic', durationMs }: Options = {}) {
  const log: JudgmentEvent[] = [];
  const sim = createSimulation({
    tiles,
    tempo,
    failMode,
    durationMs: durationMs ?? Math.max(0, ...tiles.map((t) => t.t + (t.dur ?? 0))),
    onJudgment: (event) => log.push({ ...event }),
  });
  /** `unit:judgment@lane`, compact enough to compare whole runs. */
  const summary = () => log.map((e) => `${e.unit}:${e.judgment}@${e.lane}#${e.tileIndex}`);
  return { sim, log, summary };
}

const status = (sim: Simulation) => sim.status;

describe('simulation', () => {
  describe('taps', () => {
    it('judges a press by its own timestamp and scores it', () => {
      const { sim, log } = setup([tap(1000, 0), tap(1500, 1)]);
      sim.press('a', 0, 1030);
      sim.press('b', 1, 1400);
      expect(log.map((e) => [e.unit, e.judgment, e.lane, e.tileIndex])).toEqual([
        ['tap', 'perfect', 0, 0],
        ['tap', 'good', 1, 1],
      ]);
      expect(sim.score.score).toBe(150);
      expect(sim.score.combo).toBe(2);
    });

    it('judges both members of a double independently, even at the same instant', () => {
      const { summary, sim } = setup([tap(1000, 0), tap(1000, 2)]);
      sim.press('a', 2, 1010);
      sim.press('b', 0, 1010);
      expect(summary()).toEqual(['tap:perfect@2#1', 'tap:perfect@0#0']);
    });

    it('picks the earliest unresolved eligible tile when same-lane windows overlap', () => {
      const { summary, sim } = setup([tap(1000, 1), tap(1150, 1)]);
      // 1100 is inside both windows: the earlier tile takes it.
      sim.press('a', 1, 1100);
      sim.press('b', 1, 1110);
      expect(summary()).toEqual(['tap:good@1#0', 'tap:perfect@1#1']);
    });

    it('records an empty press as one Miss and fails Classic', () => {
      const { summary, sim } = setup([tap(1000, 0)]);
      sim.press('a', 3, 1000);
      expect(summary()).toEqual(['empty:miss@3#-1']);
      expect(status(sim)).toBe('failed');
      expect(sim.failure).toEqual({ kind: 'emptyTap', lane: 3 });
      expect(sim.endMs).toBe(1000);
    });

    it('counts a press too early for the next tile in its lane as empty', () => {
      const { summary, sim } = setup([tap(1000, 0)], { failMode: 'relaxed' });
      sim.press('a', 0, 879);
      sim.press('b', 0, 880);
      expect(summary()).toEqual(['empty:miss@0#-1', 'tap:good@0#0']);
    });

    it('ignores empty presses during the lead-in but accepts early hits there', () => {
      const { summary, sim } = setup([tap(50, 0)]);
      sim.press('a', 1, -500);
      sim.press('b', 0, -40);
      expect(summary()).toEqual(['tap:good@0#0']);
      expect(status(sim)).toBe('running');
    });

    it('ignores everything after a Classic failure', () => {
      const { summary, sim } = setup([tap(1000, 0), tap(2000, 0)]);
      sim.press('a', 1, 500);
      sim.press('b', 0, 1000);
      sim.advance(5000);
      expect(summary()).toEqual(['empty:miss@1#-1']);
    });
  });

  describe('misses', () => {
    it('expires an unhit tile strictly after its +120 real ms boundary', () => {
      const { summary, sim } = setup([tap(1000, 0), tap(3000, 1)], { tempo: 1.5 });
      sim.advance(1180);
      expect(summary()).toEqual([]);
      sim.advance(1180.5);
      expect(summary()).toEqual(['tap:miss@0#0']);
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 0, tileIndex: 0 });
      expect(sim.endMs).toBe(1180);
    });

    it('still accepts a press timestamped at the deadline after time moved on to it', () => {
      const { summary, sim } = setup([tap(1000, 0)]);
      sim.advance(1120);
      sim.press('a', 0, 1120);
      expect(summary()).toEqual(['tap:good@0#0']);
    });

    it('expires earlier tiles before judging a later press, whatever the frame timing', () => {
      // Tile 0 is never hit; the press at 1250 is for tile 1. Tile 0's Miss comes first.
      const { summary, sim } = setup([tap(1000, 0), tap(1200, 0)], { failMode: 'relaxed' });
      sim.press('a', 0, 1250);
      expect(summary()).toEqual(['tap:miss@0#0', 'tap:perfect@0#1']);

      const classic = setup([tap(1000, 0), tap(1200, 0)]);
      classic.sim.press('a', 0, 1250);
      expect(classic.summary()).toEqual(['tap:miss@0#0']);
      expect(classic.sim.failure).toEqual({ kind: 'missedTile', lane: 0, tileIndex: 0 });
    });

    it('lets Relaxed play on after a Miss with the combo reset', () => {
      const { sim } = setup([tap(1000, 0), tap(2000, 1), tap(3000, 2)], { failMode: 'relaxed' });
      sim.press('a', 0, 1000);
      sim.advance(2500);
      sim.press('b', 2, 3000);
      expect(sim.status).toBe('running');
      expect(sim.score).toMatchObject({ perfect: 2, miss: 1, combo: 1, maxCombo: 1 });
    });
  });

  describe('holds', () => {
    const tiles = [hold(1000, 1, 1000), tap(3000, 2)];

    it('scores the head, then a Perfect tail when held to the end', () => {
      const { summary, sim } = setup(tiles);
      sim.press('a', 1, 1060);
      sim.advance(1999);
      expect(summary()).toEqual(['head:good@1#0']);
      sim.advance(2000);
      expect(summary()).toEqual(['head:good@1#0', 'tail:perfect@1#0']);
      expect(sim.holdEndMs[0]).toBe(2000);
      // Contact that continues after completion releases nothing and presses nothing.
      sim.release('a', 2400);
      expect(summary()).toHaveLength(2);
      expect(sim.score.combo).toBe(2);
    });

    it('completes the tail on a release within 120 real ms before the end', () => {
      const { summary, sim } = setup(tiles, { tempo: 0.75 });
      sim.press('a', 1, 1000);
      sim.release('a', 2000 - 90);
      expect(summary()).toEqual(['head:perfect@1#0', 'tail:perfect@1#0']);
      expect(sim.holdEndMs[0]).toBe(1910);
    });

    it('fails Classic on an earlier release', () => {
      const { summary, sim } = setup(tiles);
      sim.press('a', 1, 1000);
      sim.release('a', 1879);
      expect(summary()).toEqual(['head:perfect@1#0', 'tail:miss@1#0']);
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 1, tileIndex: 0 });
    });

    it('breaks the combo on an early release in Relaxed, without a re-grab', () => {
      const { summary, sim } = setup(tiles, { failMode: 'relaxed' });
      sim.press('a', 1, 1000);
      sim.release('a', 1500);
      sim.press('b', 1, 1510);
      sim.press('c', 2, 3000);
      expect(summary()).toEqual([
        'head:perfect@1#0',
        'tail:miss@1#0',
        'empty:miss@1#-1',
        'tap:perfect@2#1',
      ]);
      expect(sim.score.combo).toBe(1);
    });

    it('binds the hold to its input: other inputs do not release it', () => {
      const { summary, sim } = setup(tiles);
      sim.press('a', 1, 1000);
      sim.release('b', 1200);
      sim.advance(2000);
      expect(summary()).toEqual(['head:perfect@1#0', 'tail:perfect@1#0']);
    });

    it('misses the head in Classic and fails; in Relaxed misses head and tail', () => {
      const classic = setup(tiles);
      classic.sim.advance(1200);
      expect(classic.summary()).toEqual(['head:miss@1#0']);
      expect(classic.sim.status).toBe('failed');

      const relaxed = setup(tiles, { failMode: 'relaxed' });
      relaxed.sim.advance(1200);
      expect(relaxed.summary()).toEqual(['head:miss@1#0', 'tail:miss@1#0']);
      expect(relaxed.sim.score.miss).toBe(2);
    });

    it('finalizes a completion and an expiry in time order', () => {
      // The hold ends at 1100; the tap's deadline is 1120: completion first.
      const { summary, sim } = setup([hold(0, 0, 1100), tap(1000, 3)]);
      sim.press('a', 0, 0);
      sim.advance(3000);
      expect(summary()).toEqual(['head:perfect@0#0', 'tail:perfect@0#0', 'tap:miss@3#1']);
    });
  });

  describe('pause and reclaim', () => {
    const tiles = [hold(1000, 0, 2000), hold(1000, 3, 2000), tap(4000, 1)];

    const pausedAt1500 = (failMode: FailMode = 'classic') => {
      const run = setup(tiles, { failMode });
      run.sim.press('a', 0, 1000);
      run.sim.press('b', 3, 1000);
      run.sim.advance(1500);
      run.sim.pause();
      return run;
    };

    it('keeps hold progress without penalty and lists the lanes to reclaim', () => {
      const { sim, summary } = pausedAt1500();
      expect(sim.suspendedLanes()).toEqual([0, 3]);
      expect(summary()).toEqual(['head:perfect@0#0', 'head:perfect@3#1']);
      // The old inputs no longer own anything.
      sim.release('a', 1500);
      expect(summary()).toHaveLength(2);
    });

    it('resumes reclaimed holds and turns the others into tail Misses', () => {
      const { sim, summary } = pausedAt1500('relaxed');
      expect(sim.reclaim('k', 3)).toBe(true);
      expect(sim.reclaim('x', 1)).toBe(false);
      expect(sim.reclaimedLanes()).toEqual([3]);
      sim.resume(1500);
      expect(summary().slice(2)).toEqual(['tail:miss@0#0']);
      sim.advance(3000);
      expect(summary().slice(3)).toEqual(['tail:perfect@3#1']);
    });

    it('fails Classic on resume when a hold was not reclaimed', () => {
      const { sim } = pausedAt1500();
      sim.reclaim('k', 0);
      sim.resume(1500);
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 3, tileIndex: 1 });
    });

    it('stops judging at the first unreclaimed tail in Classic, in chart order', () => {
      const { sim, summary } = pausedAt1500();
      sim.resume(1500);
      expect(summary().slice(2)).toEqual(['tail:miss@0#0']);
      expect(sim.failure).toEqual({ kind: 'missedTile', lane: 0, tileIndex: 0 });
      expect(sim.score.perfect).toBe(2);
      expect(sim.score.miss).toBe(1);
      expect(sim.tails[1]).toBe(TAIL.suspended);
    });

    it('turns every unreclaimed tail into a Miss in Relaxed', () => {
      const { sim, summary } = pausedAt1500('relaxed');
      sim.resume(1500);
      expect(summary().slice(2)).toEqual(['tail:miss@0#0', 'tail:miss@3#1']);
      expect(sim.status).toBe('running');
    });

    it('lets a reclaiming input change its mind during the countdown', () => {
      const { sim } = pausedAt1500();
      sim.reclaim('k', 0);
      sim.unclaim('k');
      expect(sim.suspendedLanes()).toEqual([0, 3]);
      sim.reclaim('j', 0);
      sim.reclaim('m', 3);
      sim.resume(1500);
      sim.advance(3000);
      expect(sim.status).toBe('running');
      expect(sim.score.perfect).toBe(4);
    });
  });

  describe('completion', () => {
    it('completes only once time passes durationMs and every unit resolved', () => {
      const { sim } = setup([tap(1000, 0)], { durationMs: 5000 });
      sim.press('a', 0, 1000);
      sim.advance(4999);
      expect(sim.status).toBe('running');
      sim.advance(5000);
      expect(sim.status).toBe('complete');
      expect(sim.endMs).toBe(5000);
    });

    it('waits for a late window that outlasts durationMs', () => {
      const { sim, summary } = setup([tap(1000, 0)], { durationMs: 1000, failMode: 'relaxed' });
      sim.advance(1100);
      expect(sim.status).toBe('running');
      sim.advance(1121);
      expect(summary()).toEqual(['tap:miss@0#0']);
      expect(sim.status).toBe('complete');
    });
  });

  describe('frame-rate independence', () => {
    type Input =
      | { kind: 'press'; input: string; lane: number; at: number }
      | {
          kind: 'release';
          input: string;
          at: number;
        };

    // A dense passage with a double, overlapping same-lane windows, holds, an early
    // release, an empty press and a missed tile.
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
      { kind: 'press', input: 'p1', lane: 0, at: 1040 },
      { kind: 'press', input: 'p2', lane: 2, at: 1040 },
      { kind: 'release', input: 'p1', at: 1080 },
      { kind: 'release', input: 'p2', at: 1090 },
      { kind: 'press', input: 'p3', lane: 0, at: 1100 },
      { kind: 'release', input: 'p3', at: 1160 },
      { kind: 'press', input: 'k1', lane: 1, at: 1320 },
      { kind: 'press', input: 'p4', lane: 3, at: 1395 },
      { kind: 'release', input: 'p4', at: 1450 },
      // Tile 1700 in lane 3 is never pressed.
      { kind: 'release', input: 'k1', at: 1900 },
      { kind: 'press', input: 'p5', lane: 2, at: 1990 },
      { kind: 'press', input: 'p6', lane: 0, at: 2215 },
      { kind: 'release', input: 'p5', at: 2200 },
      { kind: 'press', input: 'p7', lane: 1, at: 2450 },
      { kind: 'press', input: 'p8', lane: 3, at: 2800 },
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
        // Inputs that arrived since the last frame, in arrival order.
        while (queue[0] && queue[0].at + lagMs * tempo <= now) {
          const next = queue.shift();
          if (next?.kind === 'press') run.sim.press(next.input, next.lane, next.at);
          else if (next) run.sim.release(next.input, next.at);
        }
        run.sim.advance(finalizationHorizon(now, tempo));
      }
      return { log: run.summary(), score: { ...run.sim.score }, status: run.sim.status };
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

    it('judges a press that arrives late but within the accepted lag before its miss', () => {
      // Pressed at 1120 (Good at 1×), dispatched 60 ms later.
      for (const fps of [30, 60, 120]) {
        const run = setup([tap(1000, 0)], { durationMs: 2000 });
        let dispatched = false;
        for (let now = 0; now < 1500; now += 1000 / fps) {
          if (!dispatched && now >= 1180) {
            run.sim.press('p1', 0, 1120);
            dispatched = true;
          }
          run.sim.advance(finalizationHorizon(now, 1));
        }
        expect(run.summary()).toEqual(['tap:good@0#0']);
        expect(run.sim.status).toBe('running');
      }
    });

    it('waits for the whole input lag the input layer accepts before finalizing', () => {
      expect(FINALIZE_GRACE_MS).toBe(MAX_EVENT_LAG_MS);
    });

    it('plays the passage as expected in Relaxed', () => {
      const { log, status } = simulate(60, 'relaxed');
      expect(log).toEqual([
        'tap:perfect@0#0',
        'tap:perfect@2#1',
        'tap:perfect@0#2',
        'head:perfect@1#3',
        'tap:perfect@3#4',
        'tap:miss@3#5',
        'tail:perfect@1#3',
        'head:perfect@2#6',
        'tail:miss@2#6',
        // 2215 is still inside tile 7's window, so tile 7 takes it, not tile 8.
        'tap:good@0#7',
        'tap:miss@0#8',
        'empty:miss@1#-1',
        'tap:miss@1#9',
        'tap:perfect@3#10',
      ]);
      expect(status).toBe('complete');
    });

    it('stops at the first missed tile in Classic', () => {
      const { log, status } = simulate(60, 'classic');
      expect(log.at(-1)).toBe('tap:miss@3#5');
      expect(status).toBe('failed');
    });
  });
});
