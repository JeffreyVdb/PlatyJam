import {
  AdditiveBlending,
  Color,
  DataTexture,
  Fog,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  RGBAFormat,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { fitCamera, type CameraFit } from './camera-fit';

/**
 * Placeholder stage until the real game lands: tiles fall down four lanes and ripple
 * on the hit line, on a loop, with no input. It doubles as the reference for GPU
 * resource ownership: `rebuild()` disposes and recreates every geometry, material and
 * texture, which is what a lost WebGL context requires.
 *
 * Draw calls stay at seven: highway, lane glow, two hit-line layers, tiles, ripples,
 * and nothing else. Tiles, glows and ripples are InstancedMesh.
 */

// Brand palette, kept in sync with src/style.css.
const RIVER_DEEP = new Color('#0d2b3e');
const RIVER = new Color('#164560');
const BILL = new Color('#feb102');
const RIPPLE = new Color('#6fe3cf');
const FOAM = new Color('#f3f7ee');
const BLACK = new Color(0x000000);

const LANES = 4;
const LANE_WIDTH = 1;
const HIGHWAY_WIDTH = LANES * LANE_WIDTH;
/** Lane length behind the hit line (negative z) and in front of it. */
const HIGHWAY_FAR = 14;
const HIGHWAY_NEAR = 1.6;

const BPM = 104;
const BEAT_S = 60 / BPM;
/** Tiles travel this many world units per second. */
const TILE_SPEED = 5.2;
const LEAD_S = HIGHWAY_FAR / TILE_SPEED;
const RIPPLE_S = 0.55;
const GLOW_S = 0.35;

/**
 * Lanes hit on each half-beat; an empty entry is a rest. A short phrase that
 * climbs and falls, with a few chords, so the placeholder reads as music.
 */
// prettier-ignore
const PATTERN: readonly (readonly number[])[] = [
  [0], [], [1], [], [2], [3], [2], [],
  [1], [], [0], [1], [2], [], [1, 3], [],
  [3], [], [2], [], [1], [0], [1], [],
  [2], [], [3], [2], [1], [], [0, 2], [],
];
const STEP_S = BEAT_S / 2;
const MAX_TILES = 48;
const MAX_RIPPLES = 12;

const HIT_LINE = new Vector3(0, 0, 0);
const FAR_END = new Vector3(0, 0, -HIGHWAY_FAR);

const laneX = (lane: number) => (lane - (LANES - 1) / 2) * LANE_WIDTH;

function roundedTileShape(width: number, depth: number, radius: number): Shape {
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

/** Lane surface: lane colour with darker dividers, baked so the highway is one draw. */
function createLaneTexture(): DataTexture {
  const width = LANES * 32;
  const data = new Uint8Array(width * 4);
  const lane = RIVER.clone().convertLinearToSRGB();
  const divider = RIVER_DEEP.clone().convertLinearToSRGB();
  for (let x = 0; x < width; x += 1) {
    const edge = x % 32;
    const colour = edge === 0 || edge === 31 ? divider : lane;
    data.set(
      [Math.round(colour.r * 255), Math.round(colour.g * 255), Math.round(colour.b * 255), 255],
      x * 4,
    );
  }
  const texture = new DataTexture(data, width, 1, RGBAFormat);
  // DataTexture defaults to nearest filtering, which stair-steps the dividers.
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A vertical brightness ramp (along the plane's v axis), white on black. Used as the
 * map of additive glows so they fade out softly instead of ending in a hard edge.
 */
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

interface Resources {
  geometries: BufferGeometry[];
  materials: Material[];
  textures: Texture[];
  tiles: InstancedMesh;
  glows: InstancedMesh;
  ripples: InstancedMesh;
  root: Object3D;
}

export interface PlaceholderScene {
  /** Advances the loop by a (clamped) frame delta and draws it. */
  render(deltaSeconds: number, renderer: WebGLRenderer): void;
  resize(width: number, height: number): void;
  /** Disposes and recreates every GPU resource. Call after a context restore. */
  rebuild(): void;
  /** How many times GPU resources were built (debug). */
  readonly builds: number;
  dispose(): void;
}

export function createPlaceholderScene(): PlaceholderScene {
  const scene = new Scene();
  scene.background = RIVER_DEEP;
  // Tiles emerge from, and the far lanes dissolve into, the river.
  const fog = new Fog(RIVER_DEEP, 1, 2);
  scene.fog = fog;

  const camera = new PerspectiveCamera(38, 1, 0.1, 100);
  const view: CameraFit = {
    target: new Vector3(0, 0, -3.2),
    direction: new Vector3(0, 0.62, 0.78).normalize(),
    keepVisible: [
      new Vector3(-HIGHWAY_WIDTH / 2 - 0.25, 0, 0),
      new Vector3(HIGHWAY_WIDTH / 2 + 0.25, 0, 0),
      new Vector3(-HIGHWAY_WIDTH / 2, 0, HIGHWAY_NEAR),
      new Vector3(HIGHWAY_WIDTH / 2, 0, HIGHWAY_NEAR),
      new Vector3(0, 0, -HIGHWAY_FAR * 0.75),
    ],
    margin: { x: 0.94, y: 0.9 },
  };

  const viewDepth = (point: Vector3) => -point.clone().applyMatrix4(camera.matrixWorldInverse).z;

  let songTime = 0;
  let builds = 0;
  let resources: Resources | undefined;
  const dummy = new Object3D();
  const colour = new Color();

  const build = (): Resources => {
    builds += 1;
    const root = new Object3D();
    const laneTexture = createLaneTexture();
    // Brightest just past the hit line, fading up the lane.
    const glowTexture = createFalloffTexture((v) =>
      v < 0.04 ? (v / 0.04) ** 2 : (1 - (v - 0.04) / 0.96) ** 2,
    );
    // Peaks on the line itself.
    const haloTexture = createFalloffTexture((v) => (1 - Math.abs(2 * v - 1)) ** 2.4);

    const highwayGeometry = new PlaneGeometry(HIGHWAY_WIDTH, HIGHWAY_FAR + HIGHWAY_NEAR);
    highwayGeometry.rotateX(-Math.PI / 2);
    highwayGeometry.translate(0, 0, (HIGHWAY_NEAR - HIGHWAY_FAR) / 2);
    const highwayMaterial = new MeshBasicMaterial({ map: laneTexture });
    root.add(new Mesh(highwayGeometry, highwayMaterial));

    // Per-lane glow, brightened on each hit. Additive: black is invisible.
    const glowGeometry = new PlaneGeometry(LANE_WIDTH * 0.94, 4);
    glowGeometry.rotateX(-Math.PI / 2);
    glowGeometry.translate(0, 0.002, -1.85);
    const glowMaterial = new MeshBasicMaterial({
      map: glowTexture,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    const glows = new InstancedMesh(glowGeometry, glowMaterial, LANES);
    for (let lane = 0; lane < LANES; lane += 1) {
      dummy.position.set(laneX(lane), 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      glows.setMatrixAt(lane, dummy.matrix);
      glows.setColorAt(lane, BLACK);
    }
    root.add(glows);

    const lineGeometry = new PlaneGeometry(HIGHWAY_WIDTH + 0.5, 0.09);
    lineGeometry.rotateX(-Math.PI / 2);
    lineGeometry.translate(0, 0.004, 0);
    const lineMaterial = new MeshBasicMaterial({ color: RIPPLE, fog: false });
    root.add(new Mesh(lineGeometry, lineMaterial));

    const haloGeometry = new PlaneGeometry(HIGHWAY_WIDTH + 0.5, 0.7);
    haloGeometry.rotateX(-Math.PI / 2);
    haloGeometry.translate(0, 0.003, 0);
    const haloMaterial = new MeshBasicMaterial({
      color: RIPPLE.clone().multiplyScalar(0.16),
      map: haloTexture,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    root.add(new Mesh(haloGeometry, haloMaterial));

    const tileGeometry = new ShapeGeometry(roundedTileShape(LANE_WIDTH * 0.78, 0.42, 0.16), 6);
    tileGeometry.rotateX(-Math.PI / 2);
    tileGeometry.translate(0, 0.01, 0);
    const tileMaterial = new MeshBasicMaterial();
    const tiles = new InstancedMesh(tileGeometry, tileMaterial, MAX_TILES);
    tiles.setColorAt(0, BILL);
    tiles.frustumCulled = false;
    root.add(tiles);

    const rippleGeometry = new RingGeometry(0.4, 0.46, 48);
    rippleGeometry.rotateX(-Math.PI / 2);
    rippleGeometry.translate(0, 0.006, 0);
    const rippleMaterial = new MeshBasicMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    const ripples = new InstancedMesh(rippleGeometry, rippleMaterial, MAX_RIPPLES);
    ripples.setColorAt(0, BLACK);
    ripples.frustumCulled = false;
    root.add(ripples);

    scene.add(root);
    return {
      geometries: [
        highwayGeometry,
        glowGeometry,
        lineGeometry,
        haloGeometry,
        tileGeometry,
        rippleGeometry,
      ],
      materials: [
        highwayMaterial,
        glowMaterial,
        lineMaterial,
        haloMaterial,
        tileMaterial,
        rippleMaterial,
      ],
      textures: [laneTexture, glowTexture, haloTexture],
      tiles,
      glows,
      ripples,
      root,
    };
  };

  const release = (old: Resources) => {
    scene.remove(old.root);
    old.tiles.dispose();
    old.glows.dispose();
    old.ripples.dispose();
    for (const geometry of old.geometries) geometry.dispose();
    for (const material of old.materials) material.dispose();
    for (const texture of old.textures) texture.dispose();
  };

  /** Lays out every tile, glow and ripple for the current song time. Stateless. */
  const layout = ({ tiles, glows, ripples }: Resources) => {
    const glow = new Float32Array(LANES);
    let tileCount = 0;
    let rippleCount = 0;

    const firstStep = Math.ceil((songTime - RIPPLE_S) / STEP_S);
    const lastStep = Math.floor((songTime + LEAD_S) / STEP_S);
    for (let step = firstStep; step <= lastStep; step += 1) {
      const lanes = PATTERN[((step % PATTERN.length) + PATTERN.length) % PATTERN.length] ?? [];
      const untilHit = step * STEP_S - songTime;
      for (const lane of lanes) {
        if (untilHit >= 0) {
          if (tileCount >= MAX_TILES) continue;
          dummy.position.set(laneX(lane), 0, -untilHit * TILE_SPEED);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          tiles.setMatrixAt(tileCount, dummy.matrix);
          // Warm up towards foam in the last moments before the line.
          colour.copy(BILL).lerp(FOAM, Math.max(0, 1 - untilHit / 0.25) * 0.55);
          tiles.setColorAt(tileCount, colour);
          tileCount += 1;
          continue;
        }

        const since = -untilHit;
        if (since < GLOW_S) glow[lane] = Math.max(glow[lane] ?? 0, 1 - since / GLOW_S);
        if (since < RIPPLE_S && rippleCount < MAX_RIPPLES) {
          const progress = since / RIPPLE_S;
          const ease = 1 - (1 - progress) ** 3;
          dummy.position.set(laneX(lane), 0, 0);
          dummy.scale.setScalar(0.62 + ease * 0.6);
          dummy.updateMatrix();
          ripples.setMatrixAt(rippleCount, dummy.matrix);
          ripples.setColorAt(rippleCount, colour.copy(RIPPLE).multiplyScalar((1 - progress) ** 2));
          rippleCount += 1;
        }
      }
    }

    for (let lane = 0; lane < LANES; lane += 1) {
      glows.setColorAt(lane, colour.copy(RIPPLE).multiplyScalar((glow[lane] ?? 0) * 0.3));
    }

    tiles.count = tileCount;
    ripples.count = rippleCount;
    tiles.instanceMatrix.needsUpdate = true;
    ripples.instanceMatrix.needsUpdate = true;
    for (const mesh of [tiles, glows, ripples]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  resources = build();

  return {
    render(deltaSeconds, renderer) {
      songTime += deltaSeconds;
      if (!resources) return;
      layout(resources);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      fitCamera(camera, width / height, view);
      // Fog is measured from the camera, which moves with the aspect ratio: keep the
      // lanes clear up to well past the hit line and dissolve them near the far end.
      fog.near = viewDepth(HIT_LINE) + HIGHWAY_FAR * 0.3;
      fog.far = viewDepth(FAR_END);
    },
    rebuild() {
      if (resources) release(resources);
      resources = build();
    },
    get builds() {
      return builds;
    },
    dispose() {
      if (resources) release(resources);
      resources = undefined;
    },
  };
}
