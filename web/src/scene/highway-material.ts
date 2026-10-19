import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { LANES } from '../chart/schema';

/**
 * The lane surface, drawn analytically so it is as sharp as the screen allows at any
 * size, tilt or pixel ratio. A baked texture magnifies into broad soft dividers; here
 * every edge is a one-device-pixel antialiased ramp measured with `fwidth`.
 *
 * - Lanes alternate with dark dividers at the lane boundaries. A divider has a world
 *   width, so it tapers with the lanes, but never gets thinner than a device pixel
 *   (which would shimmer) and fades out where the lanes themselves are a few pixels
 *   wide.
 * - The highway's sides and near end are alpha ramps rather than polygon edges, so
 *   they stay smooth without MSAA, which the renderer skips at 2x density.
 * - The far end fades into the water with the scene fog (`fog.near` to `fog.far`),
 *   so the lanes dissolve instead of ending on a hard edge.
 *
 * The plane must reach past the lanes by `EDGE_MARGIN` on each side, and carry its
 * world position in `position` (rotate and translate the geometry, not the mesh).
 */
export const EDGE_MARGIN = 0.5;
/** Half the width of a divider, in lanes. */
const DIVIDER_HALF = 0.016;

const VERTEX = /* glsl */ `
varying vec2 vPlane;
#include <fog_pars_vertex>
void main() {
  vPlane = position.xz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// Both uniforms are linear colours: colorspace_fragment converts them on output.
const FRAGMENT = /* glsl */ `
uniform vec3 uLane;
uniform vec3 uDivider;
uniform float uHalfWidth;
uniform float uNear;
uniform float uDividerHalf;
varying vec2 vPlane;
#include <fog_pars_fragment>
void main() {
  // Plane units per device pixel, across and along.
  vec2 pixel = max(fwidth(vPlane), vec2(1e-5));
  float halfLine = max(uDividerHalf, 0.75 * pixel.x);

  // Distance to the nearest lane boundary (boundaries sit on whole lanes from the left edge).
  float across = vPlane.x + uHalfWidth;
  float edge = abs(fract(across + 0.5) - 0.5);
  float divider = 1.0 - clamp((edge - halfLine) / pixel.x + 0.5, 0.0, 1.0);
  // Lanes under about three device pixels apart average out instead of shimmering.
  divider *= 1.0 - smoothstep(0.3, 0.5, pixel.x);

  // Coverage of the highway itself: both sides and the near end.
  float side = clamp((uHalfWidth + halfLine - abs(vPlane.x)) / pixel.x + 0.5, 0.0, 1.0);
  float end = clamp((uNear - vPlane.y) / pixel.y + 0.5, 0.0, 1.0);
  float alpha = side * end;
  #ifdef USE_FOG
    alpha *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif

  gl_FragColor = vec4(mix(uLane, uDivider, divider), alpha);
  #include <colorspace_fragment>
}
`;

export interface HighwayMaterialOptions {
  lane: Color;
  divider: Color;
  /** World z where the lanes end, in front of the hit line. */
  near: number;
}

export function createHighwayMaterial({ lane, divider, near }: HighwayMaterialOptions) {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uLane: { value: lane.clone() },
        uDivider: { value: divider.clone() },
        uHalfWidth: { value: LANES / 2 },
        uNear: { value: near },
        uDividerHalf: { value: DIVIDER_HALF },
      },
    ]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    fog: true,
    transparent: true,
    depthWrite: false,
  });
}
