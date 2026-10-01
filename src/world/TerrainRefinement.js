const MIN_EDGE_SQUARED = 0.0001 ** 2;

function edgeKey(a, b, stride) {
  return a < b ? a * stride + b : b * stride + a;
}

function addMidpoint(positions, uvs, edges, splitVertices, stride, a, b, sampleHeight) {
  const key = edgeKey(a, b, stride);
  if (edges.has(key)) return;

  const ap = a * 3;
  const bp = b * 3;
  const ax = positions[ap];
  const az = positions[ap + 2];
  const bx = positions[bp];
  const bz = positions[bp + 2];
  const dx = bx - ax;
  const dz = bz - az;
  if (dx * dx + dz * dz <= MIN_EDGE_SQUARED) return;

  const xMid = (ax + bx) * 0.5;
  const zMid = (az + bz) * 0.5;
  const vertex = positions.length / 3;
  positions.push(xMid, sampleHeight(xMid, zMid), zMid);

  const au = a * 2;
  const bu = b * 2;
  uvs.push(
    (uvs[au] + uvs[bu]) * 0.5,
    (uvs[au + 1] + uvs[bu + 1]) * 0.5,
  );

  edges.set(key, vertex);
  splitVertices[a] = 1;
  splitVertices[b] = 1;
}

function appendSplit(next, a, b, c, ab, bc, ca) {
  const hasAb = ab !== undefined;
  const hasBc = bc !== undefined;
  const hasCa = ca !== undefined;
  const count = Number(hasAb) + Number(hasBc) + Number(hasCa);

  if (count === 0) {
    next.push(a, b, c);
    return;
  }
  if (count === 3) {
    next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    return;
  }
  if (count === 1) {
    if (hasAb) next.push(a, ab, c, ab, b, c);
    else if (hasBc) next.push(b, bc, a, bc, c, a);
    else next.push(c, ca, b, ca, a, b);
    return;
  }

  if (hasAb && hasBc) next.push(a, ab, c, ab, bc, c, ab, b, bc);
  else if (hasBc && hasCa) next.push(b, bc, a, bc, ca, a, bc, c, ca);
  else next.push(c, ca, b, ca, ab, b, ca, a, ab);
}

export function refineTerrainRegion({
  positions,
  uvs,
  indices,
  passes,
  shouldRefine,
  sampleHeight,
}) {
  let refined = indices;
  for (let pass = 0; pass < passes; pass += 1) {
    const stride = positions.length / 3;
    const edges = new Map();
    const splitVertices = new Uint8Array(stride);

    for (let index = 0; index < refined.length; index += 3) {
      const a = refined[index];
      const b = refined[index + 1];
      const c = refined[index + 2];
      const ap = a * 3;
      const bp = b * 3;
      const cp = c * 3;
      const x = (positions[ap] + positions[bp] + positions[cp]) / 3;
      const z = (positions[ap + 2] + positions[bp + 2] + positions[cp + 2]) / 3;
      if (!shouldRefine(x, z, a, b, c)) continue;

      addMidpoint(positions, uvs, edges, splitVertices, stride, a, b, sampleHeight);
      addMidpoint(positions, uvs, edges, splitVertices, stride, b, c, sampleHeight);
      addMidpoint(positions, uvs, edges, splitVertices, stride, c, a, sampleHeight);
    }

    if (edges.size === 0) break;
    const next = [];
    for (let index = 0; index < refined.length; index += 3) {
      const a = refined[index];
      const b = refined[index + 1];
      const c = refined[index + 2];

      if (splitVertices[a] + splitVertices[b] + splitVertices[c] < 2) {
        next.push(a, b, c);
        continue;
      }

      const ab = splitVertices[a] && splitVertices[b]
        ? edges.get(edgeKey(a, b, stride)) : undefined;
      const bc = splitVertices[b] && splitVertices[c]
        ? edges.get(edgeKey(b, c, stride)) : undefined;
      const ca = splitVertices[c] && splitVertices[a]
        ? edges.get(edgeKey(c, a, stride)) : undefined;
      appendSplit(next, a, b, c, ab, bc, ca);
    }
    refined = next;
  }
  return refined;
}
