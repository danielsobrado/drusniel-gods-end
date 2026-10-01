// Static structures placed from GLBs: pure data, shared by StructureSystem and
// the build-time preprocessing bake (scripts/bake-scene-preprocessing.mjs).
const VILLAGE_DIR = 'Assets/terrain/structures/medieval';
// Village layout, chosen on 2026-09-23 at contract scale by searching near the
// original spots for the least terrain relief under each ground-floor
// footprint, at least 4 units from any tree trunk and 6 from the next house.
// (The original spots had the blacksmith and a tavern touching, and a tree
// growing through that tavern.) Relief left is 1-5 units (under 2 m real).
// Each house is generated (src/world/village) unless the village source is
// 'glb', which loads the original baked models instead for A/B comparison.
const HOUSES = Object.freeze([
  { id: '003', file: 'medieval-house-003', x: -178, z: -346, rotationY: 0.5 },
  { id: '004', file: 'medieval-house-004-tavern', x: -246, z: -304, rotationY: -0.7 },
  { id: '005', file: 'medieval-house-005-blacksmith', x: -228, z: -266, rotationY: 1.3 },
  { id: '006', file: 'medieval-house-006-residential', x: -214, z: -332, rotationY: -1.1 },
  { id: '009', file: 'medieval-house-009-tavern', x: -188, z: -302, rotationY: 0.15 },
]);
// A farming hamlet in the open meadow inside the lake's western bend
// (2026-09-26): among the flattest ground there (relief under 3 units under a
// footprint), at least 30 units back from the shore, clear of the goblins'
// shore range, and 11+ apart. Two farmers work the field west of them (NpcSystem).
const LAKE_HOUSES = Object.freeze([
  { id: '003', file: 'medieval-house-003', x: 386, z: 236, rotationY: 2.1 },
  { id: '006', file: 'medieval-house-006-residential', x: 386, z: 292, rotationY: 1.4 },
  { id: '009', file: 'medieval-house-009-tavern', x: 366, z: 350, rotationY: 0.9 },
]);
export const PLACEMENTS = Object.freeze([
  ...[['Village', HOUSES], ['LakeVillage', LAKE_HOUSES]].flatMap(([group, houses]) => houses.map((house) => ({
    group,
    path: `${VILLAGE_DIR}/${house.file}.glb`,
    procedural: house.id,
    rotationY: house.rotationY,
    collide: true,
    metres: true,
    x: house.x,
    z: house.z,
  }))),
  // On the lake bed under the scenic tour's lake dive (surface -17, ~7 m deep).
  // No collider: nothing walks down there.
  { group: 'LakeProps', path: 'Assets/terrain/props/sunken-chest.glb', x: 485, z: 260, rotationY: 0.6, sink: 0.35 },
]);

/**
 * 'procedural' (default) or 'glb': `?village=glb` or config
 * `world.village.source: glb` brings back the original baked houses.
 */
export function resolveVillageSource(config, search = globalThis.location?.search ?? '') {
  const requested = new URLSearchParams(search).get('village') ?? config?.world?.village?.source;
  return requested === 'glb' ? 'glb' : 'procedural';
}
