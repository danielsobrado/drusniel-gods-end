import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Scene, Object3D, Vector3, Color, Box3 } from 'three';
import { ReflectionBudget, ReflectionCaptureGate } from '../src/water/ReflectionBudget.js';
import { WaterSurface } from '../src/water/WaterSurface.js';

test('planar reflections cap moving captures while still following the current view', () => {
  for (const motion of ['translation', 'rotation']) {
    const budget = new ReflectionBudget({ intervalMs: 100 }), camera = new PerspectiveCamera();
    assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
    for (let frame = 1; frame < 6; frame++) {
      if (motion === 'translation') camera.position.x = frame * 0.001;
      else camera.rotation.y = frame * 0.0001;
      assert.equal(budget.shouldRender(camera, 'ultra', frame * 16), false,
        `${motion} frame ${frame} stays inside the motion budget`);
    }
    if (motion === 'translation') camera.position.x += 0.001;
    else camera.rotation.y += 0.0001;
    assert.equal(budget.shouldRender(camera, 'ultra', 100), true);
  }
});

test('camera and projection changes cannot bypass the capture cadence', () => {
  const budget = new ReflectionBudget({ intervalMs: 100 }), camera = new PerspectiveCamera(), rig = new Object3D();
  rig.add(camera);
  assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
  rig.position.x += 0.01;
  assert.equal(budget.shouldRender(camera, 'ultra', 1), false);
  camera.projectionMatrix.elements[8] += 0.001;
  assert.equal(budget.shouldRender(camera, 'ultra', 2), false, 'TAA-style projection jitter stays budgeted');
  camera.fov = 60; camera.updateProjectionMatrix();
  assert.equal(budget.shouldRender(camera, 'ultra', 3), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 100), true);
});

test('stopping movement remains bounded by the same cadence and performance skips captures', () => {
  const budget = new ReflectionBudget({ intervalMs: 100 }), camera = new PerspectiveCamera();
  assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
  camera.position.x = 1;
  assert.equal(budget.shouldRender(camera, 'ultra', 16), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 100), true);
  assert.equal(budget.shouldRender(camera, 'ultra', 150), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 200), true);
  camera.position.x = 2;
  assert.equal(budget.shouldRender(camera, 'performance', 201), false);
});

test('stationary reflections animate on the configured cadence and reset remains immediate', () => {
  const budget = new ReflectionBudget({ intervalMs: 250 }), camera = new PerspectiveCamera();
  assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
  assert.equal(budget.shouldRender(camera, 'ultra', 200), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 250), true);
  budget.reset();
  assert.equal(budget.shouldRender(camera, 'ultra', 251), true);
  assert.equal(budget.shouldRender(camera, 'performance', 1000), false);
});

test('cached quality levels never capture planar reflections even during motion and invalidation', () => {
  const camera = new PerspectiveCamera();
  for (const quality of ['performance', 'balanced', 'high']) {
    const budget = new ReflectionBudget();
    for (let frame = 0; frame < 60; frame++) {
      camera.position.x = frame; camera.rotation.y = frame * 0.1;
      if (frame === 30) budget.reset();
      assert.equal(budget.shouldRender(camera, quality, frame * 1000 / 60), false);
    }
  }
});

test('both visible water surfaces share the bounded current-view cadence during movement', () => {
  const camera = new PerspectiveCamera();
  const lake = new ReflectionBudget({ intervalMs: 100 }), sea = new ReflectionBudget({ intervalMs: 100 });
  for (const budget of [lake, sea]) {
    assert.equal(budget.wouldRender(camera, 'ultra', 0, true), true);
    budget.markRendered(camera, 0);
  }
  camera.position.x += 0.01;
  for (const budget of [lake, sea]) assert.equal(budget.wouldRender(camera, 'ultra', 16, true), false);
  for (const budget of [lake, sea]) {
    assert.equal(budget.wouldRender(camera, 'ultra', 100, true), true);
    budget.markRendered(camera, 100);
  }
});

test('hidden reflections reset so a visible surface refreshes immediately', () => {
  const budget = new ReflectionBudget({ intervalMs: 100 }), camera = new PerspectiveCamera();
  assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
  assert.equal(budget.wouldRender(camera, 'ultra', 20, false), false);
  assert.equal(budget.wouldRender(camera, 'ultra', 21, true), true);
});

test('shared reflection gate staggers multiple planar surfaces', () => {
  const gate = new ReflectionCaptureGate({ minGapMs: 50 });
  assert.equal(gate.wouldCapture(0), true);
  gate.markCaptured(0);
  assert.equal(gate.wouldCapture(49), false);
  assert.equal(gate.wouldCapture(50), true);
  gate.reset();
  assert.equal(gate.wouldCapture(1), true);
});

test('quality changes switch lake and sea sampling together and invalidate Ultra captures', () => {
  const water = Object.assign(Object.create(WaterSurface.prototype), {
    uniforms: { rich: { value: 1 }, seaFineDetail: { value: 1 } },
    lakeReflectionBudget: new ReflectionBudget(), seaReflectionBudget: new ReflectionBudget(),
    planar: { reflector: {} }, seaPlanar: { reflector: {} },
  });
  const expectedDetail = { performance: 0, balanced: 0.65, high: 0.85, ultra: 1 };
  for (const quality of ['high', 'ultra', 'balanced', 'performance', 'ultra']) {
    water.setQuality(quality);
    assert.equal(water.uniforms.rich.value, quality === 'ultra' ? 1 : 0);
    assert.equal(water.uniforms.seaFineDetail.value, expectedDetail[quality]);
    assert.equal(water.lakeReflectionBudget.lastTime, -Infinity);
    assert.equal(water.seaReflectionBudget.lastTime, -Infinity);
  }
});

test('enhanced fixed probe captures once across player updates and recaptures after invalidation', () => {
  let captures = 0;
  const camera = new Object3D(); camera.update = () => captures++;
  const water = Object.assign(Object.create(WaterSurface.prototype), {
    enhanced: true, reflectionInitialized: false, rippleElapsed: 0, reflectionElapsed: 0,
    quality: 'ultra', cinematic: { reflectionDistance: 120, reflectionInterval: 0.75 },
    params: {}, mesh: new Object3D(), scene: new Scene(),
    stats: { cubeCaptures: 0 },
    bounds: new Box3(new Vector3(-20, -20, -20), new Vector3(20, 20, 20)), nearest: new Vector3(),
    reflection: { cubeCamera: camera },
    uniforms: { clock: { value: 0 }, sunColor: { value: new Color() }, sunDirection: { value: new Vector3() }, sunStrength: { value: 1 } },
  });
  const position = new Vector3();
  const player = { getPosition: () => position, metrics: { rootToFeet: 1.5 }, moving: false };
  const lighting = { color: new Color(), position: new Vector3(1, 1, 1), directionalIntensity: 3 };
  for (let i = 0; i < 20; i++) { position.x = i; water.update(1, player, lighting); }
  assert.equal(captures, 1);
  assert.equal(water.stats.cubeCaptures, 1);
  water.reflectionInitialized = false;
  water.update(1, player, lighting);
  assert.equal(captures, 2);
  assert.equal(water.stats.cubeCaptures, 2);
});
