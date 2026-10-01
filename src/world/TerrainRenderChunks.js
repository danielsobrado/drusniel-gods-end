import * as THREE from 'three/webgpu';

const AUTHORED_HALF_SIZE = 480;
const AUTHORED_SIZE = AUTHORED_HALF_SIZE * 2;
const LOD_NEAR = 0;
const LOD_MID = 1;
const LOD_FAR = 2;
const DEFAULTS = Object.freeze({
  cellSize: 100,
  midDistance: 260,
  farDistance: 650,
  hysteresis: 24,
  midStep: 10,
  farStep: 25,
  skirtDepth: 4,
});

function resolveSettings(config) {
  const configured = config.terrain?.expansion?.renderChunks ?? {};
  return {
    enabled: configured.enabled !== false,
    cellSize: Number(configured.cellSize ?? DEFAULTS.cellSize),
    midDistance: Number(configured.midDistance ?? DEFAULTS.midDistance),
    farDistance: Number(configured.farDistance ?? DEFAULTS.farDistance),
    hysteresis: Number(configured.hysteresis ?? DEFAULTS.hysteresis),
    midStep: Number(configured.midStep ?? DEFAULTS.midStep),
    farStep: Number(configured.farStep ?? DEFAULTS.farStep),
    skirtDepth: Number(configured.skirtDepth ?? DEFAULTS.skirtDepth),
  };
}

function cellAt(cells, x, z) {
  let column = cells.get(x);
  if (!column) {
    column = new Map();
    cells.set(x, column);
  }
  let cell = column.get(z);
  if (!cell) {
    cell = { x, z, indices: [] };
    column.set(z, cell);
  }
  return cell;
}

function compactExactGeometry(source, indices) {
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  const sourceUv = source.getAttribute('uv');
  const positions = [];
  const normals = [];
  const uvs = [];
  const remapped = [];
  const vertices = new Map();

  for (const sourceIndex of indices) {
    let targetIndex = vertices.get(sourceIndex);
    if (targetIndex === undefined) {
      targetIndex = vertices.size;
      vertices.set(sourceIndex, targetIndex);
      positions.push(
        sourcePosition.getX(sourceIndex),
        sourcePosition.getY(sourceIndex),
        sourcePosition.getZ(sourceIndex),
      );
      if (sourceNormal) {
        normals.push(
          sourceNormal.getX(sourceIndex),
          sourceNormal.getY(sourceIndex),
          sourceNormal.getZ(sourceIndex),
        );
      }
      if (sourceUv) uvs.push(sourceUv.getX(sourceIndex), sourceUv.getY(sourceIndex));
    }
    remapped.push(targetIndex);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (uvs.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(remapped);
  if (!normals.length) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// `depth` is a number, or a function of the segment's two boundary vertices
// returning { down, up }: how far the skirt reaches below the edge and above it.
function addSkirt(positions, uvs, indices, boundary, depth) {
  if (boundary.length < 2) return;
  for (let i = 0; i < boundary.length - 1; i += 1) {
    const a = boundary[i];
    const b = boundary[i + 1];
    const reach = typeof depth === 'function' ? depth(a, b) : { down: depth, up: 0 };
    const segmentDepth = reach.down;
    const rise = reach.up;
    if (!(segmentDepth > 0)) continue;
    const ap = a * 3;
    const bp = b * 3;
    const au = a * 2;
    const bu = b * 2;
    const topA = positions.length / 3;
    positions.push(positions[ap], positions[ap + 1] + rise, positions[ap + 2]);
    uvs.push(uvs[au], uvs[au + 1]);
    const topB = positions.length / 3;
    positions.push(positions[bp], positions[bp + 1] + rise, positions[bp + 2]);
    uvs.push(uvs[bu], uvs[bu + 1]);
    const bottomA = positions.length / 3;
    positions.push(positions[ap], positions[ap + 1] - segmentDepth, positions[ap + 2]);
    uvs.push(uvs[au], uvs[au + 1]);
    const bottomB = positions.length / 3;
    positions.push(positions[bp], positions[bp + 1] - segmentDepth, positions[bp + 2]);
    uvs.push(uvs[bu], uvs[bu + 1]);
    indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
  }
}

function simplifiedGeometry(cell, target, terrainSampler, settings, step) {
  const cellMinX = cell.x * settings.cellSize;
  const cellMaxX = (cell.x + 1) * settings.cellSize;
  const cellMinZ = cell.z * settings.cellSize;
  const cellMaxZ = (cell.z + 1) * settings.cellSize;
  const minX = Math.max(cellMinX, terrainSampler.bounds.min.x);
  const maxX = Math.min(cellMaxX, terrainSampler.bounds.max.x);
  const minZ = Math.max(cellMinZ, terrainSampler.bounds.min.z);
  const maxZ = Math.min(cellMaxZ, terrainSampler.bounds.max.z);
  if (!(maxX > minX) || !(maxZ > minZ)) return null;

  const segmentsX = Math.max(1, Math.ceil((maxX - minX) / step));
  const segmentsZ = Math.max(1, Math.ceil((maxZ - minZ) / step));
  const positions = [];
  const uvs = [];
  const indices = [];
  // World XZ of each grid vertex, for measuring the skirt each edge needs.
  const worldXZ = [];
  const inverse = target.matrixWorld.clone().invert();
  const point = new THREE.Vector3();

  for (let z = 0; z <= segmentsZ; z += 1) {
    const worldZ = THREE.MathUtils.lerp(minZ, maxZ, z / segmentsZ);
    for (let x = 0; x <= segmentsX; x += 1) {
      const worldX = THREE.MathUtils.lerp(minX, maxX, x / segmentsX);
      worldXZ.push(worldX, worldZ);
      point.set(worldX, terrainSampler.sampleHeight(worldX, worldZ), worldZ).applyMatrix4(inverse);
      positions.push(point.x, point.y, point.z);
      uvs.push(
        (worldX + AUTHORED_HALF_SIZE) / AUTHORED_SIZE,
        1 - (worldZ + AUTHORED_HALF_SIZE) / AUTHORED_SIZE,
      );
    }
  }

  const row = segmentsX + 1;
  for (let z = 0; z < segmentsZ; z += 1) {
    for (let x = 0; x < segmentsX; x += 1) {
      const a = z * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const top = Array.from({ length: row }, (_, x) => x);
  const bottom = Array.from({ length: row }, (_, x) => segmentsZ * row + x).reverse();
  const left = Array.from({ length: segmentsZ + 1 }, (_, z) => z * row).reverse();
  const right = Array.from({ length: segmentsZ + 1 }, (_, z) => z * row + segmentsX);
  // A coarse edge cuts straight across what the neighbouring (finer) chunk
  // follows exactly: on the gorge walls up to 24 units apart, so a fixed
  // 4-unit skirt left slits of sky that came and went as chunks changed LOD.
  // Each segment's skirt reaches past the deepest point the true surface dips
  // below its straight edge, and up to its highest point above it (there the
  // gap faces the exact near chunk, which has no skirt), sampled every unit.
  const unitsY = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 1).length() || 1;
  const skirtDepth = (a, b) => {
    const ax = worldXZ[a * 2], az = worldXZ[a * 2 + 1], bx = worldXZ[b * 2], bz = worldXZ[b * 2 + 1];
    const ha = terrainSampler.sampleHeight(ax, az), hb = terrainSampler.sampleHeight(bx, bz);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
    let below = 0, above = 0;
    for (let k = 1; k < steps; k += 1) {
      const t = k / steps;
      const offset = ha + (hb - ha) * t - terrainSampler.sampleHeight(ax + (bx - ax) * t, az + (bz - az) * t);
      below = Math.max(below, offset);
      above = Math.max(above, -offset);
    }
    return { down: (settings.skirtDepth + below) / unitsY, up: above / unitsY };
  };
  addSkirt(positions, uvs, indices, top, skirtDepth);
  addSkirt(positions, uvs, indices, right, skirtDepth);
  addSkirt(positions, uvs, indices, bottom, skirtDepth);
  addSkirt(positions, uvs, indices, left, skirtDepth);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createBatch(name, descriptors, level, material) {
  const geometries = descriptors.map(descriptor => descriptor.geometries[level]);
  const maxVertices = geometries.reduce(
    (total, geometry) => total + geometry.getAttribute('position').count,
    0,
  );
  const maxIndices = geometries.reduce((total, geometry) => total + geometry.index.count, 0);
  const batch = new THREE.BatchedMesh(descriptors.length, maxVertices, maxIndices, material);
  batch.name = name;
  batch.castShadow = false;
  batch.receiveShadow = true;
  batch.frustumCulled = true;
  batch.perObjectFrustumCulled = true;
  batch.sortObjects = false;
  batch.userData.occlusionCull = false;
  batch.userData.terrainRenderChunk = true;
  const identity = new THREE.Matrix4();

  for (const descriptor of descriptors) {
    const geometry = descriptor.geometries[level];
    const geometryId = batch.addGeometry(geometry);
    const instanceId = batch.addInstance(geometryId);
    batch.setMatrixAt(instanceId, identity);
    batch.setVisibleAt(instanceId, false);
    descriptor.instances[level] = instanceId;
    geometry.dispose();
  }
  return batch;
}

export function chooseTerrainLod(distance, current, settings) {
  const hysteresis = Math.max(0, settings.hysteresis);
  if (current === LOD_NEAR) {
    if (distance > settings.farDistance + hysteresis) return LOD_FAR;
    if (distance > settings.midDistance + hysteresis) return LOD_MID;
    return LOD_NEAR;
  }
  if (current === LOD_MID) {
    if (distance < settings.midDistance - hysteresis) return LOD_NEAR;
    if (distance > settings.farDistance + hysteresis) return LOD_FAR;
    return LOD_MID;
  }
  if (current === LOD_FAR) {
    if (distance < settings.midDistance - hysteresis) return LOD_NEAR;
    if (distance < settings.farDistance - hysteresis) return LOD_MID;
    return LOD_FAR;
  }
  if (distance < settings.midDistance) return LOD_NEAR;
  if (distance < settings.farDistance) return LOD_MID;
  return LOD_FAR;
}

export function createTerrainRenderChunks(scene, target, terrainSampler, config) {
  const settings = resolveSettings(config);
  if (!settings.enabled || !scene || !target?.isMesh || !target.geometry?.index
    || !target.geometry?.attributes?.position || !terrainSampler?.ready) return null;

  target.updateWorldMatrix(true, false);
  const source = target.geometry;
  const position = source.attributes.position;
  const index = source.index;
  const matrix = target.matrixWorld.elements;
  const cells = new Map();

  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
    const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const cell = cellAt(
      cells,
      Math.floor(worldX / settings.cellSize),
      Math.floor(worldZ / settings.cellSize),
    );
    cell.indices.push(a, b, c);
  }

  const descriptors = [];
  for (const column of cells.values()) {
    for (const cell of column.values()) {
      const near = compactExactGeometry(source, cell.indices);
      const mid = simplifiedGeometry(cell, target, terrainSampler, settings, settings.midStep);
      const far = simplifiedGeometry(cell, target, terrainSampler, settings, settings.farStep);
      if (!mid || !far) {
        near.dispose();
        mid?.dispose();
        far?.dispose();
        continue;
      }
      const minX = Math.max(cell.x * settings.cellSize, terrainSampler.bounds.min.x);
      const maxX = Math.min((cell.x + 1) * settings.cellSize, terrainSampler.bounds.max.x);
      const minZ = Math.max(cell.z * settings.cellSize, terrainSampler.bounds.min.z);
      const maxZ = Math.min((cell.z + 1) * settings.cellSize, terrainSampler.bounds.max.z);
      const worldBounds = near.boundingBox.clone().applyMatrix4(target.matrixWorld);
      descriptors.push({
        centerX: (minX + maxX) * 0.5,
        centerZ: (minZ + maxZ) * 0.5,
        minY: worldBounds.min.y,
        maxY: worldBounds.max.y,
        radius: Math.hypot(maxX - minX, maxZ - minZ) * 0.5,
        geometries: [near, mid, far],
        triangles: [near.index.count / 3, mid.index.count / 3, far.index.count / 3],
        instances: [-1, -1, -1],
        level: -1,
      });
    }
  }
  if (!descriptors.length) return null;

  const group = new THREE.Group();
  group.name = 'Terrain render chunks';
  group.matrix.copy(target.matrixWorld);
  group.matrixAutoUpdate = false;
  const batches = [
    createBatch('Terrain near batch', descriptors, LOD_NEAR, target.material),
    createBatch('Terrain mid batch', descriptors, LOD_MID, target.material),
    createBatch('Terrain far batch', descriptors, LOD_FAR, target.material),
  ];
  for (const batch of batches) {
    batch.renderOrder = target.renderOrder;
    group.add(batch);
  }
  scene.add(group);

  const previousVisible = target.visible;
  const previousSkipWarmup = target.userData.skipWarmup;
  target.visible = false;
  target.userData.skipWarmup = true;
  const cameraPosition = new THREE.Vector3();
  const stats = {
    chunks: descriptors.length,
    batches: batches.length,
    sourceTriangles: descriptors.reduce((sum, chunk) => sum + chunk.triangles[LOD_NEAR], 0),
    midTriangles: descriptors.reduce((sum, chunk) => sum + chunk.triangles[LOD_MID], 0),
    farTriangles: descriptors.reduce((sum, chunk) => sum + chunk.triangles[LOD_FAR], 0),
    near: 0,
    mid: 0,
    far: 0,
    activeTriangles: 0,
    underwater3d: false,
  };

  const update = (camera, options = {}) => {
    if (!camera) return stats;
    camera.getWorldPosition(cameraPosition);
    const underwaterDepth = Number(options.underwaterDepth);
    const underwater3dLodDepth = Number(options.underwater3dLodDepth);
    const useUnderwater3d = Number.isFinite(underwaterDepth)
      && Number.isFinite(underwater3dLodDepth)
      && underwaterDepth >= Math.max(0, underwater3dLodDepth);
    stats.underwater3d = useUnderwater3d;
    stats.near = 0;
    stats.mid = 0;
    stats.far = 0;
    stats.activeTriangles = 0;
    for (const chunk of descriptors) {
      const horizontalDistance = Math.max(
        0,
        Math.hypot(cameraPosition.x - chunk.centerX, cameraPosition.z - chunk.centerZ) - chunk.radius,
      );
      let distance = horizontalDistance;
      if (useUnderwater3d) {
        const verticalDistance = cameraPosition.y < chunk.minY
          ? chunk.minY - cameraPosition.y
          : cameraPosition.y > chunk.maxY ? cameraPosition.y - chunk.maxY : 0;
        distance = Math.hypot(horizontalDistance, verticalDistance);
      }
      const level = chooseTerrainLod(distance, chunk.level, settings);
      if (level !== chunk.level) {
        if (chunk.level >= 0) batches[chunk.level].setVisibleAt(chunk.instances[chunk.level], false);
        batches[level].setVisibleAt(chunk.instances[level], true);
        chunk.level = level;
      }
      if (level === LOD_NEAR) stats.near += 1;
      else if (level === LOD_MID) stats.mid += 1;
      else stats.far += 1;
      stats.activeTriangles += chunk.triangles[level];
    }
    return stats;
  };

  let disposed = false;
  return {
    group,
    chunks: descriptors,
    batches,
    settings,
    stats,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      for (const batch of batches) batch.dispose();
      target.visible = previousVisible;
      target.userData.skipWarmup = previousSkipWarmup;
    },
  };
}
