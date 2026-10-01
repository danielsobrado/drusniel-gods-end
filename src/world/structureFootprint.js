// Ground-floor footprint of a building mesh, as a few rectangles in its own
// frame. A single box or convex hull around a house either blocks the air under
// its roof overhang or fills the inside corner of an L-shaped plan; this covers
// the lower storey only, follows concave plans and stays cheap for Rapier.
//
// The lower band's triangles are rasterised (by their XZ projection) into a
// grid, the enclosed interior is flood-filled, and the occupied cells are
// merged greedily into rectangles.

function markTriangle(grid, width, height, cell, minX, minZ, a, b, c) {
  const x0 = Math.floor((Math.min(a[0], b[0], c[0]) - minX) / cell);
  const x1 = Math.floor((Math.max(a[0], b[0], c[0]) - minX) / cell);
  const z0 = Math.floor((Math.min(a[1], b[1], c[1]) - minZ) / cell);
  const z1 = Math.floor((Math.max(a[1], b[1], c[1]) - minZ) / cell);
  // Every cell the projected triangle touches: the loop bounds are the grid
  // axes, and a cell is skipped when an edge normal separates it. A diagonal
  // wall projects to a slanted line, so it marks a staircase of cells rather
  // than the whole square spanned by its bounds.
  const axes = [];
  for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    const nx = p[1] - q[1], nz = q[0] - p[0];
    if (!nx && !nz) continue;
    const ta = a[0] * nx + a[1] * nz, tb = b[0] * nx + b[1] * nz, tc = c[0] * nx + c[1] * nz;
    axes.push({ nx, nz, min: Math.min(ta, tb, tc), max: Math.max(ta, tb, tc), reach: (Math.abs(nx) + Math.abs(nz)) * cell * 0.5 });
  }
  for (let z = Math.max(0, z0); z <= Math.min(height - 1, z1); z += 1) {
    const cz = minZ + (z + 0.5) * cell;
    cells: for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x += 1) {
      const cx = minX + (x + 0.5) * cell;
      for (const axis of axes) {
        const t = cx * axis.nx + cz * axis.nz;
        if (t + axis.reach < axis.min || t - axis.reach > axis.max) continue cells;
      }
      grid[z * width + x] = 1;
    }
  }
}

function fillEnclosed(grid, width, height) {
  // Flood the outside from the border; every cell it cannot reach is inside.
  const outside = new Uint8Array(grid.length);
  const stack = [];
  for (let x = 0; x < width; x += 1) stack.push(x, (height - 1) * width + x);
  for (let z = 0; z < height; z += 1) stack.push(z * width, z * width + width - 1);
  while (stack.length) {
    const index = stack.pop();
    if (outside[index] || grid[index]) continue;
    outside[index] = 1;
    const x = index % width, z = (index - x) / width;
    if (x > 0) stack.push(index - 1);
    if (x < width - 1) stack.push(index + 1);
    if (z > 0) stack.push(index - width);
    if (z < height - 1) stack.push(index + width);
  }
  for (let index = 0; index < grid.length; index += 1) if (!outside[index]) grid[index] = 1;
}

function mergeRectangles(grid, width, height) {
  const used = new Uint8Array(grid.length);
  const rectangles = [];
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = z * width + x;
      if (!grid[start] || used[start]) continue;
      let w = 1;
      while (x + w < width && grid[start + w] && !used[start + w]) w += 1;
      let h = 1;
      grow: while (z + h < height) {
        for (let k = 0; k < w; k += 1) {
          const index = (z + h) * width + x + k;
          if (!grid[index] || used[index]) break grow;
        }
        h += 1;
      }
      for (let dz = 0; dz < h; dz += 1) for (let k = 0; k < w; k += 1) used[(z + dz) * width + x + k] = 1;
      rectangles.push({ x, z, w, h });
    }
  }
  return rectangles;
}

/**
 * @param positions Float32Array-like xyz triples in the building's local frame (Y up).
 * @param index index array, or null for non-indexed triangles.
 * @param options.bandHeight  local-unit height above the lowest point treated as the ground floor.
 * @param options.cell        grid cell size in local units.
 * @param options.minArea     rectangles smaller than this (local units squared) are dropped.
 * @returns {{ minY, maxY, cells: {x,z,y}[], rectangles: {x,z,width,depth}[] }} centres/sizes in local units.
 */
export function computeFootprint(positions, index, { bandHeight, cell, minArea = 0 } = {}) {
  const count = positions.length / 3;
  let minY = Infinity, maxY = -Infinity;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const y = positions[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const top = minY + bandHeight;
  const triangleCount = index ? index.length / 3 : count / 3;
  const vertex = (i) => [positions[i * 3], positions[i * 3 + 2], positions[i * 3 + 1]];
  const band = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
    const va = vertex(a), vb = vertex(b), vc = vertex(c);
    if (Math.min(va[2], vb[2], vc[2]) > top) continue;
    band.push(va, vb, vc);
    for (const v of [va, vb, vc]) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minZ) minZ = v[1];
      if (v[1] > maxZ) maxZ = v[1];
    }
  }
  if (!band.length) return { minY, maxY, cells: [], rectangles: [] };
  // One empty cell of margin so the flood fill can walk around the outside.
  minX -= cell; minZ -= cell; maxX += cell; maxZ += cell;
  const width = Math.ceil((maxX - minX) / cell) + 1;
  const height = Math.ceil((maxZ - minZ) / cell) + 1;
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < band.length; i += 3) markTriangle(grid, width, height, cell, minX, minZ, band[i], band[i + 1], band[i + 2]);
  // Lowest geometry over each cell (triangle bounds, conservative): steps and
  // porches stand higher than the plinth, so grounding needs their own bottom.
  const bottom = new Float32Array(width * height).fill(Infinity);
  for (let i = 0; i < band.length; i += 3) {
    const [a, b, c] = [band[i], band[i + 1], band[i + 2]];
    const low = Math.min(a[2], b[2], c[2]);
    const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - minX) / cell));
    const x1 = Math.min(width - 1, Math.floor((Math.max(a[0], b[0], c[0]) - minX) / cell));
    const z0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - minZ) / cell));
    const z1 = Math.min(height - 1, Math.floor((Math.max(a[1], b[1], c[1]) - minZ) / cell));
    for (let z = z0; z <= z1; z += 1) for (let x = x0; x <= x1; x += 1) {
      if (low < bottom[z * width + x]) bottom[z * width + x] = low;
    }
  }
  fillEnclosed(grid, width, height);
  const cells = [];
  for (let z = 0; z < height; z += 1) for (let x = 0; x < width; x += 1) {
    const index = z * width + x;
    if (grid[index]) {
      cells.push({ x: minX + (x + 0.5) * cell, z: minZ + (z + 0.5) * cell, y: Number.isFinite(bottom[index]) ? bottom[index] : minY });
    }
  }
  const rectangles = mergeRectangles(grid, width, height)
    .map(({ x, z, w, h }) => ({
      x: minX + (x + w / 2) * cell, z: minZ + (z + h / 2) * cell, width: w * cell, depth: h * cell,
    }))
    .filter(({ width: w, depth: d }) => w * d >= minArea);
  return { minY, maxY, cells, rectangles };
}
