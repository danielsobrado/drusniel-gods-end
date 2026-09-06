import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyCharacter,
  defaultCharacterId,
  findCharacter,
  getRoster,
  requestedCharacterId,
} from '../src/config/characterRoster.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const JSON_CHUNK = 0x4e4f534a;

function readGlbJson(path) {
  const data = readFileSync(path);
  let offset = 12;
  while (offset < data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === JSON_CHUNK) return JSON.parse(data.subarray(start, start + length).toString('utf8'));
    offset = start + length;
  }
  throw new Error('GLB JSON chunk not found');
}

test('the roster offers Drusniel, Enanillo and the Paladin, defaulting to Drusniel', async () => {
  const config = await loadMergedConfig();
  assert.deepEqual(getRoster(config).map((entry) => entry.id), ['drusniel', 'enanillo', 'paladin']);
  assert.equal(defaultCharacterId(config), 'drusniel');
});

test('every roster model and animation source resolves to a shipped GLB', async () => {
  const config = await loadMergedConfig();
  for (const entry of getRoster(config)) {
    for (const asset of [entry.model, ...entry.player?.animationSources ?? []]) {
      const gltf = readGlbJson(new URL(`../public/${asset}`, import.meta.url));
      assert.equal(gltf.skins?.[0]?.joints?.length, 24, `${asset} is not the shared 24-joint rig`);
    }
  }
});

test('each character names clips that exist in its own assets', async () => {
  const config = await loadMergedConfig();
  for (const entry of getRoster(config)) {
    const available = [entry.model, ...entry.player?.animationSources ?? []]
      .flatMap((asset) => readGlbJson(new URL(`../public/${asset}`, import.meta.url)).animations ?? [])
      .map((animation) => animation.name);

    for (const key of ['walk', 'run']) {
      const clip = entry.player?.animations?.[key];
      assert.ok(available.includes(clip), `${entry.id} ${key} clip "${clip}" is missing from its assets`);
    }
  }
});

test('applying the default character leaves the shipped player config untouched', async () => {
  const config = await loadMergedConfig();
  const before = structuredClone(config.player);
  const character = applyCharacter(config, defaultCharacterId(config));

  assert.equal(character.id, 'drusniel');
  assert.equal(config.assets.player, 'Assets/Drusniel_Dark_Elf.glb');
  assert.equal(config.player.targetHeight, before.targetHeight);
  assert.deepEqual(config.player.animations, before.animations);
  assert.equal(config.characters.selected, 'drusniel');
});

test('applying Enanillo swaps the model, the proportions and the walk clip', async () => {
  const config = await loadMergedConfig();
  const character = applyCharacter(config, 'enanillo');

  assert.equal(character.id, 'enanillo');
  // Both rigs share a forward axis, so facing stays a global setting.
  assert.equal(config.player.modelRotationY, 0);
  assert.equal(config.assets.player, 'Assets/Enanillo_Dwarven.glb');
  assert.ok(config.player.targetHeight < 5, 'the dwarf should be shorter than the warden');
  // Both clips are baked into the one GLB, so nothing is borrowed at runtime.
  assert.deepEqual(config.player.animationSources, []);
  assert.equal(config.player.animations.walk, 'Armature|walking_man|baselayer');
  assert.equal(config.player.animations.run, 'Armature|running|baselayer');
});

test('applying a character does not mutate the roster it was read from', async () => {
  const config = await loadMergedConfig();
  applyCharacter(config, 'enanillo');
  config.player.animations.walk = 'overwritten';

  assert.equal(findCharacter(config, 'enanillo').player.animations.walk, 'Armature|walking_man|baselayer');
});

test('an unknown character falls back to the default', async () => {
  const config = await loadMergedConfig();
  assert.equal(applyCharacter(config, 'nobody').id, 'drusniel');
});

test('the character query parameter only honours a known id', async () => {
  const config = await loadMergedConfig();
  assert.equal(requestedCharacterId('?character=enanillo', config), 'enanillo');
  assert.equal(requestedCharacterId('?character=goblin', config), null);
  assert.equal(requestedCharacterId('', config), null);
});
