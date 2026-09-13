import { HalfFloatType, NearestFilter } from 'three/webgpu';
import { Fn, rtt, uv, uniform, textureSize, textureLoad, ivec2, vec2, vec4,
  getViewPosition, abs, cross, normalize } from 'three/tsl';

/** Edge-aware depth normals. Explicit scalar loads also support R32F copies.
 * Follows Three.js (MIT) PostProcessingUtils.getNormalFromDepth's stencil.
 */
export function createDepthNormals(depth, camera) {
  const inverseProjection = uniform(camera.projectionMatrixInverse);
  const normal = Fn(() => {
    const coord = uv();
    // textureSize is uvec2. Taking its reciprocal before converting to float
    // truncates each texel step to zero, producing degenerate/NaN normals.
    const size = vec2(textureSize(depth));
    const pixel = ivec2(coord.mul(size));
    const read = (x, y) => textureLoad(depth.value, pixel.add(ivec2(x, y))).r;
    const center = read(0, 0).toVar();
    const left = read(-1, 0).toVar();
    const right = read(1, 0).toVar();
    const bottom = read(0, 1).toVar();
    const top = read(0, -1).toVar();
    const dl = abs(left.mul(2).sub(read(-2, 0)).sub(center));
    const dr = abs(right.mul(2).sub(read(2, 0)).sub(center));
    const db = abs(bottom.mul(2).sub(read(0, 2)).sub(center));
    const dt = abs(top.mul(2).sub(read(0, -2)).sub(center));
    const dx = vec2(size.x.reciprocal(), 0);
    const dy = vec2(0, size.y.reciprocal());
    const position = getViewPosition(coord, center, inverseProjection);
    const tangentX = dl.lessThan(dr).select(
      position.sub(getViewPosition(coord.sub(dx), left, inverseProjection)),
      getViewPosition(coord.add(dx), right, inverseProjection).sub(position),
    );
    const tangentY = db.lessThan(dt).select(
      position.sub(getViewPosition(coord.add(dy), bottom, inverseProjection)),
      getViewPosition(coord.sub(dy), top, inverseProjection).sub(position),
    );
    return vec4(normalize(cross(tangentX, tangentY)), 1);
  })();
  return rtt(normal, null, null, {
    type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter,
  });
}
