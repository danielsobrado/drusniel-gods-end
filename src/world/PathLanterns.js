/** Project authored stations onto roads, keeping both masonry bases off the path. */
export function createPathLanternPairs(records, paths, terrain, river) {
  if (!Array.isArray(paths?.pathSegments)) return records;
  const segments = paths.pathSegments;
  const stations = [], result = [];
  const count = Math.floor(records.length / 2);
  for (const [seedX, , seedZ] of records) {
    if (stations.length >= count) break;
    const candidates = segments.map(segment => {
      const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
      const length = Math.hypot(dx, dz);
      const t = Math.max(0, Math.min(1, ((seedX - segment.a.x) * dx + (seedZ - segment.a.z) * dz) / (length * length || 1)));
      const x = segment.a.x + t * dx, z = segment.a.z + t * dz;
      return { x, z, nx: -dz / length, nz: dx / length, half: segment.half, distance: Math.hypot(x - seedX, z - seedZ) };
    }).filter(s => Number.isFinite(s.nx)).sort((a, b) => a.distance - b.distance);
    for (const station of candidates) {
      const { x, z, nx, nz, half } = station;
      if (stations.some(s => Math.hypot(s.x - x, s.z - z) < 22)) continue;
      const pair = [-1, 1].map(side => {
        const px = x + nx * side * (half + 2), pz = z + nz * side * (half + 2);
        return [px, terrain.sampleHeight(px, pz), pz, Math.atan2(nz * side, -nx * side)];
      });
      if (pair.some(([px, y, pz]) => !Number.isFinite(y) || paths.sample(px, pz) > 0.01 || (river?.sample(px, pz)?.edge ?? Infinity) < 5)) continue;
      stations.push(station); result.push(...pair); break;
    }
  }
  return result;
}
