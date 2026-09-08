import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseGlb } from '../scripts/glb.mjs';
import {
  DEFAULT_PEBBLE_MAX_SIZE,
  DEFAULT_PEBBLE_PATTERN,
  isPebbleMesh,
  isRockMesh,
  ROCK_MESH_PATTERN,
} from '../src/world/rockPack.js';

const PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/Assets/terrain/props/free_pack_-_rocks_stylized.glb',
);
const FBX_SCALE = 0.01;

test('rock mesh names match the stylized pack convention', () => {
  assert.ok(ROCK_MESH_PATTERN.test('SM_Rocks_01_RocksStylized_M_0'));
  assert.equal(isRockMesh({ isMesh: true, name: 'SM_Rocks_10_RocksStylized_M_0' }), true);
  assert.equal(isRockMesh({ isMesh: true, name: 'Stone' }), false);
  assert.equal(DEFAULT_PEBBLE_PATTERN.test('SM_Rocks_06_RocksStylized_M_0'), true);
  assert.equal(DEFAULT_PEBBLE_PATTERN.test('SM_Rocks_01_RocksStylized_M_0'), false);
  assert.equal(isPebbleMesh('SM_Rocks_01_RocksStylized_M_0', 0.5), false);
  assert.equal(isPebbleMesh('SM_Rocks_11_RocksStylized_M_0', 0.72), true);
});

test('the stylized rock pack splits into landscape stones and path pebbles', () => {
  const { json } = parseGlb(readFileSync(PACK));
  const pebbles = [];
  const stones = [];
  for (const mesh of json.meshes) {
    const acc = json.accessors[mesh.primitives[0].attributes.POSITION];
    const size = Math.max(
      (acc.max[0] - acc.min[0]) * FBX_SCALE,
      (acc.max[1] - acc.min[1]) * FBX_SCALE,
      (acc.max[2] - acc.min[2]) * FBX_SCALE,
    );
    const name = mesh.name.replace(/_RocksStylized_M_0$/, '');
    (isPebbleMesh(mesh.name, size, DEFAULT_PEBBLE_MAX_SIZE) ? pebbles : stones).push(name);
  }
  assert.deepEqual(pebbles, ['SM_Rocks_06', 'SM_Rocks_07', 'SM_Rocks_10', 'SM_Rocks_11']);
  assert.deepEqual(stones, [
    'SM_Rocks_01',
    'SM_Rocks_02',
    'SM_Rocks_03',
    'SM_Rocks_04',
    'SM_Rocks_05',
    'SM_Rocks_08',
    'SM_Rocks_09',
  ]);
});
