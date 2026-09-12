import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ScenicTour } from '../src/rendering/ScenicTour.js';

const TOUR_CONFIG = Object.freeze({
  durationSeconds: 10,
  returnDurationSeconds: 1,
  lookAheadDistance: 5,
  orientationSharpness: 7,
  terrainClearance: 4,
  targetDrop: 2,
  seaLookBlendStart: 0.88,
  seaFocusXZ: [1500, 65],
  seaFocusHeightOffset: 2,
  riverViews: [
    { fraction: 0.05, offset: 20, lift: 25 },
    { fraction: 0.95, offset: -15, lift: 12 },
  ],
});

function playerStub() {
  return {
    enabled: true,
    root: { visible: true },
    position: new THREE.Vector3(),
    setEnabled(value) { this.enabled = value; },
    getPosition() { return this.position; },
  };
}

function createTour() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 10, 0);
  const world = {
    camera,
    terrainSampler: {
      sampleHeight: () => -100,
      contains: () => true,
    },
  };
  const player = playerStub();
  const water = {
    params: { sea: { enabled: false, level: 0 } },
    mesh: { position: new THREE.Vector3(0, 0, 0) },
    bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
  };
  const tour = new ScenicTour(world, player, { trees: [] }, water).configure(TOUR_CONFIG);
  return { tour, world, player };
}

function armTour(tour, world, points, savedPosition = new THREE.Vector3()) {
  tour.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  tour.curve.updateArcLengths();
  tour.curveLength = tour.curve.getLength();
  tour.saved = {
    position: savedPosition.clone(),
    quaternion: new THREE.Quaternion(),
  };
  tour.active = true;
  tour.returning = false;
  tour.elapsed = 0;
  world.camera.position.copy(points[0]);
  world.camera.quaternion.identity();
}

test('scenic tour advances by arc length instead of uneven control-point parameter spacing', () => {
  const { tour, world } = createTour();
  armTour(tour, world, [
    new THREE.Vector3(0, 10, 0),
    new THREE.Vector3(1, 10, 0),
    new THREE.Vector3(2, 10, 0),
    new THREE.Vector3(100, 10, 0),
  ]);

  const positions = [world.camera.position.x];
  for (let index = 0; index < 5; index += 1) {
    tour.update(TOUR_CONFIG.durationSeconds * 0.1);
    positions.push(world.camera.position.x);
  }
  const steps = positions.slice(1).map((value, index) => value - positions[index]);
  const average = steps.reduce((sum, value) => sum + value, 0) / steps.length;
  for (const step of steps) assert.ok(Math.abs(step - average) < average * 0.08);
});

test('scenic tour eases back to the saved camera instead of snapping at the route end', () => {
  const { tour, world, player } = createTour();
  tour.configure({ ...TOUR_CONFIG, durationSeconds: 3, returnDurationSeconds: 1 });
  const saved = new THREE.Vector3(0, 10, 0);
  armTour(tour, world, [
    new THREE.Vector3(0, 10, 0),
    new THREE.Vector3(3, 10, 0),
    new THREE.Vector3(7, 10, 0),
    new THREE.Vector3(10, 10, 0),
  ], saved);
  player.enabled = false;
  player.root.visible = false;

  tour.update(2);
  assert.equal(tour.returning, true);
  assert.ok(world.camera.position.distanceTo(saved) > 5);

  tour.update(0.5);
  assert.equal(tour.active, true);
  assert.ok(world.camera.position.x > 0 && world.camera.position.x < 10);

  tour.update(0.5);
  assert.equal(tour.active, false);
  assert.ok(world.camera.position.distanceTo(saved) < 1e-9);
  assert.equal(player.enabled, true);
  assert.equal(player.root.visible, true);
});

test('scenic tour rejects unordered river view fractions', () => {
  const { tour } = createTour();
  assert.throws(
    () => tour.configure({
      ...TOUR_CONFIG,
      riverViews: [
        { fraction: 0.7, offset: 10, lift: 20 },
        { fraction: 0.3, offset: 10, lift: 20 },
      ],
    }),
    /strictly increasing/,
  );
});
