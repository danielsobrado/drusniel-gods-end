import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeTerrainNormal, sampleHeightGrid, terrainNormalAtUv } from '../src/grass/terrainNormals.js';

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
