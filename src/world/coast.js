import { MathUtils } from 'three';
import { sin, float } from 'three/tsl';

export function coastX(z, shoreX = 1000) {
  return shoreX + Math.sin(z * 0.005) * 65 + Math.sin(z * 0.014) * 18;
}

export function coastXNode(z, shoreX = 1000) {
  return float(shoreX).add(sin(z.mul(0.005)).mul(65)).add(sin(z.mul(0.014)).mul(18));
}

export function coastalHeight(x, z, land, sea) {
  if (!sea?.enabled) return land;
  const d = x - coastX(z, sea.shoreX);
  if (d <= -230) return land;
  const { smoothstep, lerp } = MathUtils;
  if (d < -90) return lerp(land, sea.level + 9, smoothstep(d, -230, -90));
  if (d < 0) return lerp(sea.level + 9, sea.level, smoothstep(d, -90, 0));
  if (d < 80) return lerp(sea.level, sea.level - 9, smoothstep(d, 0, 80));
  return lerp(sea.level - 9, sea.level - sea.depth, smoothstep(d, 80, 500));
}
