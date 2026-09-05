import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleGrassMask } from '../src/grass/sampleGrassMask.js';
import {
  DEFAULT_VEGETATION_CUTOFF,
  DEFAULT_VEGETATION_SOFTNESS,
  allowsVegetation,
  dilatePathMask,
  dilationRadius,
  resolveVegetationPolicy,
  vegetationStrength,
} from '../src/grass/vegetationPolicy.js';

const rgba = (values) => {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((red, i) => {
    data[i * 4] = red;
    data[i * 4 + 1] = red;
    data[i * 4 + 2] = red;
    data[i * 4 + 3] = 255;
  });
  return data;
};
const reds = (data) => Array.from({ length: data.length / 4 }, (_, i) => data[i * 4]);

test('the cutoff gates the path fringe without shortening painted grass', () => {
  assert.equal(vegetationStrength(0), 0);
  assert.equal(vegetationStrength(0.3), 0, 'exactly at the cutoff nothing grows');
  assert.equal(vegetationStrength(0.05), 0, 'the old GRASS_CUTOFF fringe is now removed');
  assert.ok(vegetationStrength(0.35) > 0 && vegetationStrength(0.35) < 0.35, 'the ramp is continuous');
  for (const raw of [0.42, 0.6, 0.83, 1]) {
    assert.equal(vegetationStrength(raw), raw, `strength above the ramp is unchanged at ${raw}`);
  }
  assert.ok(allowsVegetation(vegetationStrength(1)));
  assert.ok(!allowsVegetation(vegetationStrength(0.2)));
});

test('clearance in metres becomes whole mask pixels', () => {
  assert.deepEqual(dilationRadius(0.5, { x: 370, z: 370 }, 1024), { x: 1, y: 1 }, '~0.36 m/px rounds to one pixel');
  assert.deepEqual(dilationRadius(1.5, { x: 370, z: 370 }, 1024), { x: 4, y: 4 });
  assert.deepEqual(dilationRadius(0, { x: 370, z: 370 }, 1024), { x: 0, y: 0 }, 'no clearance means no dilation');
  assert.deepEqual(dilationRadius(0.05, { x: 370, z: 370 }, 1024), { x: 1, y: 1 }, 'a requested clearance never rounds away');
});

test('dilation grows paths by exactly the radius and is identity at radius zero', () => {
  const source = rgba([0, 0, 0, 0, 255, 0, 0, 0, 0]);
  const grown = dilatePathMask(source, new Uint8ClampedArray(source.length), 3, 3, 1, 1);
  assert.deepEqual(reds(grown), [255, 255, 255, 255, 255, 255, 255, 255, 255]);

  const identity = dilatePathMask(source, new Uint8ClampedArray(source.length), 3, 3, 0, 0);
  assert.deepEqual(reds(identity), reds(source));
});

test('a rect-limited dilation matches the full dilation over that region', () => {
  const width = 8;
  const height = 8;
  const source = rgba(Array.from({ length: width * height }, (_, i) => (i % 11 === 0 ? 255 : 0)));
  const full = dilatePathMask(source, new Uint8ClampedArray(source.length), width, height, 1, 1);
  const partial = dilatePathMask(source, new Uint8ClampedArray(source.length), width, height, 1, 1, { x: 3, y: 3, width: 2, height: 2 });
  for (let y = 3; y < 5; y += 1) {
    for (let x = 3; x < 5; x += 1) {
      assert.equal(partial[(y * width + x) * 4], full[(y * width + x) * 4], `pixel ${x},${y}`);
    }
  }
});

test('the policy reads config with defaults', () => {
  assert.deepEqual(resolveVegetationPolicy({}), {
    cutoff: DEFAULT_VEGETATION_CUTOFF,
    softness: DEFAULT_VEGETATION_SOFTNESS,
    clearance: 0.5,
  });
  assert.deepEqual(
    resolveVegetationPolicy({ grass: { vegetationCutoff: 0.4, maskSoftness: 0.2, pathClearance: 1.5 } }),
    { cutoff: 0.4, softness: 0.2, clearance: 1.5 },
  );
});

// Locks the mask row order. GrassMask.sampleWorld used to index ImageData rows
// top-down without the flipY inversion, which read the path network vertically
// mirrored and scattered plants straight onto the trails.
test('world z maps to mask rows bottom-up, matching the flipY upload', () => {
  const width = 4;
  const height = 4;
  const pixels = new Array(width * height).fill(0);
  pixels[1 * width + 1] = 255;                     // one path pixel, row 1 from the top
  const image = { width, height, data: rgba(pixels) };

  const bounds = { min: { x: 0, z: 0 }, max: { x: 4, z: 4 } };
  const strengthAt = (x, z) => {
    if (x < bounds.min.x || x > bounds.max.x || z < bounds.min.z || z > bounds.max.z) return 0;
    const u = (x - bounds.min.x) / (bounds.max.x - bounds.min.x);
    const v = (z - bounds.min.z) / (bounds.max.z - bounds.min.z);
    return vegetationStrength(sampleGrassMask(image, u, 1 - v));
  };

  // Row 1 of 4 counted from the image top is world z = 2.5 counted from min z.
  assert.equal(strengthAt(1.5, 2.5), 0, 'no vegetation on the painted pixel');
  assert.ok(strengthAt(1.5, 1.5) > 0, 'the vertically mirrored position is still grass');
  assert.equal(strengthAt(-1, 2), 0, 'outside the terrain bounds nothing grows');
});
