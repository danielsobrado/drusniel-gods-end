export const TERRAIN_BAKE_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
  );
}

function geometryConfig(config) {
  const expansion = { ...(config.terrain?.expansion ?? {}) };
  delete expansion.baked;
  delete expansion.renderChunks;
  return {
    version: TERRAIN_BAKE_VERSION,
    terrain: {
      targetMeshName: config.terrain?.targetMeshName,
      scale: config.terrain?.scale,
      position: config.terrain?.position,
      rotationY: config.terrain?.rotationY,
      heightResolution: config.terrain?.heightResolution,
      expansion,
      alpine: config.terrain?.alpine,
    },
    water: {
      position: config.water?.position,
      sea: config.water?.sea,
      river: config.water?.river,
      lake: config.water?.lake,
    },
  };
}

export function createTerrainBakeFingerprint(config) {
  const input = JSON.stringify(canonicalize(geometryConfig(config)));
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${TERRAIN_BAKE_VERSION}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
