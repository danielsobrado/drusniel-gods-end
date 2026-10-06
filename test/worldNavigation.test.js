import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FreeFlyController } from '../src/player/FreeFlyController.js';
import { WorldNavigation } from '../src/player/WorldNavigation.js';

const FREE_FLY_CONFIG = Object.freeze({
  moveSpeed: 60,
  fastMultiplier: 3,
  lookSensitivity: 0.0015,
  minPitch: -1.553,
  maxPitch: 1.553,
});

function eventTargetStub() {
  return {
    addEventListener() {},
    removeEventListener() {},
  };
}

function playerStub() {
  return {
    enabled: true,
    root: { visible: true, rotation: { y: 0 } },
    metrics: { rootToFeet: 2.2, groundOffset: 0.1 },
    position: new THREE.Vector3(0, 2.3, 0),
    cameraYaw: 0,
    cameraPitch: 0.12,
    playerYaw: 0,
    setEnabled(value) { this.enabled = value; },
    getPosition() { return this.position; },
    translateRoot(x, y, z) { this.position.set(x, y, z); },
  };
}

test('free-fly moves in camera space and restores the character pose when disabled', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(5, 10, 15);
  const initialPosition = camera.position.clone();
  const initialQuaternion = camera.quaternion.clone();
  const player = playerStub();
  const controller = new FreeFlyController({
    camera,
    player,
    domElement: eventTargetStub(),
    config: FREE_FLY_CONFIG,
    eventTarget: null,
    documentTarget: null,
  });

  assert.equal(controller.start({ requestPointerLock: false }), true);
  assert.equal(player.enabled, false);
  assert.equal(player.root.visible, false);

  controller.handleKeyDown({ code: 'KeyW', repeat: false });
  controller.update(1);
  assert.equal(camera.position.z, -45);

  controller.handleKeyDown({ code: 'ShiftLeft', repeat: false });
  controller.update(1);
  assert.equal(camera.position.z, -225);

  assert.equal(controller.stop(), true);
  assert.equal(player.enabled, true);
  assert.equal(player.root.visible, true);
  assert.ok(camera.position.distanceTo(initialPosition) < 1e-9);
  assert.ok(1 - Math.abs(camera.quaternion.dot(initialQuaternion)) < 1e-9);
  controller.dispose();
});

test('free-fly teleport sets an inspection view without changing the saved return pose', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1, 2, 3);
  const player = playerStub();
  const controller = new FreeFlyController({
    camera,
    player,
    domElement: eventTargetStub(),
    config: FREE_FLY_CONFIG,
    eventTarget: null,
    documentTarget: null,
  });

  controller.start({ requestPointerLock: false });
  controller.teleport([1500, -4, 65], [1120, -24, 65]);
  assert.deepEqual(camera.position.toArray(), [1500, -4, 65]);
  controller.stop();
  assert.deepEqual(camera.position.toArray(), [1, 2, 3]);
  controller.dispose();
});

test('world navigation sends ground destinations to the player and sea destinations to free-fly', () => {
  const camera = new THREE.PerspectiveCamera();
  const player = playerStub();
  const tour = {
    active: false,
    starts: 0,
    stops: 0,
    start() { this.active = true; this.starts += 1; return true; },
    stop() { this.active = false; this.stops += 1; },
  };
  const world = {
    camera,
    renderer: { domElement: eventTargetStub() },
    terrainSampler: {
      contains: () => true,
      sampleHeight: () => 3,
    },
  };
  const config = {
    navigation: {
      freeFly: FREE_FLY_CONFIG,
      locations: [
        { id: 'beach', label: 'Beach', mode: 'ground', position: [950, 80], yaw: 1.5 },
        { id: 'summit', label: 'Summit', mode: 'ground', position: [0, 0], yaw: -2.35, pitch: -0.12 },
        { id: 'deepSea', label: 'Deep Sea', mode: 'fly', position: [1500, -4, 65], target: [1120, -24, 65] },
      ],
    },
  };
  const navigation = new WorldNavigation({ world, player, tour, config });

  assert.equal(navigation.teleport('beach'), true);
  assert.deepEqual(player.position.toArray(), [950, 5.3, 80]);
  assert.equal(player.cameraYaw, 1.5);
  assert.equal(player.cameraPitch, 0.12, 'destinations without a pitch preserve the view');
  assert.equal(navigation.freeFly.active, false);

  assert.equal(navigation.teleport('summit'), true);
  assert.equal(player.cameraPitch, -0.12);
  assert.equal(player.cameraYaw, -2.35);
  navigation.getLocation('summit').pitch = -1.4;
  navigation.teleport('summit');
  assert.equal(player.cameraPitch, -0.8, 'arrival pitch respects the walking camera limits');
  navigation.teleport('beach');
  assert.equal(player.cameraPitch, -0.8, 'a later ordinary teleport keeps the chosen pitch');

  assert.equal(navigation.teleport('deepSea'), true);
  assert.equal(navigation.freeFly.active, true);
  assert.deepEqual(camera.position.toArray(), [1500, -4, 65]);
  assert.deepEqual(navigation.getFocusPosition().toArray(), camera.position.toArray());

  navigation.dispose();
});
