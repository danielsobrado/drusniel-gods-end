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
  canopyClearance: 9,
  obstacleStandoff: 14,
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

// A tree standing on the route, tall enough that the terrain-only clamp the tour used
// to rely on flew the camera straight through its canopy.
function treeStub(x, z, { height = 30, radius = 6 } = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 2, height, radius * 2),
    new THREE.MeshBasicMaterial(),
  );
  mesh.position.set(x, height / 2, z);
  mesh.updateMatrixWorld(true);
  return { high: mesh, position: mesh.position, top: height, radius };
}

function solidPart(x, z, { height = 20, size = 10 } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, height, size), new THREE.MeshBasicMaterial());
  mesh.position.set(x, height / 2, z);
  const group = new THREE.Group();
  group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

// Drives the real start()/update() path rather than reaching into the tour, so these
// cover the wiring as well as the geometry.
function flyGroundTour({ trees = [], terrainParts = new Map() } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 6, 0);
  const world = {
    camera,
    terrainSampler: { sampleHeight: () => 0, contains: () => true },
    terrainParts,
  };
  const water = {
    params: { sea: { enabled: false, level: 0 } },
    mesh: { position: new THREE.Vector3() },
    bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
  };
  const tour = new ScenicTour(world, playerStub(), { trees }, water).configure(TOUR_CONFIG);
  assert.equal(tour.start(), true);

  const samples = [];
  const step = TOUR_CONFIG.travelDurationSeconds ?? 0.05;
  for (let elapsed = 0; elapsed < TOUR_CONFIG.durationSeconds && tour.active && !tour.returning; elapsed += 0.05) {
    tour.update(0.05);
    samples.push(camera.position.clone());
  }
  void step;
  return { tour, samples };
}

test('the flight clears tree canopies instead of passing through the leaves', () => {
  const tree = treeStub(40, 0, { height: 30, radius: 6 });
  const { samples } = flyGroundTour({ trees: [tree] });
  assert.ok(samples.length > 10, 'the tour produced no flight samples');

  const reach = tree.radius + TOUR_CONFIG.obstacleStandoff;
  const overhead = samples.filter((point) => Math.hypot(point.x - 40, point.z - 0) <= reach);
  assert.ok(overhead.length > 0, 'the route never went near the tree, so nothing was tested');

  for (const point of overhead) {
    assert.ok(
      point.y >= tree.top + TOUR_CONFIG.canopyClearance - 1e-6,
      `camera at y=${point.y.toFixed(2)} is inside the canopy of a ${tree.top}-high tree`,
    );
  }
});

test('the flight clears solid structures and props, not just trees', () => {
  const parts = new Map([
    ['props/stone', solidPart(40, 0, { height: 22, size: 10 })],
    // Trigger volumes and invisible collision proxies must not push the camera up.
    ['zones', solidPart(45, 0, { height: 400, size: 10 })],
    ['colliders', solidPart(50, 0, { height: 400, size: 10 })],
  ]);
  const { samples } = flyGroundTour({ trees: [treeStub(40, 0, { height: 8, radius: 4 })], terrainParts: parts });

  const overhead = samples.filter((point) => Math.hypot(point.x - 40, point.z) <= 5 + TOUR_CONFIG.obstacleStandoff);
  assert.ok(overhead.length > 0, 'the route never crossed the prop');
  for (const point of overhead) {
    assert.ok(point.y >= 22 + TOUR_CONFIG.canopyClearance - 1e-6, `camera at y=${point.y.toFixed(2)} clips the prop`);
  }
  // 400-high trigger volumes would have thrown the camera into orbit had they counted.
  assert.ok(Math.max(...samples.map((point) => point.y)) < 120, 'a non-solid part was treated as an obstacle');
});

test('clearing the canopy is a climb, not a step', () => {
  const { samples } = flyGroundTour({ trees: [treeStub(40, 0, { height: 30, radius: 6 })] });
  const climb = Math.max(...samples.map((point) => point.y)) - samples[0].y;
  assert.ok(climb > 20, 'the route did not have to climb, so nothing was tested');

  let biggestStep = 0;
  for (let index = 1; index < samples.length; index += 1) {
    biggestStep = Math.max(biggestStep, Math.abs(samples[index].y - samples[index - 1].y));
  }
  // Frames are ~0.8 units of travel apart. Clamping to the canopy per frame instead of
  // routing over it put the whole climb into one of them.
  assert.ok(
    biggestStep < climb / 8,
    `a single frame moved the camera ${biggestStep.toFixed(1)} of a ${climb.toFixed(1)} climb`,
  );
});

test('the flight starts from the live camera position rather than snapping upward', () => {
  const tree = treeStub(20, 0, { height: 45, radius: 8 });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 6, 0);
  const world = {
    camera,
    terrainSampler: { sampleHeight: () => 0, contains: () => true },
    terrainParts: new Map(),
  };
  const water = {
    params: { sea: { enabled: false, level: 0 } },
    mesh: { position: new THREE.Vector3() },
    bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
  };
  const tour = new ScenicTour(world, playerStub(), { trees: [tree] }, water).configure(TOUR_CONFIG);
  tour.start();
  assert.ok(
    tour.curve.getPointAt(0).distanceTo(new THREE.Vector3(0, 6, 0)) < 1e-6,
    'lifting moved the first station, which would jump the view on the first frame',
  );
});
