import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  resolveSerpentShape, sampleStations, serpentScaleCoordinates, serpentSection, serpentStations,
} from '../src/wildlife/serpentShape.js';
import { createScaleTileData, createSerpentPatternData, serpentPatternSize } from '../src/wildlife/serpentSkin.js';
import { createSerpentGeometry } from '../src/wildlife/serpentBody.js';
import { GiantSerpent, SerpentTrail } from '../src/wildlife/GiantSerpent.js';
import { SerpentSystem } from '../src/wildlife/SerpentSystem.js';
import { SERPENT_SPECIES, resolveSerpentSettings } from '../src/wildlife/serpentSpecies.js';
import { forestWeight } from '../src/world/LandscapePaths.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import { lakeSignedDistance, resolveLakeShape } from '../src/world/LakeShape.js';
import { coastalJungleProfileWeight } from '../src/world/CoastalJungleRegion.js';

const shape = resolveSerpentShape(SERPENT_SPECIES.reticulated.shape);

test('the body closes at snout and tail, pinches at the neck and is widest mid-body', () => {
  assert.equal(serpentSection(0, shape).w, 0);
  assert.equal(serpentSection(shape.length, shape).w, 0);
  const jaw = serpentSection(shape.headLength * 0.8, shape).w;
  const neck = serpentSection(shape.neck, shape).w;
  const body = serpentSection(shape.length * 0.45, shape).w;
  const snout = serpentSection(shape.headLength * 0.1, shape).w;
  assert.ok(neck < jaw, 'the neck is narrower than the jaw hinges');
  assert.ok(snout < jaw * 0.6, 'the head is a wedge, narrow at the snout');
  assert.ok(Math.abs(body - shape.radius) < shape.radius * 0.06);
  assert.ok(serpentSection(shape.length - 0.5, shape).w < shape.radius * 0.2);
});

test('scale rows keep scales square: rows advance fastest where the body is thinnest', () => {
  const stations = serpentStations(shape);
  const rows = serpentScaleCoordinates(stations, shape);
  for (let index = 1; index < rows.length; index += 1) assert.ok(rows[index] > rows[index - 1]);
  const perMetre = (s) => (sampleStations(stations, rows, s + 0.25) - sampleStations(stations, rows, s - 0.25)) / 0.5;
  assert.ok(perMetre(shape.length - 1) > perMetre(shape.length * 0.45) * 1.5);
  // At full girth a scale is about perimeter / scaleRows long.
  const scale = 1 / perMetre(shape.length * 0.45) / shape.radius;
  assert.ok(scale > 0.07 && scale < 0.11, `scale length ${scale} body radii`);
});

test('the trail returns points by arc length back from the head', () => {
  const trail = new SerpentTrail(20, 0.05);
  trail.reset(0, 0);
  for (let step = 1; step <= 300; step += 1) trail.advance(0, step * 0.1);
  const point = { x: 0, z: 0 };
  assert.deepEqual(trail.sample(0, point), { x: 0, z: 30 });
  trail.sample(7.25, point);
  assert.ok(Math.abs(point.z - 22.75) < 1e-4);
  // Past the stored length it clamps to the oldest point instead of wrapping.
  trail.sample(500, point);
  assert.ok(point.z > 30 - 20.3 && point.z < 30 - 19.9, `oldest ${point.z}`);
});

test('the scale tile wraps seamlessly and the coat is sized before it is drawn', () => {
  const size = 64;
  const { data } = createScaleTileData({ size, columns: 4, rows: 8 });
  const diff = (a, b) => Math.abs(data[a] - data[b]);
  let seam = 0, interior = 0;
  for (let y = 0; y < size; y += 1) {
    seam += diff((y * size + size - 1) * 4 + 2, (y * size) * 4 + 2);
    interior += diff((y * size + 30) * 4 + 2, (y * size + 31) * 4 + 2);
  }
  assert.ok(seam <= interior * 1.5 + size, `seam ${seam} vs interior ${interior}`);
  const small = resolveSerpentShape({ length: 6, scaleRows: 16 });
  const stations = serpentStations(small);
  const scaleCoordinates = serpentScaleCoordinates(stations, small);
  const pattern = createSerpentPatternData({ shape: small, stations, scaleCoordinates, texelsPerScale: 1 });
  const expected = serpentPatternSize(small, scaleCoordinates.at(-1), { texelsPerScale: 1 });
  assert.equal(pattern.width, expected.width);
  assert.equal(pattern.height, expected.height);
  assert.equal(pattern.data.length, expected.width * expected.height * 4);
});

test('rest normals point out of the body', () => {
  const body = createSerpentGeometry(shape);
  const { rest, normals, ringSize } = body;
  const ring = Math.floor(body.rings / 2);
  for (let k = 0; k < ringSize; k += 1) {
    const v = ring * ringSize + k;
    const outward = rest[v * 3] * normals[v * 3] + rest[v * 3 + 1] * normals[v * 3 + 1];
    assert.ok(outward > 0, `vertex ${k} normal points inward`);
  }
  body.geometry.dispose();
});

test('every species paints a finite coat of the size the main thread expects', () => {
  for (const species of Object.keys(SERPENT_SPECIES)) {
    const small = resolveSerpentShape({ ...SERPENT_SPECIES[species].shape, length: 40, scaleRows: 16 });
    const stations = serpentStations(small);
    const scaleCoordinates = serpentScaleCoordinates(stations, small);
    const coat = createSerpentPatternData({ shape: small, stations, scaleCoordinates, species, texelsPerScale: 1 });
    const expected = serpentPatternSize(small, scaleCoordinates.at(-1), { texelsPerScale: 1 });
    assert.equal(coat.width, expected.width, species);
    assert.equal(coat.height, expected.height, species);
    let belly = 0;
    for (let index = 3; index < coat.data.length; index += 4) belly += coat.data[index] > 128 ? 1 : 0;
    const share = belly / (coat.width * coat.height);
    assert.ok(share > 0.1 && share < 0.45, `${species} belly covers ${share.toFixed(2)} of the coat`);
  }
});

test('a jungle serpent lives only with the jungle; a meadow one needs a home', () => {
  const jungleOff = { biomes: { coastalJungle: { enabled: false } } };
  assert.equal(resolveSerpentSettings({ habitat: 'jungle' }, jungleOff).enabled, false);
  const jungleOn = {
    water: { sea: { enabled: true } },
    biomes: { coastalJungle: { enabled: true, region: { zStart: 0, zEnd: 100, inlandStart: 10, inlandEnd: 90 } } },
  };
  const jungle = resolveSerpentSettings({ habitat: 'jungle' }, jungleOn);
  assert.equal(jungle.enabled, true);
  assert.equal(jungle.home[1], 50, 'defaults to the middle of the strip');
  assert.equal(resolveSerpentSettings({ habitat: 'jungle', enabled: false }, jungleOn).enabled, false);
  assert.equal(resolveSerpentSettings({ habitat: 'meadow', species: 'cobra' }, jungleOff).enabled, false);
  const cobra = resolveSerpentSettings({ habitat: 'meadow', species: 'cobra', home: [1, 2], headLift: 30 }, jungleOff);
  assert.equal(cobra.enabled, true);
  assert.equal(cobra.label, 'King cobra');
  assert.equal(cobra.headLift, 30, 'entries override species values');
  assert.ok(cobra.hood);
});

function skinTexture() {
  return new THREE.DataTexture(new Uint8Array(4), 1, 1);
}

function flatWorld(serpent) {
  return {
    water: { sea: { enabled: false } },
    biomes: { coastalJungle: { enabled: false } },
    wildlife: { serpents: [serpent] },
  };
}

test('a python-sized serpent roaming keeps near home, out of the lake and moving', () => {
  const home = [0, 0];
  const lake = {
    bounds: { minX: 5, minZ: -15, maxX: 35, maxZ: 15 },
    segments: [{ ax: 20, az: 0, ar: 12, dx: 0, dz: 0, radiusDelta: 0, lengthSquared: 0 }],
    wobble: 0,
  };
  const terrain = { sampleHeight: (x, z) => Math.sin(x * 0.05) + Math.cos(z * 0.04) };
  const config = flatWorld({
    species: 'reticulated', habitat: 'meadow', home, roamRadius: 35, speed: 1.3, fleeSpeed: 2.6, wavelength: 6.5,
    turnRate: 0.5, headLift: 2.4, neckLength: 6,
    shape: { length: 26, radius: 0.5, headLength: 1.45, headWidth: 0.44, headHeight: 0.27 },
  });
  const settings = resolveSerpentSettings(config.wildlife.serpents[0], config);
  const serpent = new GiantSerpent({
    scene: new THREE.Scene(), terrain, config, settings, tileTexture: skinTexture(), patternTexture: skinTexture(), lake,
  });
  let travelled = 0;
  let lastX = serpent.trail.headX, lastZ = serpent.trail.headZ;
  let farthest = 0, wettest = Infinity;
  for (let frame = 0; frame < 60 * 300; frame += 1) {
    serpent.update(1 / 60, null, null);
    const { headX, headZ } = serpent.trail;
    farthest = Math.max(farthest, Math.hypot(headX - home[0], headZ - home[1]));
    wettest = Math.min(wettest, Math.hypot(headX - 20, headZ) - 12);
    if (frame % 60 === 0) {
      travelled += Math.hypot(headX - lastX, headZ - lastZ);
      lastX = headX;
      lastZ = headZ;
    }
  }
  serpent.dispose();
  assert.ok(farthest < 35 + 12, `strayed ${farthest.toFixed(1)} m from home`);
  assert.ok(wettest > 0, `head went ${(-wettest).toFixed(1)} m into the lake`);
  assert.ok(travelled > 100, `only crawled ${travelled.toFixed(1)} m in five minutes`);
});

test('a cobra that sees a walker stops, rears and spreads its hood', () => {
  const config = flatWorld({ species: 'cobra', habitat: 'meadow', home: [0, 0], roamRadius: 400 });
  const settings = resolveSerpentSettings(config.wildlife.serpents[0], config);
  const serpent = new GiantSerpent({
    scene: new THREE.Scene(), terrain: { sampleHeight: () => 0 }, config, settings,
    tileTexture: skinTexture(), patternTexture: skinTexture(),
  });
  const walker = new THREE.Vector3();
  for (let frame = 0; frame < 60 * 8; frame += 1) {
    // A walker standing 90 m ahead of the head, inside its alert distance.
    const { headX, headZ } = serpent.trail;
    walker.set(headX + Math.sin(serpent.heading) * 90, 0, headZ + Math.cos(serpent.heading) * 90);
    serpent.update(1 / 60, null, walker);
  }
  assert.equal(serpent.state, 'alert');
  assert.ok(serpent.speed < 0.5, `still crawling at ${serpent.speed.toFixed(2)} m/s`);
  const headHeight = serpent.headPosition.y;
  assert.ok(headHeight > settings.headLift * 0.7, `head only ${headHeight.toFixed(1)} m up`);
  const widest = Math.max(...serpent.flare);
  assert.ok(widest > settings.hood.spread * 0.85, `hood spread only ${widest.toFixed(2)}x`);
  serpent.dispose();
});

test('the configured giants keep to their habitats, off the lake and off their own coils', async () => {
  const config = await loadMergedConfig();
  const lake = resolveLakeShape(config);
  const system = new SerpentSystem({ scene: new THREE.Scene(), terrain: { sampleHeight: () => 20 }, config, lake });
  assert.deepEqual(system.serpents.map(serpent => serpent.settings.species), ['reticulated', 'anaconda', 'cobra']);
  const point = { x: 0, z: 0 };
  const stats = system.serpents.map(serpent => ({
    serpent, jungle: [1, 0], forest: 0, shore: Infinity, coil: Infinity, travelled: 0,
    lastX: serpent.trail.headX, lastZ: serpent.trail.headZ,
  }));
  for (let frame = 0; frame < 60 * 240; frame += 1) {
    system.update(1 / 60, null, null);
    for (const stat of stats) {
      const { serpent } = stat;
      const { headX, headZ } = serpent.trail;
      const jungle = coastalJungleProfileWeight(headX, headZ, config);
      stat.jungle = [Math.min(stat.jungle[0], jungle), Math.max(stat.jungle[1], jungle)];
      stat.forest = Math.max(stat.forest, forestWeight(headX, headZ));
      stat.shore = Math.min(stat.shore, lakeSignedDistance(headX, headZ, lake));
      if (frame % 60 === 0) {
        stat.travelled += Math.hypot(headX - stat.lastX, headZ - stat.lastZ);
        stat.lastX = headX;
        stat.lastZ = headZ;
        for (let s = serpent.shape.radius * 6; s < serpent.shape.length; s += serpent.shape.radius) {
          serpent.trail.sample(s, point);
          stat.coil = Math.min(stat.coil, Math.hypot(point.x - headX, point.z - headZ));
        }
      }
    }
  }
  const markers = system.minimapMarkers();
  assert.deepEqual(markers.map(marker => marker.label), ['Python', 'Anaconda', 'King cobra']);
  assert.ok(markers.every(marker => marker.path.length > 8));
  system.dispose();
  for (const { serpent, jungle, forest, shore, coil, travelled } of stats) {
    const name = serpent.settings.label;
    if (serpent.settings.habitat === 'jungle') assert.ok(jungle[0] > 0.5, `${name} left the jungle`);
    else assert.ok(jungle[1] < 0.2 && forest < 0.4, `${name} wandered into the jungle or the forest`);
    assert.ok(shore > serpent.shape.radius, `${name} came ${shore.toFixed(1)} m from the lake`);
    assert.ok(coil > serpent.shape.radius * 2, `${name} ran into its own body (${coil.toFixed(1)} m)`);
    assert.ok(travelled > 300, `${name} only crawled ${travelled.toFixed(0)} m in four minutes`);
  }
});
