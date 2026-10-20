import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Tile } from '../chart/schema';
import { createTilesSimulation } from '../game/tiles-simulation';
import {
  EDGE_PX,
  FLAT_SLACK_PX,
  flatFrame,
  flatLayout,
  flatSpotAt,
  frameFlat,
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
import {
  FLAT_LINE_LANDSCAPE,
  FLAT_LINE_PORTRAIT,
  tileDepth,
  tileSizing,
  tileSpans,
} from './lane-layout';

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

const VIEWPORTS = [
  ['a phone in portrait', 390, 844, FLAT_LINE_PORTRAIT],
  ['an iPad in portrait', 820, 1180, FLAT_LINE_PORTRAIT],
  ['an iPad lying flat', 1180, 820, FLAT_LINE_LANDSCAPE],
  ['a phone on its side', 844, 390, FLAT_LINE_LANDSCAPE],
] as const;

describe("Tiles' flat view", () => {
  for (const [label, width, height, line] of VIEWPORTS) {
    describe(label, () => {
      const flat = flatLayout(width, height);
      const camera = new OrthographicCamera();
      frameFlat(camera, flat);
      /** A world point on the lanes, in CSS px from the top left. */
      const px = (x: number, z: number) => {
        const p = new Vector3(x, 0, z).project(camera);
        return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
      };

      it('fills the whole screen with the four lanes, flat, the line where it should be', () => {
        expect(flat.line).toBe(line);
        expect(px(-HIGHWAY_WIDTH / 2, 0).x).toBeCloseTo(0, 6);
        expect(px(HIGHWAY_WIDTH / 2, 0).x).toBeCloseTo(width, 6);
        expect(px(0, -flat.far).y).toBeCloseTo(0, 6);
        expect(px(0, 0).y).toBeCloseTo(height * line, 6);
        expect(px(0, flat.near).y).toBeCloseTo(height, 6);
        // No perspective: a lane is as wide at the top as at the bottom, and a unit is
        // as long down the lane as across it.
        expect(px(-1, -flat.far).x).toBeCloseTo(px(-1, flat.near).x, 6);
        expect(px(0, 1).y - px(0, 0).y).toBeCloseTo(px(1, 0).x - px(0, 0).x, 6);
      });

      it('keeps the lead time: a tile reaches the line a scroll window after the top', () => {
        const windowMs = 1600 * 1.25;
        const t = 10_000;
        expect(px(0, tileDepth(t, t - windowMs, windowMs, flat.far)).y).toBeCloseTo(0, 6);
        expect(px(0, tileDepth(t, t, windowMs, flat.far)).y).toBeCloseTo(height * line, 6);
      });

      it('finds the lane by quarter of the width, and the time by height', () => {
        const windowMs = 1600;
        const songMs = 5000;
        for (let lane = 0; lane < 4; lane += 1) {
          for (const y of [0, height * 0.3, height * line, height - 1]) {
            const x = ((lane + 0.5) / 4) * width;
            const spot = flatSpotAt(x, y, flat);
            expect(spot.lane).toBe(lane);
            // The time of a tile edge drawn at that height.
            const ms = songMs - spot.along * windowMs;
            expect(px(0, tileDepth(ms, songMs, windowMs, flat.far)).y).toBeCloseTo(y, 6);
          }
        }
        // The dividers, a hair either side, and the edges of the screen.
        for (const divider of [1, 2, 3]) {
          expect(flatSpotAt((divider / 4) * width - 0.5, 10, flat).lane).toBe(divider - 1);
          expect(flatSpotAt((divider / 4) * width + 0.5, 10, flat).lane).toBe(divider);
        }
        expect(flatSpotAt(0, 0, flat).lane).toBe(0);
        expect(flatSpotAt(width, height, flat).lane).toBe(3);
      });

      it('counts the slack in CSS px along the lane', () => {
        const windowMs = 1600;
        const { reach } = flatSpotAt(10, 10, flat);
        // The slack in chart ms, back in px at the speed tiles move.
        const msPerPx = windowMs / (height * line);
        expect((reach * windowMs) / msPerPx).toBeCloseTo(FLAT_SLACK_PX, 6);
      });

      it('loses a tile at the bottom edge of the screen', () => {
        const frame = flatFrame(flat);
        expect(frame).toMatchObject({ widthPx: width, heightPx: height });
        expect(frame.exitAlong).toBeCloseTo((1 - line) / line, 9);
        // A tile's top crossing the exit line is at the bottom edge.
        const windowMs = 1600;
        const top = 7000;
        const lostAt = top + frame.exitAlong * windowMs;
        expect(px(0, tileDepth(top, lostAt, windowMs, flat.far)).y).toBeCloseTo(height, 6);
      });

      it('claims a tile pressed anywhere it is drawn, and only there', () => {
        // A staircase, the simulation's own spans: the same sizing the stage draws with.
        const windowMs = 1600;
        const tap = (t: number, lane: number): Tile => ({ t, lane, pitches: [60], vel: 90 });
        const tiles = [tap(1000, 0), tap(1450, 1), tap(1900, 2), tap(4000, 3)];
        const sizing = tileSizing('normal', flatFrame(flat));
        const spans = tileSpans(tiles, windowMs, sizing);
        const songMs = 600;
        /** Where on screen tile `index` is drawn: x across its lane, y from top to bottom. */
        const drawn = (index: number) => {
          const tile = tiles[index] ?? tap(0, 0);
          return {
            x: ((tile.lane + 0.5) / 4) * width,
            bottom: px(0, tileDepth(tile.t, songMs, windowMs, flat.far)).y,
            top: px(0, tileDepth(tile.t + (spans[index] ?? 0), songMs, windowMs, flat.far)).y,
          };
        };
        /** A fresh run, one press at (x, y): what it did. */
        const press = (x: number, y: number) => {
          const log: string[] = [];
          const sim = createTilesSimulation({
            tiles,
            tempo: 1,
            failMode: 'relaxed',
            durationMs: 5000,
            scrollDurationMs: windowMs,
            exitAlong: flatFrame(flat).exitAlong,
            sizing,
            onJudgment: (e) => log.push(`${e.unit}:${e.judgment}#${e.tileIndex}`),
            onNotYet: (_, index) => log.push(`notYet#${index}`),
          });
          const spot = flatSpotAt(x, y, flat);
          sim.press('p', spot.lane, songMs, {
            ms: songMs - spot.along * windowMs,
            reachMs: spot.reach * windowMs,
          });
          return log;
        };
        const first = drawn(0);
        for (const y of [first.bottom - 1, (first.bottom + first.top) / 2, first.top + 0.01]) {
          if (y < 0 || y > height) continue;
          expect(press(first.x, y), `at y ${y}`).toEqual(['tap:clear#0']);
        }
        // Its top edge exactly, and within the slack above it.
        expect(press(first.x, first.top)).toEqual(['tap:clear#0']);
        if (first.top - FLAT_SLACK_PX * 0.9 > 0) {
          expect(press(first.x, first.top - FLAT_SLACK_PX * 0.9)).toEqual(['tap:clear#0']);
        }
        // Beyond the slack above its top: empty space in that lane.
        if (first.top - FLAT_SLACK_PX * 1.1 > 0) {
          expect(press(first.x, first.top - FLAT_SLACK_PX * 1.1)).toEqual(['empty:miss#-1']);
        }
        // Staircase neighbours, level with the first tile's top: by lane.
        const second = drawn(1);
        expect(second.bottom).toBeCloseTo(first.top, 6);
        expect(press(second.x, first.top - 2)).toEqual(['notYet#1']);
        expect(press(first.x, first.top + 2)).toEqual(['tap:clear#0']);
        expect(press(drawn(2).x, first.top + 2)).toEqual(['empty:miss#-1']);
      });
    });
  }
});
