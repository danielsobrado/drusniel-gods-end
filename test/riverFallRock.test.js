import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { findRiverFalls, measureRiverSurface } from '../src/water/RiverCourse.js';
import { RiverDetails } from '../src/water/RiverDetails.js';

// A straight river running north: level, a 30 m drop, level again.
function createRiver() {
  const level = i => i < 50 ? 40 : i < 70 ? 40 - (i - 50) * 1.5 : 10;
  const samples = Array.from({ length: 140 }, (_, i) => ({
    x: 0, z: i * 1.5, y: level(i), s: i * 1.5, width: 8, dx: 0, dz: 1, outletProgress: 0, bankBlend: 7,
  }));
  measureRiverSurface(samples);
  return { samples, lakeLevel: -100, sample: () => null };
}

// Ground a little above the water, rising away from the channel.
const terrain = {
  config: { water: { sea: { enabled: false } } },
  sampleHeight: (x, z) => {
    const i = THREE.MathUtils.clamp(Math.round(z / 1.5), 0, 139);
    return (i < 50 ? 40 : i < 70 ? 40 - (i - 50) * 1.5 : 10) + 0.6 + Math.abs(x) * 0.12;
  },
};

function stones(river) {
  const details = new RiverDetails(new THREE.Scene(), river, terrain, []);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const result = [];
  for (const mesh of details.meshes) {
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      result.push({ x: position.x, y: position.y, z: position.z, scale: scale.z, key: matrix.elements.map(v => v.toFixed(4)).join() });
    }
  }
  details.dispose();
  return result;
}

test('falls get their own grouped rock, and every other stone keeps its place', () => {
  const plain = stones({ ...createRiver(), falls: [] });
  const river = createRiver();
  const [fall] = findRiverFalls(river.samples);
  assert.ok(fall, 'the test river has a fall');
  const withFalls = stones(river);
  const zone = [river.samples[fall.lip - 3].z - 3, river.samples[Math.min(139, fall.foot + 8)].z + 3];
  const inZone = stone => stone.z >= zone[0] && stone.z <= zone[1] && Math.abs(stone.x) < 30;

  // Stones away from the fall, the upland boulders included, are unchanged.
  const kept = new Set(withFalls.map(stone => stone.key));
  const elsewhere = plain.filter(stone => !inZone(stone));
  assert.ok(elsewhere.length > 100);
  assert.deepEqual(elsewhere.filter(stone => !kept.has(stone.key)).length, 0);

  // The fall is rockier than the bank loop left it, with boulders at the lip.
  const fallRock = withFalls.filter(inZone);
  assert.ok(fallRock.length > plain.filter(inZone).length, `${fallRock.length} stones at the fall`);
  const lipZ = river.samples[fall.lip].z;
  assert.ok(fallRock.filter(stone => stone.scale > 2.4 && Math.abs(stone.z - lipZ) < 4).length >= 2, 'lip boulders');
  // Sizes are skewed small: most stones are far smaller than the largest.
  const sizes = fallRock.map(stone => stone.scale).sort((a, b) => a - b);
  assert.ok(sizes[Math.floor(sizes.length / 2)] < sizes.at(-1) * 0.5);
  // No stone floats: each rests on or in the ground under it.
  for (const stone of fallRock) assert.ok(stone.y <= terrain.sampleHeight(stone.x, stone.z) + 1e-6, `floating at ${stone.x},${stone.z}`);
});
