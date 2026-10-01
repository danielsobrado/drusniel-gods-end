import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { rasterizeTerrain } from '../src/world/rasterizeTerrain.js';
import { createLocomotionClips, FootPlacement } from '../src/player/CharacterMotion.js';

test('height rasterization matches downward rays on rotated, overlapping terrain', async () => {
  const root = new THREE.Group();
  for (const [height, angle, size] of [[0, 0.13, 20], [2, -0.2, 7]]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 3, 3), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.rotation.set(-Math.PI / 2 + angle, 0.1, 0.07);
    mesh.position.set(1, height, 2);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const resolution = 17;
  const heights = await rasterizeTerrain(root, bounds, resolution);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      ray.set(new THREE.Vector3(
        THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, x / (resolution - 1)),
        bounds.max.y + 10,
        THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, z / (resolution - 1)),
      ), down);
      const expected = ray.intersectObject(root, true)[0]?.point.y ?? bounds.min.y;
      assert.ok(Math.abs(expected - heights[z * resolution + x]) < 1e-5, `grid ${x},${z}`);
    }
  }
});

test('height rasterization respects front/back sided surfaces', async () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 3;
  mesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3(new THREE.Vector3(-5, -2, -5), new THREE.Vector3(5, 5, 5));
  assert.equal((await rasterizeTerrain(mesh, bounds, 5))[12], 3);
  mesh.material.side = THREE.BackSide;
  assert.equal((await rasterizeTerrain(mesh, bounds, 5))[12], -2);
});

function rig() {
  const root = new THREE.Group();
  for (const side of ['Left', 'Right']) {
    const hip = new THREE.Bone(); hip.name = `${side}UpLeg`; hip.position.set(side === 'Left' ? -0.15 : 0.15, 2, 0);
    const knee = new THREE.Bone(); knee.name = `${side}Leg`; knee.position.set(0, -0.9, 0.12);
    const foot = new THREE.Bone(); foot.name = `${side}Foot`; foot.position.set(0, -0.9, -0.12);
    knee.add(foot); hip.add(knee); root.add(hip);
  }
  return root;
}

test('generated locomotion loops continuously without replacing the source rig pose', () => {
  const root = rig();
  const before = root.getObjectByName('LeftUpLeg').quaternion.clone();
  const clips = createLocomotionClips(root);
  assert.equal(clips.length, 2);
  for (const clip of clips) for (const track of clip.tracks) {
    const first = Array.from(track.values.slice(0, 4));
    const last = Array.from(track.values.slice(-4));
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(first[i] - last[i]) < 1e-6);
  }
  assert.deepEqual(root.getObjectByName('LeftUpLeg').quaternion.toArray(), before.toArray());
});

test('foot placement reduces ground error and leaves airborne poses untouched', () => {
  const root = rig();
  const foot = root.getObjectByName('LeftFoot');
  const position = new THREE.Vector3();
  const before = foot.getWorldPosition(position).y;
  // A planted foot (soles at its bind ankle height below it) over ground 5 cm
  // lower, as the downhill foot on a slope: the ankle should head for that ground.
  const placement = new FootPlacement(root, { sampleHeight: () => ground }, 2);
  const soles = before - placement.ankleHeight;
  const ground = soles - 0.05;
  const target = ground + placement.ankleHeight;
  placement.update(false, soles);
  assert.equal(foot.getWorldPosition(position).y, before);
  placement.update(true, soles);
  assert.ok(Math.abs(foot.getWorldPosition(position).y - target) < Math.abs(before - target));
  assert.ok(root.getObjectByName('LeftLeg').quaternion.toArray().every(Number.isFinite));
});

// The generated idle keys no Foot track, so nothing but FootPlacement writes the
// foot while standing; its correction must not compound frame over frame.
test('foot placement settles on a slope when no clip rewrites the legs', () => {
  const root = rig();
  const bones = ['LeftUpLeg', 'LeftLeg', 'LeftFoot'].map(name => root.getObjectByName(name));
  const rest = bones.map(bone => bone.quaternion.clone());
  const placement = new FootPlacement(root, { sampleHeight: (x, z) => 0.1 + x * 0.3 + z * 0.2 }, 2);
  for (let frame = 0; frame < 60; frame++) placement.update(true, 0);
  // A single frame's tilt is capped at 0.45 rad; a compounding one is not.
  assert.ok(bones[2].quaternion.angleTo(rest[2]) < 0.5, `foot twisted ${bones[2].quaternion.angleTo(rest[2])} rad`);
  const settled = bones.map(bone => bone.quaternion.clone());
  for (let frame = 0; frame < 60; frame++) placement.update(true, 0);
  bones.forEach((bone, index) => assert.ok(bone.quaternion.angleTo(settled[index]) < 1e-4, bone.name));
});

test('foot placement measures ankle height after world scaling when soles are known', () => {
  const root = rig();
  root.position.y = 10;
  root.updateMatrixWorld(true);
  const leftFoot = root.getObjectByName('LeftFoot');
  const ankle = leftFoot.getWorldPosition(new THREE.Vector3()).y;
  const solesY = ankle - 0.24;
  const placement = new FootPlacement(root, { sampleHeight: () => solesY }, 2, solesY);
  assert.ok(Math.abs(placement.ankleHeight - 0.24) < 1e-6);
});

test('foot placement restores the unsolved pose before animation writes the next frame', () => {
  const root = rig();
  const hip = root.getObjectByName('LeftUpLeg');
  const placement = new FootPlacement(root, { sampleHeight: () => -0.05 }, 2);

  placement.update(true, 0);
  const previousInput = placement.solved.find(entry => entry.bone === hip).input.clone();

  placement.beginFrame();
  assert.ok(hip.quaternion.angleTo(previousInput) < 1e-8);

  const animated = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, 0, 0));
  hip.quaternion.copy(animated);
  placement.update(false, 0);

  const captured = placement.solved.find(entry => entry.bone === hip).input;
  assert.ok(captured.angleTo(animated) < 1e-8);
});
