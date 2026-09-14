import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrassGeometry } from '../src/grass/GrassGeometry.js';
import { compactGrassGeometry } from '../src/grass/compactGrassGeometry.js';
import { sampleGrassMask } from '../src/grass/sampleGrassMask.js';
import { Scene, MeshBasicMaterial, StaticDrawUsage } from 'three';
import WebGPUAttributeUtils from 'three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js';
import { GrassTile } from '../src/grass/GrassTile.js';

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

test('mask compaction respects linear-filtered edges instead of dropping a partly grass-covered square', () => {
  const image = { width: 2, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]) };
  assert.equal(sampleGrassMask(image, 0.25, 0.5), 0);
  assert.equal(sampleGrassMask(image, 0.75, 0.5), 1);
  assert.equal(sampleGrassMask(image, 0.5, 0.5), 0.5);
  assert.ok(sampleGrassMask(image, 0.251, 0.5) > 0);
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
