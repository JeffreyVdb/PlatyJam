import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  Fog,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  RingGeometry,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
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
import { HEAD, type Simulation, TAIL } from '../game/simulation';
import {
  exitTime,
  holdDoneTime,
  POP_MS,
  TILES_FAIL_BLINK_MS,
  TILES_FAIL_BLINKS,
  TILES_FAIL_SLIDE_MS,
} from '../game/tiles-simulation';
import { createHighwayMaterial, EDGE_MARGIN } from './highway-material';
import {
  type FlatLayout,
  flatFrame,
  flatLayout,
  flatSpotAt,
  frameFlat,
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
  type StageLayoutKind,
} from './highway-layout';
import {
  firstVisibleTile,
  longestHold,
  type TilesFrame,
  tileDepth,
  tileSizing,
  type TileSizing,
  tileSpans,
} from './lane-layout';

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
 * Tiles (the game is read from the view each frame, so a game picked in the menus
 * shows without a resize) draws its own flat view instead, as in Magic Tiles: the four
 * lanes are the whole screen seen from straight above (`FlatLayout`, an orthographic
 * camera), on a gradient backdrop with thin dividers, a faint line and a few sparkles,
 * all in one full-screen shader. Its tiles are big ink blocks from their time up to
 * the next tile's (`tileSpan`, the same extent the hit test and exit use), and its
 * accent, the water lily, marks what happens: the next tile's tint, the pop of a
 * claimed tile that then rides off translucent, a long tile filling with a rounded top.
 * None of Rhythm's water, highway, fog, lane glow or hit line is drawn, and a miss
 * shows on the tile, never on the lane. Its draw calls stay at six: the backdrop,
 * blocks, the fills' rounded tops, claimed tiles, ripples (with the rings under held
 * long tiles) and droplets. Each game's meshes are hidden while the other plays, so
 * Rhythm still draws its eleven.
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
const INK_NEXT = new Color('#211a2b');
/** A long tile claimed, the part its fill has not reached yet. */
const INK_CLAIMED = INK;
/** A long tile's centre line and dot, while it waits. */
const INK_MARK = INK.clone().lerp(FOAM, 0.28);
/** A claimed tile riding off: added to what is under it, so it reads as translucent white. */
const GHOST = new Color(0.05, 0.05, 0.05);
/** The flat backdrop: river at the top, lighter water below, a lily glow at the bottom. */
const BACKDROP_TOP = RIVER.clone().lerp(RIVER_RAISED, 0.5);
const BACKDROP_BOTTOM = new Color('#2f7d8c');

const MAX_TILES = 160;
const MAX_HOLD_SEGMENTS = 32;
const MAX_BRIDGES = 24;
const MAX_FLASHES = 16;
/** Tiles: rings under held long tiles (one per lane at most). */
const MAX_RINGS = LANES;
/** Tiles' flat view: blocks (tiles, long tiles in up to three parts), caps, claimed tiles. */
const MAX_BLOCKS = MAX_TILES + 64;
const MAX_CAPS = 32;
const MAX_GHOSTS = MAX_TILES;
const MAX_RIPPLES = 16;
const MAX_DROPLETS = 160;

/**
 * Feedback lifetimes, real seconds (never song time, so they do not scale with tempo).
 * Tiles' pops last as long but are timed in song time from when the tile cleared
 * (`popAge`), as the simulation times a press on it (`POP_MS`).
 */
const FLASH_S = POP_MS / 1000;
const RIPPLE_S = 0.5;
const DROPLET_S = 0.45;
const LANE_PULSE_S = 0.3;
/** Tiles: the "not yet" shake of a later tile. */
const SHAKE_S = 0.28;
/** Tiles: how far the shake reaches across the lane, lane widths. */
const SHAKE_X = 0.06;
/** Tiles: a gap left between tiles side by side, CSS px, so the divider shows. */
const FLAT_GUTTER_PX = 1;
/** Tiles: a long tile's centre line, CSS px wide, and its dot, lane widths across. */
const FLAT_MARK_PX = 2;
const FLAT_DOT = 0.16;
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

/**
 * Tiles' backdrop: one full-screen pass, drawn behind everything in clip space. A
 * vertical gradient in the river palette with a lily glow from below, a few faint
 * sparkles drifting up, the faint line where a tile's time is, and the three lane
 * dividers, 1 CSS px of white at about a fifth (antialiased with `fwidth`, so it needs
 * no pixel ratio).
 */
const BACKDROP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;
const BACKDROP_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uSize;
uniform float uLine;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
varying vec2 vUv;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  // CSS px from the top left.
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  float down = 1.0 - vUv.y;
  vec3 colour = mix(uTop, uBottom, smoothstep(0.0, 1.0, down));
  vec2 glow = (px - vec2(0.5 * uSize.x, 1.08 * uSize.y)) / max(uSize.x, uSize.y);
  colour += uGlow * 0.07 * exp(-dot(glow, glow) * 5.0);
  float fromLine = abs(px.y - uLine * uSize.y);
  colour += vec3(0.07 * exp(-fromLine * fromLine / 450.0) + 0.16 * exp(-fromLine * fromLine / 2.0));
  vec2 cell = vec2(px.x, px.y + uTime * 12.0) / 64.0;
  vec2 id = floor(cell);
  float seed = hash(id);
  if (seed > 0.9) {
    vec2 at = vec2(hash(id + 1.3), hash(id + 2.7)) * 0.7 + 0.15;
    float dist = length(fract(cell) - at) * 64.0;
    float twinkle = 0.5 + 0.5 * sin(uTime * (0.8 + seed * 2.0) + seed * 40.0);
    colour += vec3(0.32 * twinkle * smoothstep(2.4, 0.2, dist));
  }
  float lane = uSize.x / 4.0;
  float nearest = floor(px.x / lane + 0.5);
  float dist = abs(px.x - nearest * lane);
  float cover = clamp((0.5 - dist) / max(fwidth(px.x), 1e-4) + 0.5, 0.0, 1.0);
  if (nearest < 0.5 || nearest > 3.5) cover = 0.0;
  colour = mix(colour, vec3(1.0), cover * 0.22);
  gl_FragColor = vec4(colour, 1.0);
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
  /** Drawn by Rhythm only: hidden while Tiles shows its flat view. */
  rhythmOnly: Object3D[];
  /** Tiles' flat view: the backdrop, its blocks, the fills' rounded tops, claimed tiles. */
  backdrop: Mesh;
  backdropMaterial: ShaderMaterial;
  blocks: InstancedMesh;
  caps: InstancedMesh;
  ghosts: InstancedMesh;
  flatOnly: Object3D[];
  root: Object3D;
}

/**
 * A pooled one-shot effect: lane, birth time and colour per slot, and where along the
 * lane: at the hit line (`at` NaN), or riding with a tile at chart ms `at` that is
 * `span` ms tall (Tiles: at its middle).
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
   * Fits the cameras to a viewport in CSS px: Rhythm's, switching its layout if the
   * shape calls for another (`layout`), and Tiles' flat view. `insets` are the
   * safe-area insets, which the tabletop layout keeps its lanes and top band inside
   * (the flat view runs under them).
   */
  resize(width: number, height: number, insets?: Readonly<Insets>): void;
  /**
   * Rhythm's layout for this viewport: portrait is handheld, landscape tabletop.
   * Changes in `resize`. Tiles always draws its flat view (`drawing`).
   */
  readonly layout: LayoutKind;
  /** What the last frame drew: Rhythm's layout, or Tiles' flat view. */
  readonly drawing: StageLayoutKind;
  /** Tiles: a tile that is not next yet was pressed; it shakes. */
  onNotYet(event: Readonly<NotYetEvent>): void;
  /** The lane under a client point, or undefined off the lanes. */
  laneAt(clientX: number, clientY: number): number | undefined;
  /** Tiles' hit test: the lane and the place along it under a client point. */
  spotAt(clientX: number, clientY: number): LaneSpot | undefined;
  /**
   * Tiles: the flat view's screen, for the simulation (`GameplaySession.setTilesFrame`):
   * where tiles are lost and how tall they are. Changes in `resize`.
   */
  tilesFrame(): TilesFrame;
  /** Rhythm's hit line height on screen, 0 (top) to 1 (bottom). */
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
  // Tiles' flat view, framed in every resize whatever is drawn, so switching games
  // in the menus needs no resize.
  const flatCamera = new OrthographicCamera();
  let flat: FlatLayout = flatLayout(390, 844);
  frameFlat(flatCamera, flat);
  /** Whether the last frame drew the flat view (Tiles). */
  let drawsFlat = false;

  // Reused every frame and every touch.
  const dummy = new Object3D();
  const colour = new Color();
  const tint = new Color();
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
  /**
   * Tiles: each tile's span and the tallest (`tileSpan`), cached per tile list, scroll
   * window and sizing: the extent the simulation presses and loses tiles by.
   */
  const sized: {
    tiles: readonly Tile[] | undefined;
    windowMs: number;
    sizing: TileSizing;
    spans: Float64Array;
    tallest: number;
  } = {
    tiles: undefined,
    windowMs: 0,
    sizing: { base: 0, floor: 0, seam: 0 },
    spans: new Float64Array(0),
    tallest: 0,
  };
  /** The view drawn last: feedback spawned between frames reads its song and game. */
  let shown: StageView | undefined;
  /** Tiles: the tile shaking "not yet", and since when. */
  let shakeTile = -1;
  let shakeBorn = -Infinity;
  /** Tiles: rings under the long tiles held this frame (filled by `layoutFlat`). */
  const rings = {
    lane: new Int8Array(MAX_RINGS),
    z: new Float64Array(MAX_RINGS),
    count: 0,
  };
  /** Tiles: long tiles whose completion has rippled, in the run of `runIn`. */
  const celebrated = new Set<number>();
  /** Tiles: the song ms each tile was claimed at, in the run of `runIn` (its pop). */
  let claimedAt = new Float64Array(0);
  /** Tiles: the clock when the run's Classic failure was first shown (its blink). */
  let failingSince = Number.NaN;
  /** The run Tiles' effects belong to: each run (restart, retry, new song) has its own. */
  let runIn: Simulation | undefined;

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
    const rippleMesh = dynamicMesh(rippleGeometry, rippleMaterial, MAX_RIPPLES + MAX_RINGS, root);
    rippleMesh.name = 'ripples';

    const dropletGeometry = new PlaneGeometry(1, 1);
    dropletGeometry.rotateX(-Math.PI / 2);
    dropletGeometry.translate(0, 0.02, 0);
    const dropletMaterial = new MeshBasicMaterial({ map: dotTexture, ...additive });
    const dropletMesh = dynamicMesh(dropletGeometry, dropletMaterial, MAX_DROPLETS, root);

    // Tiles' flat view. Its parts never fog: the flat camera sees nothing far away.
    const backdropGeometry = new PlaneGeometry(2, 2);
    const backdropMaterial = new ShaderMaterial({
      vertexShader: BACKDROP_VERTEX,
      fragmentShader: BACKDROP_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: new Vector2(1, 1) },
        uLine: { value: 0.74 },
        uTop: { value: BACKDROP_TOP.clone() },
        uBottom: { value: BACKDROP_BOTTOM.clone() },
        uGlow: { value: LILY.clone() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const backdrop = new Mesh(backdropGeometry, backdropMaterial);
    backdrop.name = 'flat-backdrop';
    backdrop.frustumCulled = false;
    backdrop.renderOrder = -2;
    root.add(backdrop);

    // Unit squares on the lanes, scaled per block: tiles, long tiles and their parts.
    const blockGeometry = new PlaneGeometry(1, 1);
    blockGeometry.rotateX(-Math.PI / 2);
    const blockMaterial = new MeshBasicMaterial({ fog: false });
    const blocks = dynamicMesh(blockGeometry, blockMaterial, MAX_BLOCKS, root);
    blocks.name = 'flat-tiles';
    // A disc: the rounded top of a long tile's fill, and the dot of one waiting.
    const capGeometry = new CircleGeometry(0.5, 40);
    capGeometry.rotateX(-Math.PI / 2);
    const capMaterial = new MeshBasicMaterial({ fog: false });
    const caps = dynamicMesh(capGeometry, capMaterial, MAX_CAPS, root);
    caps.name = 'flat-caps';
    // Claimed tiles riding off, and their pop: added light, so they read as translucent.
    const ghostMaterial = new MeshBasicMaterial({ ...additive });
    const ghosts = dynamicMesh(blockGeometry, ghostMaterial, MAX_GHOSTS, root);
    ghosts.name = 'flat-claimed';

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
        backdropGeometry,
        blockGeometry,
        capGeometry,
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
        backdropMaterial,
        blockMaterial,
        capMaterial,
        ghostMaterial,
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
      rhythmOnly: [waterMesh, highwayMesh, glows, line, halo, tiles, bodies, bridges, flashMesh],
      backdrop,
      backdropMaterial,
      blocks,
      caps,
      ghosts,
      flatOnly: [backdrop, blocks, caps, ghosts],
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
      old.blocks,
      old.caps,
      old.ghosts,
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

  /**
   * Tiles: drops another run's effects once a new run is shown. Its ripples and
   * droplets are placed in its song time, which starts over: they would come back on
   * lanes the new run left empty. Rhythm's feedback is timed in real time at the hit
   * line (`at` NaN) and plays out.
   */
  const keepToRun = () => {
    const run = shown?.simulation;
    if (run === runIn) return;
    runIn = run;
    celebrated.clear();
    claimedAt = new Float64Array(run?.heads.length ?? 0).fill(Number.NaN);
    failingSince = Number.NaN;
    shakeTile = -1;
    for (const pool of [flashes, ripples, droplets]) {
      for (let i = 0; i < pool.lane.length; i += 1) {
        if (!Number.isNaN(pool.at[i] ?? Number.NaN)) pool.lane[i] = -1;
      }
    }
  };

  /**
   * Tiles: how far through its pop (0 to 1) a tile that cleared at song ms `from` is,
   * in song time as the simulation lets a press on it go (`POP_MS` × tempo); NaN when
   * it is not popping. Only while the run goes on: a frozen failure plays no pops.
   */
  const popAge = (from: number) => {
    const config = shown?.config;
    if (!shown || !config || shown.state === 'failing' || shown.state === 'finished') {
      return Number.NaN;
    }
    const age = (shown.songMs - from) / (POP_MS * config.tempo);
    return age >= 0 && age < 1 ? age : Number.NaN;
  };

  /** Tiles' spans for the tiles in view (cached; see `sized`). */
  const spansFor = (config: NonNullable<StageView['config']>) => {
    const all = config.chart.difficulties[config.difficulty].tiles;
    const windowMs = config.scrollDurationMs * config.tempo;
    const sizing = tileSizing(config.tileSize, flatFrame(flat));
    const same = sized.sizing;
    if (
      sized.tiles !== all ||
      sized.windowMs !== windowMs ||
      same.base !== sizing.base ||
      same.floor !== sizing.floor ||
      same.seam !== sizing.seam
    ) {
      sized.tiles = all;
      sized.windowMs = windowMs;
      sized.sizing = sizing;
      sized.spans = tileSpans(all, windowMs, sizing);
      sized.tallest = sized.spans.reduce((a, b) => Math.max(a, b), 0);
    }
    return sized;
  };

  /** Tiles: a long tile that has filled ripples once, at its top. */
  const celebrate = (index: number, tile: Tile, top: number) => {
    if (celebrated.has(index)) return;
    celebrated.add(index);
    if (still) return;
    spawn(ripples, tile.lane, LILY, top);
    burst(tile.lane, LILY, 8, top);
    pulse = Math.min(1, pulse + 0.25);
  };

  /** World z of an effect slot this frame: on the line, or with its tile (Tiles). */
  const effectZ = (pool: Pool, slot: number) => {
    const at = pool.at[slot] ?? Number.NaN;
    const config = shown?.config;
    if (Number.isNaN(at) || !config || !shown) return 0;
    const windowMs = config.scrollDurationMs * config.tempo;
    return tileDepth(at + (pool.span[slot] ?? 0) / 2, shown.songMs, windowMs, flat.far);
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

    for (let i = firstVisibleTile(all, songMs - behindMs, longest); i < all.length; i += 1) {
      const tile = all[i];
      if (!tile || tile.t > songMs + aheadMs) break;
      const head = simulation?.heads[i] ?? HEAD.pending;
      const tail = simulation?.tails[i] ?? TAIL.none;
      // Past its late boundary: the Miss is only waiting for in-flight input.
      const lapsed = head === HEAD.pending && songMs > headDeadline(tile.t, config.tempo);
      const z = tileDepth(tile.t, songMs, windowMs, far);

      if (tile.dur !== undefined && bodyCount + 2 <= MAX_HOLD_SEGMENTS) {
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
      } else {
        const realUntil = (tile.t - songMs) / config.tempo;
        colour.copy(BILL).lerp(FOAM, Math.max(0, 1 - realUntil / WARM_MS) * 0.55);
      }
      dummy.position.set(laneX(tile.lane), 0, z);
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
        res.bridges.setColorAt(bridgeCount, colour.copy(FOAM).lerp(BILL, 0.3));
        bridgeCount += 1;
      }
    }

    res.tiles.count = tileCount;
    res.bodies.count = bodyCount;
    res.bridges.count = bridgeCount;
  };

  /**
   * Tiles: whether a Classic failure's offender shows red now. It holds steady while
   * the board slides back, blinks `TILES_FAIL_BLINKS` times, then stays red (steady
   * throughout under reduced motion).
   */
  const failRed = () => {
    if (still || Number.isNaN(failingSince)) return true;
    const ms = (clock - failingSince) * 1000 - TILES_FAIL_SLIDE_MS;
    if (ms < 0 || ms >= TILES_FAIL_BLINKS * TILES_FAIL_BLINK_MS) return true;
    return ms % TILES_FAIL_BLINK_MS < TILES_FAIL_BLINK_MS / 2;
  };

  /**
   * Tiles' flat view. Each tile is a block from its bottom edge (its time) to its top
   * (`tileSpan` later), full lane width but for a gutter at the dividers: ink while
   * it waits (tinted when it is next), a lily pop when claimed that then rides off
   * translucent, red when it fell off. A long tile held fills with lily from the
   * bottom, with a rounded top and a ring under it; once full it pops like a tap.
   * Draw calls: the blocks, the fills' caps (and a waiting long tile's dot), and the
   * claimed tiles; the shared ripples and droplets come in `layoutEffects`.
   */
  const layoutFlat = (res: Resources, stage: StageView) => {
    const { config, simulation } = stage;
    let blockCount = 0;
    let capCount = 0;
    let ghostCount = 0;
    rings.count = 0;
    if (!config) {
      res.blocks.count = 0;
      res.caps.count = 0;
      res.ghosts.count = 0;
      return;
    }
    const { far, near, unit } = flat;
    const all = config.chart.difficulties[config.difficulty].tiles;
    const { spans, tallest, sizing } = spansFor(config);
    const { scrollDurationMs, tempo } = config;
    const songMs = stage.songMs;
    const windowMs = scrollDurationMs * tempo;
    const exit = near / far;
    const behindMs = exit * windowMs;
    const aheadMs = windowMs * 1.02;
    const failing = stage.state === 'failing' || stage.state === 'finished';
    const failure = failing ? simulation?.failure : undefined;
    if (failure && Number.isNaN(failingSince)) failingSince = clock;
    const offender = failure?.kind === 'missedTile' ? failure.tileIndex : -1;
    const red = failRed();
    const width = LANE_WIDTH - FLAT_GUTTER_PX * unit;
    const z = (ms: number) => tileDepth(ms, songMs, windowMs, far);

    /** A block in a lane from z = bottom up to z = top, `lift` above the lanes. */
    const block = (lane: number, bottom: number, top: number, across = width, x = 0, lift = 0) => {
      if (blockCount >= MAX_BLOCKS) return;
      dummy.position.set(laneX(lane) + x, lift, (bottom + top) / 2);
      dummy.scale.set(across, 1, Math.max(0.0001, bottom - top));
      dummy.updateMatrix();
      res.blocks.setMatrixAt(blockCount, dummy.matrix);
      res.blocks.setColorAt(blockCount, colour);
      blockCount += 1;
    };
    /** A disc in a lane centred at z, `across` wide and `along` tall. */
    const cap = (lane: number, at: number, across: number, along: number) => {
      if (capCount >= MAX_CAPS) return;
      dummy.position.set(laneX(lane), 0.002, at);
      dummy.scale.set(across, 1, Math.max(0.0001, along));
      dummy.updateMatrix();
      res.caps.setMatrixAt(capCount, dummy.matrix);
      res.caps.setColorAt(capCount, colour);
      capCount += 1;
    };
    /** A claimed tile riding off, `age` (0 to 1, NaN when done) through its pop. */
    const ghost = (lane: number, bottom: number, top: number, age: number) => {
      if (ghostCount >= MAX_GHOSTS) return;
      const pop = Number.isNaN(age) ? 0 : (1 - age) ** 2;
      dummy.position.set(laneX(lane), 0.004, (bottom + top) / 2);
      dummy.scale.set(width * (1 + 0.06 * pop), 1, Math.max(0.0001, bottom - top));
      dummy.updateMatrix();
      res.ghosts.setMatrixAt(ghostCount, dummy.matrix);
      colour.copy(GHOST).multiplyScalar(1 - pop);
      res.ghosts.setColorAt(ghostCount, colour.add(tint.copy(LILY).multiplyScalar(0.9 * pop)));
      ghostCount += 1;
    };
    const missedColour = (index: number) =>
      colour.copy(SNAG).lerp(INK, index === offender && !red ? 0.75 : 0);

    /** Tiles: the time of the tile(s) to claim next, once found (they come first). */
    let nextT = Number.NaN;
    for (let i = firstVisibleTile(all, songMs - behindMs, tallest); i < all.length; i += 1) {
      const tile = all[i];
      if (!tile || tile.t > songMs + aheadMs) break;
      const span = spans[i] ?? 0;
      const top = z(tile.t + span);
      const bottom = z(tile.t);
      const head = simulation?.heads[i] ?? HEAD.pending;
      const tail = simulation?.tails[i] ?? TAIL.none;
      // Its top has left the screen: the Miss is only waiting for in-flight input.
      const lapsed =
        head === HEAD.pending && songMs > exitTime(tile.t + span, exit, scrollDurationMs, tempo);
      if (head === HEAD.pending && !lapsed && Number.isNaN(nextT)) nextT = tile.t;
      // Below the bottom edge, unless it is the failure the board shows.
      if (top > near && i !== offender) continue;
      const isNext = tile.t === nextT && head === HEAD.pending && !lapsed;

      if (head === HEAD.missed || lapsed) {
        missedColour(i);
        block(tile.lane, bottom, top);
        continue;
      }
      if (head === HEAD.pending) {
        // Pressed too soon, it shakes its head ("not yet"); held still, it flushes lily.
        const shake = i === shakeTile ? Math.max(0, 1 - (clock - shakeBorn) / SHAKE_S) : 0;
        const sway = shake > 0 && !still ? Math.sin(shake * Math.PI * 6) * SHAKE_X * shake : 0;
        colour.copy(isNext ? INK_NEXT : INK);
        if (shake > 0 && still) colour.lerp(LILY, 0.45 * shake);
        block(tile.lane, bottom, top, width, sway);
        if (tile.dur !== undefined) {
          // A long tile waiting: a thin line up its middle, and a dot near its foot.
          const dot = FLAT_DOT;
          colour.copy(INK_MARK);
          block(tile.lane, bottom - dot * 1.5, top + dot, FLAT_MARK_PX * unit, sway, 0.001);
          cap(tile.lane, bottom - dot, dot, dot);
        }
        continue;
      }
      if (tile.dur === undefined) {
        ghost(tile.lane, bottom, top, popAge(claimedAt[i] ?? Number.NaN));
        continue;
      }

      // A long tile claimed: filling, full, or let go too soon.
      const start = simulation?.noteStartMs[i] ?? Number.NaN;
      const doneAt =
        tail === TAIL.clear
          ? (simulation?.holdEndMs[i] ?? Number.NaN)
          : tail === TAIL.holding
            ? holdDoneTime(
                tile,
                span,
                Number.isNaN(start) ? tile.t : start,
                exit,
                scrollDurationMs,
                tempo,
              )
            : Number.NaN;
      if (songMs >= doneAt) {
        // Full (or its top off the screen): it pops whole from then, and rides off.
        ghost(tile.lane, bottom, top, popAge(doneAt));
        celebrate(i, tile, tile.t + span);
        continue;
      }
      // The fill rises from the bottom over the note, reaching the top when full.
      const length = (Number.isNaN(doneAt) ? tileEnd(tile) : doneAt) - start;
      const filled =
        Number.isNaN(start) || length <= 0
          ? 0
          : Math.min(1, Math.max(0, (songMs - start) / length));
      const stopped = simulation?.holdEndMs[i] ?? Number.NaN;
      const reached =
        tail === TAIL.missed && !Number.isNaN(stopped) && !Number.isNaN(start)
          ? Math.min(1, Math.max(0, (stopped - start) / (tile.dur || 1)))
          : filled;
      const level = bottom + (top - bottom) * reached;
      if (tail === TAIL.missed) {
        // Let go: what had filled rides off claimed, the rest is red.
        if (reached > 0) ghost(tile.lane, bottom, level, Number.NaN);
        missedColour(i);
        block(tile.lane, level, top);
        continue;
      }
      // Holding (or held through a pause): ink above the fill, then the fill and its
      // rounded top, a half disc as wide as the lane.
      colour.copy(INK_CLAIMED);
      block(tile.lane, level, top);
      const radius = Math.min(width / 2, (bottom - level) / 2);
      if (bottom - level > 0.0001) {
        colour.copy(LILY);
        block(tile.lane, bottom, level + radius, width, 0, 0.001);
        cap(tile.lane, level + radius, width, radius * 2);
      }
      if (tail === TAIL.holding && rings.count < MAX_RINGS) {
        rings.lane[rings.count] = tile.lane;
        rings.z[rings.count] = Math.min(level + radius, near);
        rings.count += 1;
      }
    }

    // An empty tap that ended the run: a red block where the finger landed.
    if (failure?.kind === 'emptyTap' && failure.at !== undefined) {
      const half = (sizing.floor * windowMs) / 2;
      colour.copy(SNAG).lerp(INK, red ? 0 : 0.75);
      block(failure.lane, z(failure.at - half), z(failure.at + half));
    }

    res.blocks.count = blockCount;
    res.caps.count = capCount;
    res.ghosts.count = ghostCount;
  };

  const layoutLanes = (res: Resources, stage: StageView) => {
    const failure =
      stage.state === 'failing' || stage.state === 'finished'
        ? stage.simulation?.failure
        : undefined;
    const snagLane = failure?.kind === 'emptyTap' ? failure.lane : -1;
    for (let lane = 0; lane < LANES; lane += 1) {
      const sincePulse = clock - (lanePulse[lane] ?? -Infinity);
      const sinceSnag = clock - (laneSnag[lane] ?? -Infinity);
      const pulseLevel = Math.max(0, 1 - sincePulse / LANE_PULSE_S);
      const held = isLaneHeld(lane) ? 0.55 : 0;
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

  /** One flash, `age` (0 to 1) through, at world z `z`. */
  const placeFlash = (
    res: Resources,
    slot: number,
    lane: number,
    z: number,
    age: number,
    tint: Color,
  ) => {
    dummy.position.set(laneX(lane), 0, z);
    dummy.scale.set(1 + age * 0.35, 1, 1 + age * 0.6);
    dummy.updateMatrix();
    res.flashes.setMatrixAt(slot, dummy.matrix);
    res.flashes.setColorAt(slot, colour.copy(tint).multiplyScalar((1 - age) ** 2));
  };

  const layoutEffects = (res: Resources) => {
    let flashCount = 0;
    for (let i = 0; i < MAX_FLASHES; i += 1) {
      const lane = flashes.lane[i] ?? -1;
      const age = (clock - (flashes.born[i] ?? -Infinity)) / FLASH_S;
      if (lane < 0 || !(age < 1)) continue;
      placeFlash(res, flashCount, lane, effectZ(flashes, i), age, flashes.colour[i] ?? FOAM);
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
    // Tiles: a soft ring under each long tile held, breathing with the clock.
    for (let i = 0; i < rings.count; i += 1) {
      const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(clock * 7);
      dummy.position.set(laneX(rings.lane[i] ?? 0), 0.003, rings.z[i] ?? 0);
      dummy.scale.setScalar(0.72 + 0.06 * breath);
      dummy.updateMatrix();
      res.ripples.setMatrixAt(rippleCount, dummy.matrix);
      res.ripples.setColorAt(rippleCount, colour.copy(FOAM).multiplyScalar(0.35 + 0.2 * breath));
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
      res.blocks,
      res.caps,
      res.ghosts,
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

  /** A client point in the surface, as CSS px of the flat view, or undefined. */
  const flatPoint = (clientX: number, clientY: number) => {
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    return flatSpotAt(
      ((clientX - rect.left) / rect.width) * flat.width,
      ((clientY - rect.top) / rect.height) * flat.height,
      flat,
    );
  };

  return {
    render(stage, deltaSeconds, renderer) {
      shown = stage;
      keepToRun();
      clock += deltaSeconds;
      still = reducedMotion();
      if (!still) waterClock += deltaSeconds;
      pulse = still ? 0 : Math.max(0, pulse - deltaSeconds * 2.2);
      if (!resources) return;
      // The game decides the view, every frame: a game picked in the menus shows at once.
      drawsFlat = stage.config?.mode === 'tiles';
      for (const object of resources.rhythmOnly) object.visible = !drawsFlat;
      for (const object of resources.flatOnly) object.visible = drawsFlat;
      let view: Camera = camera;
      if (drawsFlat) {
        const backdrop = resources.backdropMaterial.uniforms;
        if (backdrop.uTime) backdrop.uTime.value = waterClock;
        if (backdrop.uLine) backdrop.uLine.value = flat.line;
        (backdrop.uSize?.value as Vector2 | undefined)?.set(flat.width, flat.height);
        layoutFlat(resources, stage);
        view = flatCamera;
      } else {
        const water = resources.water.uniforms;
        if (water.uTime) water.uTime.value = waterClock;
        if (water.uPulse) water.uPulse.value = pulse;
        layoutTiles(resources, stage);
        layoutLanes(resources, stage);
      }
      layoutEffects(resources);
      markDirty(resources);
      renderer.render(scene, view);
    },

    onJudgment(event) {
      keepToRun();
      const config = shown?.config;
      if (config?.mode === 'tiles') {
        // Tiles shows a miss on the tile itself (`layoutFlat`), not on the lane.
        if (event.judgment === 'miss') return;
        const tile = config.chart.difficulties[config.difficulty].tiles[event.tileIndex];
        // A long tile pops whole from when it filled (`layoutFlat`), before this comes.
        if (!tile || event.unit === 'tail') return;
        // A tap, or a long tile's head, pops where it is when claimed, timed from the
        // claim in song time.
        if (event.tileIndex < claimedAt.length) claimedAt[event.tileIndex] = event.songMs;
        if (still) return;
        const span = spansFor(config).spans[event.tileIndex] ?? 0;
        spawn(ripples, event.lane, LILY, tile.t, span);
        burst(event.lane, LILY, 5, tile.t + span / 2);
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
      keepToRun();
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
      flat = flatLayout(width, height);
      frameFlat(flatCamera, flat);
    },

    get layout() {
      return layout.kind;
    },

    get drawing() {
      return drawsFlat ? 'flat' : layout.kind;
    },

    laneAt(clientX, clientY) {
      if (drawsFlat) return flatPoint(clientX, clientY)?.lane;
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
      return flatPoint(clientX, clientY);
    },

    tilesFrame() {
      return flatFrame(flat);
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
