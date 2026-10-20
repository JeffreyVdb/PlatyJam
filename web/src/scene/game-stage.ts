import {
  AdditiveBlending,
  Color,
  DataTexture,
  DynamicDrawUsage,
  Fog,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  RingGeometry,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { LANES, type Tile, tileEnd } from '../chart/schema';
import type { LaneSpot } from '../game/input';
import type { JudgmentEvent, NotYetEvent } from '../game/session-contract';
import type { StageView } from '../game/session';
import { headDeadline } from '../game/judgment';
import { prefersReducedMotion } from '../hud/motion';
import { HEAD, TAIL } from '../game/simulation';
import { exitTime } from '../game/tiles-simulation';
import { createHighwayMaterial, EDGE_MARGIN } from './highway-material';
import {
  exitAlong,
  exitDepth,
  frameLayout,
  HANDHELD,
  HIGHWAY_WIDTH,
  type HighwayLayout,
  type Insets,
  LANE_WIDTH,
  laneAtNdc,
  type LayoutKind,
  NO_INSETS,
  selectLayout,
  spotAtNdc,
} from './highway-layout';
import { firstVisibleTile, longestHold, tileDepth } from './lane-layout';

/**
 * The gameplay stage: four lanes on the billabong, tiles scrolling to the hit line
 * as a pure function of song time, and the feedback for every hit.
 *
 * Draw calls stay at eleven: water, highway, lane glow, two hit-line layers, hold
 * bodies, double bridges, tiles, flashes, ripples and droplets. The highway is one
 * analytic-antialiasing shader (`highway-material.ts`), not a texture. Everything that
 * repeats is an InstancedMesh with a fixed capacity drawn up to `count`; nothing is
 * allocated per frame. `rebuild()` disposes and recreates every GPU resource, which
 * a lost WebGL context requires, and `resize()` does the same when the viewport's
 * shape calls for the other layout (`highway-layout.ts`): geometry, camera, fog and
 * touch area are all read from the active layout when they are used.
 *
 * Tiles (the game is read from the view each frame) draws the same lanes with dark
 * ink tiles that ride on past the hit line, and keeps its accent, the water lily, for
 * what happens: the next tile's tint, the pop of a claimed tile, a long tile filling
 * up and the faint exit line where tiles fall off. The hit line itself, a promise
 * that timing matters, is gone; its mesh marks the exit line instead.
 */

// Brand palette, kept in sync with src/style.css.
const RIVER_DEEP = new Color('#0d2b3e');
const RIVER = new Color('#164560');
const RIVER_RAISED = new Color('#1d5574');
const BILL = new Color('#feb102');
const RIPPLE = new Color('#6fe3cf');
const FOAM = new Color('#f3f7ee');
/** Misses and failure. */
const SNAG = new Color('#ff6f61');
const BLACK = new Color(0x000000);
/** A hold body not yet played, and one being played. */
const HOLD_WAITING = BILL.clone().lerp(RIVER, 0.55);
const HOLD_PLAYED = BILL.clone().lerp(FOAM, 0.25);
const MISSED_TILE = SNAG.clone().lerp(RIVER, 0.45);
const MISSED_BODY = SNAG.clone().lerp(RIVER, 0.7);
/** Tiles' accent (`--game-tiles` in style.css): a water lily. */
const LILY = new Color('#f7a8d8');
/** Tiles' "black" tiles: ink darker than the deepest water, so they read on the lanes. */
const INK = new Color('#06141d');
/** The tile, or both tiles of a double, to claim next. */
const INK_NEXT = INK.clone().lerp(LILY, 0.2);
/** A long tile claimed, its fill not yet risen this far. */
const INK_CLAIMED = INK.clone().lerp(LILY, 0.5);
const EXIT_LINE = LILY.clone().lerp(RIVER, 0.6);

const MAX_TILES = 160;
const MAX_HOLD_SEGMENTS = 32;
const MAX_BRIDGES = 24;
const MAX_FLASHES = 16;
const MAX_RIPPLES = 16;
const MAX_DROPLETS = 160;

/** Feedback lifetimes, real seconds (never song time, so they do not scale with tempo). */
const FLASH_S = 0.18;
const RIPPLE_S = 0.5;
const DROPLET_S = 0.45;
const LANE_PULSE_S = 0.3;
/** Tiles: the "not yet" shake of a later tile. */
const SHAKE_S = 0.28;
const SHAKE_X = 0.07;
/** Tiles warm towards foam over the last this-many real ms before the line. */
const WARM_MS = 250;

const laneX = (lane: number) => (lane - (LANES - 1) / 2) * LANE_WIDTH;
/** A hold body's width: narrower than a tile in Rhythm, widened to a whole tile in Tiles. */
const BODY_WIDTH = LANE_WIDTH * 0.42;

function roundedTileShape(width: number, depth: number): Shape {
  const radius = Math.min(0.16, depth * 0.4);
  const x = -width / 2;
  const y = -depth / 2;
  const shape = new Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + depth - radius);
  shape.quadraticCurveTo(x + width, y + depth, x + width - radius, y + depth);
  shape.lineTo(x + radius, y + depth);
  shape.quadraticCurveTo(x, y + depth, x, y + depth - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

/** A brightness ramp along the plane's v axis, white on black, for soft additive glows. */
function createFalloffTexture(profile: (v: number) => number): DataTexture {
  const height = 64;
  const data = new Uint8Array(height * 4);
  for (let y = 0; y < height; y += 1) {
    const value = Math.round(Math.min(1, Math.max(0, profile((y + 0.5) / height))) * 255);
    data.set([value, value, value, 255], y * 4);
  }
  const texture = new DataTexture(data, 1, height, RGBAFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A round soft dot, for droplets. */
function createDotTexture(): DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const value = Math.round(Math.max(0, 1 - d) ** 1.6 * 255);
      data.set([value, value, value, 255], (y * size + x) * 4);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The billabong under the lanes: slow light bands drifting on dark water. */
const WATER_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const WATER_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uDeep;
uniform vec3 uLight;
varying vec2 vUv;
void main() {
  vec2 p = vUv * vec2(9.0, 7.0);
  float a = sin(p.x * 1.3 + uTime * 0.31) * sin(p.y * 1.7 - uTime * 0.23);
  float b = sin((p.x + p.y) * 0.8 + uTime * 0.17 + sin(p.y * 0.5 + uTime * 0.11) * 2.0);
  float band = smoothstep(0.55, 1.35, a + b);
  float glow = band * (0.09 + uPulse * 0.16);
  gl_FragColor = vec4(mix(uDeep, uLight, glow), 1.0);
  #include <colorspace_fragment>
}
`;

interface Resources {
  geometries: BufferGeometry[];
  materials: Material[];
  textures: Texture[];
  water: ShaderMaterial;
  glows: InstancedMesh;
  tiles: InstancedMesh;
  bodies: InstancedMesh;
  bridges: InstancedMesh;
  flashes: InstancedMesh;
  ripples: InstancedMesh;
  droplets: InstancedMesh;
  /** The hit line and its glow; in Tiles the line marks the exit and the glow is hidden. */
  line: Mesh;
  lineMaterial: MeshBasicMaterial;
  halo: Mesh;
  /** What tiles are drawn with: heads, hold bodies and bridges. */
  tileMaterials: MeshBasicMaterial[];
  root: Object3D;
}

/**
 * A pooled one-shot effect: lane, birth time and colour per slot, and where along the
 * lane: at the hit line (`at` NaN), or riding with a tile at chart ms `at` that lasts
 * `span` ms (Tiles' pops).
 */
interface Pool {
  lane: Int8Array;
  born: Float64Array;
  colour: Color[];
  at: Float64Array;
  span: Float64Array;
  next: number;
}

function createPool(size: number): Pool {
  return {
    lane: new Int8Array(size).fill(-1),
    born: new Float64Array(size).fill(-Infinity),
    colour: Array.from({ length: size }, () => new Color()),
    at: new Float64Array(size).fill(Number.NaN),
    span: new Float64Array(size),
    next: 0,
  };
}

export interface GameStage {
  /** Draws the session's view. `deltaSeconds` drives feedback animations only. */
  render(view: StageView, deltaSeconds: number, renderer: WebGLRenderer): void;
  /** Spawns hit and miss feedback. */
  onJudgment(event: Readonly<JudgmentEvent>): void;
  /** Whether a lane is held, for its highlight. */
  setLaneHeld(isHeld: (lane: number) => boolean): void;
  /**
   * Fits the camera to a viewport in CSS px, switching layout if its shape calls for
   * another (`layout`). `insets` are the safe-area insets, which the tabletop layout
   * keeps its lanes and top band inside.
   */
  resize(width: number, height: number, insets?: Readonly<Insets>): void;
  /** The layout in use: portrait is handheld, landscape tabletop. Changes in `resize`. */
  readonly layout: LayoutKind;
  /** Tiles: a tile that is not next yet was pressed; it shakes. */
  onNotYet(event: Readonly<NotYetEvent>): void;
  /** The lane under a client point, or undefined off the lanes. */
  laneAt(clientX: number, clientY: number): number | undefined;
  /** Tiles' hit test: the lane and the place along it under a client point. */
  spotAt(clientX: number, clientY: number): LaneSpot | undefined;
  /**
   * Tiles: where this layout loses a tile, in scroll windows past the hit line (for
   * `GameplaySession.setExitAlong`). Changes in `resize`.
   */
  exitAlong(): number;
  /** The hit line's height on screen, 0 (top) to 1 (bottom). */
  hitLineY(): number;
  /** Disposes and recreates every GPU resource. Call after a context restore. */
  rebuild(): void;
  /** How many times GPU resources were built (debug). */
  readonly builds: number;
  dispose(): void;
}

export interface GameStageOptions {
  /** The element the canvas fills, for pointer-to-lane mapping. */
  surface: HTMLElement;
  /**
   * Whether the player asked for less motion: the water stands still, hits skip the
   * ripples and droplets, and failure highlights hold steady. Tiles still travel.
   */
  reducedMotion?: () => boolean;
}

export function createGameStage({
  surface,
  reducedMotion = () => prefersReducedMotion(),
}: GameStageOptions): GameStage {
  const scene = new Scene();
  scene.background = RIVER_DEEP;
  const fog = new Fog(RIVER_DEEP, 1, 2);
  scene.fog = fog;

  const camera = new PerspectiveCamera(HANDHELD.fov, 1, 0.1, 100);
  // Chosen again by `resize()`; everything below reads it when it is used.
  let layout: HighwayLayout = HANDHELD;
  const viewDepth = (point: Vector3) => -point.clone().applyMatrix4(camera.matrixWorldInverse).z;

  // Reused every frame and every touch.
  const dummy = new Object3D();
  const colour = new Color();
  const projected = new Vector3();
  const laneGlow = new Float32Array(LANES);
  const lanePulse = new Float64Array(LANES).fill(-Infinity);
  const laneSnag = new Float64Array(LANES).fill(-Infinity);

  const flashes = createPool(MAX_FLASHES);
  const ripples = createPool(MAX_RIPPLES);
  const droplets = createPool(MAX_DROPLETS);
  const dropletVelocity = new Float32Array(MAX_DROPLETS * 2);
  const dropletOrigin = new Float32Array(MAX_DROPLETS);

  let clock = 0;
  let pulse = 0;
  /** `reducedMotion()`, read once per frame. */
  let still = false;
  /** Water time: stands still under reduced motion. */
  let waterClock = 0;
  let builds = 0;
  let isLaneHeld: (lane: number) => boolean = () => false;
  let resources: Resources | undefined;
  // The longest hold of the tiles drawn last, cached per tile list.
  let measured: readonly Tile[] | undefined;
  let longest = 0;
  /** The view drawn last: feedback spawned between frames reads its song and game. */
  let shown: StageView | undefined;
  /** Tiles' exit line, world z: set by `resize`. */
  let exitZ = HANDHELD.near;
  /** Tiles: the tile shaking "not yet", and since when. */
  let shakeTile = -1;
  let shakeBorn = -Infinity;

  const build = (): Resources => {
    builds += 1;
    const { far, near, tileWidth, tileDepth: tileLength, hitLine, glowLength } = layout;
    const root = new Object3D();
    const glowTexture = createFalloffTexture((v) =>
      v < 0.04 ? (v / 0.04) ** 2 : (1 - (v - 0.04) / 0.96) ** 2,
    );
    const haloTexture = createFalloffTexture((v) => (1 - Math.abs(2 * v - 1)) ** 2.4);
    const dotTexture = createDotTexture();
    const additive = {
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    };

    const waterGeometry = new PlaneGeometry(70, 50);
    waterGeometry.rotateX(-Math.PI / 2);
    waterGeometry.translate(0, -0.25, -12);
    const water = new ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: 0 },
        uDeep: { value: RIVER_DEEP.clone() },
        uLight: { value: RIVER_RAISED.clone().lerp(RIPPLE, 0.35) },
      },
      depthWrite: false,
    });
    const waterMesh = new Mesh(waterGeometry, water);
    waterMesh.renderOrder = -1;
    root.add(waterMesh);

    const highwayGeometry = new PlaneGeometry(HIGHWAY_WIDTH + 2 * EDGE_MARGIN, far + near);
    highwayGeometry.rotateX(-Math.PI / 2);
    highwayGeometry.translate(0, 0, (near - far) / 2);
    const highwayMaterial = createHighwayMaterial({
      lane: RIVER,
      divider: RIVER_DEEP,
      near,
    });
    const highwayMesh = new Mesh(highwayGeometry, highwayMaterial);
    // Alpha-blended, so it draws first among the transparent layers that sit on it.
    highwayMesh.renderOrder = -1;
    root.add(highwayMesh);

    // Per-lane glow: held lanes, hits, and red for a snag. Additive: black is invisible.
    const glowGeometry = new PlaneGeometry(LANE_WIDTH * 0.94, glowLength);
    glowGeometry.rotateX(-Math.PI / 2);
    glowGeometry.translate(0, 0.002, 0.15 - glowLength / 2);
    const glowMaterial = new MeshBasicMaterial({ map: glowTexture, ...additive });
    const glows = new InstancedMesh(glowGeometry, glowMaterial, LANES);
    glows.name = 'lane-glows';
    for (let lane = 0; lane < LANES; lane += 1) {
      dummy.position.set(laneX(lane), 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      glows.setMatrixAt(lane, dummy.matrix);
      glows.setColorAt(lane, BLACK);
    }
    root.add(glows);

    const lineGeometry = new PlaneGeometry(HIGHWAY_WIDTH + 2 * hitLine.overhang, hitLine.thickness);
    lineGeometry.rotateX(-Math.PI / 2);
    lineGeometry.translate(0, 0.004, 0);
    const lineMaterial = new MeshBasicMaterial({ color: RIPPLE, fog: false });
    const line = new Mesh(lineGeometry, lineMaterial);
    line.name = 'hit-line';
    root.add(line);

    const haloGeometry = new PlaneGeometry(HIGHWAY_WIDTH + 2 * hitLine.overhang, hitLine.halo);
    haloGeometry.rotateX(-Math.PI / 2);
    haloGeometry.translate(0, 0.003, 0);
    const haloMaterial = new MeshBasicMaterial({
      color: RIPPLE.clone().multiplyScalar(0.16),
      map: haloTexture,
      ...additive,
    });
    const halo = new Mesh(haloGeometry, haloMaterial);
    halo.name = 'hit-line-glow';
    root.add(halo);

    // Hold bodies: unit length along z, scaled per segment.
    const bodyGeometry = new PlaneGeometry(BODY_WIDTH, 1);
    bodyGeometry.rotateX(-Math.PI / 2);
    bodyGeometry.translate(0, 0.006, 0);
    const bodyMaterial = new MeshBasicMaterial();
    const bodies = dynamicMesh(bodyGeometry, bodyMaterial, MAX_HOLD_SEGMENTS, root);
    bodies.name = 'hold-bodies';

    // A bridge joins the two tiles of a double.
    const bridgeGeometry = new PlaneGeometry(1, tileLength * 0.24);
    bridgeGeometry.rotateX(-Math.PI / 2);
    bridgeGeometry.translate(0, 0.008, 0);
    const bridgeMaterial = new MeshBasicMaterial();
    const bridges = dynamicMesh(bridgeGeometry, bridgeMaterial, MAX_BRIDGES, root);

    const tileGeometry = new ShapeGeometry(roundedTileShape(tileWidth, tileLength), 6);
    tileGeometry.rotateX(-Math.PI / 2);
    tileGeometry.translate(0, 0.01, 0);
    const tileMaterial = new MeshBasicMaterial();
    const tiles = dynamicMesh(tileGeometry, tileMaterial, MAX_TILES, root);
    tiles.name = 'tiles';

    const flashGeometry = new ShapeGeometry(roundedTileShape(tileWidth, tileLength), 6);
    flashGeometry.rotateX(-Math.PI / 2);
    flashGeometry.translate(0, 0.012, 0);
    const flashMaterial = new MeshBasicMaterial({ ...additive });
    const flashMesh = dynamicMesh(flashGeometry, flashMaterial, MAX_FLASHES, root);
    flashMesh.name = 'flashes';

    const rippleGeometry = new RingGeometry(0.4, 0.46, 48);
    rippleGeometry.rotateX(-Math.PI / 2);
    rippleGeometry.translate(0, 0.006, 0);
    const rippleMaterial = new MeshBasicMaterial({ ...additive });
    const rippleMesh = dynamicMesh(rippleGeometry, rippleMaterial, MAX_RIPPLES, root);

    const dropletGeometry = new PlaneGeometry(1, 1);
    dropletGeometry.rotateX(-Math.PI / 2);
    dropletGeometry.translate(0, 0.02, 0);
    const dropletMaterial = new MeshBasicMaterial({ map: dotTexture, ...additive });
    const dropletMesh = dynamicMesh(dropletGeometry, dropletMaterial, MAX_DROPLETS, root);

    scene.add(root);
    return {
      geometries: [
        waterGeometry,
        highwayGeometry,
        glowGeometry,
        lineGeometry,
        haloGeometry,
        bodyGeometry,
        bridgeGeometry,
        tileGeometry,
        flashGeometry,
        rippleGeometry,
        dropletGeometry,
      ],
      materials: [
        water,
        highwayMaterial,
        glowMaterial,
        lineMaterial,
        haloMaterial,
        bodyMaterial,
        bridgeMaterial,
        tileMaterial,
        flashMaterial,
        rippleMaterial,
        dropletMaterial,
      ],
      textures: [glowTexture, haloTexture, dotTexture],
      water,
      glows,
      tiles,
      bodies,
      bridges,
      flashes: flashMesh,
      ripples: rippleMesh,
      droplets: dropletMesh,
      line,
      lineMaterial,
      halo,
      tileMaterials: [tileMaterial, bodyMaterial, bridgeMaterial],
      root,
    };
  };

  /** An InstancedMesh rewritten every frame: never culled, colours allocated at build. */
  function dynamicMesh(
    geometry: BufferGeometry,
    material: Material,
    capacity: number,
    root: Object3D,
  ): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // The first setColorAt allocates instanceColor; doing it now keeps the shader
    // compile out of gameplay.
    mesh.setColorAt(0, BLACK);
    mesh.instanceColor?.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  }

  const release = (old: Resources) => {
    scene.remove(old.root);
    for (const mesh of [
      old.glows,
      old.tiles,
      old.bodies,
      old.bridges,
      old.flashes,
      old.ripples,
      old.droplets,
    ]) {
      mesh.dispose();
    }
    for (const geometry of old.geometries) geometry.dispose();
    for (const material of old.materials) material.dispose();
    for (const texture of old.textures) texture.dispose();
  };

  /** Spawns an effect at the hit line, or riding with a tile at chart ms `at`. */
  const spawn = (pool: Pool, lane: number, tint: Color, at = Number.NaN, span = 0) => {
    const slot = pool.next;
    pool.next = (pool.next + 1) % pool.lane.length;
    pool.lane[slot] = lane;
    pool.born[slot] = clock;
    pool.colour[slot]?.copy(tint);
    pool.at[slot] = at;
    pool.span[slot] = span;
    return slot;
  };

  /** World z of an effect slot this frame: on the line, or with its tile. */
  const effectZ = (pool: Pool, slot: number) => {
    const at = pool.at[slot] ?? Number.NaN;
    const config = shown?.config;
    if (Number.isNaN(at) || !config || !shown) return 0;
    const windowMs = config.scrollDurationMs * config.tempo;
    return tileDepth(at + (pool.span[slot] ?? 0) / 2, shown.songMs, windowMs, layout.far);
  };

  const burst = (lane: number, tint: Color, count: number, at = Number.NaN) => {
    for (let k = 0; k < count; k += 1) {
      const slot = spawn(droplets, lane, tint, at);
      const angle = Math.PI * (0.15 + 0.7 * Math.random());
      const speed = 1.6 + Math.random() * 2.2;
      dropletVelocity[slot * 2] = Math.cos(angle) * speed;
      dropletVelocity[slot * 2 + 1] = -Math.sin(angle) * speed * 0.7;
      dropletOrigin[slot] = (Math.random() - 0.5) * layout.tileWidth * 0.6;
    }
  };

  /** One segment of a hold body spanning z = a..b in a lane, `widen` times its width. */
  const placeSegment = (
    mesh: InstancedMesh,
    slot: number,
    lane: number,
    a: number,
    b: number,
    widen = 1,
  ) => {
    dummy.position.set(laneX(lane), 0, (a + b) / 2);
    dummy.scale.set(widen, 1, Math.max(0.0001, Math.abs(a - b)));
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, colour);
  };

  const layoutTiles = (res: Resources, stage: StageView) => {
    const { config, simulation } = stage;
    let tileCount = 0;
    let bodyCount = 0;
    let bridgeCount = 0;
    if (!config) {
      res.tiles.count = 0;
      res.bodies.count = 0;
      res.bridges.count = 0;
      return;
    }
    const { far, near, tileWidth, tileDepth: tileLength } = layout;
    const all = config.chart.difficulties[config.difficulty].tiles;
    if (measured !== all) {
      measured = all;
      longest = longestHold(all);
    }
    const songMs = stage.songMs;
    const windowMs = config.scrollDurationMs * config.tempo;
    const msPerUnit = windowMs / far;
    const behindMs = (near + tileLength) * msPerUnit;
    const aheadMs = windowMs * 1.02;
    const failure =
      stage.state === 'failing' || stage.state === 'finished' ? simulation?.failure : undefined;
    const offender = failure?.kind === 'missedTile' ? failure.tileIndex : -1;
    const blink = still ? 0.5 : 0.5 + 0.5 * Math.sin(clock * 18);
    const tiles = config.mode === 'tiles';
    const exit = exitAlong(layout, exitZ);
    /** Tiles: the time of the tile(s) to claim next, once found (they come first). */
    let nextT = Number.NaN;

    for (let i = firstVisibleTile(all, songMs - behindMs, longest); i < all.length; i += 1) {
      const tile = all[i];
      if (!tile || tile.t > songMs + aheadMs) break;
      const head = simulation?.heads[i] ?? HEAD.pending;
      const tail = simulation?.tails[i] ?? TAIL.none;
      // Past its late boundary (Tiles: its exit line): the Miss is only waiting for
      // in-flight input.
      const lapsed =
        head === HEAD.pending &&
        songMs >
          (tiles
            ? exitTime(tile.t, exit, config.scrollDurationMs, config.tempo)
            : headDeadline(tile.t, config.tempo));
      const z = tileDepth(tile.t, songMs, windowMs, far);
      if (tiles && head === HEAD.pending && !lapsed && Number.isNaN(nextT)) nextT = tile.t;
      const isNext = tile.t === nextT && head === HEAD.pending && !lapsed;

      if (tiles && tile.dur !== undefined && bodyCount + 2 <= MAX_HOLD_SEGMENTS) {
        // A long tile: one tall tile, as wide as a head, that fills up when claimed.
        const widen = tileWidth / BODY_WIDTH;
        const endAt = tileDepth(tileEnd(tile), songMs, windowMs, far);
        const top = Math.max(-far * 1.02, endAt);
        // It slides over the exit line, off the end of the lanes.
        const base = z + tileLength / 2;
        const bottom = Math.min(exitZ, base);
        const claimed = tail === TAIL.holding || tail === TAIL.suspended;
        if (tail !== TAIL.clear && top < bottom) {
          if (tail === TAIL.missed || head === HEAD.missed || lapsed) {
            const stopped = simulation?.holdEndMs[i] ?? Number.NaN;
            const from = Number.isNaN(stopped)
              ? bottom
              : Math.min(bottom, tileDepth(stopped, songMs, windowMs, far));
            colour.copy(i === offender ? SNAG : MISSED_BODY);
            placeSegment(res.bodies, bodyCount, tile.lane, from, top, widen);
            bodyCount += 1;
          } else if (claimed) {
            // The fill rises from the bottom over the note's length.
            const start = simulation?.noteStartMs[i] ?? Number.NaN;
            const filled = Number.isNaN(start)
              ? 0
              : Math.min(1, Math.max(0, (songMs - start) / (tile.dur || 1)));
            const level = Math.min(bottom, Math.max(top, base + (endAt - base) * filled));
            colour.copy(LILY);
            placeSegment(res.bodies, bodyCount, tile.lane, bottom, level, widen);
            bodyCount += 1;
            colour.copy(INK_CLAIMED);
            placeSegment(res.bodies, bodyCount, tile.lane, level, top, widen);
            bodyCount += 1;
          } else {
            colour.copy(isNext ? INK_NEXT : INK);
            placeSegment(res.bodies, bodyCount, tile.lane, bottom, top, widen);
            bodyCount += 1;
          }
        }
      } else if (tile.dur !== undefined && bodyCount + 2 <= MAX_HOLD_SEGMENTS) {
        const end = tileEnd(tile);
        const endZ = Math.max(-far * 1.02, tileDepth(end, songMs, windowMs, far));
        const startZ = Math.min(near, z);
        const holding = tail === TAIL.holding || tail === TAIL.suspended;
        const done = tail === TAIL.perfect;
        if (!done && endZ < near) {
          if (tail === TAIL.missed || head === HEAD.missed || lapsed) {
            // From where it was let go (or the whole hold) up to its tail.
            const stopped = simulation?.holdEndMs[i] ?? Number.NaN;
            const fromZ = Number.isNaN(stopped)
              ? startZ
              : Math.min(near, tileDepth(stopped, songMs, windowMs, far));
            colour.copy(i === offender ? SNAG : MISSED_BODY);
            placeSegment(res.bodies, bodyCount, tile.lane, fromZ, endZ);
            bodyCount += 1;
          } else if (holding) {
            // The played part has crossed the line and fills bright; the rest waits.
            colour.copy(HOLD_PLAYED);
            placeSegment(res.bodies, bodyCount, tile.lane, Math.max(startZ, 0), Math.max(endZ, 0));
            bodyCount += 1;
            colour.copy(HOLD_WAITING).lerp(HOLD_PLAYED, 0.35);
            placeSegment(res.bodies, bodyCount, tile.lane, Math.min(startZ, 0), Math.min(endZ, 0));
            bodyCount += 1;
          } else {
            colour.copy(HOLD_WAITING);
            placeSegment(res.bodies, bodyCount, tile.lane, startZ, endZ);
            bodyCount += 1;
          }
        }
      }

      const hitHead = head === HEAD.perfect || head === HEAD.good || head === HEAD.clear;
      if (hitHead || z > near + tileLength || z < -far * 1.02) continue;
      if (tileCount >= MAX_TILES) continue;
      if (head === HEAD.missed || lapsed) {
        colour.copy(i === offender ? SNAG : MISSED_TILE);
        if (i === offender) colour.lerp(FOAM, 0.25 * blink);
      } else if (tiles) {
        colour.copy(isNext ? INK_NEXT : INK);
      } else {
        const realUntil = (tile.t - songMs) / config.tempo;
        colour.copy(BILL).lerp(FOAM, Math.max(0, 1 - realUntil / WARM_MS) * 0.55);
      }
      // Tiles: a later tile pressed too soon shakes its head ("not yet"); held still,
      // it flushes lily instead.
      const shake = i === shakeTile ? Math.max(0, 1 - (clock - shakeBorn) / SHAKE_S) : 0;
      if (shake > 0 && still) colour.lerp(LILY, 0.45 * shake);
      const sway = shake > 0 && !still ? Math.sin(shake * Math.PI * 6) * SHAKE_X * shake : 0;
      dummy.position.set(laneX(tile.lane) + sway, 0, z);
      dummy.scale.setScalar(i === offender ? 1.08 : 1);
      dummy.updateMatrix();
      res.tiles.setMatrixAt(tileCount, dummy.matrix);
      res.tiles.setColorAt(tileCount, colour);
      tileCount += 1;

      // A double: bridge it to its partner while both wait.
      const partner = all[i + 1];
      if (
        partner?.t === tile.t &&
        head === HEAD.pending &&
        simulation?.heads[i + 1] !== HEAD.perfect &&
        simulation?.heads[i + 1] !== HEAD.good &&
        simulation?.heads[i + 1] !== HEAD.clear &&
        bridgeCount < MAX_BRIDGES
      ) {
        const left = laneX(tile.lane) + tileWidth / 2;
        const right = laneX(partner.lane) - tileWidth / 2;
        dummy.position.set((left + right) / 2, 0, z);
        dummy.scale.set(Math.max(0.01, right - left), 1, 1);
        dummy.updateMatrix();
        res.bridges.setMatrixAt(bridgeCount, dummy.matrix);
        res.bridges.setColorAt(
          bridgeCount,
          tiles ? colour.copy(isNext ? LILY : EXIT_LINE) : colour.copy(FOAM).lerp(BILL, 0.3),
        );
        bridgeCount += 1;
      }
    }

    res.tiles.count = tileCount;
    res.bodies.count = bodyCount;
    res.bridges.count = bridgeCount;
  };

  const layoutLanes = (res: Resources, stage: StageView) => {
    const failure =
      stage.state === 'failing' || stage.state === 'finished'
        ? stage.simulation?.failure
        : undefined;
    const snagLane = failure?.kind === 'emptyTap' ? failure.lane : -1;
    // Tiles' lanes only glow red: a glow at the hit line would say timing matters.
    const quiet = stage.config?.mode === 'tiles';
    for (let lane = 0; lane < LANES; lane += 1) {
      const sincePulse = clock - (lanePulse[lane] ?? -Infinity);
      const sinceSnag = clock - (laneSnag[lane] ?? -Infinity);
      const pulseLevel = Math.max(0, 1 - sincePulse / LANE_PULSE_S);
      const held = isLaneHeld(lane) && !quiet ? 0.55 : 0;
      laneGlow[lane] = Math.max(held, pulseLevel);
      if (lane === snagLane) {
        // An empty-tap failure: the pressed lane stays lit red at the line.
        colour.copy(SNAG).multiplyScalar(still ? 0.65 : 0.55 + 0.25 * Math.sin(clock * 9));
      } else if (sinceSnag < LANE_PULSE_S * 1.5) {
        colour.copy(SNAG).multiplyScalar(0.5 * (1 - sinceSnag / (LANE_PULSE_S * 1.5)));
      } else {
        colour.copy(RIPPLE).multiplyScalar((laneGlow[lane] ?? 0) * 0.32);
      }
      res.glows.setColorAt(lane, colour);
    }
    if (res.glows.instanceColor) res.glows.instanceColor.needsUpdate = true;
  };

  const layoutEffects = (res: Resources) => {
    let flashCount = 0;
    for (let i = 0; i < MAX_FLASHES; i += 1) {
      const lane = flashes.lane[i] ?? -1;
      const age = (clock - (flashes.born[i] ?? -Infinity)) / FLASH_S;
      if (lane < 0 || age >= 1) continue;
      // A Tiles pop covers its whole tile, a long one included.
      const span = flashes.span[i] ?? 0;
      const config = shown?.config;
      const length =
        span > 0 && config
          ? 1 + (span / (config.scrollDurationMs * config.tempo)) * (layout.far / layout.tileDepth)
          : 1;
      dummy.position.set(laneX(lane), 0, effectZ(flashes, i));
      dummy.scale.set(1 + age * 0.35, 1, (1 + age * 0.6) * length);
      dummy.updateMatrix();
      res.flashes.setMatrixAt(flashCount, dummy.matrix);
      res.flashes.setColorAt(
        flashCount,
        colour.copy(flashes.colour[i] ?? FOAM).multiplyScalar((1 - age) ** 2),
      );
      flashCount += 1;
    }
    res.flashes.count = flashCount;

    let rippleCount = 0;
    for (let i = 0; i < MAX_RIPPLES; i += 1) {
      const lane = ripples.lane[i] ?? -1;
      const age = (clock - (ripples.born[i] ?? -Infinity)) / RIPPLE_S;
      if (lane < 0 || age >= 1) continue;
      const ease = 1 - (1 - age) ** 3;
      dummy.position.set(laneX(lane), 0, effectZ(ripples, i));
      dummy.scale.setScalar(0.62 + ease * 0.7);
      dummy.updateMatrix();
      res.ripples.setMatrixAt(rippleCount, dummy.matrix);
      res.ripples.setColorAt(
        rippleCount,
        colour.copy(ripples.colour[i] ?? RIPPLE).multiplyScalar((1 - age) ** 2),
      );
      rippleCount += 1;
    }
    res.ripples.count = rippleCount;

    let dropletCount = 0;
    for (let i = 0; i < MAX_DROPLETS; i += 1) {
      const lane = droplets.lane[i] ?? -1;
      const seconds = clock - (droplets.born[i] ?? -Infinity);
      const age = seconds / DROPLET_S;
      if (lane < 0 || age >= 1) continue;
      const x =
        laneX(lane) + (dropletOrigin[i] ?? 0) + (dropletVelocity[i * 2] ?? 0) * seconds * 0.35;
      const z =
        effectZ(droplets, i) +
        (dropletVelocity[i * 2 + 1] ?? 0) * seconds +
        2.4 * seconds * seconds;
      dummy.position.set(x, 0, z);
      dummy.scale.setScalar(0.16 * (1 - age * 0.6));
      dummy.updateMatrix();
      res.droplets.setMatrixAt(dropletCount, dummy.matrix);
      res.droplets.setColorAt(
        dropletCount,
        colour.copy(droplets.colour[i] ?? FOAM).multiplyScalar(1 - age),
      );
      dropletCount += 1;
    }
    res.droplets.count = dropletCount;
  };

  const markDirty = (res: Resources) => {
    for (const mesh of [
      res.tiles,
      res.bodies,
      res.bridges,
      res.flashes,
      res.ripples,
      res.droplets,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  resources = build();

  const rebuild = () => {
    if (resources) release(resources);
    resources = build();
  };

  return {
    render(stage, deltaSeconds, renderer) {
      shown = stage;
      clock += deltaSeconds;
      still = reducedMotion();
      if (!still) waterClock += deltaSeconds;
      pulse = still ? 0 : Math.max(0, pulse - deltaSeconds * 2.2);
      if (!resources) return;
      const water = resources.water.uniforms;
      if (water.uTime) water.uTime.value = waterClock;
      if (water.uPulse) water.uPulse.value = pulse;
      // Tiles: the hit line becomes a faint exit line, and its glow goes.
      const tiles = stage.config?.mode === 'tiles';
      resources.line.position.z = tiles ? exitZ : 0;
      resources.lineMaterial.color.copy(tiles ? EXIT_LINE : RIPPLE);
      resources.halo.visible = !tiles;
      // Rhythm's tiles come out of the mist; Tiles' can be claimed from the top of the
      // lane, so they show from there (one shader switch when the game changes).
      for (const material of resources.tileMaterials) {
        if (material.fog === tiles) {
          material.fog = !tiles;
          material.needsUpdate = true;
        }
      }
      layoutTiles(resources, stage);
      layoutLanes(resources, stage);
      layoutEffects(resources);
      markDirty(resources);
      renderer.render(scene, camera);
    },

    onJudgment(event) {
      const config = shown?.config;
      if (event.judgment !== 'miss' && config?.mode === 'tiles') {
        laneSnag[event.lane] = -Infinity;
        const tile = config.chart.difficulties[config.difficulty].tiles[event.tileIndex];
        if (!tile) return;
        // The tile pops where it is: a tap or a long tile's head when claimed, the
        // whole long tile when it has filled.
        const whole = event.unit === 'tail';
        spawn(flashes, event.lane, LILY, tile.t, whole ? (tile.dur ?? 0) : 0);
        if (still) return;
        spawn(ripples, event.lane, LILY, whole ? tileEnd(tile) : tile.t);
        burst(event.lane, LILY, whole ? 8 : 5, whole ? tileEnd(tile) : tile.t);
        pulse = Math.min(1, pulse + 0.25);
        return;
      }
      if (event.judgment === 'miss') {
        // The red follows the latest miss. The clock only moves in `render`, so
        // misses from one update (a chord expiring together) share it and all stay lit.
        for (let lane = 0; lane < LANES; lane += 1) {
          if (laneSnag[lane] !== clock) laneSnag[lane] = -Infinity;
        }
        laneSnag[event.lane] = clock;
        return;
      }
      // A hit shows at once, not behind that lane's earlier miss.
      laneSnag[event.lane] = -Infinity;
      // A completed hold tail is a quieter moment than a strike.
      const strike = event.unit !== 'tail';
      const perfect = event.judgment === 'perfect';
      lanePulse[event.lane] = clock;
      if (strike) spawn(flashes, event.lane, perfect ? FOAM : RIPPLE);
      if (still) return;
      spawn(ripples, event.lane, perfect ? BILL : RIPPLE);
      burst(event.lane, perfect ? BILL : RIPPLE, strike ? (perfect ? 10 : 6) : 4);
      pulse = Math.min(1, pulse + (perfect ? 0.35 : 0.2));
    },

    onNotYet(event) {
      shakeTile = event.tileIndex;
      shakeBorn = clock;
    },

    setLaneHeld(next) {
      isLaneHeld = next;
    },

    resize(width, height, insets = NO_INSETS) {
      const next = selectLayout(width, height);
      if (next !== layout) {
        layout = next;
        // The lanes' geometry belongs to the layout: build it again.
        if (resources) rebuild();
      }
      frameLayout(camera, layout, width, height, insets);
      const lineDepth = viewDepth(projected.set(0, 0, 0));
      const endDepth = viewDepth(projected.set(0, 0, -layout.far));
      fog.near = lineDepth + (endDepth - lineDepth) * layout.fogFrom;
      fog.far = endDepth;
      exitZ = exitDepth(camera, layout, height, insets);
    },

    get layout() {
      return layout.kind;
    },

    laneAt(clientX, clientY) {
      const rect = surface.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return undefined;
      return laneAtNdc(
        camera,
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
        layout,
      );
    },

    spotAt(clientX, clientY) {
      const rect = surface.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return undefined;
      return spotAtNdc(
        camera,
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
        layout,
      );
    },

    exitAlong() {
      return exitAlong(layout, exitZ);
    },

    hitLineY() {
      projected.set(0, 0, 0).project(camera);
      return (1 - projected.y) / 2;
    },

    rebuild,
    get builds() {
      return builds;
    },
    dispose() {
      if (resources) release(resources);
      resources = undefined;
    },
  };
}
