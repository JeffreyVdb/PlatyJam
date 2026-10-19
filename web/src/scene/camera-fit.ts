import { PerspectiveCamera, Vector3 } from 'three';

export interface CameraFit {
  /** Point the camera looks at. */
  target: Vector3;
  /** Unit vector from the target towards the camera. */
  direction: Vector3;
  /** World points that must stay on screen. */
  keepVisible: readonly Vector3[];
  /**
   * World points whose sideways position must stay on screen but which may sit off
   * the top or bottom: where a surface runs past the screen edge.
   */
  keepAcross?: readonly Vector3[];
  /** Fraction of the half-screen the points may use, per axis. */
  margin: { x: number; y: number };
}

const projected = new Vector3();

function fits(camera: PerspectiveCamera, fit: CameraFit): boolean {
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const onScreen = (point: Vector3, checkHeight: boolean) => {
    projected.copy(point).applyMatrix4(camera.matrixWorldInverse);
    // Behind the near plane never fits. The far plane is ignored on purpose, so that
    // moving the camera back always helps and the search below stays monotonic.
    if (projected.z > -camera.near) return false;
    projected.applyMatrix4(camera.projectionMatrix);
    return (
      Math.abs(projected.x) <= fit.margin.x &&
      (!checkHeight || Math.abs(projected.y) <= fit.margin.y)
    );
  };
  return (
    fit.keepVisible.every((point) => onScreen(point, true)) &&
    (fit.keepAcross ?? []).every((point) => onScreen(point, false))
  );
}

/**
 * Moves the camera along `direction` until every `keepVisible` point fits on screen,
 * so the lanes fill the narrower screen dimension in portrait and landscape alike.
 */
export function fitCamera(camera: PerspectiveCamera, aspect: number, fit: CameraFit): void {
  camera.aspect = aspect;
  const place = (distance: number) => {
    camera.position.copy(fit.direction).multiplyScalar(distance).add(fit.target);
    camera.lookAt(fit.target);
  };

  let near = 0.5;
  let far = 200;
  for (let i = 0; i < 32; i += 1) {
    const mid = (near + far) / 2;
    place(mid);
    if (fits(camera, fit)) far = mid;
    else near = mid;
  }
  place(far);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
}
