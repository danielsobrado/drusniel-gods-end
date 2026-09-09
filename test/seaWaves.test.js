import test from 'node:test';
import assert from 'node:assert/strict';
import { coastX, coastalHeight } from '../src/world/coast.js';
import { resolveSeaWaves, seaDepth, seaEnvelope, sampleSeaSurface, seaDisplacementBound } from '../src/water/seaWaves.js';
import { createWaterGeometry } from '../src/water/waterGeometry.js';
import { createSeaDetailTexture } from '../src/water/seaDetail.js';

const sea = { enabled: true, level: -24, shoreX: 1000, depth: 95 };

test('existing sea settings get wave defaults; invalid wave controls fail with a named error', () => {
  const p = resolveSeaWaves(sea);
  assert.equal(p.offshoreAmplitude, 1.2);
  assert.equal(p.beachAmplitude, 0.25);
  assert.equal(p.transitionStart, 30);
  assert.equal(p.transitionEnd, 180);
  for (const change of [{ offshoreAmplitude: -1 }, { choppiness: NaN }, { beachAmplitude: Infinity },
    { choppiness: 7 }, { transitionStart: 200 }, { transitionEnd: 30 }]) {
    assert.throws(() => resolveSeaWaves({ ...sea, ...change }), /water.sea/);
  }
  assert.equal(resolveSeaWaves({ ...sea, offshoreAmplitude: 0 }).offshoreAmplitude, 0);
});

test('choppy detail is deterministic, balanced, and wraps without a slope seam', () => {
  const a = createSeaDetailTexture(), b = createSeaDetailTexture();
  try {
    assert.deepEqual(a.image.data, b.image.data);
    const { data, width: size } = a.image;
    let meanX = 0, meanZ = 0, interior = 0, seam = 0, variation = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      meanX += data[i]; meanZ += data[i + 1]; variation += Math.abs(data[i] - 128);
      if (x) interior += Math.abs(data[i] - data[i - 4]);
      else seam += Math.abs(data[i] - data[(y * size + size - 1) * 4]);
    }
    assert.ok(Math.abs(meanX / (size * size) - 127.5) < 2);
    assert.ok(Math.abs(meanZ / (size * size) - 127.5) < 2);
    assert.ok(variation / (size * size) > 10);
    assert.ok(seam / size < interior / (size * (size - 1)) * 2);
    assert.equal(a.generateMipmaps, true);
  } finally { a.dispose(); b.dispose(); }
});

test('sea depth follows the authored shelf continuously and remains deep beyond the terrain map', () => {
  for (const z of [-1200, -500, 0, 500, 1200]) for (const distance of [0, 1, 30, 79.999, 80, 180, 500, 2500]) {
    const x = coastX(z, sea.shoreX) + distance;
    assert.ok(Math.abs(seaDepth(distance, sea) - (sea.level - coastalHeight(x, z, 10, sea))) < 1e-8);
  }
  assert.equal(seaDepth(-10, sea), 0);
  assert.equal(seaDepth(5000, sea), sea.depth);
});

test('the surf transition is continuous and storm waves cannot expose the seabed', () => {
  let previous = 0;
  for (let d = 0; d <= 600; d += 0.25) {
    const p = seaEnvelope(d, sea, 1);
    assert.ok(p.offshore >= previous && p.offshore <= 1);
    assert.ok(p.amplitude <= p.depth * 0.42 + 1e-8);
    if (d) assert.ok(Math.abs(p.amplitude - seaEnvelope(d - 0.25, sea, 1).amplitude) < 0.02);
    previous = p.offshore;
  }
  assert.equal(seaEnvelope(0, sea).amplitude, 0);
  assert.equal(seaEnvelope(30, sea).offshore, 0);
  assert.equal(seaEnvelope(180, sea).offshore, 1);
});

test('waves oscillate around sea level, stay bounded in storms, and beach crests travel shoreward', () => {
  for (const d of [0, 8, 24, 80, 180, 470, 3000]) {
    const x = coastX(125, sea.shoreX) + d;
    let sum = 0, energy = 0;
    for (let i = 0; i < 5000; i++) {
      const h = sampleSeaSurface(x, 125, i * 0.37, sea, 1);
      assert.ok(Math.abs(h) <= seaEnvelope(d, sea, 1).amplitude + 1e-7);
      sum += h; energy += h * h;
    }
    assert.ok(Math.abs(sum / 5000) < 0.02);
    if (d > 0) assert.ok(energy > 0);
  }
  const z = 0, x = coastX(z, sea.shoreX) + 24, dt = 0.4;
  const travel = 1.35 / (Math.PI * 2 / 13) * dt;
  const before = sampleSeaSurface(x, z, 2, sea) / seaEnvelope(24, sea).amplitude;
  const after = sampleSeaSurface(x - travel, z, 2 + dt, sea) / seaEnvelope(24 - travel, sea).amplitude;
  assert.ok(Math.abs(before - after) < 1e-7);
});

test('coastal grid resolves surf, shares all interior edges, and bounds include storm displacement', () => {
  const params = { size: 20, segments: 2, position: [312, -17, 163], sea };
  const g = createWaterGeometry(params);
  try {
    const p = g.attributes.position, kind = g.attributes.waterKind, index = g.index;
    const edges = new Map(), vertices = new Set();
    let surfEdges = 0;
    for (let i = 0; i < index.count; i += 3) {
      const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      if (kind.getX(ids[0]) !== 2) continue;
      const [a, b, c] = ids;
      const area = (p.getZ(b) - p.getZ(a)) * (p.getX(c) - p.getX(a)) - (p.getX(b) - p.getX(a)) * (p.getZ(c) - p.getZ(a));
      assert.ok(area > 0);
      for (let j = 0; j < 3; j++) {
        const a = ids[j], b = ids[(j + 1) % 3];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1); vertices.add(a);
        const z = p.getZ(a) + params.position[2], d = p.getX(a) + params.position[0] - coastX(z, sea.shoreX);
        if (Math.abs(z) < 700 && d > 2 && d < 75 && p.getZ(a) === p.getZ(b)) {
          assert.ok(Math.abs(p.getX(a) - p.getX(b)) <= 1.001); surfEdges++;
        }
      }
    }
    assert.ok(surfEdges > 1000);
    const boundaryDegree = new Map();
    for (const [edge, count] of edges) {
      assert.ok(count === 1 || count === 2);
      if (count === 1) for (const id of edge.split(',').map(Number)) boundaryDegree.set(id, (boundaryDegree.get(id) ?? 0) + 1);
    }
    for (const degree of boundaryDegree.values()) assert.equal(degree, 2);
    const faces = [...edges.values()].reduce((sum, n) => sum + n, 0) / 3;
    assert.equal(vertices.size - edges.size + faces, 1, 'one connected sea disk without holes');
    const bound = seaDisplacementBound(sea);
    assert.ok(g.boundingBox.min.y <= sea.level - params.position[1] - bound);
    for (const id of vertices) {
      const y = p.getY(id) - bound;
      const distance = Math.hypot(p.getX(id) - g.boundingSphere.center.x, y - g.boundingSphere.center.y, p.getZ(id) - g.boundingSphere.center.z);
      assert.ok(distance <= g.boundingSphere.radius + 1e-6);
    }
  } finally { g.dispose(); }
});
