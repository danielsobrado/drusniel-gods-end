import { Vector2 } from 'three/webgpu';
import { Fn, dot, float, floor, fract, mix, positionWorld, sin, smoothstep, uniform, vec2 } from 'three/tsl';

// Drifting cloud shadows: a two-octave value noise in world XZ multiplied into
// the sun-lit color of terrain and grass. Two noise taps per fragment, no extra
// pass. Strength 0 disables it (the multiplier becomes exactly 1).
export const cloudShadowUniforms = {
  offset: uniform(new Vector2()),
  scale: uniform(0.008),
  coverage: uniform(0.5),
  strength: uniform(0),
};

const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const valueNoise = Fn(([p]) => {
  const cell = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  return mix(
    mix(hash(cell), hash(cell.add(vec2(1, 0))), u.x),
    mix(hash(cell.add(vec2(0, 1))), hash(cell.add(vec2(1, 1))), u.x),
    u.y,
  );
});

export const cloudShade = Fn(() => {
  const p = positionWorld.xz.mul(cloudShadowUniforms.scale).add(cloudShadowUniforms.offset);
  const noise = valueNoise(p).mul(0.65).add(valueNoise(p.mul(2.3).add(7.7)).mul(0.35));
  // Denser cloud cover lowers the threshold so more of the field is shaded.
  const threshold = cloudShadowUniforms.coverage.oneMinus().mul(0.5).add(0.3);
  const cloud = smoothstep(threshold, threshold.add(0.32), noise);
  return float(1).sub(cloud.mul(cloudShadowUniforms.strength));
});

export function updateCloudShadow({ windX, windZ, time, speed, coverage, strength }) {
  cloudShadowUniforms.offset.value.set(windX * time * speed, windZ * time * speed);
  cloudShadowUniforms.coverage.value = coverage;
  cloudShadowUniforms.strength.value = strength;
}
