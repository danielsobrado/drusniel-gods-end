import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainAnimationSystem } from '../src/world/TerrainAnimationSystem.js';

test('terrain animations start every clip in repeat mode', () => {
  const root = new THREE.Object3D();
  root.name = 'TerrainRoot';
  const clipA = new THREE.AnimationClip('A', 1, []);
  const clipB = new THREE.AnimationClip('B', 1, []);
  const system = new TerrainAnimationSystem(root, [clipA, clipB]).init();

  assert.equal(system.actions.length, 2);
  for (const action of system.actions) {
    assert.equal(action.loop, THREE.LoopRepeat);
    assert.equal(action.repetitions, Infinity);
    assert.equal(action.isRunning(), true);
  }

  system.update(1 / 60);
  system.dispose();
  assert.equal(system.actions.length, 0);
});
