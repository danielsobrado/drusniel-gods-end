// NPC kinds: pure data, shared by NpcSystem and the build-time preprocessing
// bake (scripts/bake-scene-preprocessing.mjs).
//
// Villager ambles around the medieval village; the goblin roams the lake shore
// and alternates walking and running. Clip names follow the roster convention
// (the rigs ship Running/Walking/restpose on the same 28-joint skeleton).
//
// Heights are ratios of a human under the world-scale contract (config
// world.scale.humanHeight, 5 units), not real metres: a raw 1.8 m NPC read as a
// doll and disappeared in the grass. A farmer is a human, so exactly the
// contract height and the same as the avatar (at 1.425 he stood 2.5
// human-metres tall, over the house doors). A goblin is a species just under
// human height.
export const NPC_KINDS = Object.freeze({
  villager: {
    model: 'Assets/Villager_Rugged_Blacks.glb',
    heightRatio: 1,
    clips: { idle: 'restpose', walk: 'Walking', run: 'Running' },
  },
  goblin: {
    model: 'Assets/Goblin_Gribble_Thornhide.glb',
    heightRatio: 0.93,
    clips: { idle: 'restpose', walk: 'Walking', run: 'Running' },
  },
});
