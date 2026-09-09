import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import { TerrainSampler } from '../src/world/TerrainSampler.js';
import { expandLandscape, mountainHeight } from '../src/world/ExpandedLandscape.js';
import { createWaterGeometry } from '../src/water/waterGeometry.js';
import { createWorldSpacePositions } from '../src/player/terrainColliderGeometry.js';
import { coastX } from '../src/world/coast.js';

let fixture;
async function landscape() {
  fixture ??= (async () => {
    const config = await loadMergedConfig();
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
    const document = await io.read(new URL('../public/Assets/terrain/landscape/landscape.glb', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
    const node = document.getRoot().listNodes().find(n => n.getName() === 'Landscape.002');
    const p = node.getMesh().listPrimitives()[0];
    const source = new THREE.BufferGeometry();
    source.setAttribute('position', new THREE.BufferAttribute(p.getAttribute('POSITION').getArray().slice(), 3));
    source.setIndex(new THREE.BufferAttribute(p.getIndices().getArray().slice(), 1));
    const mesh = new THREE.Mesh(source); mesh.name = 'Landscape002';
    mesh.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));
    const original = new TerrainSampler(mesh, { ...config, terrain: { ...config.terrain, heightResolution: 384 } });
    await original.build();
    const expansion = expandLandscape(mesh, original, config);
    const sampler = new TerrainSampler(mesh, config); await sampler.build();
    return { config, mesh, source, expansion, sampler };
  })();
  return fixture;
}
after(async () => {
  if (!fixture) return;
  const f = await fixture;
  f.expansion.dispose(); f.source.dispose(); f.mesh.material.dispose(); f.sampler.texture.dispose();
});

test('expanded terrain encloses the lake, adds alpine relief, and uses the rendered geometry for collision', async () => {
  const { mesh, sampler, config } = await landscape();
  assert.equal(sampler.bounds.min.x, -800); assert.equal(sampler.bounds.max.z, 800);
  assert.equal(sampler.bounds.max.x, 1600);
  assert.ok(sampler.bounds.max.y > 190);
  const [x, , z] = config.water.position, half = config.water.size / 2;
  assert.ok(sampler.contains(x - half, z - half, 25) && sampler.contains(x + half, z + half, 25));
  const positions = createWorldSpacePositions(mesh);
  const p = mesh.geometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 997) {
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    assert.ok(Math.abs(positions[i * 3 + 1] - v.y) < 0.00002);
  }
  assert.ok(mountainHeight(0, -650) > mountainHeight(0, 0) + 100);
});

test('river runs downhill from snow country, remains carved, and meets the lake at its exact level', async () => {
  const { expansion, sampler } = await landscape();
  const river = expansion.river;
  assert.ok(river.length > 800 && river.samples[0].y > 140);
  for (let i = 1; i < river.samples.length; i++) assert.ok(river.samples[i].y <= river.samples[i - 1].y + 1e-6);
  assert.equal(river.samples.at(-1).y, -17);
  for (let i = 10; i < river.samples.length - 20; i += 23) {
    const p = river.samples[i];
    assert.ok(sampler.sampleHeight(p.x, p.z) < p.y + 0.2, `river bed at ${p.x},${p.z}`);
    assert.ok(river.sample(p.x, p.z).edge < 0);
  }
  assert.equal(river.sample(-650, 650), null);
  const ford = river.sample(88, -19);
  assert.ok(ford.edge < 0);
  assert.ok(ford.y - river.carve(88, -19, ford.y + 3) < 0.4);
});

test('corridor subdivision has no unmatched interior edges or inverted triangles', async () => {
  const { mesh } = await landscape();
  const { index, attributes: { position: p } } = mesh.geometry;
  const edges = new Map();
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    const [a, b, c] = ids;
    const area = (p.getZ(b) - p.getZ(a)) * (p.getX(c) - p.getX(a)) - (p.getX(b) - p.getX(a)) * (p.getZ(c) - p.getZ(a));
    assert.ok(area > 0, `inverted triangle ${i / 3}`);
    for (let j = 0; j < 3; j++) {
      const a = ids[j], b = ids[(j + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    if (count === 2) continue;
    assert.equal(count, 1);
    const [a, b] = key.split(',').map(Number);
    assert.ok(((p.getX(a) === -800 || p.getX(a) === 1600) && p.getX(a) === p.getX(b))
      || (Math.abs(p.getZ(a)) === 800 && p.getZ(a) === p.getZ(b)), `open interior edge ${key}`);
  }
});

test('exploration routes stay on land and connect the forest, ford, summit and lake', async () => {
  const { expansion, sampler } = await landscape();
  assert.ok(expansion.paths.sample(2, -5) > 0.9);
  assert.ok(expansion.paths.sample(88, -19) > 0.9);
  for (const route of expansion.paths.routes) for (const [x, z] of route.points) {
    assert.ok(sampler.contains(x, z, 25));
    if (route.name === 'Lakeside circuit') assert.ok(sampler.sampleHeight(x, z) > -16, `submerged path ${x},${z}`);
  }
});

test('one water geometry contains the lake and river with matching surface attributes', async () => {
  const { expansion, config } = await landscape();
  const geometry = createWaterGeometry(config.water, expansion.river);
  try {
    const count = geometry.attributes.position.count;
    for (const name of ['waterKind', 'waterFlow', 'waterLevel', 'riverSurface', 'normal']) assert.equal(geometry.attributes[name].count, count);
    assert.ok(geometry.boundingBox.max.y > 140);
    assert.ok(geometry.attributes.waterKind.array.includes(0) && geometry.attributes.waterKind.array.includes(1));
    assert.ok(geometry.attributes.waterKind.array.includes(2));
  } finally { geometry.dispose(); }
});

test('coast has dry beach, shallow water and a deep seabed beyond the separate inland lake', async () => {
  const { sampler, config } = await landscape();
  const sea = config.water.sea;
  for (const z of [-500, -200, 0, 250, 500]) {
    const shore = coastX(z, sea.shoreX);
    const dry = sampler.sampleHeight(shore - 50, z);
    const shallows = sampler.sampleHeight(shore + 40, z);
    const deep = sampler.sampleHeight(shore + 470, z);
    assert.ok(dry > sea.level + 3, `dry beach at ${z}`);
    assert.ok(shallows < sea.level && shallows > sea.level - 8, `shallows at ${z}`);
    assert.ok(deep < sea.level - 85, `deep sea at ${z}`);
  }
  assert.ok(sampler.sampleHeight(720, 160) > config.water.position[1] + 20, 'dry land separates lake and sea');
});
