import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { WorldCollisionSystem } from '../src/physics/WorldCollisionSystem.js';

function mockCollider() {
  return {
    enabled: true,
    setEnabled(value) { this.enabled = Boolean(value); },
  };
}

test('prepared convex colliders require group enabled and proximity', () => {
  const player = { getWorldPosition(target) { return target.set(0, 0, 0); } };
  const removed = [];
  const world = {
    createCollider: () => mockCollider(),
    removeRigidBody: (body) => removed.push(body),
  };
  const system = new WorldCollisionSystem({
    physics: { world },
    player,
    convexHull: () => ({ setFriction() {} }),
    createFixedBody: () => ({ id: 'body' }),
    config: { activeDistance: 50, inactiveDistance: 70 },
  });
  const near = system.addPreparedConvex(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), {
    position: new Vector3(0, 0, 0), radius: 1,
  }, { group: 'referenceBiome', id: 'cactus:1' });
  const far = system.addPreparedConvex(new Float32Array([0, 0, 0]), {
    position: new Vector3(400, 0, 0), radius: 1,
  }, { group: 'referenceBiome', id: 'cactus:2' });

  system.update();
  assert.equal(near.retained, true);
  assert.equal(near.active, true);
  assert.equal(near.collider.enabled, true);
  assert.equal(far.body, null);

  system.setGroupEnabled('referenceBiome', false);
  assert.equal(near.collider.enabled, false);
  system.setGroupEnabled('referenceBiome', true);
  assert.equal(near.collider.enabled, true);

  system.removeGroup('referenceBiome');
  assert.equal(system.colliders.length, 0);
  assert.ok(removed.length >= 1);
});

test('ungrouped colliders keep the original enable hysteresis', () => {
  const player = { getWorldPosition(target) { return target.set(0, 0, 0); } };
  const collider = mockCollider();
  const system = new WorldCollisionSystem({ player, physics: { world: {} } });
  system.colliders.push({
    body: {}, collider, position: new Vector3(80, 0, 0), radius: 0, active: true, groupEnabled: true,
  });
  system.update();
  assert.equal(collider.enabled, false);
  assert.equal(system.colliders[0].active, false);
});
