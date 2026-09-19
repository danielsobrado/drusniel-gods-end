import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { fitRootGround, measureRootReach, resolveRootSettings, rootBendFor } from '../src/world/treeRootFit.js';

const settings = resolveRootSettings({ bury: 0.05, maxSink: 2, maxSlope: 1.2 });

test('root reach counts only low bark, not the canopy or excluded leaves', () => {
  const tree = new THREE.Group();
  const roots = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 2));
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(1, 10, 1)); trunk.position.y = 5;
  const leaves = new THREE.Mesh(new THREE.BoxGeometry(20, 0.2, 20)); leaves.name = 'Leaves';
  tree.add(roots, trunk, leaves);
  const reach = measureRootReach(tree, { rootHeight: 0.25, excludeName: 'Leaves' });
  assert.ok(Math.abs(reach - Math.hypot(4, 1)) < 1e-6);
});

test('ground fit recovers a planar slope and only buries by the configured margin', () => {
  const ground = fitRootGround((x, z) => 0.4 * x - 0.25 * z + 3, 10, -4, 6, settings);
  assert.ok(Math.abs(ground.slopeX - 0.4) < 1e-9);
  assert.ok(Math.abs(ground.slopeZ + 0.25) < 1e-9);
  assert.ok(Math.abs(ground.sink + settings.bury) < 1e-9);
});

test('ground fit sinks past dips the plane misses, capped by maxSink', () => {
  const bowl = (x, z) => -0.3 * Math.hypot(x, z);
  const ground = fitRootGround(bowl, 0, 0, 5, settings);
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    const dx = Math.cos(a) * 5, dz = Math.sin(a) * 5;
    assert.ok(ground.center + ground.sink + ground.slopeX * dx + ground.slopeZ * dz <= bowl(dx, dz) + 1e-9);
  }
  const cliff = fitRootGround((x) => (x > 2 ? -50 : 0), 0, 0, 5, settings);
  assert.ok(cliff.sink >= -settings.maxSink);
  assert.ok(Math.hypot(cliff.slopeX, cliff.slopeZ) <= settings.maxSlope + 1e-9);
});

test('root bend lands local root vertices on the ground plane for any yaw and scale', () => {
  const slopeX = 0.35, slopeZ = -0.2;
  for (const [yaw, sx, sy, sz] of [[0, 1, 1, 1], [1.1, 1.3, 0.9, 0.8], [4, 0.7, 1.4, 1.1]]) {
    const tree = new THREE.Object3D();
    tree.position.set(12, 7, -3);
    tree.rotation.set(0, yaw, 0, 'YXZ');
    tree.scale.set(sx, sy, sz);
    const bend = rootBendFor(tree, slopeX, slopeZ);
    for (const local of [new THREE.Vector3(3, 0, 0), new THREE.Vector3(-2, 0, 4), new THREE.Vector3(1, 0, -5)]) {
      const bent = local.clone().setY(bend.x * local.x + bend.y * local.z);
      const world = bent.applyMatrix4(tree.matrix);
      const plane = 7 + slopeX * (world.x - 12) + slopeZ * (world.z + 3);
      assert.ok(Math.abs(world.y - plane) < 1e-9, `yaw ${yaw}`);
    }
  }
});
