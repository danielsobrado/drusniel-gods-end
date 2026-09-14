import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, DirectionalLight, Group, InstancedMesh, LOD, Mesh, MeshBasicMaterial, Scene } from 'three';
import { CinematicPipeline } from '../src/rendering/CinematicPipeline.js';
import { WaterSurface } from '../src/water/WaterSurface.js';

function fixture() {
  const scene = new Scene();
  const geometry = new BoxGeometry();
  geometry.setDrawRange(3, 6);
  const material = new MeshBasicMaterial();
  const lod = new LOD();
  const near = new Mesh(geometry, material);
  const far = new Mesh(geometry, material);
  lod.addLevel(near, 0).addLevel(far, 100);
  near.visible = false;
  const instances = new InstancedMesh(geometry, material, 4);
  instances.count = 0;
  instances.visible = false;
  const hiddenGroup = new Group();
  hiddenGroup.visible = false;
  const hiddenLight = new DirectionalLight();
  hiddenGroup.add(hiddenLight);
  const sun = new DirectionalLight();
  scene.add(lod, instances, hiddenGroup, sun);
  const visibility = () => { throw new Error('warmup must not cull future jungle variants'); };
  scene.userData.updateCoastalJungleVisibility = visibility;
  const pipeline = Object.create(CinematicPipeline.prototype);
  pipeline.world = { scene, renderer: {} };
  return { scene, geometry, lod, near, far, instances, hiddenGroup, hiddenLight, sun, pipeline,
    checkRestored() {
      assert.equal(lod.autoUpdate, true);
      assert.equal(near.visible, false);
      assert.equal(far.visible, true);
      assert.equal(instances.visible, false);
      assert.equal(instances.count, 0);
      assert.equal(near.frustumCulled, true);
      assert.equal(hiddenGroup.visible, false);
      assert.equal(hiddenLight.visible, true);
      assert.deepEqual(geometry.drawRange, { start: 3, count: 6 });
      assert.equal(scene.userData.updateCoastalJungleVisibility, visibility);
    },
    dispose() { geometry.dispose(); material.dispose(); instances.dispose(); },
  };
}

test('warmup renders future LODs through the real pipeline without drawing their geometry', async () => {
  const f = fixture();
  let freshFrame = false;
  let calls = 0;
  f.pipeline.render = options => {
    calls++;
    assert.equal(freshFrame, true, 'frame-based pass nodes must be eligible to update');
    assert.equal(options.occlusionEnabled, false);
    assert.equal(f.scene.userData.updateCoastalJungleVisibility, undefined);
    assert.equal(f.lod.autoUpdate, false);
    assert.equal(f.near.visible, true);
    assert.equal(f.far.visible, true);
    assert.equal(f.instances.visible, true);
    assert.equal(f.instances.count, 0, 'do not change published instance populations');
    assert.equal(f.near.frustumCulled, false);
    assert.equal(f.hiddenLight.visible, false, 'keep the same effective lights and shader cache keys');
    assert.equal(f.sun.visible, true);
    assert.deepEqual(f.geometry.drawRange, { start: 0, count: 0 });
  };
  try {
    await f.pipeline.warmup({ nextFrame: async () => { freshFrame = true; } });
    assert.equal(calls, 1);
    f.checkRestored();
    assert.equal(f.sun.shadow.needsUpdate, true, 'refresh shadow contents after the empty draw');
  } finally { f.dispose(); }
});

test('failed warmup restores shared geometry, visibility, LOD and culling state', async () => {
  const f = fixture();
  f.pipeline.render = () => { throw new Error('device lost'); };
  try {
    await assert.rejects(f.pipeline.warmup({ nextFrame: async () => {} }), /device lost/);
    f.checkRestored();
  } finally { f.dispose(); }
});

test('aborting while waiting for a fresh frame never renders a warmup', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.pipeline.render = () => assert.fail('aborted load must not render');
  try {
    await assert.rejects(f.pipeline.warmup({ signal: controller.signal,
      nextFrame: async () => controller.abort() }), { name: 'AbortError' });
    f.checkRestored();
  } finally { f.dispose(); }
});

test('warmup restores the scene before waiting for submitted GPU work', async () => {
  const f = fixture();
  const water = Object.create(WaterSurface.prototype);
  f.pipeline.render = () => assert.equal(water.warmingReflections, true);
  f.pipeline.world.renderer.backend = { device: { queue: {
    async onSubmittedWorkDone() {
      f.checkRestored();
      assert.equal(water.warmingReflections, false);
      throw new Error('GPU submission failed');
    },
  } } };
  try {
    await assert.rejects(f.pipeline.warmup({ water, nextFrame: async () => {} }), /GPU submission failed/);
    f.checkRestored();
  } finally { f.dispose(); }
});

test('reflection warmup keeps the selected quality and invalidates empty captures even on failure', () => {
  const water = Object.create(WaterSurface.prototype);
  let resets = 0;
  water.quality = 'high';
  water.lakeReflectionBudget = water.seaReflectionBudget = { reset() { resets++; } };
  assert.throws(() => water.withReflectionWarmup(() => {
    assert.equal(water.warmingReflections, true);
    assert.equal(water.quality, 'high');
    throw new Error('render failed');
  }), /render failed/);
  assert.equal(water.warmingReflections, false);
  assert.equal(water.quality, 'high');
  assert.equal(resets, 4, 'both reflection budgets reset before and after warmup');
});
