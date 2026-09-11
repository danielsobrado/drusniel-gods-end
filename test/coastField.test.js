import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleCoastField, advanceBeachMoisture } from '../src/world/CoastField.js';
import { coastX, coastalHeight } from '../src/world/coast.js';
import { createBeachScatter, disposeBeachScatter } from '../src/world/BeachScatter.js';
import { WaterRefractionNode } from '../src/water/WaterRefractionNode.js';

const sea = { enabled: true, shoreX: 1000, level: -24, depth: 95 };
test('refraction isolates render targets and recovered renderers and disposes captures', () => {
  const a = new WaterRefractionNode(), b = new WaterRefractionNode();
  const canvas = {}, hdr = {};
  assert.notEqual(a.getTextureForReference(canvas), a.getTextureForReference(hdr));
  assert.equal(a.getTextureForReference(hdr), a.getTextureForReference(hdr));
  assert.notEqual(a.getTextureForReference(hdr), b.getTextureForReference(hdr));
  const sample = a.sample();
  assert.equal(sample.getTextureForReference(hdr), a.getTextureForReference(hdr));
  let disposed = 0;
  for (const texture of a.ownedTextures) texture.addEventListener('dispose', () => disposed++);
  const count = a.ownedTextures.size;
  a.dispose(); b.dispose();
  assert.equal(disposed, count);
  assert.equal(a.ownedTextures.size, 0);
});
test('coast field follows curved terrain and excludes plants and scatter from wash', () => {
  for (const z of [-800, -250, 0, 375, 800]) for (const d of [-150, -80, -20, 0, 25, 180, 2600]) {
    const x = coastX(z, sea.shoreX) + d;
    const field = sampleCoastField(x, z, 7, sea);
    assert.ok(Math.abs(field.signedCoastDistance - d) < 1e-10);
    if (d >= 0) assert.ok(Math.abs(field.oceanDepth - (sea.level - coastalHeight(x, z, 30, sea))) < 1e-10);
    if (d >= -20) {
      assert.equal(field.vegetationSuitability, 0);
      assert.equal(field.scatterSuitability, 0);
    }
    for (const key of ['baseMoisture', 'waveWash', 'vegetationSuitability', 'scatterSuitability']) assert.ok(field[key] >= 0 && field[key] <= 1);
  }
});
test('sunny wave wash leaves a damp wake independent of rain and stays near shore', () => {
  const sample = t => sampleCoastField(998, 0, t, sea);
  const crestTime = (Math.PI / 2 + 4 * Math.PI / 13) / 1.35;
  assert.ok(sample(crestTime + 0.2).waveWash > sample(crestTime + 3).waveWash);
  assert.ok(sample(crestTime + 3).waveWash > 0);
  assert.equal(sampleCoastField(950, 0, crestTime, sea).waveWash, 0);
});
test('rain accumulates and clears gradually with frame-rate independent integration', () => {
  const wet = advanceBeachMoisture(0, 1, 30);
  assert.ok(wet > 0.7 && wet < 1);
  const clearing = advanceBeachMoisture(wet, 0, 30);
  assert.ok(clearing > 0 && clearing < wet);
  let stepped = 0;
  for (let i = 0; i < 1800; i++) stepped = advanceBeachMoisture(stepped, 1, 1 / 60);
  assert.ok(Math.abs(stepped - wet) < 1e-10);
  assert.equal(advanceBeachMoisture(wet, 1, -1), wet);
  assert.equal(advanceBeachMoisture(wet, 1, NaN), wet);
});

test('beach debris stays on dry terrain, is sparse and deterministic, and releases resources', () => {
  const terrain = { bounds: { min: { x: -800, z: -800 }, max: { x: 1600, z: 800 } },
    sampleHeight: (x, z) => coastalHeight(x, z, 20, sea) };
  const a = createBeachScatter(terrain, sea), b = createBeachScatter(terrain, sea);
  let count = 0, disposed = 0;
  a.children.forEach((mesh, kind) => {
    count += mesh.count;
    assert.deepEqual(mesh.instanceMatrix.array, b.children[kind].instanceMatrix.array);
    for (let i = 0; i < mesh.count; i++) {
      const [x, y, z] = mesh.instanceMatrix.array.slice(i * 16 + 12, i * 16 + 15);
      assert.ok(sampleCoastField(x, z, 0, sea).signedCoastDistance < -20);
      assert.ok(Math.abs(y - terrain.sampleHeight(x, z)) < 0.025);
    }
    mesh.geometry.addEventListener('dispose', () => disposed++);
    mesh.material.addEventListener('dispose', () => disposed++);
  });
  assert.ok(count > 100 && count < 1000);
  disposeBeachScatter(a); disposeBeachScatter(b);
  assert.equal(disposed, 6);
  assert.equal(createBeachScatter(terrain, { enabled: false }).children.length, 0);
});
