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
import { MOUTH_HANDOVER_HEIGHT } from '../src/water/RiverCourse.js';
import { createWorldSpacePositions } from '../src/player/terrainColliderGeometry.js';
import { coastX } from '../src/world/coast.js';
import { lakeSignedDistance, resolveLakeShape } from '../src/world/LakeShape.js';

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
  assert.equal(sampler.bounds.min.z, -1100);
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

// The ranges stand on the unrefined five-metre grid, so their ridged relief is
// cut to the octaves it can carry; the finer ones only came out as facets and
// ridgelines that stepped from vertex to vertex. Same budget, and same
// measurement, as terrain.alpine.landform.relief.octaves.
test('the mountain field stays inside what the world grid can carry', () => {
  const step = 5;
  let total = 0;
  let count = 0;
  for (let z = -900; z <= -350; z += step) {
    for (let x = -700; x <= 700; x += step) {
      const middle = mountainHeight(x, z);
      if (middle < 25) continue;
      const alongX = mountainHeight(x - step, z) - 2 * middle + mountainHeight(x + step, z);
      const alongZ = mountainHeight(x, z - step) - 2 * middle + mountainHeight(x, z + step);
      total += Math.atan2(Math.hypot(alongX, alongZ), step) * 180 / Math.PI;
      count += 1;
    }
  }
  assert.ok(total / count < 21, `mean slope break per cell is ${(total / count).toFixed(1)} degrees`);
});

test('river descends from snow country through the lake and drains into the sea', async () => {
  const { expansion, sampler, config } = await landscape();
  const river = expansion.river;
  assert.ok(river.length > 1500 && river.samples[0].y > 140);
  for (let i = 1; i < river.samples.length; i++) assert.ok(river.samples[i].y <= river.samples[i - 1].y + 1e-6);

  const lakeJoin = river.sample(202, 97);
  assert.ok(lakeJoin?.edge < 0);
  assert.ok(Math.abs(lakeJoin.y - config.water.position[1]) < 0.05);
  assert.equal(river.samples.at(-1).y, config.water.sea.level);
  assert.ok(river.samples.at(-1).outletProgress > 0.99);

  for (let i = 10; i < river.samples.length - 20; i += 31) {
    const p = river.samples[i];
    assert.ok(sampler.sampleHeight(p.x, p.z) < p.y + 0.2, `river bed at ${p.x},${p.z}`);
    assert.ok(river.sample(p.x, p.z).edge < 0);
  }
  assert.equal(river.sample(-650, 650), null);
  const ford = river.sample(88, -19);
  assert.ok(ford.edge < 0);
  assert.ok(ford.y - river.carve(88, -19, ford.y + 3) < 0.4);

  const mouth = river.sample(1045, 80);
  assert.ok(mouth.edge < 0 && mouth.outletProgress > 0.98);
  assert.ok(Math.abs(mouth.y - config.water.sea.level) < 0.05);
  assert.ok(sampler.sampleHeight(1045, 80) < config.water.sea.level);
});

test('river banks hold the water: past each channel edge the ground rises above the surface', async () => {
  const { expansion } = await landscape();
  const river = expansion.river;
  // The shaped terrain itself; the mesh places its vertices on this function.
  const ground = (x, z) => river.carve(x, z, expansion.baseHeight(x, z));
  const spills = [];
  for (let i = 0; i < river.samples.length; i += 2) {
    const p = river.samples[i];
    if (p.outletProgress <= 0 && p.y <= river.lakeLevel + 0.05) continue; // the lake is its own basin
    // Nor at the mouth: there the sea stands at the channel's own level and
    // holds the water, so the carve fades its bank out. See the mouth test.
    if (p.outletProgress > 0 && p.y <= river.outletLevel + MOUTH_HANDOVER_HEIGHT) continue;
    for (const side of [-1, 1]) {
      // Just past the edge, which erosion moves up to a metre either way.
      let bank = -Infinity;
      for (const beyond of [0.8, 1.6, 2.4, 3.2]) {
        const across = side * (p.width / 2 + beyond);
        bank = Math.max(bank, ground(p.x - p.dz * across, p.z + p.dx * across));
      }
      if (bank < p.y) spills.push(`${i} side ${side}: ${(p.y - bank).toFixed(2)} m`);
    }
  }
  assert.deepEqual(spills.slice(0, 12), [], `${spills.length} bank spills`);
});

// The bank that holds the river in its channel used to run all the way to the
// mouth, where the river surface is the sea's own level. It came out as a bar
// of sand standing 0.3 m proud of the water right across the outlet, so the
// estuary read from the beach as water, a strip of sand, then the open sea,
// with the sea's wave lines stopping at the bar.
test('the carve raises no bar across the river mouth', async () => {
  const { expansion, config } = await landscape();
  const river = expansion.river;
  const level = config.water.sea.level;
  const proud = [];
  for (const p of river.samples) {
    if (p.y > level + 0.2) continue;
    for (const side of [-1, 1]) {
      for (const beyond of [0.5, 2, 6, 14, 24]) {
        const across = side * (p.width / 2 + beyond);
        const x = p.x - p.dz * across;
        const z = p.z + p.dx * across;
        const original = expansion.baseHeight(x, z);
        const carved = river.carve(x, z, original);
        // The beach rises above the sea on its own; only ground the carve
        // lifts there closes the mouth off.
        if (carved > level && carved > original + 0.01) {
          proud.push(`${p.x.toFixed(0)},${p.z.toFixed(0)} ${beyond} m out: ${(carved - level).toFixed(2)} m above the sea`);
        }
      }
    }
  }
  assert.deepEqual(proud.slice(0, 8), [], `${proud.length} samples of bar across the mouth`);
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
      || ((p.getZ(a) === -1100 || p.getZ(a) === 800) && p.getZ(a) === p.getZ(b)), `open interior edge ${key}`);
  }
});

test('exploration routes stay in bounds and configured travel corridors remain walkable', async () => {
  const { expansion, sampler } = await landscape();
  assert.ok(expansion.paths.sample(2, -5) > 0.9);
  assert.ok(expansion.paths.sample(88, -19) > 0.9);
  for (const route of expansion.paths.routes) for (const [x, z] of route.points) {
    assert.ok(sampler.contains(x, z, 25));
    if (route.name === 'Lakeside circuit') assert.ok(sampler.sampleHeight(x, z) > -16, `submerged path ${x},${z}`);
  }

  for (const route of expansion.paths.routes.filter(candidate => candidate.walkable)) {
    const curve = new THREE.CatmullRomCurve3(
      route.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      false,
      'centripetal',
    );
    const samples = curve.getSpacedPoints(Math.ceil(curve.getLength() / 8));
    let previous = null;
    for (const point of samples) {
      const y = sampler.sampleHeight(point.x, point.z);
      if (previous) {
        const river = expansion.river?.sample(point.x, point.z);
        if (!river || river.edge > river.bankBlend + 2) {
          const distance = Math.hypot(point.x - previous.x, point.z - previous.z);
          const grade = Math.abs(y - previous.y) / Math.max(distance, 0.001);
          assert.ok(grade <= route.maxGrade + 0.09, `${route.name} grade ${grade.toFixed(3)}`);
        }
      }
      previous = { x: point.x, y, z: point.z };
    }
  }
});

test('root water geometry contains only lake and river surface attributes', async () => {
  const { expansion, config } = await landscape();
  const geometry = createWaterGeometry(config.water, expansion.river);
  try {
    const count = geometry.attributes.position.count;
    for (const name of ['waterKind', 'waterFlow', 'waterLevel', 'riverSurface', 'normal']) assert.equal(geometry.attributes[name].count, count);
    assert.ok(geometry.boundingBox.max.y > 140);
    assert.ok(geometry.boundingBox.min.y < 0);
    assert.ok(geometry.attributes.waterKind.array.includes(0) && geometry.attributes.waterKind.array.includes(1));
    assert.equal(geometry.attributes.waterKind.array.includes(2), false);
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
  assert.ok(sampler.sampleHeight(720, 160) > config.water.position[1] + 20, 'dry land separates lake and sea away from the outlet');
});

// A ground teleport that sits under the lake or sea drops the player on the bed.
test('ground travel destinations stand above the lake and the sea', async () => {
  const { sampler, config } = await landscape();
  const lake = resolveLakeShape(config);
  for (const location of config.navigation.locations.filter(entry => entry.mode === 'ground')) {
    const [x, z] = location.position;
    const ground = sampler.sampleHeight(x, z);
    if (lake && lakeSignedDistance(x, z, lake) < lake.margin) {
      assert.ok(ground > lake.level + 0.5, `${location.id} is under the lake`);
    }
    if (config.water.sea?.enabled) assert.ok(ground > config.water.sea.level + 0.5, `${location.id} is under the sea`);
  }
});
