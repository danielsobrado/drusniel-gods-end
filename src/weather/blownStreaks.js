import { Fn, If, cameraPosition, dot, float, positionWorld, smoothstep, vec2 } from 'three/tsl';
import { noise2 } from '../world/snowNoiseNodes.js';

// Below this the streaks are skipped (a uniform branch, so free).
const ACTIVE_AMOUNT = 0.001;

/**
 * Loose snow or sand streaming across the ground in the wind, as a 0..1
 * surface mask: noise stretched `length` metres along the wind and `width`
 * across it, sliding downwind by `travel` metres, and broken into gust
 * patches `patch` metres across that drift more slowly, so the streaming
 * comes and goes. It fades out past `reach` metres, where the fine streaks
 * would only shimmer. `direction` is a normalised vec2 node (x, z).
 *
 * Every node is built inside the branch from positionWorld afresh: a shared
 * expression first built inside an If would leave its later readers an
 * unassigned variable (see the TSL pitfalls note).
 */
export function blownStreaks({ direction, travel, amount, length, width, patch, reach }) {
  return Fn(() => {
    const value = float(0).toVar();
    If(amount.greaterThan(ACTIVE_AMOUNT), () => {
      const world = positionWorld.xz;
      const along = dot(world, direction);
      const across = dot(world, vec2(direction.y.negate(), direction.x));
      const cell = vec2(along.sub(travel).div(length), across.div(width));
      const fine = noise2(cell).add(noise2(cell.mul(vec2(1.9, 2.3)).add(vec2(5.2, 1.3))).mul(0.5));
      const streak = smoothstep(0.12, 0.55, fine);
      const gusts = smoothstep(-0.1, 0.4, noise2(vec2(along.sub(travel.mul(0.6)), across).div(patch)));
      const near = smoothstep(reach * 0.4, reach, cameraPosition.distance(positionWorld)).oneMinus();
      value.assign(streak.mul(gusts).mul(near).mul(amount));
    });
    return value;
  })();
}
