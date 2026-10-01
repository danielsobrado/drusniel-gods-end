import * as THREE from 'three/webgpu';

// Tree models spread their roots flat at local y ≈ 0, several metres out from
// the trunk. Placed at the terrain height under the trunk, those roots hang in
// the air on the downhill side of any slope. The fit below finds the ground
// plane under the root footprint (the bark shader bends the roots onto it) and
// how far the tree must sink so no root hangs over a dip the plane misses.

const RING_FRACTIONS = [0.35, 0.7, 1];
const RING_SAMPLES = 12;

export const DEFAULT_ROOT_SETTINGS = Object.freeze({
  enabled: true,
  // Local bark height below which a vertex counts as root when measuring reach.
  rootHeight: 0.25,
  // Local height over which the slope bend fades out up the trunk.
  conformHeight: 3,
  maxSlope: 1.2,
  maxSink: 2,
  bury: 0.05,
  // A tree whose roots would still stand this far above the ground after the
  // bend and sink (on a cliff or ridge edge) is not planted at all.
  maxOverhang: 1,
});

export function resolveRootSettings(settings = {}) {
  const merged = { ...DEFAULT_ROOT_SETTINGS, ...settings };
  return {
    enabled: merged.enabled !== false,
    rootHeight: Number(merged.rootHeight) || 0,
    conformHeight: Math.max(0.01, Number(merged.conformHeight) || DEFAULT_ROOT_SETTINGS.conformHeight),
    maxSlope: Math.max(0, Number(merged.maxSlope) || 0),
    maxSink: Math.max(0, Number(merged.maxSink) || 0),
    bury: Math.max(0, Number(merged.bury) || 0),
    maxOverhang: Number(merged.maxOverhang) >= 0 ? Number(merged.maxOverhang) : Infinity,
  };
}

// Horizontal reach of the root flare in the tree's own (unscaled) frame.
export function measureRootReach(root, { rootHeight, excludeName = null }) {
  root.updateWorldMatrix(true, true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const toRoot = new THREE.Matrix4();
  const vertex = new THREE.Vector3();
  let reach = 0;
  root.traverse((object) => {
    if (!object.isMesh || object.name === excludeName) return;
    const position = object.geometry?.getAttribute('position');
    if (!position) return;
    toRoot.multiplyMatrices(inverseRoot, object.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(toRoot);
      if (vertex.y < rootHeight) reach = Math.max(reach, Math.hypot(vertex.x, vertex.z));
    }
  });
  return reach;
}

// Least-squares ground slope over rings around (x, z); the rings are symmetric,
// so the slope terms separate. The plane is anchored at the trunk, and `sink`
// (≤ 0, capped by maxSink) drops it below every sample, including a ridge crest
// falling away on both sides. `overhang` is how far the sunk plane still stands
// above the lowest sample once the sink is capped: roots in the air.
export function fitRootGround(sampleHeight, x, z, radius, settings) {
  const center = sampleHeight(x, z);
  if (!(radius > 0)) return { center, slopeX: 0, slopeZ: 0, sink: 0, overhang: 0 };
  const samples = [[0, 0, center]];
  for (const fraction of RING_FRACTIONS) {
    for (let i = 0; i < RING_SAMPLES; i++) {
      const angle = (i / RING_SAMPLES) * Math.PI * 2;
      const dx = Math.cos(angle) * radius * fraction;
      const dz = Math.sin(angle) * radius * fraction;
      samples.push([dx, dz, sampleHeight(x + dx, z + dz)]);
    }
  }
  let sumX = 0, sumZ = 0, sumXX = 0, sumZZ = 0;
  for (const [dx, dz, h] of samples) {
    sumX += h * dx; sumZ += h * dz; sumXX += dx * dx; sumZZ += dz * dz;
  }
  let slopeX = sumX / sumXX;
  let slopeZ = sumZ / sumZZ;
  const slope = Math.hypot(slopeX, slopeZ);
  if (slope > settings.maxSlope) {
    const clamp = settings.maxSlope / slope;
    slopeX *= clamp; slopeZ *= clamp;
  }
  let lowest = 0;
  for (const [dx, dz, h] of samples) lowest = Math.min(lowest, h - (center + slopeX * dx + slopeZ * dz));
  const sink = Math.max(-settings.maxSink, lowest - settings.bury);
  return { center, slopeX, slopeZ, sink, overhang: Math.max(0, sink - lowest) };
}

// Converts a world ground slope into the local-space shear the bark shader
// applies: local dy = dot(bend, local xz), so roots land on the fitted plane.
export function rootBendFor(object, slopeX, slopeZ, target = new THREE.Vector2()) {
  object.updateMatrix();
  const e = object.matrix.elements;
  const up = e[5];
  if (Math.abs(up) < 1e-6) return target.set(0, 0);
  return target.set(
    (slopeX * e[0] + slopeZ * e[2]) / up,
    (slopeX * e[8] + slopeZ * e[10]) / up,
  );
}
