import { texture, positionWorld, vec2, vec4, float } from 'three/tsl';

export function riverField(river) {
  if (!river?.texture) return vec4(-17, 100, 0, 0);
  const uv = positionWorld.xz.sub(vec2(river.bounds.min.x, river.bounds.min.z))
    .div(vec2(river.size.x, river.size.z));
  const valid = uv.x.greaterThanEqual(0).and(uv.x.lessThanEqual(1))
    .and(uv.y.greaterThanEqual(0)).and(uv.y.lessThanEqual(1));
  const value = texture(river.texture, uv.clamp(0, 1));
  return vec4(value.x, valid.select(value.y, float(100)), value.z, value.w);
}
