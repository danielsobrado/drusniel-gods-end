import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoxGeometry,
  DirectionalLight,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LOD,
  Mesh,
  MeshBasicMaterial,
  Scene,
} from 'three';
import { CinematicPipeline } from '../src/rendering/CinematicPipeline.js';
import { withDrawPreparation, withPreparationFrame } from '../src/rendering/DrawPreparation.js';

test('preparation isolates frame caches and temporal history even when rendering fails', () => {
  const frame = { frameId: 5, time: 2, deltaTime: 0.016 };
  const renderer = { _nodes: { nodeFrame: frame } };
  const before = () => assert.fail('must not feed empty frames into temporal history');
  const after = () => assert.fail('must not feed empty frames into temporal history');
  const resolve = { updateBefore: before, updateAfter: after };
  assert.throws(() => withPreparationFrame(renderer, resolve, () => {
    assert.notEqual(frame.frameId, 5);
    assert.equal(resolve.updateBefore(), false);
    assert.equal(resolve.updateAfter(), false);
    throw new Error('prepare failure');
  }), /prepare failure/);
  assert.equal(frame.frameId, 7, 'gameplay has a fresh cache identity in the same animation callback');
  assert.equal(frame.time, 2);
  assert.equal(frame.deltaTime, 0.016);
  assert.equal(resolve.updateBefore, before);
  assert.equal(resolve.updateAfter, after);
});

test('a skipped ancestor does not suppress a requested target or enable its hidden lights', () => {
  const f = fixture();
  f.branch.userData.skipWarmup = true;
  f.branch.add(f.darkLight);
  withDrawPreparation(f.scene, [f.branch], () => {
    assert.equal(f.branch.visible, true);
    assert.equal(f.target.visible, true);
    assert.equal(f.darkLight.visible, false);
  });
  f.geometry.dispose(); f.material.dispose();
});

test('staged targets retain their world transform and original sibling order', () => {
  const f = fixture();
  const holder = new Group(); holder.position.x = 12;
  const target = new Mesh(f.geometry, f.material); target.position.x = 3;
  const sibling = new Group(); holder.add(target, sibling);
  withDrawPreparation(f.scene, [target], () => {
    target.updateWorldMatrix(true, false);
    assert.equal(target.matrixWorld.elements[12], 15);
  });
  assert.deepEqual(holder.children, [target, sibling]);
  assert.equal(target.position.x, 3);
  f.geometry.dispose(); f.material.dispose();
});

function fixture() {
  const scene = new Scene();
  const geometry = new BoxGeometry();
  geometry.setDrawRange(3, 6);
  const material = new MeshBasicMaterial();
  const target = new Mesh(geometry, material);
  target.name = 'target';
  const branch = new Group();
  branch.visible = false;
  branch.add(target);
  const other = new Mesh(geometry, material);
  other.name = 'other';
  const sun = new DirectionalLight();
  const darkGroup = new Group();
  darkGroup.visible = false;
  const darkLight = new DirectionalLight();
  darkGroup.add(darkLight);
  scene.add(branch, other, sun, darkGroup);
  return { scene, geometry, material, target, branch, other, sun, darkGroup, darkLight };
}

test('preparation reveals only the requested draws and the lighting already active', () => {
  const f = fixture();
  let seen = null;
  const counts = withDrawPreparation(f.scene, [f.target], () => {
    seen = {
      target: f.target.visible,
      branch: f.branch.visible,
      other: f.other.visible,
      sun: f.sun.visible,
      darkLight: f.darkLight.visible,
      darkGroup: f.darkGroup.visible,
      drawCount: f.geometry.drawRange.count,
      culled: f.target.frustumCulled,
    };
  });
  // The target's hidden ancestor is revealed so the draw reaches the pass.
  assert.deepEqual(seen, {
    target: true, branch: true, other: false,
    // An already-lit light stays lit; one under a hidden ancestor stays dark,
    // because the active light set is part of the shader key being prepared.
    sun: true, darkLight: false, darkGroup: false,
    drawCount: 0, culled: false,
  });
  assert.equal(counts.prepared, 1);
  f.geometry.dispose(); f.material.dispose();
});

test('preparation restores visibility, culling and draw range even when rendering throws', () => {
  const f = fixture();
  const lod = new LOD();
  lod.autoUpdate = true;
  f.scene.add(lod);
  assert.throws(() => withDrawPreparation(f.scene, [f.target], () => { throw new Error('compile failed'); }), /compile failed/);
  assert.equal(f.target.visible, true);
  assert.equal(f.branch.visible, false);
  assert.equal(f.other.visible, true);
  assert.equal(f.darkGroup.visible, false);
  assert.equal(f.target.frustumCulled, true);
  assert.equal(lod.autoUpdate, true);
  assert.deepEqual({ ...f.geometry.drawRange }, { start: 3, count: 6 });
  f.geometry.dispose(); f.material.dispose();
});

test('preparation suspends the jungle visibility pass so prepared draws are not culled away', () => {
  const f = fixture();
  const updater = () => { throw new Error('visibility must not cull a draw being prepared'); };
  f.scene.userData.updateCoastalJungleVisibility = updater;
  withDrawPreparation(f.scene, [f.target], () => {
    assert.equal(f.scene.userData.updateCoastalJungleVisibility, undefined);
  });
  assert.equal(f.scene.userData.updateCoastalJungleVisibility, updater);
  f.geometry.dispose(); f.material.dispose();
});

test('preparation leaves shadows to be recomputed from real gameplay draws', () => {
  const f = fixture();
  f.sun.shadow.needsUpdate = false;
  withDrawPreparation(f.scene, [f.target], () => {});
  assert.equal(f.sun.shadow.needsUpdate, true);
  f.geometry.dispose(); f.material.dispose();
});

test('preparing nothing leaves the scene untouched and reports no work', () => {
  const f = fixture();
  const counts = withDrawPreparation(f.scene, [], () => {});
  assert.equal(counts.prepared, 0);
  assert.equal(f.other.visible, true);
  assert.equal(f.branch.visible, false);
  f.geometry.dispose(); f.material.dispose();
});

test('an explicit skipWarmup target is still revealed so its gameplay program can compile', () => {
  const f = fixture();
  f.target.userData.skipWarmup = true;
  let seen = false;
  withDrawPreparation(f.scene, [f.target], () => { seen = f.target.visible; });
  assert.equal(seen, true);
  assert.equal(f.target.userData.skipWarmup, true);
  f.geometry.dispose(); f.material.dispose();
});

test('preparation wakes zero-count instanced buffer geometry without publishing instances', () => {
  const f = fixture();
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', f.geometry.getAttribute('position'));
  geometry.setIndex(f.geometry.index);
  geometry.setAttribute('instanceOffset', new InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3));
  geometry.instanceCount = 0;
  geometry.setDrawRange(2, 4);
  const target = new Mesh(geometry, f.material);
  f.scene.add(target);

  withDrawPreparation(f.scene, [target], () => {
    assert.equal(geometry.instanceCount, 1, 'staged instanced geometry exposes one compile-only instance');
    assert.deepEqual({ ...geometry.drawRange }, { start: 0, count: 0 });
  });

  assert.equal(geometry.instanceCount, 0, 'gameplay population is restored after preparation');
  assert.deepEqual({ ...geometry.drawRange }, { start: 2, count: 4 });
  geometry.dispose(); f.geometry.dispose(); f.material.dispose();
});

test('a staged draw outside the scene is attached for the pass and restored afterward', () => {
  const f = fixture();
  const orphan = new Mesh(f.geometry, f.material);
  orphan.name = 'staged';
  orphan.visible = false;
  let parent = null;
  let visible = false;
  const counts = withDrawPreparation(f.scene, [orphan], () => {
    parent = orphan.parent;
    visible = orphan.visible;
  });
  assert.equal(counts.prepared, 1);
  assert.equal(parent, f.scene);
  assert.equal(visible, true);
  assert.equal(orphan.parent, null);
  assert.equal(orphan.visible, false);
  f.geometry.dispose(); f.material.dispose();
});

test('a staged draw returns to its previous parent when preparation throws', () => {
  const f = fixture();
  const holder = new Group();
  const orphan = new Mesh(f.geometry, f.material);
  holder.add(orphan);
  assert.throws(() => withDrawPreparation(f.scene, [orphan], () => { throw new Error('compile failed'); }), /compile failed/);
  assert.equal(orphan.parent, holder);
  f.geometry.dispose(); f.material.dispose();
});

test('pipeline prepareDraws uses the cinematic render path and restores before awaiting GPU work', async () => {
  const f = fixture();
  const pipeline = Object.create(CinematicPipeline.prototype);
  pipeline.world = { scene: f.scene, renderer: { backend: { device: { queue: {
    async onSubmittedWorkDone() {
      assert.equal(f.target.visible, true);
      assert.equal(f.branch.visible, false);
      assert.equal(f.other.visible, true);
    },
  } } } } };
  pipeline.render = (options) => {
    assert.equal(options.occlusionEnabled, false);
    assert.equal(f.target.visible, true);
    assert.equal(f.other.visible, false);
    assert.equal(f.sun.visible, true);
    assert.deepEqual({ ...f.geometry.drawRange }, { start: 0, count: 0 });
  };
  try {
    const counts = await pipeline.prepareDraws([f.target], { waitForFrame: false });
    assert.equal(counts.prepared, 1);
    assert.equal(f.target.visible, true);
    assert.equal(f.branch.visible, false);
    assert.deepEqual({ ...f.geometry.drawRange }, { start: 3, count: 6 });
  } finally {
    f.geometry.dispose(); f.material.dispose();
  }
});

test('aborted prepareDraws never renders when waiting for a frame', async () => {
  const f = fixture();
  const pipeline = Object.create(CinematicPipeline.prototype);
  pipeline.world = { scene: f.scene, renderer: {} };
  pipeline.render = () => assert.fail('aborted prepare must not render');
  const controller = new AbortController();
  try {
    await assert.rejects(pipeline.prepareDraws([f.target], { signal: controller.signal,
      nextFrame: async () => controller.abort() }), { name: 'AbortError' });
  } finally {
    f.geometry.dispose(); f.material.dispose();
  }
});
