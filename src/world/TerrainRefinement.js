const MIN_EDGE = 0.0001;

function edgeKey(a, b) {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function splitTriangle(next, ids, mids) {
  const count = mids.filter((value) => value !== undefined).length;
  if (count === 0) {
    next.push(...ids);
    return;
  }
  if (count === 3) {
    const [a, b, c] = ids;
    const [ab, bc, ca] = mids;
    next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    return;
  }

  const rotatedIds = [...ids];
  const rotatedMids = [...mids];
  while (rotatedMids[0] === undefined || (count === 2 && rotatedMids[1] === undefined)) {
    rotatedIds.push(rotatedIds.shift());
    rotatedMids.push(rotatedMids.shift());
  }
  const [v0, v1, v2] = rotatedIds;
  const [m0, m1] = rotatedMids;
  if (count === 1) next.push(v0, m0, v2, m0, v1, v2);
  else next.push(v0, m0, v2, m0, m1, v2, m0, v1, m1);
}

export function refineTerrainRegion({ positions, uvs, indices, passes, shouldRefine, sampleHeight }) {
  let refined = indices;
  for (let pass = 0; pass < passes; pass += 1) {
    const edges = new Map();
    for (let index = 0; index < refined.length; index += 3) {
      const ids = refined.slice(index, index + 3);
      const x = ids.reduce((sum, id) => sum + positions[id * 3], 0) / 3;
      const z = ids.reduce((sum, id) => sum + positions[id * 3 + 2], 0) / 3;
      if (!shouldRefine(x, z, ids)) continue;

      for (let edge = 0; edge < 3; edge += 1) {
        const a = ids[edge];
        const b = ids[(edge + 1) % 3];
        const key = edgeKey(a, b);
        if (edges.has(key)) continue;
        const ax = positions[a * 3];
        const az = positions[a * 3 + 2];
        const bx = positions[b * 3];
        const bz = positions[b * 3 + 2];
        if (Math.hypot(bx - ax, bz - az) <= MIN_EDGE) continue;
        const xMid = (ax + bx) * 0.5;
        const zMid = (az + bz) * 0.5;
        const vertex = positions.length / 3;
        positions.push(xMid, sampleHeight(xMid, zMid), zMid);
        uvs.push((uvs[a * 2] + uvs[b * 2]) * 0.5, (uvs[a * 2 + 1] + uvs[b * 2 + 1]) * 0.5);
        edges.set(key, vertex);
      }
    }

    if (edges.size === 0) break;
    const next = [];
    for (let index = 0; index < refined.length; index += 3) {
      const ids = refined.slice(index, index + 3);
      const mids = [
        edges.get(edgeKey(ids[0], ids[1])),
        edges.get(edgeKey(ids[1], ids[2])),
        edges.get(edgeKey(ids[2], ids[0])),
      ];
      splitTriangle(next, ids, mids);
    }
    refined = next;
  }
  return refined;
}
