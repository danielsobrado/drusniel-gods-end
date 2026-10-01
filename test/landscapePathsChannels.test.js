import assert from 'node:assert/strict';
import test from 'node:test';
import { LandscapePaths } from '../src/world/LandscapePaths.js';

const RES = 32;

function texel(paths, x, z, channel) {
  const res = paths.texture.image.width;
  const px = Math.floor((x - paths.minX) / paths.width * res), pz = Math.floor((z - paths.minZ) / paths.depth * res);
  return paths.texture.image.data[(pz * res + px) * 4 + channel];
}

test('path texture keeps R for paths and reserves G/B for the ground', () => {
  const paths = new LandscapePaths(320, 320, 0, 0);
  paths.createTexture(RES);
  const data = paths.texture.image.data;
  let pathTexels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 0) pathTexels++;
    assert.equal(data[i + 1], 0, 'G starts as "grass grows"');
    assert.equal(data[i + 2], 0, 'B starts unshaded');
  }
  assert.ok(pathTexels > 0, 'authored routes still paint R');
});

test('grass exclusion is resampled into G without touching R', () => {
  const paths = new LandscapePaths(320, 320, 0, 0);
  paths.createTexture(RES);
  const before = paths.texture.image.data.filter((_, i) => i % 4 === 0);
  // A corner-aligned 5x5 field excluding grass only in its +X half.
  const field = new Uint8Array(5 * 5 * 4);
  for (let z = 0; z < 5; z++) for (let x = 3; x < 5; x++) field[(z * 5 + x) * 4] = 255;
  const version = paths.texture.version;
  assert.equal(paths.writeVegetationExclusion({ image: { width: 5, height: 5, data: field } }), true);
  assert.ok(paths.texture.version > version, 'the texture re-uploads');
  assert.equal(texel(paths, 150, 0, 1), 255);
  assert.equal(texel(paths, -150, 0, 1), 0);
  assert.deepEqual(paths.texture.image.data.filter((_, i) => i % 4 === 0), before);
});

test('contact shade peaks at each footprint and fades to nothing at its radius', () => {
  const paths = new LandscapePaths(320, 320, 0, 0);
  paths.createTexture(RES);
  paths.writeContactShade([{ x: 50, z: 50, radius: 40, strength: 1 }, { x: 55, z: 50, radius: 10, strength: 0.2 }]);
  const centre = texel(paths, 50, 50, 2), mid = texel(paths, 70, 50, 2), outside = texel(paths, 110, 50, 2);
  assert.ok(centre > 150, `centre ${centre}`);
  assert.ok(mid > 0 && mid < centre, `mid ${mid}`);
  assert.equal(outside, 0);
  assert.equal(texel(paths, -100, -100, 2), 0);
});
