import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { coastX, coastalHeight } from '../src/world/coast.js';
import {
  resolveSeaWaves,
  SEA_COMPONENTS,
  seaDepth,
  seaDisplacementBound,
  seaEnvelope,
  sampleSeaNormal,
  sampleSeaSurface,
} from '../src/water/seaWaves.js';
import {
  createSeaTileGeometries,
  SEA_ACROSS_BOUNDS,
  SEA_ALONG_BOUNDS,
  seaTileStats,
} from '../src/water/seaGeometry.js';
import { createWaterGeometry } from '../src/water/waterGeometry.js';
import {
  createSeaDetailTexture,
  SEA_DETAIL_MOMENT_SCALE,
  SEA_DETAIL_SLOPE_RANGE,
} from '../src/water/seaDetail.js';

const sea = { enabled: true, level: -24, shoreX: 1000, depth: 95 };

function disposeTiles(tiles) {
  for (const tile of tiles) tile.geometry.dispose();
}

function position(geometry, index) {
  const p = geometry.attributes.position;
  return [p.getX(index), p.getY(index), p.getZ(index)];
}

test('legacy sea settings resolve to the richer offshore defaults and invalid controls fail clearly', () => {
  const params = resolveSeaWaves(sea);
  assert.equal(params.offshoreAmplitude, 1.6);
  assert.equal(params.beachAmplitude, 0.25);
  assert.equal(params.transitionStart, 30);
  assert.equal(params.transitionEnd, 180);
  assert.deepEqual(SEA_COMPONENTS.map((wave) => wave.wavelength), [56, 38, 28, 20, 16]);
  assert.deepEqual(SEA_COMPONENTS.map((wave) => wave.weight), [0.48, 0.25, 0.14, 0.08, 0.05]);
  assert.equal(params.detailStrength, 1);
  assert.equal(params.whitecapStrength, 1);
  assert.equal(params.crestTranslucency, 1);
  for (const change of [
    { offshoreAmplitude: -1 },
    { choppiness: Number.NaN },
    { beachAmplitude: Infinity },
    { choppiness: 7 },
    { transitionStart: 200 },
    { transitionEnd: 30 },
  ]) assert.throws(() => resolveSeaWaves({ ...sea, ...change }), /water\.sea/);
  assert.throws(
    () => resolveSeaWaves({ ...sea, detail: { fineDistance: 900, mediumDistance: 800 } }),
    /mediumDistance/,
  );
  assert.throws(
    () => resolveSeaWaves({ ...sea, detail: { roughnessMin: 0.5, roughnessMax: 0.2 } }),
    /roughnessMax/,
  );
  assert.equal(resolveSeaWaves({ ...sea, offshoreAmplitude: 0 }).offshoreAmplitude, 0);
});

test('choppy detail is deterministic, seam-safe and stores an unclipped second slope moment', () => {
  const a = createSeaDetailTexture(), b = createSeaDetailTexture();
  try {
    assert.deepEqual(a.image.data, b.image.data);
    const { data, width: size } = a.image;
    let meanX = 0, meanZ = 0, interior = 0, seam = 0, variation = 0, squaredSlope = 0, secondMoment = 0;
    let minSlope = 255, maxSlope = 0, minMoment = 255, maxMoment = 0;
    const moments = new Set();
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      meanX += data[i];
      meanZ += data[i + 1];
      const dx = (data[i] / 255 * 2 - 1) * SEA_DETAIL_SLOPE_RANGE;
      const dz = (data[i + 1] / 255 * 2 - 1) * SEA_DETAIL_SLOPE_RANGE;
      variation += (Math.abs(dx) + Math.abs(dz)) * 0.5;
      squaredSlope += dx * dx + dz * dz;
      secondMoment += data[i + 3] / 255 * SEA_DETAIL_MOMENT_SCALE;
      minSlope = Math.min(minSlope, data[i], data[i + 1]);
      maxSlope = Math.max(maxSlope, data[i], data[i + 1]);
      minMoment = Math.min(minMoment, data[i + 3]);
      maxMoment = Math.max(maxMoment, data[i + 3]);
      moments.add(data[i + 3]);
      if (x) interior += Math.abs(data[i] - data[i - 4]);
      else seam += Math.abs(data[i] - data[(y * size + size - 1) * 4]);
    }
    assert.ok(Math.abs(meanX / (size * size) - 127.5) < 2);
    assert.ok(Math.abs(meanZ / (size * size) - 127.5) < 2);
    assert.ok(variation / (size * size) > 0.2, 'decoded slopes retain visible directional variation');
    assert.ok(Math.abs(secondMoment - squaredSlope) / (size * size) < 0.02,
      'alpha stores the same unfiltered squared-slope moment as RG');
    assert.ok(seam / size < interior / (size * (size - 1)) * 2);
    assert.ok(minSlope > 0 && maxSlope < 255, 'configured slope range does not clip source slopes');
    assert.ok(minMoment >= 0 && maxMoment < 255 && moments.size > 8, 'alpha encodes filtered second moment');
    assert.equal(a.generateMipmaps, true);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('sea depth follows the shared coast shelf continuously beyond terrain texture bounds', () => {
  for (const z of [-1200, -500, 0, 500, 1200]) for (const distance of [0, 1, 30, 79.999, 80, 180, 500, 2500]) {
    const x = coastX(z, sea) + distance;
    assert.ok(Math.abs(seaDepth(distance, sea) - (sea.level - coastalHeight(x, z, 10, sea))) < 1e-8);
  }
  assert.equal(seaDepth(-10, sea), 0);
  assert.equal(seaDepth(5000, sea), sea.depth);
});

test('surf transition is continuous and storm waves remain depth-limited', () => {
  let previous = 0;
  for (let d = 0; d <= 600; d += 0.25) {
    const envelope = seaEnvelope(d, sea, 1);
    assert.ok(envelope.offshore >= previous && envelope.offshore <= 1);
    assert.ok(envelope.amplitude <= envelope.depth * 0.42 + 1e-8);
    if (d) assert.ok(Math.abs(envelope.amplitude - seaEnvelope(d - 0.25, sea, 1).amplitude) < 0.02);
    previous = envelope.offshore;
  }
  assert.equal(seaEnvelope(0, sea).amplitude, 0);
  assert.equal(seaEnvelope(30, sea).offshore, 0);
  assert.equal(seaEnvelope(180, sea).offshore, 1);
  assert.equal(seaDisplacementBound(sea), 2.64);
});

test('waves stay centered and bounded while beach crests travel shoreward', () => {
  for (const d of [0, 8, 24, 80, 180, 470, 3000]) {
    const x = coastX(125, sea) + d;
    let sum = 0, energy = 0;
    for (let i = 0; i < 5000; i += 1) {
      const h = sampleSeaSurface(x, 125, i * 0.37, sea, 1);
      assert.ok(Math.abs(h) <= seaEnvelope(d, sea, 1).amplitude + 1e-7);
      sum += h;
      energy += h * h;
    }
    assert.ok(Math.abs(sum / 5000) < 0.025);
    if (d > 0) assert.ok(energy > 0);
  }
  const z = 0, x = coastX(z, sea) + 24, dt = 0.4;
  const travel = 1.35 / (Math.PI * 2 / 13) * dt;
  const before = sampleSeaSurface(x, z, 2, sea) / seaEnvelope(24, sea).amplitude;
  const after = sampleSeaSurface(x - travel, z, 2 + dt, sea) / seaEnvelope(24 - travel, sea).amplitude;
  assert.ok(Math.abs(before - after) < 1e-7);
});

test('CPU sea normals use the same forward height differences as the TSL wave normal', () => {
  const step = 0.25;
  for (const [distance, z, time, rain] of [[24, 0, 2.4, 0], [80, 190, 8.2, 0.4], [180, -315, 16.7, 1]]) {
    const x = coastX(z, sea) + distance;
    const height = sampleSeaSurface(x, z, time, sea, rain);
    const dx = (sampleSeaSurface(x + step, z, time, sea, rain) - height) / step;
    const dz = (sampleSeaSurface(x, z + step, time, sea, rain) - height) / step;
    const expected = new THREE.Vector3(-dx, 1, -dz).normalize();
    const actual = sampleSeaNormal(x, z, time, sea, rain);
    assert.ok(actual.distanceTo(expected) < 1e-12);
    assert.ok(Number.isFinite(actual.x) && Number.isFinite(actual.y) && Number.isFinite(actual.z));
  }
});

test('sea tiles are 48 crack-safe root-local meshes with quality-scaled geometry and storm bounds', () => {
  const root = [312, -17, 163];
  const qualities = ['performance', 'balanced', 'high', 'ultra'];
  const counts = [];
  for (const quality of qualities) {
    const tiles = createSeaTileGeometries(sea, quality, root);
    try {
      assert.equal(tiles.length, (SEA_ACROSS_BOUNDS.length - 1) * (SEA_ALONG_BOUNDS.length - 1));
      const stats = seaTileStats(tiles);
      assert.equal(stats.tiles, 48);
      counts.push(stats.vertices);
      const bound = seaDisplacementBound(sea);
      for (const tile of tiles) {
        assert.ok(tile.geometry.boundingBox.min.y <= sea.level - root[1] - bound);
        assert.ok(tile.geometry.boundingBox.max.y >= sea.level - root[1] + bound);
        const index = tile.geometry.index;
        const [a, b, c] = [index.getX(0), index.getX(1), index.getX(2)];
        const pa = position(tile.geometry, a), pb = position(tile.geometry, b), pc = position(tile.geometry, c);
        const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        const normalY = ab[2] * ac[0] - ab[0] * ac[2];
        assert.ok(normalY > 0, 'tile winding faces upward');
      }

      const by = new Map(tiles.map((tile) => [`${tile.acrossIndex}:${tile.alongIndex}`, tile]));
      for (let across = 0; across < SEA_ACROSS_BOUNDS.length - 2; across += 1) {
        for (let along = 0; along < SEA_ALONG_BOUNDS.length - 1; along += 1) {
          const left = by.get(`${across}:${along}`), right = by.get(`${across + 1}:${along}`);
          assert.equal(left.rows, right.rows);
          for (let row = 0; row < left.rows; row += 1) {
            assert.deepEqual(
              position(left.geometry, row * left.columns + left.columns - 1),
              position(right.geometry, row * right.columns),
            );
          }
        }
      }
      for (let across = 0; across < SEA_ACROSS_BOUNDS.length - 1; across += 1) {
        for (let along = 0; along < SEA_ALONG_BOUNDS.length - 2; along += 1) {
          const low = by.get(`${across}:${along}`), high = by.get(`${across}:${along + 1}`);
          assert.equal(low.columns, high.columns);
          for (let column = 0; column < low.columns; column += 1) {
            assert.deepEqual(
              position(low.geometry, (low.rows - 1) * low.columns + column),
              position(high.geometry, column),
            );
          }
        }
      }
    } finally {
      disposeTiles(tiles);
    }
  }
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2] && counts[2] < counts[3]);
});

test('root water geometry owns only inland water after sea is split into child tiles', () => {
  const params = { size: 20, segments: 2, position: [312, -17, 163], sea };
  const geometry = createWaterGeometry(params);
  try {
    const kind = geometry.attributes.waterKind;
    for (let i = 0; i < kind.count; i += 1) assert.equal(kind.getX(i), 0);
    assert.ok(geometry.boundingBox.max.x < 20);
  } finally {
    geometry.dispose();
  }
});
