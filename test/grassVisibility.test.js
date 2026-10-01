import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrassGeometry } from '../src/grass/GrassGeometry.js';
import {
  acquireCompactionScratch, compactGrassGeometry, disposeCompactionScratch, releaseCompactionScratch,
} from '../src/grass/compactGrassGeometry.js';
import { Scene, MeshBasicMaterial, StaticDrawUsage } from 'three';
import WebGPUAttributeUtils from 'three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js';
import { GrassTile } from '../src/grass/GrassTile.js';
import { enqueueGrassTileCompaction } from '../src/grass/GrassField.js';
import { createVegetationJobScheduler } from '../src/foliage/vegetationRebuild.js';

test('concurrent LOD compactions publish only their completed geometry and retain other LODs', () => {
  const scene = new Scene(), material = new MeshBasicMaterial();
  const high = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const low = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 25, stable: true });
  const tile = new GrassTile(scene, material, high, true);
  let time = 0;
  const jobs = createVegetationJobScheduler({ budgetMs: 2, now: () => time });
  const containsGrass = () => { time += 1; return true; };
  try {
    for (const [source, lodName] of [[high, 'high'], [low, 'low']]) {
      enqueueGrassTileCompaction(jobs, { tile, source, lodName, revision: 0, containsGrass, stepLimit: 20 });
    }
    for (let i = 0; i < 300 && (!tile.valid.has(high) || !tile.valid.has(low)); i++) {
      jobs.tick();
      for (const source of tile.valid) assert.equal(tile.cache.get(source).userData.compactDone, true);
    }
    assert.equal(tile.valid.size, 2);
    assert.equal(tile.cache.get(high).instanceCount, high.instanceCount);
    assert.equal(tile.cache.get(low).instanceCount, low.instanceCount);
  } finally { jobs.dispose(); tile.dispose(scene); high.dispose(); low.dispose(); material.dispose(); }
});

test('disposed tile cannot be repopulated by queued compaction', () => {
  const scene = new Scene(), material = new MeshBasicMaterial();
  const source = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 25, stable: true });
  const tile = new GrassTile(scene, material, source, true);
  const jobs = createVegetationJobScheduler({ now: () => 0 });
  enqueueGrassTileCompaction(jobs, { tile, source, lodName: 'high', revision: 0, containsGrass: () => true });
  tile.dispose(scene);
  jobs.tick();
  assert.equal(tile.cache.size, 0);
  assert.equal(tile.staging.size, 0);
  jobs.dispose(); source.dispose(); material.dispose();
});

test('cinematic grass LODs retain the exact positions, rotations and identities of surviving blades', () => {
  const make = (density, detail) => createGrassGeometry({ type: 'blade', density, detail, tileSize: 25, bladeHeight: 1, stable: true });
  const high = make(5.5, 5);
  const low = make(2, 2);
  try {
    assert.equal(high.instanceCount, 137 ** 2, 'keep the configured high-density blade count');
    for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
      const a = high.getAttribute(name).array;
      const b = low.getAttribute(name).array;
      assert.deepEqual(a.slice(0, b.length), b, name);
    }
  } finally { high.dispose(); low.dispose(); }
});

test('path compaction preserves every unmasked blade and its original LOD identity', () => {
  const source = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const compact = compactGrassGeometry(source, 100, -40, (x) => x >= 100);
  const positions = source.getAttribute('instancePosition');
  const identities = compact.getAttribute('instanceData');
  const expected = Array.from({ length: source.instanceCount }, (_, i) => i).filter(i => positions.getX(i) >= 0);
  assert.equal(compact.instanceCount, expected.length);
  assert.deepEqual(Array.from({ length: compact.instanceCount }, (_, i) => identities.getY(i)), expected);
  const full = compactGrassGeometry(source, 0, 0, () => true);
  assert.equal(full.instanceCount, source.instanceCount);
  source.dispose(); compact.dispose(); full.dispose();
});


test('recycling a grass tile reuses its GPU buffers while replacing the masked population', () => {
  const source = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  const tile = new GrassTile(scene, material, source, true);
  const contains = (x, z) => Math.sin(x * 0.13) + Math.cos(z * 0.19) > 0;
  tile.setGeometry(source, 'high', contains);
  const geometry = tile.mesh.geometry;
  const attributes = Object.values(geometry.attributes);
  const arrays = attributes.map((attribute) => attribute.array);
  let disposals = 0;
  geometry.addEventListener('dispose', () => { disposals++; });
  try {
    for (const [x, z] of [[200, 25], [-175, -50], [0, 0]]) {
      tile.setPosition(x, z, x / 25, z / 25);
      assert.equal(tile.setGeometry(source, 'high', contains), true);
      assert.equal(tile.mesh.geometry, geometry, 'movement must not allocate a new render geometry');
      assert.deepEqual(Object.values(geometry.attributes), attributes);
      Object.values(geometry.attributes).forEach((attribute, index) => assert.equal(attribute.array, arrays[index]));
      const expected = compactGrassGeometry(source, x, z, contains);
      assert.equal(geometry.instanceCount, expected.instanceCount);
      for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
        const actual = geometry.getAttribute(name);
        const count = geometry.instanceCount * actual.itemSize;
        assert.deepEqual(actual.array.slice(0, count), expected.getAttribute(name).array.slice(0, count));
      }
      expected.dispose();
      assert.equal(disposals, 0, 'movement must not release GPU resources');
    }
    tile.dispose(scene);
    assert.equal(disposals, 1, 'final cleanup still releases the retained buffer');
  } finally {
    source.dispose();
    material.dispose();
  }
});

test('reused compaction handles an empty tile followed by a fully occupied tile', () => {
  const source = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 4, stable: true });
  const compact = compactGrassGeometry(source, 0, 0, () => false);
  try {
    assert.equal(compact.instanceCount, 0);
    const attributes = Object.values(compact.attributes);
    const filled = compactGrassGeometry(source, 0, 0, () => true, compact);
    assert.equal(filled, compact, 'compaction must update existing storage');
    assert.deepEqual(Object.values(compact.attributes), attributes);
    assert.equal(compact.instanceCount, source.instanceCount);
    for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
      const input = source.getAttribute(name);
      const output = compact.getAttribute(name);
      for (let i = 0; i < source.instanceCount; i++) {
        for (let c = 0; c < input.itemSize; c++) {
          assert.equal(output.array[i * output.itemSize + c], input.array[i * input.itemSize + c]);
        }
      }
    }
  } finally { source.dispose(); compact.dispose(); }
});

test('WebGPU uploads retain the position layout and accept a full population after recycling', () => {
  const source = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 4, stable: true });
  const compact = compactGrassGeometry(source, 0, 0, x => x > 0);
  const data = new Map();
  const device = {
    createBuffer: ({ size }) => {
      const bytes = new ArrayBuffer(size);
      return { bytes, getMappedRange: () => bytes, unmap() {} };
    },
    queue: { writeBuffer: (buffer, offset, array, start = 0, count = array.length - start) => {
      assert.ok((start + count) * array.BYTES_PER_ELEMENT <= array.byteLength, 'upload stays inside source');
      new Uint8Array(buffer.bytes, offset, count * array.BYTES_PER_ELEMENT)
        .set(new Uint8Array(array.buffer, array.byteOffset + start * array.BYTES_PER_ELEMENT, count * array.BYTES_PER_ELEMENT));
    } },
  };
  const gpu = new WebGPUAttributeUtils({ device, get: attribute => {
    if (!data.has(attribute)) data.set(attribute, {});
    return data.get(attribute);
  } });
  try {
    const position = compact.getAttribute('instancePosition');
    const array = position.array;
    for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
      const attribute = compact.getAttribute(name);
      assert.equal(attribute.usage, StaticDrawUsage, 'only upload when a tile changes');
      gpu.createAttribute(attribute, 0);
      attribute.clearUpdateRanges();
    }
    assert.equal(position.array, array, 'the renderer must not repack position storage');
    for (const predicate of [() => true, () => false, x => x < 0, () => true]) {
      compactGrassGeometry(source, 0, 0, predicate, compact);
      for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
        const attribute = compact.getAttribute(name);
        if (compact.instanceCount) gpu.updateAttribute(attribute);
        const uploaded = new Float32Array(data.get(attribute).buffer.bytes);
        assert.deepEqual(uploaded.slice(0, compact.instanceCount * attribute.itemSize),
          attribute.array.slice(0, compact.instanceCount * attribute.itemSize));
      }
      assert.equal(position.array, array);
    }
  } finally { source.dispose(); compact.dispose(); }
});

test('tile layout changes and cancelled staging never reuse a stale population', () => {
  const source = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 4, stable: true });
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  const tile = new GrassTile(scene, material, source, true);
  try {
    tile.setGeometry(source, 'high', () => true, 0);
    tile.stageGeometry(source, 'high', () => false, 1);
    assert.equal(tile.mesh.geometry.instanceCount, source.instanceCount, 'staging does not affect visible grass');
    tile.discardStaging();
    tile.commitStaged(1);
    assert.equal(tile.mesh.geometry.instanceCount, source.instanceCount);
    tile.setGeometry(source, 'high', () => false, 1);
    assert.equal(tile.mesh.geometry.instanceCount, 0, 'new revision rebuilds cached data');
    tile.stageGeometry(source, 'high', () => true, 2);
    tile.setPosition(25, 0, 1, 0);
    tile.commitStaged(2);
    tile.setGeometry(source, 'high', () => false, 2);
    assert.equal(tile.mesh.geometry.instanceCount, 0, 'relocation cancels the old staged layout');
    tile.stageGeometry(source, 'high', () => true, 3);
    tile.commitStaged(3);
    assert.equal(tile.mesh.geometry.instanceCount, source.instanceCount);
    assert.equal(tile.setGeometry(source, 'high', () => true, 3), false, 'committed layout is already current');
    tile.invalidate();
    tile.setGeometry(source, 'high', () => false, 3);
    assert.equal(tile.mesh.geometry.instanceCount, 0);
  } finally { tile.dispose(scene); source.dispose(); material.dispose(); }
});

test('resumable compaction matches a one-shot compact and only publishes when complete', () => {
  const source = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const full = compactGrassGeometry(source, 0, 0, () => true);
  assert.ok(source.instanceCount > 1, 'the fixture must have more than one stem to resume');
  let partial = compactGrassGeometry(source, 0, 0, () => true, null, { resume: true, limit: 1 });
  assert.equal(partial.userData.compactDone, false);
  while (!partial.userData.compactDone) {
    partial = compactGrassGeometry(source, 0, 0, () => true, partial, { resume: true, limit: 1 });
  }
  assert.equal(partial.instanceCount, full.instanceCount);
  const identities = full.getAttribute('instanceData');
  const resumed = partial.getAttribute('instanceData');
  assert.deepEqual(
    resumed.array.slice(0, full.instanceCount * resumed.itemSize),
    identities.array.slice(0, full.instanceCount * identities.itemSize),
  );
  source.dispose(); full.dispose(); partial.dispose();
});

test('tiles compacting the same LOD at once each keep their own blades', () => {
  const source = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const meadow = (x, z) => Math.sin(x * 0.13) + Math.cos(z * 0.19) > -0.4;
  const pathEdge = (x) => x > 20;
  const step = (x, contains, target) => compactGrassGeometry(source, x, 0, contains, target, { resume: true, limit: 64 });
  const results = [];
  try {
    // The scheduler time-slices jobs, so a second tile can start and finish
    // this LOD while the first is part-way through.
    let a = step(0, meadow, null);
    let b = step(25, pathEdge, null);
    while (!b.userData.compactDone) b = step(25, pathEdge, b);
    while (!a.userData.compactDone) a = step(0, meadow, a);
    results.push(a, b);
    for (const [geometry, x, contains] of [[a, 0, meadow], [b, 25, pathEdge]]) {
      const expected = compactGrassGeometry(source, x, 0, contains);
      results.push(expected);
      assert.equal(geometry.instanceCount, expected.instanceCount);
      for (const name of ['instancePosition', 'instanceRotation', 'instanceData']) {
        const actual = geometry.getAttribute(name);
        const count = expected.instanceCount * actual.itemSize;
        assert.deepEqual(actual.array.slice(0, count), expected.getAttribute(name).array.slice(0, count), name);
      }
    }
    assert.equal(source.userData.instanceCount, source.instanceCount, 'the shared template keeps its full blade count');
  } finally {
    source.dispose();
    for (const geometry of results) geometry.dispose();
  }
});

test('scheduled compactions of one LOD on two tiles publish each tile\'s own blades', () => {
  const scene = new Scene(), material = new MeshBasicMaterial();
  const source = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 25, stable: true });
  const tiles = [new GrassTile(scene, material, source, true), new GrassTile(scene, material, source, true)];
  tiles[1].setPosition(25, 0, 1, 0);
  const meadow = (x, z) => Math.sin(x * 0.13) + Math.cos(z * 0.19) > 0;
  let time = 0;
  // Every blade test costs a millisecond, so each tick runs one 20-blade step
  // and the starvation rule hands the turn from one tile's job to the other's.
  const jobs = createVegetationJobScheduler({ budgetMs: 2, now: () => time });
  const containsGrass = (x, z) => { time += 1; return meadow(x, z); };
  const expected = [];
  try {
    for (const tile of tiles) {
      enqueueGrassTileCompaction(jobs, { tile, source, lodName: 'high', revision: 0, containsGrass, stepLimit: 20 });
    }
    for (let i = 0; i < 1000 && tiles.some((tile) => !tile.valid.has(source)); i++) jobs.tick();
    for (const tile of tiles) {
      assert.equal(tile.valid.has(source), true);
      const want = compactGrassGeometry(source, tile.mesh.position.x, tile.mesh.position.z, meadow);
      expected.push(want);
      const geometry = tile.cache.get(source);
      assert.equal(geometry.instanceCount, want.instanceCount);
      for (const name of ['instancePosition', 'instanceData']) {
        const actual = geometry.getAttribute(name);
        const count = want.instanceCount * actual.itemSize;
        assert.deepEqual(actual.array.slice(0, count), want.getAttribute(name).array.slice(0, count), name);
      }
    }
  } finally {
    jobs.dispose();
    for (const tile of tiles) tile.dispose(scene);
    for (const geometry of expected) geometry.dispose();
    source.dispose(); material.dispose();
  }
});

test('a scheduler does not compact an empty-cache tile on the enqueueing frame', async () => {
  const source = createGrassGeometry({ type: 'blade', density: 2, detail: 3, tileSize: 25, stable: true });
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  const tile = new GrassTile(scene, material, source, true);
  const scheduler = createVegetationJobScheduler({ budgetMs: 100, now: () => 0 });
  try {
    assert.equal(enqueueGrassTileCompaction(scheduler, {
      tile, source, lodName: 'high', revision: 0, containsGrass: () => true, stepLimit: 64,
    }), false);
    assert.equal(tile.valid.has(source), false);
    assert.equal(tile.cache.size, 0);
    assert.equal(tile.mesh.geometry, source);
    for (let step = 0; step < 12; step += 1) {
      scheduler.tick();
      await Promise.resolve();
    }
    assert.equal(tile.valid.has(source), true);
    assert.ok(tile.mesh.geometry.instanceCount > 0);
  } finally {
    tile.dispose(scene);
    source.dispose();
    material.dispose();
  }
});

test('recycled tile compactions reuse pooled scratch and publish exact blades', () => {
  const scene = new Scene(), material = new MeshBasicMaterial();
  const source = createGrassGeometry({ type: 'blade', density: 1, detail: 2, tileSize: 25, stable: true });
  const tile = new GrassTile(scene, material, source, true);
  const jobs = createVegetationJobScheduler({ budgetMs: 100, now: () => 0 });
  const names = ['instancePosition', 'instanceRotation', 'instanceData'];
  const move = (x, revision, containsGrass) => {
    tile.setPosition(x, 0, x / 25, 0);
    enqueueGrassTileCompaction(jobs, { tile, source, lodName: 'high', revision, containsGrass });
    for (let i = 0; i < 100 && !(tile.valid.has(source) && tile.layoutRevision === revision); i++) jobs.tick();
    const expected = compactGrassGeometry(source, x, 0, containsGrass);
    const published = tile.cache.get(source);
    assert.equal(published.instanceCount, expected.instanceCount);
    for (const name of names) {
      const length = expected.instanceCount * expected.getAttribute(name).itemSize;
      assert.deepEqual(published.getAttribute(name).array.subarray(0, length),
        expected.getAttribute(name).array.subarray(0, length), name);
    }
    expected.dispose();
    return published;
  };
  try {
    const published = move(0, 0, () => true);
    const buffers = names.map(name => published.getAttribute(name));
    // Later compactions run in scratch, copy into the published geometry and
    // return the scratch to the pool for the next recycled tile.
    assert.equal(move(25, 1, (x) => x < 30), published);
    const scratch = acquireCompactionScratch(source);
    assert.ok(scratch, 'finished scratch returns to the pool');
    assert.equal(scratch.userData.compactCursor, 0);
    releaseCompactionScratch(source, scratch);
    assert.equal(move(50, 2, (x) => x > 55), published);
    assert.equal(acquireCompactionScratch(source), scratch, 'the next compaction reused the pooled scratch');
    assert.deepEqual(names.map(name => published.getAttribute(name)), buffers, 'GPU attribute identities are kept');
    scratch.dispose();
  } finally {
    jobs.dispose(); tile.dispose(scene); disposeCompactionScratch(source); source.dispose(); material.dispose();
  }
});
