import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureArrivalHitch,
  capturePoseMeta,
  freezeSceneControls,
  pose,
  restoreSceneControls,
  runTopologyComparison,
  snapshotSceneControls,
} from '../scripts/debug/scene-benchmark.js';

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
}

function vec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    clone() { return vec(this.x, this.y, this.z); },
    copy(other) { this.x = other.x; this.y = other.y; this.z = other.z; return this; },
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
  };
}

function quat() {
  return {
    w: 1, x: 0, y: 0, z: 0,
    clone() { return Object.assign(quat(), this); },
    copy(other) { Object.assign(this, other); return this; },
  };
}

function mockDemo() {
  const playerUpdate = () => 'player';
  const tourUpdate = () => 'tour';
  return {
    playerUpdate,
    tourUpdate,
    player: {
      enabled: true,
      update: playerUpdate,
      root: { visible: true },
      metrics: { rootToFeet: 2.5, groundOffset: 0.125 },
      getPosition() { return this.placed ? this.placed.clone() : vec(1, 2, 3); },
      setPosition(x, y, z) { this.placed = vec(x, y, z); this.restored = this.placed; },
      setEnabled(value) { this.enabled = Boolean(value); },
    },
    tour: { active: true, update: tourUpdate },
    world: {
      terrainSampler: { sampleHeight: () => 10 },
      camera: {
        position: vec(4, 5, 6),
        quaternion: quat(),
        lookAt(...args) { this.looked = args; },
      },
    },
  };
}

test('benchmark restore puts player movement, visibility and tour state back, including after failure', () => {
  const demo = mockDemo();
  const saved = snapshotSceneControls(demo);
  freezeSceneControls(demo);
  demo.player.update = () => {};
  demo.tour.update = () => {};
  try {
    throw new Error('measurement failed');
  } catch {
    restoreSceneControls(demo, saved);
  }
  assert.equal(demo.player.enabled, true);
  assert.equal(demo.player.root.visible, true);
  assert.equal(demo.tour.active, true);
  assert.equal(demo.player.update, demo.playerUpdate);
  assert.equal(demo.tour.update, demo.tourUpdate);
  assert.equal(demo.player.restored.x, 1);
  assert.equal(demo.player.restored.y, 2);
  assert.equal(demo.player.restored.z, 3);
});

test('free-camera freeze hides the avatar because setEnabled leaves the mesh in the scene', () => {
  const demo = mockDemo();
  freezeSceneControls(demo);
  assert.equal(demo.player.enabled, false);
  assert.equal(demo.player.root.visible, false);
  assert.equal(demo.tour.active, false);
});

test('benchmark pose keeps the camera at the viewpoint and the player on the ground', () => {
  const demo = mockDemo();
  pose(demo, { position: [2, null, -5], target: [40, 6, 30], move: [0, 0, 0] });
  assert.equal(demo.player.placed.x, 2);
  assert.equal(demo.player.placed.y, 12.625);
  assert.equal(demo.player.placed.y - demo.player.metrics.rootToFeet, 10.125);
  assert.equal(demo.player.placed.z, -5);
  assert.equal(demo.world.camera.position.x, 2);
  assert.equal(demo.world.camera.position.y, 16);
  assert.equal(demo.world.camera.position.z, -5);
  assert.notEqual(demo.world.camera.position.y, demo.player.placed.y);
  assert.deepEqual(demo.world.camera.looked, [40, 6, 30]);
});

test('moving benchmark poses follow terrain using character metrics independently of lens height', () => {
  const demo = mockDemo();
  demo.world.terrainSampler.sampleHeight = (x, z) => x + z;
  const scenario = { position: [2, 20, -5], target: [40, 6, 30], move: [8, 0, 4] };
  for (const metrics of [
    { rootToFeet: 1.25, groundOffset: 0 },
    { rootToFeet: 3.5, groundOffset: 0.25 },
  ]) {
    demo.player.metrics = metrics;
    for (const phase of [0, 0.5, 1]) {
      pose(demo, scenario, phase);
      const { x, y, z } = demo.player.placed;
      assert.equal(x, 2 + 8 * phase);
      assert.equal(z, -5 + 4 * phase);
      assert.equal(y - metrics.rootToFeet, x + z + metrics.groundOffset);
      assert.equal(demo.world.camera.position.y, 26);
    }
  }
});

test('pose metadata records a hidden avatar, grounded feet and a camera above the root', () => {
  const demo = mockDemo();
  freezeSceneControls(demo);
  pose(demo, { position: [2, null, -5], target: [40, 6, 30], move: [0, 0, 0] });
  const meta = capturePoseMeta(demo);
  assert.equal(meta.avatarVisible, false);
  assert.equal(meta.cameraAboveRoot, true);
  assert.equal(meta.feetY, 10.125);
  assert.equal(meta.camera[1], 16);
});

const FOREST = { id: 'denseForest', position: [-280, null, 20], target: [-350, 12, 90], move: [0, 0, 36] };

function stubProfiler(demo) {
  let calls = 0;
  demo.started = true;
  demo.getProfileResults = () => ({
    backend: 'webgpu',
    viewport: { width: 3440, height: 1440, drawingBuffer: { width: 3440, height: 1440 } },
    pixelRatio: 1,
    gpuTiming: true,
    quality: 'Ultra',
  });
  demo.profiler = {
    done: true,
    startTimed(opts) { this.opts = opts; },
    summarize() {
      calls += 1;
      return {
        frames: 1,
        hitch: { maxProcessingMs: calls === 1 ? 4336 : 12 },
        processing: { median: 12 },
      };
    },
  };
  return () => calls;
}

test('arrival hitch capture uses zero warmup so the first forest frame is kept', async () => {
  const demo = mockDemo();
  stubProfiler(demo);
  const summary = await captureArrivalHitch(demo, FOREST, { measureSeconds: 8 });
  assert.equal(demo.profiler.opts.warmupSeconds, 0);
  assert.equal(demo.profiler.opts.measureSeconds, 8);
  assert.equal(summary.hitch.maxProcessingMs, 4336);
});

test('topology comparison records hitch then shared, duplicated, shared and restores sharing', async () => {
  const demo = mockDemo();
  stubProfiler(demo);
  const shares = [];
  demo.grass = {
    shareVertices: true,
    geometries: { high: { getAttribute() { return { count: 11 }; } } },
    setShareVertices(value) {
      this.shareVertices = value !== false;
      const count = this.shareVertices ? 11 : 19;
      shares.push(this.shareVertices);
      this.geometries = {
        high: { getAttribute() { return { count }; } },
      };
    },
  };
  const result = await runTopologyComparison({
    demo,
    warmupSeconds: 0,
    measureSeconds: 0,
    repetitions: 1,
    hitchSeconds: 0,
    settleSeconds: 0,
    scenarios: [FOREST],
  });
  assert.equal(result.hitch.hitch.maxProcessingMs, 4336);
  assert.equal(result.runs.length, 3);
  assert.equal(result.shared.shareVertices, true);
  assert.equal(result.duplicated.shareVertices, false);
  assert.equal(result.sharedRepeat.shareVertices, true);
  assert.equal(result.shared.templateVertices.high, 11);
  assert.equal(result.duplicated.templateVertices.high, 19);
  assert.equal(result.sharedRepeat.templateVertices.high, 11);
  assert.equal(demo.grass.shareVertices, true);
  assert.ok(shares.includes(false));
});
