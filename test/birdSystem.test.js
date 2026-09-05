import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BirdSystem } from '../src/foliage/BirdSystem.js';
import { createRandom } from '../src/utils/random.js';

function range(random, min, max) {
  return min + random() * (max - min);
}

function config() {
  return {
    birds: {
      sourceName: 'Birds',
      count: 1,
      minHeight: 5,
      maxHeight: 10,
      minOrbitRadius: 50,
      maxOrbitRadius: 200,
      minSpeed: 0.15,
      maxSpeed: 0.25,
      minScale: 3,
      maxScale: 5,
      bobAmount: 0.4,
      bobSpeed: 999,
      edgePadding: 20,
      randomSeed: 1234,
      orbitCenter: [0, 100, 0],
    },
  };
}

test('birds use the recovered seeded orbit layout and signed direction', () => {
  const scene = new THREE.Scene();
  const terrainRoot = new THREE.Group();
  const source = new THREE.Group();
  source.name = 'Birds';
  source.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  terrainRoot.add(source);

  const system = new BirdSystem({
    scene,
    terrainRoot,
    clips: [],
    terrainSampler: { bounds: new THREE.Box3() },
    config: config(),
  });

  const random = createRandom(1234);
  const expectedRadius = range(random, 50, 200);
  const expectedAngle = range(random, 0, Math.PI * 2);
  const expectedSpeed = range(random, 0.15, 0.25);
  const expectedHeight = range(random, 5, 10);
  const expectedScale = range(random, 3, 5);
  const expectedDirection = random() > 0.5 ? 1 : -1;
  const expectedBobOffset = range(random, 0, Math.PI * 2);
  const entry = system.entries[0];

  assert.equal(source.visible, true);
  assert.equal(entry.radius, expectedRadius);
  assert.equal(entry.angle, expectedAngle);
  assert.equal(entry.speed, expectedSpeed);
  assert.equal(entry.height, expectedHeight);
  assert.equal(entry.scale, expectedScale);
  assert.equal(entry.direction, expectedDirection);
  assert.equal(entry.bobOffset, expectedBobOffset);
  assert.deepEqual(entry.group.position.toArray(), [0, 100, 0]);
  assert.equal(entry.bird.position.x, expectedRadius);
  assert.equal(entry.bird.position.y, expectedHeight);
  assert.equal(entry.bird.position.z, 0);
  assert.deepEqual(entry.bird.scale.toArray(), [expectedScale, expectedScale, expectedScale]);

  system.dispose();
});

test('bird bobbing is tied to orbit angle, not the legacy bobSpeed key', () => {
  const scene = new THREE.Scene();
  const terrainRoot = new THREE.Group();
  const source = new THREE.Group();
  source.name = 'Birds';
  terrainRoot.add(source);

  const system = new BirdSystem({
    scene,
    terrainRoot,
    clips: [],
    terrainSampler: { bounds: new THREE.Box3() },
    config: config(),
  });

  const entry = system.entries[0];
  const startAngle = entry.angle;
  system.update(0.5);
  const expectedAngle = startAngle + entry.speed * entry.direction * 0.5;

  assert.equal(entry.angle, expectedAngle);
  assert.equal(entry.group.rotation.y, expectedAngle);
  assert.equal(entry.bird.position.y, entry.height + Math.sin(expectedAngle + entry.bobOffset) * 0.4);

  system.dispose();
});
