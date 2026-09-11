import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceBeachMoisture,
  resolveCoastConfig,
  sampleCoastField,
  seedBeachMoisture,
} from '../src/world/CoastField.js';
import { coastX, coastalHeight } from '../src/world/coast.js';
import { createBeachScatter, disposeBeachScatter } from '../src/world/BeachScatter.js';
import {
  createCoastalGroundcover,
  disposeCoastalGroundcover,
} from '../src/world/CoastalGroundcover.js';
import { WaterRefractionNode } from '../src/water/WaterRefractionNode.js';

const sea = { enabled: true, shoreX: 1000, level: -24, depth: 95 };

function terrainFixture() {
  return {
    bounds: { min: { x: -800, z: -800 }, max: { x: 1600, z: 800 } },
    sampleHeight: (x, z) => coastalHeight(x, z, 20, sea),
  };
}

test('refraction isolates render targets and recovered renderers and disposes captures', () => {
  const a = new WaterRefractionNode(), b = new WaterRefractionNode();
  const canvas = {}, hdr = {};
  assert.notEqual(a.getTextureForReference(canvas), a.getTextureForReference(hdr));
  assert.equal(a.getTextureForReference(hdr), a.getTextureForReference(hdr));
  assert.notEqual(a.getTextureForReference(hdr), b.getTextureForReference(hdr));
  const sample = a.sample();
  assert.equal(sample.getTextureForReference(hdr), a.getTextureForReference(hdr));
  let disposed = 0;
  for (const texture of a.ownedTextures) texture.addEventListener('dispose', () => disposed += 1);
  const count = a.ownedTextures.size;
  a.dispose();
  b.dispose();
  assert.equal(disposed, count);
  assert.equal(a.ownedTextures.size, 0);
});

test('coast config resolves legacy settings once and rejects invalid art bands', () => {
  const resolved = resolveCoastConfig(sea);
  assert.equal(resolveCoastConfig(resolved), resolved);
  assert.equal(resolved.coast.wave.wavelength, 13);
  assert.equal(resolved.coast.moisture.wettingSeconds, 18);
  assert.equal(resolved.coast.moisture.dryingSeconds, 100);
  assert.equal(resolved.coast.sand.dryDark, '#b39a72');
  assert.equal(resolved.coast.sand.dryLight, '#d6be96');
  assert.equal(resolved.coast.sand.dryRoughness, 0.97);
  assert.equal(resolved.coast.sand.wetRoughness, 0.24);
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { swash: { reach: Number.NaN } } }),
    /water\.sea\.coast\.swash\.reach/,
  );
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { sand: { inlandStart: -50, inlandEnd: -80 } } }),
    /water\.sea\.coast\.sand/,
  );
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { terrain: { shelfKnee: 600, shelfEnd: 500 } } }),
    /water\.sea\.coast\.terrain bands/,
  );
});

test('coast field follows curved terrain and keeps placement fields bounded', () => {
  for (const z of [-800, -250, 0, 375, 800]) for (const d of [-150, -80, -20, 0, 25, 180, 2600]) {
    const x = coastX(z, sea) + d;
    const field = sampleCoastField(x, z, 7, sea);
    assert.ok(Math.abs(field.signedCoastDistance - d) < 1e-10);
    if (d >= 0) {
      assert.ok(Math.abs(field.oceanDepth - (sea.level - coastalHeight(x, z, 30, sea))) < 1e-10);
    }
    if (d >= -20) {
      assert.equal(field.vegetationSuitability, 0);
      assert.equal(field.scatterSuitability, 0);
      assert.equal(field.groundcoverSuitability, 0);
    }
    for (const key of [
      'baseMoisture',
      'waterCoverage',
      'foamFront',
      'washMemory',
      'waveWash',
      'vegetationSuitability',
      'groundcoverSuitability',
      'scatterSuitability',
    ]) assert.ok(field[key] >= 0 && field[key] <= 1, `${key} is bounded`);
    assert.equal(field.waveWash, Math.max(field.waterCoverage, field.washMemory));
  }
});

test('swash visibly reaches the beach, leaves wet memory, and wraps continuously', () => {
  const z = 0;
  const distance = -6;
  const x = coastX(z, sea) + distance;
  let visible = false, wake = false;
  for (let i = 0; i <= 240; i += 1) {
    const field = sampleCoastField(x, z, i / 240 * (Math.PI * 2 / 1.35), sea, 0);
    visible ||= field.waterCoverage > 0.75;
    wake ||= field.waterCoverage < 0.05 && field.washMemory > 0.05;
  }
  assert.equal(visible, true);
  assert.equal(wake, true);
  assert.equal(sampleCoastField(coastX(z, sea) - 20, z, 0, sea).waterCoverage, 0);

  const d = -2;
  const wrap = (Math.PI / 2 + Math.PI * 2 - d * Math.PI * 2 / 13) / 1.35;
  const before = sampleCoastField(coastX(z, sea) + d, z, wrap - 1e-6, sea);
  const after = sampleCoastField(coastX(z, sea) + d, z, wrap + 1e-6, sea);
  for (const key of ['shoreRunup', 'waterCoverage', 'foamFront', 'washMemory']) {
    assert.ok(Math.abs(before[key] - after[key]) < 0.001, `${key} wraps continuously`);
  }
});

test('rain moisture seeds established weather and integrates independently of frame rate', () => {
  assert.equal(seedBeachMoisture(0.65), 0.65);
  assert.equal(seedBeachMoisture(5), 1);
  const wet = advanceBeachMoisture(0, 1, 30, sea);
  assert.ok(wet > 0.7 && wet < 1);
  const clearing = advanceBeachMoisture(wet, 0, 30, sea);
  assert.ok(clearing > 0 && clearing < wet);
  let stepped = 0;
  for (let i = 0; i < 1800; i += 1) stepped = advanceBeachMoisture(stepped, 1, 1 / 60, sea);
  assert.ok(Math.abs(stepped - wet) < 1e-10);
  assert.equal(advanceBeachMoisture(wet, 1, -1, sea), wet);
  assert.equal(advanceBeachMoisture(wet, 1, Number.NaN, sea), wet);
});

test('beach debris stays dry, sparse and deterministic and releases resources', () => {
  const terrain = terrainFixture();
  const a = createBeachScatter(terrain, sea), b = createBeachScatter(terrain, sea);
  let count = 0, disposed = 0;
  a.children.forEach((mesh, kind) => {
    count += mesh.count;
    assert.deepEqual(mesh.instanceMatrix.array, b.children[kind].instanceMatrix.array);
    for (let i = 0; i < mesh.count; i += 1) {
      const [x, y, z] = mesh.instanceMatrix.array.slice(i * 16 + 12, i * 16 + 15);
      const field = sampleCoastField(x, z, 0, sea);
      assert.ok(field.signedCoastDistance < -20);
      assert.equal(field.waterCoverage, 0);
      assert.ok(Math.abs(y - terrain.sampleHeight(x, z)) < 0.025);
    }
    mesh.geometry.addEventListener('dispose', () => disposed += 1);
    mesh.material.addEventListener('dispose', () => disposed += 1);
  });
  assert.ok(count > 100 && count < 1000);
  disposeBeachScatter(a);
  disposeBeachScatter(b);
  assert.equal(disposed, 6);
  assert.equal(createBeachScatter(terrain, { enabled: false }).children.length, 0);
});

test('coastal groundcover is deterministic, quality-scaled and outside active wash', () => {
  const terrain = terrainFixture();
  const a = createCoastalGroundcover(terrain, sea, 'ultra');
  const b = createCoastalGroundcover(terrain, sea, 'ultra');
  const mesh = a.children[0];
  const copy = b.children[0];
  assert.ok(mesh.count > 0);
  assert.deepEqual(mesh.instanceMatrix.array, copy.instanceMatrix.array);
  assert.ok(a.userData.stats.patches <= 500);
  assert.ok(mesh.count <= a.userData.stats.patches * 3);
  for (let i = 0; i < mesh.count; i += 1) {
    const x = mesh.instanceMatrix.array[i * 16 + 12];
    const z = mesh.instanceMatrix.array[i * 16 + 14];
    const field = sampleCoastField(x, z, 0, sea);
    assert.ok(field.signedCoastDistance < -54.4 && field.signedCoastDistance > -145.6);
    assert.equal(field.waterCoverage, 0);
    assert.equal(field.oceanDepth, 0);
  }
  const ultra = mesh.count;
  a.userData.setQuality('performance');
  assert.ok(mesh.count < ultra);
  const performance = mesh.count;
  a.userData.setQuality('high');
  assert.ok(mesh.count > performance && mesh.count < ultra);
  let disposed = 0;
  mesh.geometry.addEventListener('dispose', () => disposed += 1);
  mesh.material.addEventListener('dispose', () => disposed += 1);
  disposeCoastalGroundcover(a);
  disposeCoastalGroundcover(b);
  assert.equal(disposed, 2);
});
