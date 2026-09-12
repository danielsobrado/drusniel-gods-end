import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Scene, Object3D, Vector3, Color, Box3 } from 'three';
import { ReflectionBudget } from '../src/water/ReflectionBudget.js';
import { WaterSurface } from '../src/water/WaterSurface.js';

test('planar reflections follow every moving frame, including slow movement and tiny turns', () => {
  for (const quality of ['ultra']) {
    for (const motion of ['translation', 'rotation']) {
      const budget = new ReflectionBudget(), camera = new PerspectiveCamera();
      for (let frame = 0; frame < 60; frame++) {
        if (motion === 'translation') camera.position.x = frame * 0.001;
        else camera.rotation.y = frame * 0.0001;
        assert.equal(budget.shouldRender(camera, quality, frame * 1000 / 60), true,
          `${quality} ${motion} frame ${frame} must sample the current view`);
      }
    }
  }
});

test('parent motion and projection changes invalidate the captured view immediately', () => {
  const budget = new ReflectionBudget(), camera = new PerspectiveCamera(), rig = new Object3D();
  rig.add(camera);
  assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
  rig.position.x += 0.01;
  assert.equal(budget.shouldRender(camera, 'ultra', 1), true);
  camera.fov = 60; camera.updateProjectionMatrix();
  assert.equal(budget.shouldRender(camera, 'ultra', 2), true);
  camera.aspect = 2; camera.updateProjectionMatrix();
  assert.equal(budget.shouldRender(camera, 'ultra', 3), true);
  assert.equal(budget.shouldRender(camera, 'ultra', 4), false);
});

test('stopping movement returns to the idle budget, and performance skips moving captures', () => {
  const budget = new ReflectionBudget(), camera = new PerspectiveCamera();
  assert.equal(budget.shouldRender(camera, 'ultra', 0), true);
  camera.position.x = 1;
  assert.equal(budget.shouldRender(camera, 'ultra', 16), true);
  assert.equal(budget.shouldRender(camera, 'ultra', 32), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 265), false);
  assert.equal(budget.shouldRender(camera, 'ultra', 266), true);
  camera.position.x = 2;
  assert.equal(budget.shouldRender(camera, 'performance', 267), false);
});

test('stationary reflections still animate, invalidation refreshes immediately, performance skips capture', () => {
  const budget = new ReflectionBudget(), camera = new PerspectiveCamera();
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

test('quality changes switch lake and sea sampling together and invalidate Ultra captures', () => {
  const water = Object.assign(Object.create(WaterSurface.prototype), {
    uniforms: { rich: { value: 1 }, seaDetail: { value: 1 } },
    lakeReflectionBudget: new ReflectionBudget(), seaReflectionBudget: new ReflectionBudget(),
    planar: { reflector: {} }, seaPlanar: { reflector: {} },
  });
  for (const quality of ['high', 'ultra', 'balanced', 'performance', 'ultra']) {
    water.setQuality(quality);
    assert.equal(water.uniforms.rich.value, quality === 'ultra' ? 1 : 0);
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
