export const LOD_ORDER = Object.freeze(['high', 'medium', 'low', 'veryLow']);

export function toOdd(value) {
  const rounded = Math.max(1, Math.ceil(value));
  return rounded % 2 === 0 ? rounded + 1 : rounded;
}

export function computeGrassGrid({
  terrainSizeX,
  terrainSizeZ,
  tileSize,
  maxDistance,
  painterEnabled,
}) {
  const terrainTilesX = Math.ceil(terrainSizeX / tileSize);
  const terrainTilesZ = Math.ceil(terrainSizeZ / tileSize);
  const coverage = Math.ceil((maxDistance * 2) / tileSize);
  const gridSizeX = painterEnabled
    ? terrainTilesX
    : Math.min(terrainTilesX, coverage);
  const gridSizeZ = painterEnabled
    ? terrainTilesZ
    : Math.min(terrainTilesZ, coverage);

  return {
    terrainTilesX,
    terrainTilesZ,
    gridSizeX: toOdd(gridSizeX),
    gridSizeZ: toOdd(gridSizeZ),
  };
}

export function tileDistanceSquared(cameraX, cameraZ, tileX, tileZ, tileSize) {
  const half = tileSize * 0.5;
  const dx = Math.max(Math.abs(cameraX - tileX) - half, 0);
  const dz = Math.max(Math.abs(cameraZ - tileZ) - half, 0);
  return dx * dx + dz * dz;
}

export function tileOverlapsTerrain(tileX, tileZ, tileSize, bounds) {
  const half = tileSize * 0.5;
  return tileX + half > bounds.min.x
    && tileX - half < bounds.max.x
    && tileZ + half > bounds.min.z
    && tileZ - half < bounds.max.z;
}

export function terrainTileKey(tileX, tileZ, tileSize, bounds) {
  return `${Math.floor((tileX - bounds.min.x) / tileSize)},${Math.floor((tileZ - bounds.min.z) / tileSize)}`;
}

export function selectGrassLod(distanceSquared, maxDistance, lod) {
  for (const name of LOD_ORDER) {
    const threshold = lod[name].distance * maxDistance;
    if (distanceSquared < threshold * threshold) return name;
  }
  return 'veryLow';
}
