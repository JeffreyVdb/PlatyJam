import {
  type OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
import { LANES } from '../chart/schema';
import type { LaneSpot } from '../game/input';
import { fitCamera, type CameraFit } from './camera-fit';
import {
  FLAT_LINE_LANDSCAPE,
  FLAT_LINE_PORTRAIT,
  laneForPoint,
  type HighwayBounds,
  type TilesFrame,
} from './lane-layout';

/**
 * How Rhythm's four lanes are laid out for the way the iPad is held. (Tiles draws
 * its own flat view in both orientations: `FlatLayout` below.)
 *
 * - `handheld` (portrait): the iPad is held and played with both thumbs. A long
 *   highway in perspective, as narrow as the screen is, lanes and notes as big as
 *   the width allows.
 * - `tabletop` (landscape): the iPad lies on a table and is played like a piano.
 *   The lanes span the full width as four very large keys, seen from nearly above
 *   and running off the bottom of the screen, so the whole lower half is key. A band
 *   at the top is kept clear for the HUD.
 *
 * A layout is geometry (how long and how near the lanes run, how big a note is),
 * the camera that frames it, and the touch area. Lead time does not depend on the
 * geometry: `tileDepth` maps the scroll window onto `far`, so a note takes the same
 * real time to arrive in both.
 */
export type LayoutKind = 'handheld' | 'tabletop';

/** World units across one lane; also the unit the highway is measured in. */
export const LANE_WIDTH = 1;
export const HIGHWAY_WIDTH = LANES * LANE_WIDTH;

/** Landscape layout from this width-to-height ratio up (a Split View sliver stays handheld). */
export const TABLETOP_MIN_ASPECT = 1.15;
/** Space kept clear at the screen edge, CSS px; added to the safe-area inset. */
export const EDGE_PX = 16;
/** Height of the HUD's band along the top of the tabletop layout, below the inset. */
export const HUD_BAND_PX = 76;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Readonly<Insets> = { top: 0, right: 0, bottom: 0, left: 0 };

export interface HighwayLayout {
  kind: LayoutKind;
  /** Lane length behind the hit line (negative z). A scroll window spans exactly this. */
  far: number;
  /** Lane length in front of the hit line. */
  near: number;
  tileWidth: number;
  tileDepth: number;
  /** Hit line thickness, its glow's depth, and how far each reaches past the lanes. */
  hitLine: { thickness: number; halo: number; overhang: number };
  /** How far up the lane a hit's glow reaches. */
  glowLength: number;
  /** Where the fog starts, as a fraction of the view depth from the hit line to the far end. */
  fogFrom: number;
  fov: number;
  /** The point the camera looks at, and the direction from it to the camera. */
  target: Vector3;
  direction: Vector3;
  /** Where a touch counts, beyond the drawn lanes: `halfWidth` and `slack` are lane units. */
  touch: HighwayBounds;
}

export const HANDHELD: HighwayLayout = {
  kind: 'handheld',
  far: 14,
  near: 1.6,
  tileWidth: LANE_WIDTH * 0.78,
  tileDepth: 0.42,
  hitLine: { thickness: 0.09, halo: 0.7, overhang: 0.25 },
  glowLength: 4,
  fogFrom: 0.385,
  fov: 38,
  target: new Vector3(0, 0, -3.2),
  direction: new Vector3(0, 0.62, 0.78).normalize(),
  touch: { halfWidth: HIGHWAY_WIDTH / 2, slack: 0.15, far: 14, near: 1.6 + 1.2 },
};

/** Elevation of the tabletop camera above the table, degrees. */
const TABLETOP_ELEVATION = (70 * Math.PI) / 180;

export const TABLETOP: HighwayLayout = {
  kind: 'tabletop',
  far: 2.1,
  // Well below the bottom of any screen the layout is chosen for.
  near: 2.4,
  tileWidth: LANE_WIDTH * 0.84,
  tileDepth: 0.24,
  hitLine: { thickness: 0.045, halo: 0.45, overhang: 0.05 },
  glowLength: 1.7,
  fogFrom: 0.45,
  fov: 28,
  target: new Vector3(0, 0, -0.7),
  direction: new Vector3(0, Math.sin(TABLETOP_ELEVATION), Math.cos(TABLETOP_ELEVATION)),
  touch: { halfWidth: HIGHWAY_WIDTH / 2, slack: 0.1, far: 2.1, near: 2.4 },
};

/** Whether a viewport is landscape: by its shape, never by orientation events. */
export function isLandscape(width: number, height: number): boolean {
  return width / Math.max(1, height) >= TABLETOP_MIN_ASPECT;
}

/** The layout for a measured viewport. Decided by its shape, never by orientation events. */
export function selectLayout(width: number, height: number): HighwayLayout {
  return isLandscape(width, height) ? TABLETOP : HANDHELD;
}

/** How far below the hit line the tabletop camera keeps the lanes' outer edges on screen. */
const TABLETOP_ANCHOR_Z = 0.8;

/** What the camera must keep on screen in a viewport of this size. */
export function layoutFit(
  layout: HighwayLayout,
  width: number,
  height: number,
  insets: Readonly<Insets> = NO_INSETS,
): CameraFit {
  const { target, direction } = layout;
  if (layout.kind === 'handheld') {
    const half = HIGHWAY_WIDTH / 2;
    return {
      target,
      direction,
      keepVisible: [
        new Vector3(-half - layout.hitLine.overhang, 0, 0),
        new Vector3(half + layout.hitLine.overhang, 0, 0),
        new Vector3(-half, 0, layout.near),
        new Vector3(half, 0, layout.near),
        new Vector3(0, 0, -layout.far * 0.75),
      ],
      margin: { x: 0.94, y: 0.9 },
    };
  }
  const half = HIGHWAY_WIDTH / 2 + layout.hitLine.overhang;
  const side = EDGE_PX + Math.max(insets.left, insets.right);
  const top = insets.top + HUD_BAND_PX;
  return {
    target,
    direction,
    // The far end of the lanes stops at the HUD band.
    keepVisible: [new Vector3(0, 0, -layout.far)],
    // The outer lane edges just below the hit line, where they are widest on screen
    // short of the bottom edge the lanes run off.
    keepAcross: [new Vector3(-half, 0, TABLETOP_ANCHOR_Z), new Vector3(half, 0, TABLETOP_ANCHOR_Z)],
    margin: {
      x: Math.min(0.99, Math.max(0.5, 1 - (2 * side) / width)),
      y: Math.min(0.95, Math.max(0.3, 1 - (2 * top) / height)),
    },
  };
}

/** Points the camera at the layout. Does not allocate beyond the fit's few vectors. */
export function frameLayout(
  camera: PerspectiveCamera,
  layout: HighwayLayout,
  width: number,
  height: number,
  insets: Readonly<Insets> = NO_INSETS,
): void {
  camera.fov = layout.fov;
  fitCamera(camera, width / Math.max(1, height), layoutFit(layout, width, height, insets));
}

// Reused for every touch.
const raycaster = new Raycaster();
const pointer = new Vector2();
const ground = new Plane(new Vector3(0, 1, 0), 0);
const hit = new Vector3();

/** The lane under a point of the screen in normalized device coordinates, or undefined. */
export function laneAtNdc(
  camera: PerspectiveCamera,
  x: number,
  y: number,
  layout: HighwayLayout,
): number | undefined {
  raycaster.setFromCamera(pointer.set(x, y), camera);
  if (!raycaster.ray.intersectPlane(ground, hit)) return undefined;
  return laneForPoint(hit.x, hit.z, layout.touch);
}

// ---- Tiles: the flat view (PLA-18) ----

/**
 * Tiles' view in both orientations, as in Magic Tiles: the four lanes are the whole
 * screen, seen flat from straight above, edge to edge and top to bottom (under the
 * safe areas too; nothing is kept clear for the HUD, which tiles pass under). World
 * units are lane widths, as in Rhythm's layouts, so the screen is `4 × height / width`
 * of them tall.
 *
 * A tile's time is its bottom edge. It reaches the notional line, `line` of the way
 * down, at that time, and the top of the screen a scroll window before: `far` units
 * from the line are one window, so Tile speed keeps its lead time. Below the line the
 * lanes run `near` units to the bottom edge, which is the exit line. All of it is
 * arithmetic on the viewport, computed again on every resize.
 */
export interface FlatLayout {
  kind: 'flat';
  /** The viewport, CSS px. */
  width: number;
  height: number;
  /** World units per CSS px (the same both ways: nothing is foreshortened). */
  unit: number;
  /** The line, as a fraction of the height from the top. */
  line: number;
  /** From the top of the screen to the line, world units: one scroll window. */
  far: number;
  /** From the line to the bottom edge, world units. */
  near: number;
}

/** Every layout the stage draws: Rhythm's highways and Tiles' flat view. */
export type StageLayoutKind = LayoutKind | 'flat';

/**
 * Tiles' along-lane slack: how far beyond a tile's drawn top or bottom edge a press
 * still lands on it, CSS px. Generous: a fingertip lands a little off where it aims,
 * and a tile pressed just outside its edge should still count. Across the lane the
 * whole lane counts.
 */
export const FLAT_SLACK_PX = 28;

/** The flat view of a viewport, CSS px. */
export function flatLayout(width: number, height: number): FlatLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const line = isLandscape(w, h) ? FLAT_LINE_LANDSCAPE : FLAT_LINE_PORTRAIT;
  const unit = HIGHWAY_WIDTH / w;
  const length = h * unit;
  return {
    kind: 'flat',
    width: w,
    height: h,
    unit,
    line,
    far: length * line,
    near: length * (1 - line),
  };
}

/** How high above the lanes the flat camera sits, and the depth it sees. */
const FLAT_EYE = 10;

/** Points an orthographic camera straight down at the lanes, framing exactly the viewport. */
export function frameFlat(camera: OrthographicCamera, flat: FlatLayout): void {
  const half = (flat.far + flat.near) / 2;
  const centre = (flat.near - flat.far) / 2;
  camera.left = -HIGHWAY_WIDTH / 2;
  camera.right = HIGHWAY_WIDTH / 2;
  camera.top = half;
  camera.bottom = -half;
  camera.near = 0.1;
  camera.far = FLAT_EYE * 2;
  // Up on screen is up the lane (negative z): looking straight down needs a new up.
  camera.up.set(0, 0, -1);
  camera.position.set(0, FLAT_EYE, centre);
  camera.lookAt(0, 0, centre);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/**
 * The Tiles hit test in the flat view: the lane under a point of the screen (CSS px
 * from the surface's top left) by which quarter of the width it is in, and the place
 * along it by its height, in scroll windows from the line. The whole screen is lanes.
 * The simulation finds the tile from the time; `reach` is the slack only, since a
 * tile's drawn extent comes with it (`tileSpan`).
 */
export function flatSpotAt(x: number, y: number, flat: FlatLayout): LaneSpot {
  const lane = Math.min(LANES - 1, Math.max(0, Math.floor((x / flat.width) * LANES)));
  const z = -flat.far + Math.min(flat.height, Math.max(0, y)) * flat.unit;
  return { lane, along: z / flat.far, reach: (FLAT_SLACK_PX * flat.unit) / flat.far };
}

/**
 * What the simulation needs of the flat view: the exit line (the bottom edge of the
 * screen) in scroll windows past the line, and the screen's size.
 */
export function flatFrame(flat: FlatLayout): TilesFrame {
  return { exitAlong: flat.near / flat.far, widthPx: flat.width, heightPx: flat.height };
}
