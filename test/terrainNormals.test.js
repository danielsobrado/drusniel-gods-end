import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerrainNormalDataTexture,
  encodeTerrainNormal,
  sampleHeightGrid,
  terrainNormalAtUv,
} from '../src/grass/terrainNormals.js';

test('CPU terrain normals match the four-tap height difference used by grass', () => {
  const resolution = 8;
  const size = { x: 16, z: 16 };
  const heights = new Float32Array(resolution * resolution);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      heights[y * resolution + x] = x * 0.4 + y * 0.15;
    }
  }
  const u = 0.5;
  const v = 0.5;
  const du = 0.8 / size.x;
  const dv = 0.8 / size.z;
  const nx = sampleHeightGrid(heights, resolution, u - du, v) - sampleHeightGrid(heights, resolution, u + du, v);
  const ny = 1.6;
  const nz = sampleHeightGrid(heights, resolution, u, v - dv) - sampleHeightGrid(heights, resolution, u, v + dv);
  const length = Math.hypot(nx, ny, nz);
  const [ax, ay, az] = terrainNormalAtUv(heights, resolution, size, u, v);
  assert.ok(Math.abs(ax - nx / length) < 1e-12);
  assert.ok(Math.abs(ay - ny / length) < 1e-12);
  assert.ok(Math.abs(az - nz / length) < 1e-12);
  const encoded = encodeTerrainNormal(ax, ay, az);
  assert.equal(encoded.length, 3);
  assert.ok(encoded.every((channel) => channel >= 0 && channel <= 255));
});


test('terrain normal texture preserves the reference per-pixel encoding exactly', () => {
  const resolution = 31;
  const size = { x: 73.5, z: 91.25 };
  const heights = new Float32Array(resolution * resolution);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      heights[y * resolution + x] = Math.sin(x * 0.37) * 4.5 + Math.cos(y * 0.23) * 2.1 + x * y * 0.003;
    }
  }

  const expected = new Uint8Array(resolution * resolution * 4);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const u = x / (resolution - 1);
      const v = y / (resolution - 1);
      const [nx, ny, nz] = terrainNormalAtUv(heights, resolution, size, u, v);
      const [r, g, b] = encodeTerrainNormal(nx, ny, nz);
      const index = (y * resolution + x) * 4;
      expected[index] = r;
      expected[index + 1] = g;
      expected[index + 2] = b;
      expected[index + 3] = 255;
    }
  }

  const texture = createTerrainNormalDataTexture(heights, resolution, size);
  try {
    assert.deepEqual(texture.image.data, expected);
  } finally {
    texture.dispose();
  }
});
