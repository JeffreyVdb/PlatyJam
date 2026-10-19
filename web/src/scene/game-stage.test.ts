import { Color, type InstancedMesh, type Object3D, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { LANES, type Tile } from '../chart/schema';
import type { StageView } from '../game/session';
import type { FailMode, SessionConfig } from '../game/session-contract';
import { createSimulation } from '../game/simulation';
import { createGameStage, type GameStage } from './game-stage';

// The stage's palette (kept in sync with src/style.css there).
const SNAG = new Color('#ff6f61');
const RIPPLE = new Color('#6fe3cf');
const FOAM = new Color('#f3f7ee');

const tap = (t: number, lane: number): Tile => ({ t, lane, pitches: [60], vel: 90 });
const hold = (t: number, lane: number, dur: number): Tile => ({
  t,
  lane,
  dur,
  pitches: [64],
  vel: 90,
});
/** One tile per lane, far in the future: every earlier press is an empty press. */
const farAway = [0, 1, 2, 3].map((lane) => tap(60_000, lane));

const stages: GameStage[] = [];
afterEach(() => {
  for (const stage of stages.splice(0)) stage.dispose();
});

/**
 * The real path: simulation events feed the stage, which renders them. Like
 * `main.ts`, each frame is one simulation update followed by one render, and the
 * stage's clock only advances in the render.
 */
function setup(
  tiles: Tile[],
  {
    failMode = 'relaxed',
    reducedMotion = false,
  }: { failMode?: FailMode; reducedMotion?: boolean } = {},
) {
  const stage = createGameStage({
    surface: document.createElement('div'),
    reducedMotion: () => reducedMotion,
  });
  stages.push(stage);
  const sim = createSimulation({
    tiles,
    tempo: 1,
    failMode,
    durationMs: 120_000,
    onJudgment: (event) => {
      stage.onJudgment(event);
    },
  });
  // Only what the stage reads of a session config.
  const config = {
    chart: { difficulties: { normal: { tiles } } },
    difficulty: 'normal',
    tempo: 1,
    failMode,
    scrollDurationMs: 1600,
  } as unknown as SessionConfig;

  let songMs = 0;
  let drawn: Object3D | undefined;
  const renderer = {
    render: (scene: Object3D) => {
      drawn = scene;
    },
  } as unknown as WebGLRenderer;
  const view: StageView = {
    config,
    simulation: sim,
    get songMs() {
      return songMs;
    },
    get state() {
      return sim.status === 'failed' ? 'failing' : 'playing';
    },
  };

  const draw = (ms = 0) => {
    stage.render(view, ms / 1000, renderer);
  };
  const mesh = (name: string) => {
    const found = drawn?.getObjectByName(name) as InstancedMesh | undefined;
    if (!found) throw new Error(`nothing drawn as ${name}`);
    return found;
  };
  const laneColour = (lane: number) => mesh('lane-glows').getColorAt(lane, new Color());

  return {
    sim,
    draw,
    /** Time passes: the simulation finalizes up to now, then the stage draws. */
    step(ms: number) {
      songMs += ms;
      sim.advance(songMs);
      draw(ms);
    },
    press(lane: number) {
      sim.press('a', lane, songMs);
      draw();
    },
    release() {
      sim.release('a', songMs);
      draw();
    },
    laneColour,
    redLanes: () =>
      Array.from({ length: LANES }, (_, lane) => lane).filter((lane) => isRed(laneColour(lane))),
    tileColour: (index: number) => mesh('tiles').getColorAt(index, new Color()),
  };
}

/** A positive multiple of the snag colour. */
function isRed(colour: Color): boolean {
  return (
    colour.r > 0 &&
    Math.abs(colour.g / colour.r - SNAG.g / SNAG.r) < 0.01 &&
    Math.abs(colour.b / colour.r - SNAG.b / SNAG.r) < 0.01
  );
}

/** A positive multiple of the ripple colour: the success and held glow. */
function isRippleGlow(colour: Color): boolean {
  return (
    colour.g > 0 &&
    Math.abs(colour.r / colour.g - RIPPLE.r / RIPPLE.g) < 0.01 &&
    Math.abs(colour.b / colour.g - RIPPLE.b / RIPPLE.g) < 0.01
  );
}

describe('lane glow after misses (Relaxed)', () => {
  for (const reducedMotion of [false, true]) {
    it(`moves red from an empty press to the next one${reducedMotion ? ' (reduced motion)' : ''}`, () => {
      const h = setup(farAway, { reducedMotion });
      h.step(500);
      h.press(0);
      expect(h.redLanes()).toEqual([0]);
      h.step(100);
      h.press(2);
      expect(h.redLanes()).toEqual([2]);
    });
  }

  it('leaves only the latest of four misses 100 ms apart red', () => {
    const h = setup([tap(1000, 0), tap(1100, 1), tap(1200, 2), tap(1300, 3)]);
    h.step(1000);
    expect(h.redLanes()).toEqual([]);
    for (const lane of [0, 1, 2, 3]) {
      h.step(lane === 0 ? 121 : 100);
      expect(h.redLanes()).toEqual([lane]);
    }
  });

  it('shows the success glow at once when a Perfect follows a miss in the same lane', () => {
    const h = setup([tap(1000, 0), tap(1300, 0), ...farAway.slice(1)]);
    h.step(1000);
    h.step(121);
    expect(h.redLanes()).toEqual([0]);
    h.step(179);
    h.press(0);
    expect(h.sim.score.combo).toBe(1);
    expect(h.redLanes()).toEqual([]);
    expect(isRippleGlow(h.laneColour(0))).toBe(true);
  });

  it('keeps every lane of a chord that expires together red', () => {
    const h = setup([tap(1000, 1), tap(1000, 3), ...farAway.filter((t) => t.lane % 2 === 0)]);
    h.step(1000);
    h.step(121);
    expect(h.redLanes()).toEqual([1, 3]);
  });

  it('attributes a missed hold head, and its tail, to the hold lane', () => {
    const h = setup([hold(1000, 2, 500), tap(60_000, 0)]);
    h.step(1000);
    h.step(121);
    expect(h.redLanes()).toEqual([2]);
  });

  it('attributes a missed hold tail to the hold lane, not an earlier miss', () => {
    const h = setup([tap(500, 3), hold(1000, 1, 600), tap(60_000, 0)]);
    h.step(500);
    h.step(121);
    expect(h.redLanes()).toEqual([3]);
    h.step(379);
    h.press(1);
    expect(h.sim.score.combo).toBe(1);
    h.step(100);
    h.release();
    expect(h.sim.tails[1]).toBe(5);
    expect(h.redLanes()).toEqual([1]);
  });

  it('fades the red out when nothing else happens', () => {
    const h = setup([tap(1000, 0), ...farAway.slice(1)]);
    h.step(1000);
    h.step(121);
    expect(h.redLanes()).toEqual([0]);
    h.step(460);
    expect(h.redLanes()).toEqual([]);
  });
});

describe('failure presentation (Classic)', () => {
  it('keeps the empty-pressed lane red', () => {
    const h = setup(farAway, { failMode: 'classic' });
    h.step(500);
    h.press(0);
    expect(h.sim.status).toBe('failed');
    h.draw();
    expect(h.redLanes()).toEqual([0]);
    // Long after the miss feedback would have faded.
    h.draw(1000);
    expect(h.redLanes()).toEqual([0]);
  });

  it('colours the missed tile red', () => {
    const h = setup([tap(1000, 1)], { failMode: 'classic', reducedMotion: true });
    h.step(1000);
    h.step(121);
    expect(h.sim.status).toBe('failed');
    const expected = SNAG.clone().lerp(FOAM, 0.25 * 0.5);
    const actual = h.tileColour(0);
    expect(actual.r).toBeCloseTo(expected.r, 2);
    expect(actual.g).toBeCloseTo(expected.g, 2);
    expect(actual.b).toBeCloseTo(expected.b, 2);
  });
});
