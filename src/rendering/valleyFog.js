import { Fn, If, Loop, cameraPosition, color, dot, exp, float, mix, positionWorld, smoothstep, texture, time, vec2 } from 'three/tsl';
import { noise2 } from '../world/snowNoiseNodes.js';
import { snowWindVector } from '../world/SnowPowderPhysics.js';

// Below this snow-country weight the march is skipped entirely.
const ACTIVE_WEIGHT = 0.001;

export { resolveValleyFogConfig } from '../config/resolveValleyFogConfig.js';

// Mist lying in the valleys and gorges of snow country. Density falls off
// exponentially with height above the local terrain, so it pools on gorge
// floors and in the valleys below the view while crests stand clear of it. It
// is modulated by drifting pockets, so it gathers in banks rather than as one
// even sheet. The density is marched along the view ray (the terrain under the
// ray varies too much for a closed form), sampling the heightfield and the
// pocket noise in the air, not on the surface, so it reads as volume rather
// than paint. The first metres stay clear, so a wall beside the camera is not
// washed out. Sunlit mist scatters forward toward the low sun and falls to a
// cool shade away from it.
//
// Returns { factor, color } for blending over the existing fog, or null.
export function createValleyFogNodes({ settings, terrainSampler, weight, fogColor, sunDirection, sunColor }) {
  if (!settings || !terrainSampler?.texture || !(terrainSampler.size?.x > 0)) return null;
  const min = terrainSampler.bounds.min;
  const heightRange = Math.max(1e-4, terrainSampler.bounds.max.y - min.y);
  const wind = snowWindVector(settings.windAngleDegrees, settings.drift);
  const drift = vec2(wind.x, wind.z).mul(time).mul(settings.pocketScale);
  const samples = settings.samples;
  const stepFraction = 1 / samples;

  // Explicit level: the march runs inside a branch and a loop, where implicit
  // derivatives are not allowed.
  const groundAt = (xz) => texture(
    terrainSampler.texture,
    xz.sub(vec2(min.x, min.z)).div(vec2(terrainSampler.size.x, terrainSampler.size.z)).clamp(0, 1),
  ).level(0).r.mul(heightRange).add(min.y);

  const opticalDepth = Fn(() => {
    const depth = float(0).toVar();
    If(weight.greaterThan(ACTIVE_WEIGHT), () => {
      const ray = positionWorld.sub(cameraPosition).toVar();
      const length = ray.length().min(settings.maxDistance).toVar();
      const direction = ray.normalize().toVar();
      const step = length.mul(stepFraction).toVar();
      Loop(samples, ({ i }) => {
        const along = float(i).add(0.5).mul(step);
        // Keep the same integration points; skip only exactly zero density.
        If(along.greaterThan(settings.nearStart), () => {
          const point = cameraPosition.add(direction.mul(along));
          const above = point.y.sub(groundAt(point.xz)).max(0).toVar();
          If(above.lessThan(settings.ceiling), () => {
            // Ragged tops: height is folded into the pocket coordinates.
            const cell = point.xz.mul(settings.pocketScale).add(drift).add(vec2(point.y.mul(0.004), 0));
            const pocket = noise2(cell).add(noise2(cell.mul(2.3).sub(drift.mul(0.6))).mul(0.5));
            const banks = mix(float(1 - settings.pocketStrength), float(1 + settings.pocketStrength),
              smoothstep(-0.45, 0.45, pocket));
            const clear = smoothstep(settings.nearStart, settings.nearEnd, along);
            const ceiling = smoothstep(settings.ceiling * 0.6, settings.ceiling, above).oneMinus();
            depth.addAssign(exp(above.div(-settings.height)).mul(banks).mul(clear).mul(ceiling).mul(step));
          });
        });
      });
    });
    return depth.mul(settings.density).mul(weight);
  })();

  const factor = exp(opticalDepth.negate()).oneMinus().clamp(0, 1);
  // Henyey-Greenstein forward lobe toward the sun, normalised to 1 at 90 degrees.
  const view = positionWorld.sub(cameraPosition).normalize();
  const g = settings.scatter;
  const cosine = dot(view, sunDirection);
  const phase = float((1 + g * g) ** 1.5).div(float(1 + g * g).sub(cosine.mul(2 * g)).pow(1.5));
  const lit = mix(color(settings.shadeColor).mul(fogColor), fogColor, 0.5)
    .add(sunColor.mul(phase.mul(settings.sunScatter)));
  return { factor, color: lit };
}
