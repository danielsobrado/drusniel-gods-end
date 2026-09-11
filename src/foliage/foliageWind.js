import { Fn, If, cos, float, mix, sin, smoothstep, time, vec3 } from 'three/tsl';
import { createCinematicWindFieldNode, getSharedWindUniforms } from '../weather/WindField.js';

export function createSimpleFoliageSway({ origin, heightWeight, windIntensity, windBend, windFlutter }) {
  const shared = getSharedWindUniforms();
  const angle = shared.directionDegrees.mul(Math.PI / 180);
  const phase = origin.x.mul(0.17).add(origin.z.mul(0.11));
  const clock = time.mul(shared.simulationSpeed);
  const bend = sin(clock.mul(0.8).add(phase)).mul(0.15).add(0.25)
    .mul(windIntensity).mul(windBend).mul(heightWeight);
  const flutter = sin(clock.mul(1.6).add(phase)).mul(windFlutter).mul(heightWeight);
  return vec3(cos(angle).mul(bend).sub(sin(angle).mul(flutter)), 0,
    sin(angle).mul(bend).add(cos(angle).mul(flutter)));
}

export function createFoliageWind({ origin, world, distance, heightWeight,
  windIntensity, windBend, windFlutter, config }) {
  const simple = createSimpleFoliageSway({ origin, heightWeight, windIntensity, windBend, windFlutter });
  const shared = getSharedWindUniforms();
  return Fn(() => {
    const offset = simple.toVar();
    // The expensive spatial noise graph is evaluated only for nearby clumps.
    If(distance.lessThan(32), () => {
      const field = createCinematicWindFieldNode({ positionXZ: world.xz, timeNode: time,
        directionDegrees: shared.directionDegrees, intensity: windIntensity,
        simulationSpeed: shared.simulationSpeed, noiseScale: shared.noiseScale, config });
      const phase = origin.x.mul(0.17).add(origin.z.mul(0.11));
      const flutter = sin(time.mul(shared.simulationSpeed).mul(1.6).add(phase)).mul(windFlutter).mul(heightWeight);
      const bend = field.strength.mul(windBend).mul(heightWeight);
      const full = vec3(field.direction.x.mul(bend).sub(flutter.mul(field.direction.y)), 0,
        field.direction.y.mul(bend).add(flutter.mul(field.direction.x)));
      offset.assign(mix(full, simple, smoothstep(float(20), float(32), distance)));
    });
    return offset;
  })();
}
