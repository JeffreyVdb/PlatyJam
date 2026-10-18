import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fitCamera, type CameraFit } from './camera-fit';

const fit: CameraFit = {
  target: new Vector3(0, 0, -3),
  direction: new Vector3(0, 0.6, 0.8),
  keepVisible: [new Vector3(-2, 0, 0), new Vector3(2, 0, 0), new Vector3(0, 0, -10)],
  margin: { x: 0.9, y: 0.9 },
};

function extent(camera: PerspectiveCamera) {
  const ndc = fit.keepVisible.map((p) => p.clone().project(camera));
  return {
    x: Math.max(...ndc.map((p) => Math.abs(p.x))),
    y: Math.max(...ndc.map((p) => Math.abs(p.y))),
  };
}

describe('fitCamera', () => {
  for (const [label, aspect] of [
    ['portrait', 820 / 1180],
    ['landscape', 1180 / 820],
  ] as const) {
    it(`keeps every point on screen and fills one axis in ${label}`, () => {
      const camera = new PerspectiveCamera(38, 1, 0.1, 100);
      fitCamera(camera, aspect, fit);
      const { x, y } = extent(camera);
      expect(x).toBeLessThanOrEqual(fit.margin.x);
      expect(y).toBeLessThanOrEqual(fit.margin.y);
      // Tight on at least one axis: the lanes use the narrower dimension.
      expect(Math.max(x / fit.margin.x, y / fit.margin.y)).toBeGreaterThan(0.98);
    });
  }

  it('moves further back in portrait than in landscape', () => {
    const portrait = new PerspectiveCamera(38, 1, 0.1, 100);
    const landscape = new PerspectiveCamera(38, 1, 0.1, 100);
    fitCamera(portrait, 820 / 1180, fit);
    fitCamera(landscape, 1180 / 820, fit);
    expect(portrait.position.distanceTo(fit.target)).toBeGreaterThan(
      landscape.position.distanceTo(fit.target),
    );
  });
});
