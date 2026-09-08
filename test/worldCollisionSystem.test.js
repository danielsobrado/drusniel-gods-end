import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldCollisionSystem } from '../src/physics/WorldCollisionSystem.js';

test('dispose removes owned bodies and releases runtime references', () => {
  const removed = [];
  const world = { removeRigidBody: body => removed.push(body) };
  const player = {};
  const scene = {};
  const first = {};
  const second = {};
  const system = new WorldCollisionSystem({ physics: { world }, player, scene });
  system.colliders.push({ body: first }, { body: second });

  system.dispose();

  assert.deepEqual(removed, [first, second]);
  assert.equal(system.colliders.length, 0);
  assert.equal(system.world, null);
  assert.equal(system.player, null);
  assert.equal(system.scene, null);

  system.dispose();
  assert.deepEqual(removed, [first, second]);
});
