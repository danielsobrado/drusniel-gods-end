const MIN_TERMINAL_SPEED = 0.001;

export function snowWindVector(angleDegrees, speed) {
  const angle = Number(angleDegrees) * Math.PI / 180;
  const magnitude = Number(speed);
  return {
    x: Math.sin(angle) * magnitude,
    z: Math.cos(angle) * magnitude,
  };
}

export function advanceSnowPowderVelocity(
  velocities,
  offset,
  delta,
  { windX, windZ, drag, gravity, terminalFallSpeed },
) {
  const response = Math.min(1, drag * delta);
  velocities[offset] += (windX - velocities[offset]) * response;
  velocities[offset + 2] += (windZ - velocities[offset + 2]) * response;

  const verticalDrag = gravity / Math.max(terminalFallSpeed, MIN_TERMINAL_SPEED);
  const vy = velocities[offset + 1];
  velocities[offset + 1] = vy + (-gravity - verticalDrag * vy) * delta;
}
