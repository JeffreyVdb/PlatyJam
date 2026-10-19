import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  EDGE_PX,
  frameLayout,
  HANDHELD,
  HIGHWAY_WIDTH,
  HUD_BAND_PX,
  laneAtNdc,
  selectLayout,
  TABLETOP,
  type HighwayLayout,
  type Insets,
} from './highway-layout';
import { tileDepth } from './lane-layout';

const half = HIGHWAY_WIDTH / 2;

function framed(layout: HighwayLayout, width: number, height: number, insets?: Insets) {
  const camera = new PerspectiveCamera(10, 1, 0.1, 100);
  frameLayout(camera, layout, width, height, insets);
  /** A world point on the table, in CSS px from the top left. */
  const px = (x: number, z: number) => {
    const p = new Vector3(x, 0, z).project(camera);
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height, ndcX: p.x, ndcY: p.y };
  };
  return { camera, px };
}

describe('layout selection', () => {
  it('uses the tabletop layout for landscape shapes and handheld for portrait', () => {
    expect(selectLayout(820, 1180)).toBe(HANDHELD);
    expect(selectLayout(1024, 1366)).toBe(HANDHELD);
    expect(selectLayout(1180, 820)).toBe(TABLETOP);
    expect(selectLayout(1366, 1024)).toBe(TABLETOP);
    expect(selectLayout(1920, 1080)).toBe(TABLETOP);
  });

  it('keeps square and nearly square windows handheld, and survives a zero height', () => {
    expect(selectLayout(1000, 1000)).toBe(HANDHELD);
    expect(selectLayout(1100, 1000)).toBe(HANDHELD);
    expect(selectLayout(1200, 1000)).toBe(TABLETOP);
    expect(selectLayout(500, 0)).toBe(TABLETOP);
  });
});

describe('the handheld layout', () => {
  it('fills the portrait width with the lanes and shows the camera it is meant to', () => {
    const { camera, px } = framed(HANDHELD, 820, 1180);
    expect(camera.fov).toBe(HANDHELD.fov);
    const span = px(half, 0).x - px(-half, 0).x;
    expect(span / 820).toBeGreaterThan(0.7);
  });
});

describe('the tabletop layout', () => {
  for (const [width, height] of [
    [1180, 820],
    [1366, 1024],
    [1112, 834],
  ] as const) {
    it(`spans the lanes across the ${width}x${height} screen as four large keys`, () => {
      const { camera, px } = framed(TABLETOP, width, height);
      expect(camera.fov).toBe(TABLETOP.fov);
      const line = px(half, 0).x - px(-half, 0).x;
      // Nearly the full width, with only the edge margin, at the hit line...
      expect(line / width).toBeGreaterThan(0.88);
      expect(px(-half, 0).x).toBeGreaterThanOrEqual(EDGE_PX - 1);
      expect(px(half, 0).x).toBeLessThanOrEqual(width - EDGE_PX + 1);
      // ...and a lane is a quarter of it.
      expect(line / 4).toBeGreaterThan(width * 0.22);
    });

    it(`keeps ${width}x${height}'s lanes clear of the HUD band and running off the bottom`, () => {
      const { px } = framed(TABLETOP, width, height);
      // The far end stops at the band; the lanes run past the bottom edge.
      expect(px(0, -TABLETOP.far).y).toBeGreaterThanOrEqual(HUD_BAND_PX - 1);
      expect(px(0, TABLETOP.near).y).toBeGreaterThan(height);
      // The hit line leaves the lower part of the screen as keys to rest on.
      expect(px(0, 0).y / height).toBeGreaterThan(0.6);
      expect(px(0, 0).y / height).toBeLessThan(0.8);
      // The outer edges are still on screen at the bottom of the screen.
      const bottom = px(half, 0.8);
      expect(bottom.x).toBeLessThanOrEqual(width - EDGE_PX + 1);
    });
  }

  it('moves its lanes in from a notch and clears the HUD band below the status bar', () => {
    const insets = { top: 24, right: 20, bottom: 20, left: 20 };
    const { px } = framed(TABLETOP, 1180, 820, insets);
    expect(px(-half, 0).x).toBeGreaterThanOrEqual(insets.left + EDGE_PX - 1);
    expect(px(half, 0).x).toBeLessThanOrEqual(1180 - insets.right - EDGE_PX + 1);
    expect(px(0, -TABLETOP.far).y).toBeGreaterThanOrEqual(insets.top + HUD_BAND_PX - 1);
  });

  it('gives the notes the same lead time as the handheld layout: a window spans the lanes', () => {
    const windowMs = 1600 * 1.25;
    for (const layout of [HANDHELD, TABLETOP]) {
      expect(tileDepth(5000 + windowMs, 5000, windowMs, layout.far)).toBe(-layout.far);
      expect(tileDepth(5000, 5000, windowMs, layout.far)).toBe(-0);
    }
  });
});

describe('touch lanes follow the drawn lanes', () => {
  const cases = [
    ['handheld', HANDHELD, 820, 1180],
    ['tabletop', TABLETOP, 1180, 820],
    ['tabletop on a wide screen', TABLETOP, 1920, 1080],
  ] as const;

  for (const [label, layout, width, height] of cases) {
    describe(label, () => {
      const { camera, px } = framed(layout, width, height);

      it('maps every drawn lane, along its length, to itself', () => {
        for (let lane = 0; lane < 4; lane += 1) {
          const x = lane - 1.5;
          for (const z of [-layout.far * 0.95, -layout.far / 2, -0.1, 0, 0.5]) {
            const { ndcX, ndcY } = px(x, z);
            expect(laneAtNdc(camera, ndcX, ndcY, layout), `lane ${lane} at z ${z}`).toBe(lane);
          }
        }
      });

      it('puts the dividers where they are drawn', () => {
        for (const divider of [-1, 0, 1]) {
          for (const z of [-layout.far / 2, 0]) {
            const left = px(divider - 0.03, z);
            const right = px(divider + 0.03, z);
            expect(laneAtNdc(camera, left.ndcX, left.ndcY, layout)).toBe(divider + 1);
            expect(laneAtNdc(camera, right.ndcX, right.ndcY, layout)).toBe(divider + 2);
          }
        }
      });

      it('takes both outer lanes to their edges, a little beyond, and no further', () => {
        const { slack } = layout.touch;
        for (const [side, lane] of [
          [-1, 0],
          [1, 3],
        ] as const) {
          const inside = px(side * (half - 0.02), 0);
          const slackEdge = px(side * (half + (slack ?? 0) * 0.8), 0);
          const beyond = px(side * (half + (slack ?? 0) + 0.2), 0);
          expect(laneAtNdc(camera, inside.ndcX, inside.ndcY, layout)).toBe(lane);
          expect(laneAtNdc(camera, slackEdge.ndcX, slackEdge.ndcY, layout)).toBe(lane);
          expect(laneAtNdc(camera, beyond.ndcX, beyond.ndcY, layout)).toBeUndefined();
        }
      });
    });
  }

  it('lets the tabletop keys be played all the way to the bottom of the screen', () => {
    const { camera, px } = framed(TABLETOP, 1180, 820);
    for (let lane = 0; lane < 4; lane += 1) {
      const centre = px(lane - 1.5, 0.7);
      expect(laneAtNdc(camera, centre.ndcX, -0.999, TABLETOP)).toBe(lane);
    }
  });

  it('ignores the HUD band above the far end of the tabletop lanes', () => {
    const { camera } = framed(TABLETOP, 1180, 820);
    expect(laneAtNdc(camera, 0, 0.99, TABLETOP)).toBeUndefined();
  });
});
