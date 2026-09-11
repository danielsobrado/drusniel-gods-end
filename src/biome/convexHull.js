export function reduceConvexPoints(points, maxVertices = 32) {
  const source = points instanceof Float32Array ? points : new Float32Array(points);
  const count = Math.floor(source.length / 3);
  if (count <= maxVertices) return source.slice(0, count * 3);

  const chosen = [];
  const used = new Uint8Array(count);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = source[i * 3], y = source[i * 3 + 1], z = source[i * 3 + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const corners = [
    [minX, minY, minZ], [maxX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ],
    [minX, minY, maxZ], [maxX, minY, maxZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
  ];
  for (const corner of corners) {
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const dx = source[i * 3] - corner[0];
      const dy = source[i * 3 + 1] - corner[1];
      const dz = source[i * 3 + 2] - corner[2];
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    if (!used[best]) { used[best] = 1; chosen.push(best); }
  }

  while (chosen.length < maxVertices) {
    let best = -1, bestDistance = -1;
    for (let i = 0; i < count; i++) {
      if (used[i]) continue;
      let nearest = Infinity;
      for (const index of chosen) {
        const dx = source[i * 3] - source[index * 3];
        const dy = source[i * 3 + 1] - source[index * 3 + 1];
        const dz = source[i * 3 + 2] - source[index * 3 + 2];
        nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
      }
      if (nearest > bestDistance) { bestDistance = nearest; best = i; }
    }
    if (best < 0) break;
    used[best] = 1;
    chosen.push(best);
  }

  const packed = new Float32Array(chosen.length * 3);
  chosen.forEach((index, slot) => {
    packed[slot * 3] = source[index * 3];
    packed[slot * 3 + 1] = source[index * 3 + 1];
    packed[slot * 3 + 2] = source[index * 3 + 2];
  });
  return packed;
}

export function hullFromGeometry(geometry, maxVertices = 32) {
  const position = geometry?.attributes?.position;
  if (!position) return new Float32Array();
  const points = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    points[i * 3] = position.getX(i);
    points[i * 3 + 1] = position.getY(i);
    points[i * 3 + 2] = position.getZ(i);
  }
  return reduceConvexPoints(points, maxVertices);
}
