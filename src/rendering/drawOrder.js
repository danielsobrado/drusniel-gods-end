// Opaque draw order. The foliage shaders discard (alpha test, LOD dither,
// alpha to coverage), which stops the GPU writing depth early but not testing
// it early: a fragment behind depth already written is rejected before it is
// shaded. What gets drawn first therefore decides how much is shaded twice.
//
// Three sorts opaque draws by renderOrder, then by the depth of the geometry's
// bounding-sphere centre. Instanced and batched meshes that sit at the world
// origin (trees, grass, terrain chunks) all tie on that depth and fall back to
// creation order, which drew the terrain first, under every blade and tree,
// and the tree stages in no particular order. At 3440x1440 this order took the
// main pass from about 10 ms to 7 ms of GPU time with an identical image.
//
// Only known occluders are pulled ahead, with negative orders. The terrain and
// any opaque object not listed here stay at 0, so whatever draws over the
// terrain today keeps its place relative to it. Transparent draws are sorted
// on their own after every opaque one and are left alone.
export const DRAW_ORDER = Object.freeze({
  // Rocks, lanterns, scatter and houses: solid, cheap, and in front of what
  // grows around them.
  props: -60,
  // Near grass batches, nearest band first (high .. veryLow).
  nearGrass: -50,
  // Vegetation LOD stages, nearest first (full, medium, low, billboard).
  vegetationStage: -40,
  // Wild grass, understory, meadow details and biome cards.
  foliage: -30,
  farGrass: -20,
});

const NEAR_GRASS_LODS = ['high', 'medium', 'low', 'veryLow'];

export function nearGrassDrawOrder(lodName) {
  const index = NEAR_GRASS_LODS.indexOf(lodName);
  return DRAW_ORDER.nearGrass + (index < 0 ? NEAR_GRASS_LODS.length - 1 : index);
}

export function vegetationStageDrawOrder(level) {
  return DRAW_ORDER.vegetationStage + Math.min(3, Math.max(0, Math.trunc(Number(level) || 0)));
}

// Transparent draws have their own sort; reordering one would change blending.
export function setOpaqueDrawOrder(object, order) {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  if (materials.some(material => !material || material.transparent)) return false;
  object.renderOrder = order;
  return true;
}
