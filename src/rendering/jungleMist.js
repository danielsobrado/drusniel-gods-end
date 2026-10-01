import { abs, color, exp, float, mix, smoothstep, time, vec2 } from 'three/tsl';
import { noise2 } from '../world/snowNoiseNodes.js';

// Below this height difference along the ray the closed form's divide is
// replaced by its limit.
const FLAT_RAY = 0.05;

// Humid ground mist between the jungle trees, applied in the post pass once
// per screen pixel. As a fog node it ran for every fragment of the jungle's
// alpha-tested foliage, whose overdraw defeats early depth rejection, and
// cost close to a millisecond at 3440x1440; here it is one evaluation per
// pixel against the resolved depth.
//
// Density falls off exponentially with height above one ground level (the
// eased terrain height under the view), so the integral along the view ray
// has a closed form: one exp pair and one noise tap, no march. Drifting
// pockets make it gather in banks, and the first metres stay clear so the
// player is never fogged in.
//
// `eye` is the camera position, `ray` the normalised world view ray and
// `length` the distance to the surface the pixel shows. `settings` is
// ambientEffects.jungleMist; `strength` and `ground` are uniforms.
// Returns { factor, color } to blend over the pixel.
export function jungleMistNodes({ settings, strength, ground, eye, ray, length, fogColor, sunColor, fill }) {
  const reach = length.min(settings.maxDistance);
  const scale = float(settings.height);
  // Heights above the mist's ground, clamped so a camera below that level
  // does not see exponentially dense fog.
  const start = eye.y.sub(ground).max(0);
  const end = start.add(ray.y.mul(reach)).max(0);
  const rise = end.sub(start);
  const startDensity = exp(start.div(scale).negate());
  const endDensity = exp(end.div(scale).negate());
  // Mean density along the ray; a level ray takes the limit.
  const flat = abs(rise).lessThan(FLAT_RAY);
  const sloped = startDensity.sub(endDensity).mul(scale).div(flat.select(float(FLAT_RAY), rise));
  const integral = flat.select(startDensity, sloped).mul(reach);
  const point = eye.xz.add(ray.xz.mul(reach));
  const drift = vec2(time.mul(0.6), time.mul(0.25));
  const banks = mix(float(1 - settings.pocketStrength), float(1 + settings.pocketStrength),
    smoothstep(-0.45, 0.45, noise2(point.add(drift).mul(settings.pocketScale))));
  const clear = smoothstep(settings.nearStart, settings.nearEnd, reach);
  const opticalDepth = integral.mul(banks).mul(clear).mul(settings.density).mul(strength);
  const factor = exp(opticalDepth.negate()).oneMinus().clamp(0, 0.92);
  const lit = mix(fogColor, color(settings.color).mul(sunColor.mul(0.6).add(fill).add(0.15)), 0.7);
  return { factor, color: lit };
}
