import {
  Color,
  type Camera,
  type InstancedMesh,
  Matrix4,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import type { StageView } from '../game/session';
import type { FailMode, GameMode, SessionConfig, SessionState } from '../game/session-contract';
import { HEAD } from '../game/simulation';
import {
  createTilesSimulation,
  TILES_FAIL_BLINK_MS,
  TILES_FAIL_SLIDE_MS,
} from '../game/tiles-simulation';
import { createGameStage, type GameStage } from './game-stage';
import { flatFrame, flatLayout } from './highway-layout';
import { tileSizing, tileSpans } from './lane-layout';

const LILY = new Color('#f7a8d8');
const SNAG = new Color('#ff6f61');
const SCROLL_MS = 1600;
const WIDTH = 390;
const HEIGHT = 844;

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

interface Options {
  failMode?: FailMode;
  reducedMotion?: boolean;
  width?: number;
  height?: number;
}

/** The Tiles simulation feeding a stage on a phone, frame by frame as in `main.ts`. */
function setup(
  tiles: Tile[],
  { failMode = 'relaxed', reducedMotion = false, width = WIDTH, height = HEIGHT }: Options = {},
) {
  const surface = document.createElement('div');
  surface.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  const stage = createGameStage({ surface, reducedMotion: () => reducedMotion });
  stages.push(stage);
  stage.resize(width, height);
  const frame = stage.tilesFrame();
  const sizing = tileSizing('normal', frame);
  const sim = createTilesSimulation({
    tiles,
    tempo: 1,
    failMode,
    durationMs: 120_000,
    scrollDurationMs: SCROLL_MS,
    exitAlong: frame.exitAlong,
    sizing,
    onJudgment: (event) => {
      stage.onJudgment(event);
    },
    onNotYet: (lane, tileIndex) => {
      stage.onNotYet({ lane, tileIndex });
    },
  });
  const config = (mode: GameMode) =>
    ({
      chart: { difficulties: { normal: { tiles } } },
      mode,
      difficulty: 'normal',
      tempo: 1,
      failMode,
      scrollDurationMs: SCROLL_MS,
      tileSize: 'normal',
    }) as unknown as SessionConfig;
  let mode: GameMode = 'tiles';

  let songMs = 0;
  let state: SessionState | undefined;
  let drawn: Object3D | undefined;
  let camera: Camera | undefined;
  const renderer = {
    render: (scene: Object3D, view: Camera) => {
      drawn = scene;
      camera = view;
    },
  } as unknown as WebGLRenderer;
  const view: StageView = {
    get config() {
      return config(mode);
    },
    simulation: sim,
    get songMs() {
      return songMs;
    },
    get state() {
      return state ?? (sim.status === 'failed' ? 'failing' : 'playing');
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
      const position = new Vector3();
      const scale = new Vector3();
      matrix.decompose(position, new Quaternion(), scale);
      return {
        colour: mesh.getColorAt(i, new Color()),
        position,
        scale,
        /** World z of its bottom and top edges (z grows down the screen). */
        bottom: position.z + scale.z / 2,
        top: position.z - scale.z / 2,
      };
    });
  };
  /** The ink blocks of tiles, not the marks on long tiles. */
  const blocks = () => instances('flat-tiles').filter((b) => b.scale.x > 0.5);
  const flat = flatLayout(width, height);
  /** CSS px from the top of the screen of a world z. */
  const screenY = (z: number) => (z + flat.far) / flat.unit;
  return {
    sim,
    stage,
    sizing,
    flat,
    screenY,
    draw,
    object,
    instances,
    blocks,
    camera: () => camera,
    setMode(next: GameMode) {
      mode = next;
      draw();
    },
    setState(next: SessionState | undefined) {
      state = next;
    },
    /** The display time jumps. */
    show(ms: number) {
      songMs = ms;
      draw();
    },
    step(ms: number) {
      songMs += ms;
      sim.advance(songMs);
      draw(ms);
    },
    /** A finger at CSS px (x, y) of the screen, through the stage's hit test. */
    touchAt(input: string, x: number, y: number) {
      const spot = stage.spotAt(x, y);
      if (!spot) throw new Error('no spot');
      const windowMs = SCROLL_MS;
      sim.press(input, spot.lane, songMs, {
        ms: songMs - spot.along * windowMs,
        reachMs: spot.reach * windowMs,
      });
      draw();
    },
    /** A finger on the middle of the tile at chart ms `t`. */
    touch(input: string, lane: number, t: number) {
      sim.press(input, lane, songMs, { ms: t + 1, reachMs: 30 });
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
const isSnag = (c: Color) => Math.abs(c.r - SNAG.r) < 0.01 && Math.abs(c.g - SNAG.g) < 0.01;

describe('the Tiles stage', () => {
  it('draws the flat view: the backdrop and blocks, none of Rhythm’s highway', () => {
    const h = setup([tap(1000, 0)]);
    expect(h.camera()).toBeInstanceOf(OrthographicCamera);
    expect(h.stage.drawing).toBe('flat');
    for (const name of ['flat-backdrop', 'flat-tiles', 'flat-caps', 'flat-claimed']) {
      expect(h.object(name).visible, name).toBe(true);
    }
    for (const name of [
      'hit-line',
      'hit-line-glow',
      'lane-glows',
      'tiles',
      'hold-bodies',
      'flashes',
    ]) {
      expect(h.object(name).visible, name).toBe(false);
    }
  });

  it('draws full-width tiles from their time up to the next one: a staircase', () => {
    const h = setup([tap(1000, 0), tap(1450, 1), tap(1900, 2), tap(4000, 3)]);
    h.step(400);
    const [a, b, c] = h.blocks();
    // Full lane width but for a 1 px gutter.
    expect(a?.scale.x).toBeCloseTo(1 - h.flat.unit, 6);
    // Each one's top is the next one's bottom.
    expect(a?.top).toBeCloseTo(b?.bottom ?? NaN, 6);
    expect(b?.top).toBeCloseTo(c?.bottom ?? NaN, 6);
    // About a quarter of the screen tall, and at least a fifth.
    const tall = ((a?.bottom ?? 0) - (a?.top ?? 0)) / h.flat.unit;
    expect(tall).toBeGreaterThan(HEIGHT / 5 - 0.01);
    expect(tall).toBeLessThan(HEIGHT / 4 + 0.01);
  });

  it('puts a tile’s bottom edge on the line at its time', () => {
    const h = setup([tap(1000, 0), tap(3000, 1)]);
    h.step(1000);
    expect(h.screenY(h.blocks()[0]?.bottom ?? NaN)).toBeCloseTo(HEIGHT * h.flat.line, 3);
  });

  it('tints the tiles to claim next, and keeps later ones ink', () => {
    const h = setup([tap(1000, 0), tap(1000, 2), tap(1300, 1)]);
    h.step(200);
    const [a, b, later] = h.blocks();
    expect(a?.colour.equals(b?.colour ?? new Color())).toBe(true);
    expect(later?.colour.r).toBeLessThan(a?.colour.r ?? 0);
  });

  it('pops a claimed tile lily, then lets it ride off translucent', () => {
    const h = setup([tap(1000, 0), tap(1300, 1)]);
    h.step(400);
    const before = h.blocks()[0];
    h.touch('a', 0, 1000);
    expect(h.blocks()).toHaveLength(1);
    const [pop] = h.instances('flat-claimed');
    expect(pop?.position.z).toBeCloseTo(before?.position.z ?? NaN, 6);
    expect(sameHue(pop?.colour ?? new Color(), LILY)).toBe(true);
    // Once the pop is over it stays, faint white, riding down with the lanes.
    h.step(400);
    const [ghost] = h.instances('flat-claimed');
    expect(ghost?.position.z).toBeGreaterThan(before?.position.z ?? NaN);
    expect(ghost?.colour.r).toBeCloseTo(ghost?.colour.b ?? NaN, 6);
    expect(ghost?.colour.r).toBeLessThan(0.3);
    // Until it has left the screen.
    h.step(2000);
    expect(h.instances('flat-claimed')).toHaveLength(0);
  });

  it('shakes a later tile pressed too soon, and claims nothing', () => {
    const h = setup([tap(1000, 0), tap(1300, 1)]);
    h.step(400);
    const x = h.blocks()[1]?.position.x ?? NaN;
    h.touch('a', 1, 1300);
    h.draw(0.05 * 1000);
    expect(h.blocks()).toHaveLength(2);
    expect(h.blocks()[1]?.position.x).not.toBeCloseTo(x, 3);
    h.draw(1000);
    expect(h.blocks()[1]?.position.x).toBeCloseTo(x, 6);
  });

  it('marks a waiting long tile, then fills it with lily from the bottom, a rounded top', () => {
    const h = setup([hold(1000, 2, 800)]);
    h.step(900);
    // One block, its centre line and its dot.
    expect(h.instances('flat-tiles')).toHaveLength(2);
    expect(h.instances('flat-caps')).toHaveLength(1);
    h.touch('a', 2, 1200);
    h.step(500); // song 1400: half full
    const [rest, fill] = h.instances('flat-tiles');
    expect(sameHue(fill?.colour ?? new Color(), LILY)).toBe(true);
    // The fill is at the bottom, the part still to fill above it.
    expect(fill?.bottom).toBeGreaterThan(rest?.bottom ?? Infinity);
    // Its top: a disc as wide as the lane, sitting on the fill.
    const [cap] = h.instances('flat-caps');
    expect(cap?.scale.x).toBeCloseTo(fill?.scale.x ?? NaN, 6);
    expect(sameHue(cap?.colour ?? new Color(), LILY)).toBe(true);
    expect(cap?.top).toBeCloseTo(rest?.bottom ?? NaN, 6);
    // A ring under the finger while it is held.
    expect(h.instances('ripples').length).toBeGreaterThanOrEqual(1);
    h.step(500); // full at 1800
    expect(h.sim.tails[0]).not.toBe(0);
    expect(h.instances('flat-tiles')).toHaveLength(0);
    expect(h.instances('flat-claimed')).toHaveLength(1);
  });

  it('keeps a tile past the line claimable until its top leaves the screen (Relaxed)', () => {
    const tiles = [tap(1000, 1), tap(5000, 0)];
    const h = setup(tiles);
    h.step(1150);
    const [tile] = h.blocks();
    // Its bottom edge is past the line; it is still ink.
    expect(tile?.bottom).toBeGreaterThan(0);
    expect(tile?.colour.r).toBeLessThan(0.3);
    const span = tileSpans(tiles, SCROLL_MS, h.sizing)[0] ?? 0;
    const lostAt = 1000 + span + (h.flat.near / h.flat.far) * SCROLL_MS;
    h.step(lostAt - 1150 - 20);
    expect(h.sim.heads[0]).toBe(HEAD.pending);
    expect(h.screenY(h.blocks()[0]?.top ?? NaN)).toBeLessThan(HEIGHT);
    h.step(40);
    expect(h.sim.heads[0]).toBe(HEAD.missed);
    expect(h.object('lane-glows').visible).toBe(false);
  });

  it('turns a long tile let go too soon red above its fill, riding off (Relaxed)', () => {
    const h = setup([hold(1000, 2, 800), tap(5000, 0)]);
    h.step(1000);
    h.touch('a', 2, 1000);
    h.step(300);
    h.release('a');
    h.step(100);
    const red = h.blocks().filter((b) => isSnag(b.colour));
    expect(red).toHaveLength(1);
    // What had filled rides off claimed, below the red.
    const [claimed] = h.instances('flat-claimed');
    expect(claimed?.top).toBeCloseTo(red[0]?.bottom ?? NaN, 3);
    expect(h.object('lane-glows').visible).toBe(false);
  });

  it('blinks the tile that fell off a few times in Classic, then keeps it red', () => {
    const h = setup([tap(1000, 1)], { failMode: 'classic' });
    h.step(3000);
    expect(h.sim.status).toBe('failed');
    // The session slides the board back to show it whole above the bottom edge.
    const exitMs = (h.flat.near / h.flat.far) * SCROLL_MS;
    h.show(1000 + exitMs);
    const red = () => isSnag(h.blocks()[0]?.colour ?? new Color());
    expect(red()).toBe(true);
    expect(h.screenY(h.blocks()[0]?.bottom ?? NaN)).toBeCloseTo(HEIGHT, 3);
    const seen: boolean[] = [];
    // Sampled a quarter blink into each half.
    h.draw(TILES_FAIL_SLIDE_MS + TILES_FAIL_BLINK_MS / 4);
    for (let ms = 0; ms < 1200; ms += TILES_FAIL_BLINK_MS / 2) {
      seen.push(red());
      h.draw(TILES_FAIL_BLINK_MS / 2);
    }
    expect(seen.slice(0, 6)).toEqual([true, false, true, false, true, false]);
    expect(seen.slice(6).every(Boolean)).toBe(true);
  });

  it('holds the offender steady red under reduced motion', () => {
    const h = setup([tap(1000, 1)], { failMode: 'classic', reducedMotion: true });
    h.step(3000);
    h.show(1000 + (h.flat.near / h.flat.far) * SCROLL_MS);
    for (let ms = 0; ms < 1500; ms += 50) {
      h.draw(50);
      expect(isSnag(h.blocks()[0]?.colour ?? new Color())).toBe(true);
    }
  });

  it('marks the spot of an empty tap that ended the run red', () => {
    const h = setup([tap(3000, 1)], { failMode: 'classic' });
    h.step(500);
    h.touchAt('a', WIDTH * 0.1, HEIGHT * 0.4);
    expect(h.sim.failure).toMatchObject({ kind: 'emptyTap', lane: 0 });
    h.draw();
    const [spot] = h.blocks().filter((b) => isSnag(b.colour));
    expect(spot?.position.x).toBeCloseTo(-1.5, 6);
    expect(h.screenY(spot?.position.z ?? NaN)).toBeCloseTo(HEIGHT * 0.4, 3);
    expect(h.object('lane-glows').visible).toBe(false);
  });

  it('claims what is drawn: a press at any drawn tile’s top edge or bottom edge takes it', () => {
    const tiles = [tap(1000, 0), tap(1250, 1), tap(1500, 2), hold(1700, 3, 900), tap(2700, 0)];
    for (const edge of ['top', 'bottom', 'middle'] as const) {
      for (let index = 0; index < 4; index += 1) {
        const h = setup(tiles);
        h.step(900);
        // Claim the ones before it first, in order.
        for (let earlier = 0; earlier < index; earlier += 1) {
          h.touch(`e${earlier}`, tiles[earlier]?.lane ?? 0, tiles[earlier]?.t ?? 0);
        }
        const drawn = h
          .blocks()
          .find((b) => Math.abs(b.position.x - ((tiles[index]?.lane ?? 0) - 1.5)) < 0.01);
        if (!drawn) throw new Error(`tile ${index} not drawn`);
        const z = edge === 'top' ? drawn.top : edge === 'bottom' ? drawn.bottom : drawn.position.z;
        const x = (((tiles[index]?.lane ?? 0) + 0.5) / 4) * WIDTH;
        h.touchAt('p', x, h.screenY(z));
        expect(h.sim.heads[index], `tile ${index} at its ${edge}`).toBe(HEAD.clear);
        expect(h.sim.score.miss).toBe(0);
      }
    }
  });

  it('switches view with the game, with no resize in between', () => {
    const h = setup([tap(1000, 0)]);
    expect(h.stage.drawing).toBe('flat');
    h.setMode('rhythm');
    expect(h.stage.drawing).toBe('handheld');
    expect(h.camera()).toBeInstanceOf(PerspectiveCamera);
    expect(h.object('flat-backdrop').visible).toBe(false);
    expect(h.object('hit-line').visible).toBe(true);
    h.setMode('tiles');
    expect(h.stage.drawing).toBe('flat');
    expect(h.camera()).toBeInstanceOf(OrthographicCamera);
    expect(h.object('hit-line').visible).toBe(false);
    // Its exit line and touch are the flat view's all along.
    expect(h.stage.tilesFrame()).toEqual(flatFrame(flatLayout(WIDTH, HEIGHT)));
    expect(h.stage.spotAt(WIDTH * 0.9, 1)?.lane).toBe(3);
  });

  it('fills a landscape screen too, with Rhythm still on its tabletop', () => {
    const h = setup([tap(1000, 0)], { width: 1180, height: 820 });
    expect(h.stage.layout).toBe('tabletop');
    expect(h.stage.drawing).toBe('flat');
    expect(h.stage.tilesFrame()).toEqual(flatFrame(flatLayout(1180, 820)));
    expect(h.stage.spotAt(1179, 819)?.lane).toBe(3);
  });
});
