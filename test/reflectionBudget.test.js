import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Scene, Object3D, Vector3, Color, Box3 } from 'three';
import { ReflectionBudget } from '../src/water/ReflectionBudget.js';
import { WaterSurface } from '../src/water/WaterSurface.js';

test('moving main camera does not trigger a full reflection on every frame', () => {
  const budget = new ReflectionBudget(), camera = new PerspectiveCamera();
  const captures = [];
  for (let frame = 0; frame < 60; frame++) {
    camera.position.x = frame * 0.1;
    if (budget.shouldRender(camera, 'ultra', frame * 1000 / 60)) captures.push(frame);
  }
  assert.ok(captures.length >= 10 && captures.length <= 13);
  assert.equal(captures[0], 0);
});

test('stationary reflections still animate, invalidation refreshes immediately, performance skips capture', () => {
  const budget = new ReflectionBudget(), camera = new PerspectiveCamera();
  assert.equal(budget.shouldRender(camera, 'high', 0), true);
  assert.equal(budget.shouldRender(camera, 'high', 200), false);
  assert.equal(budget.shouldRender(camera, 'high', 250), true);
  budget.reset();
  assert.equal(budget.shouldRender(camera, 'high', 251), true);
  assert.equal(budget.shouldRender(camera, 'performance', 1000), false);
});

test('enhanced fixed probe captures once across player updates and recaptures after invalidation', () => {
  let captures = 0;
  const camera = new Object3D(); camera.update = () => captures++;
  const water = Object.assign(Object.create(WaterSurface.prototype), {
    enhanced: true, reflectionInitialized: false, rippleElapsed: 0, reflectionElapsed: 0,
    quality: 'ultra', cinematic: { reflectionDistance: 120, reflectionInterval: 0.75 },
    params: {}, mesh: new Object3D(), scene: new Scene(),
    bounds: new Box3(new Vector3(-20, -20, -20), new Vector3(20, 20, 20)), nearest: new Vector3(),
    reflection: { cubeCamera: camera },
    uniforms: { clock: { value: 0 }, sunColor: { value: new Color() }, sunDirection: { value: new Vector3() }, sunStrength: { value: 1 } },
  });
  const position = new Vector3();
  const player = { getPosition: () => position, metrics: { rootToFeet: 1.5 }, moving: false };
  const lighting = { color: new Color(), position: new Vector3(1, 1, 1), directionalIntensity: 3 };
  for (let i = 0; i < 20; i++) { position.x = i; water.update(1, player, lighting); }
  assert.equal(captures, 1);
  water.reflectionInitialized = false;
  water.update(1, player, lighting);
  assert.equal(captures, 2);
});
