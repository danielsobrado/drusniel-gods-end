import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const PLAYER_ASSET = 'Assets/Drunsiel_Warden_biped_Animation_Running_withSkin.glb';
const MOVEMENT_CLIP = 'Armature|running|baselayer';

function readGlbJson(path) {
  const data = readFileSync(path);
  assert.equal(data.readUInt32LE(0), GLB_MAGIC);
  assert.equal(data.readUInt32LE(4), 2);

  let offset = 12;
  while (offset < data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === JSON_CHUNK) {
      return JSON.parse(data.subarray(start, start + length).toString('utf8'));
    }
    offset = start + length;
  }
  throw new Error('GLB JSON chunk not found');
}

function nodeIndexByName(nodes, name) {
  return nodes.findIndex((node) => node.name === name);
}

test('configured player uses the Drunsiel Warden movement asset', async () => {
  const config = await loadMergedConfig();
  assert.equal(config.assets.player, PLAYER_ASSET);
  assert.equal(config.player.modelOffsetY, 0);
  assert.equal(config.player.animations.idle, null);
  assert.equal(config.player.animations.walk, MOVEMENT_CLIP);
  assert.equal(config.player.animations.run, MOVEMENT_CLIP);
  assert.equal(config.player.influenceObjects, undefined);
});

test('Drunsiel Warden GLB keeps its movement clip and skinned mesh', () => {
  const gltf = readGlbJson(new URL(`../public/${PLAYER_ASSET}`, import.meta.url));
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const skins = gltf.skins ?? [];
  const animationNames = (gltf.animations ?? []).map((animation) => animation.name);

  assert.deepEqual(animationNames, [MOVEMENT_CLIP]);
  assert.equal(skins.length, 1);
  assert.equal(skins[0].name, 'Armature');
  assert.equal(skins[0].joints?.length, 24);

  const characterIndex = nodeIndexByName(nodes, 'char1');
  assert.notEqual(characterIndex, -1, 'char1 mesh is missing');
  const character = nodes[characterIndex];
  assert.equal(character.skin, 0);

  for (const primitive of meshes[character.mesh]?.primitives ?? []) {
    assert.ok(primitive.attributes?.JOINTS_0 !== undefined, 'char1 is missing JOINTS_0');
    assert.ok(primitive.attributes?.WEIGHTS_0 !== undefined, 'char1 is missing WEIGHTS_0');
  }
});
