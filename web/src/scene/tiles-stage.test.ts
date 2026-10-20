import {
  Color,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  type Object3D,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import type { StageView } from '../game/session';
import type { FailMode, SessionConfig } from '../game/session-contract';
import { createTilesSimulation } from '../game/tiles-simulation';
import { createGameStage, type GameStage } from './game-stage';
import { exitAlong, HANDHELD } from './highway-layout';

const LILY = new Color('#f7a8d8');
const SCROLL_MS = 1600;

const tap = (t: number, lane: number): Tile => ({ t, lane, pitches: [60], vel: 90 });
const hold = (t: number, lane: number, dur: number): Tile => ({
  t,
  lane,
  dur,
  pitches: [64],
  vel: 90,
});

const stages: GameStage[] = [];
afterEach(() => {
  for (const stage of stages.splice(0)) stage.dispose();
});

/** The Tiles simulation feeding a handheld stage, frame by frame as in `main.ts`. */
function setup(tiles: Tile[], { failMode = 'relaxed' }: { failMode?: FailMode } = {}) {
  const stage = createGameStage({
    surface: document.createElement('div'),
    reducedMotion: () => false,
  });
  stages.push(stage);
  stage.resize(820, 1180);
  const sim = createTilesSimulation({
    tiles,
    tempo: 1,
    failMode,
    durationMs: 120_000,
    scrollDurationMs: SCROLL_MS,
    exitAlong: stage.exitAlong(),
    onJudgment: (event) => {
      stage.onJudgment(event);
    },
    onNotYet: (lane, tileIndex) => {
      stage.onNotYet({ lane, tileIndex });
    },
  });
  const config = {
    chart: { difficulties: { normal: { tiles } } },
    mode: 'tiles',
    difficulty: 'normal',
    tempo: 1,
    failMode,
    scrollDurationMs: SCROLL_MS,
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
  draw();
  const object = (name: string) => {
    const found = drawn?.getObjectByName(name);
    if (!found) throw new Error(`nothing drawn as ${name}`);
    return found;
  };
  const instances = (name: string) => {
    const mesh = object(name) as InstancedMesh;
    return Array.from({ length: mesh.count }, (_, i) => {
      const matrix = new Matrix4();
      mesh.getMatrixAt(i, matrix);
      return {
        colour: mesh.getColorAt(i, new Color()),
        position: new Vector3().setFromMatrixPosition(matrix),
      };
    });
  };
  return {
    sim,
    stage,
    draw,
    object,
    instances,
    /** The display time jumps, as in the fail rewind. */
    show(ms: number) {
      songMs = ms;
      draw();
    },
    step(ms: number) {
      songMs += ms;
      sim.advance(songMs);
      draw(ms);
    },
    /** A finger on the tile at chart ms `t`. */
    touch(input: string, lane: number, t: number) {
      sim.press(input, lane, songMs, { ms: t, reachMs: 30 });
      draw();
    },
    release(input: string) {
      sim.release(input, songMs);
      draw();
    },
  };
}

const sameHue = (a: Color, b: Color) =>
  Math.abs(a.r / a.b - b.r / b.b) < 0.02 && Math.abs(a.g / a.b - b.g / b.b) < 0.02;

describe('the Tiles stage', () => {
  it('turns the hit line into a faint exit line at the near end, and drops its glow', () => {
    const h = setup([tap(1000, 0)]);
    const line = h.object('hit-line') as Mesh;
    expect(line.position.z).toBe(HANDHELD.near);
    expect(h.object('hit-line-glow').visible).toBe(false);
    expect(h.stage.exitAlong()).toBe(exitAlong(HANDHELD, HANDHELD.near));
  });

  it('tints the tiles to claim next, and keeps later ones ink', () => {
    const h = setup([tap(1000, 0), tap(1000, 2), tap(1300, 1)]);
    h.step(200);
    const [a, b, later] = h.instances('tiles');
    expect(a?.colour.equals(b?.colour ?? new Color())).toBe(true);
    expect(later?.colour.r).toBeLessThan(a?.colour.r ?? 0);
  });

  it('pops a claimed tile where it is, lily, and stops drawing it', () => {
    const h = setup([tap(1000, 0), tap(1300, 1)]);
    h.step(400);
    const before = h.instances('tiles')[0]?.position.z;
    h.touch('a', 0, 1000);
    expect(h.instances('tiles')).toHaveLength(1);
    const [pop] = h.instances('flashes');
    expect(pop?.position.z).toBeCloseTo(before ?? NaN, 6);
    expect(sameHue(pop?.colour ?? new Color(), LILY)).toBe(true);
    // It rides down with the lanes while it fades.
    h.step(50);
    expect(h.instances('flashes')[0]?.position.z).toBeGreaterThan(before ?? NaN);
  });

  it('shakes a later tile pressed too soon, and claims nothing', () => {
    const h = setup([tap(1000, 0), tap(1300, 1)]);
    h.step(400);
    const x = h.instances('tiles')[1]?.position.x ?? NaN;
    h.touch('a', 1, 1300);
    h.draw(0.05 * 1000);
    expect(h.instances('tiles')).toHaveLength(2);
    expect(h.instances('tiles')[1]?.position.x).not.toBeCloseTo(x, 3);
    h.draw(1000);
    expect(h.instances('tiles')[1]?.position.x).toBeCloseTo(x, 6);
  });

  it('fills a claimed long tile with lily from the bottom', () => {
    const h = setup([hold(1000, 2, 800)]);
    h.step(900);
    expect(h.instances('hold-bodies')).toHaveLength(1);
    h.touch('a', 2, 1200);
    h.step(500); // song 1400: half full
    const [fill, rest] = h.instances('hold-bodies');
    expect(sameHue(fill?.colour ?? new Color(), LILY)).toBe(true);
    // The fill is nearer the player than the part still to fill.
    expect(fill?.position.z).toBeGreaterThan(rest?.position.z ?? Infinity);
    h.step(500); // full at 1800
    expect(h.sim.tails[0]).not.toBe(0);
    expect(h.instances('hold-bodies')).toHaveLength(0);
  });

  it('keeps a tile past the hit line claimable, and red once it falls off', () => {
    const h = setup([tap(1000, 1)], { failMode: 'classic' });
    h.step(1150);
    const [tile] = h.instances('tiles');
    expect(tile?.position.z).toBeGreaterThan(0);
    expect(tile?.colour.r).toBeLessThan(0.3);
    h.step(400);
    expect(h.sim.status).toBe('failed');
    expect(h.instances('tiles')).toHaveLength(0);
    // The rewind brings it back on screen: the snag red, blinking towards foam.
    h.show((h.sim.endMs ?? 0) - 450);
    const red = h.instances('tiles')[0]?.colour ?? new Color();
    expect(red.r).toBeGreaterThan(0.9);
    expect(red.g).toBeLessThan(0.45);
  });
});
