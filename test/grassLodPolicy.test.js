import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import {
  MAX_GRASS_DETAIL,
  grassTrianglesPerBlade,
  validateGrassLodBands,
  validateGrassQualityLod,
} from '../src/grass/grassLodPolicy.js';
import { createGrassGeometry } from '../src/grass/GrassGeometry.js';
import {
  LOD_ORDER,
  grassLodThresholds,
  selectGrassLod,
  selectGrassLodFromThresholds,
} from '../src/grass/GrassFieldLayout.js';

// The shipped values are the merged ones: visual-refinement.yaml overrides the
// densities that config.yaml declares, so validating config.yaml alone would
// check a configuration the runtime never sees.
const config = await loadMergedConfig();

function bands(overrides = {}) {
  const base = {
    high: { detail: 5, density: 4.5, distance: 0.12 },
    medium: { detail: 3, density: 4.5, distance: 0.3 },
    low: { detail: 2, density: 3, distance: 0.55 },
    veryLow: { detail: 1, density: 2, distance: 1 },
  };
  for (const [name, patch] of Object.entries(overrides)) base[name] = { ...base[name], ...patch };
  return base;
}

test('the triangle budget per blade stays at 2 * detail - 1 for every band detail', () => {
  const expected = { 1: 1, 2: 3, 3: 5, 4: 7, 5: 9 };
  for (const [detail, triangles] of Object.entries(expected)) {
    assert.equal(grassTrianglesPerBlade(Number(detail)), triangles, `detail ${detail}`);
    const geometry = createGrassGeometry({
      type: 'blade', shape: 'slender', detail: Number(detail),
      density: 1, tileSize: 4, bladeHeight: 1.5, stable: true,
    });
    assert.equal(geometry.index.count / 3, triangles, `detail ${detail} geometry`);
  }
});

test('shipped quality profiles satisfy the LOD band policy', () => {
  assert.deepEqual(validateGrassQualityLod(config, []), []);
});

test('every shipped blade profile keeps detail 5 nearest and falls off monotonically', () => {
  for (const [name, profile] of Object.entries(config.quality)) {
    const lod = profile.blade.lod;
    const details = LOD_ORDER.map((band) => lod[band].detail);
    const densities = LOD_ORDER.map((band) => lod[band].density);
    assert.deepEqual([...details].sort((a, b) => b - a), details, `${name} detail order`);
    assert.deepEqual([...densities].sort((a, b) => b - a), densities, `${name} density order`);
  }
});

test('segmentation is allowed to fall faster than population', () => {
  // The point of the retune: the medium band keeps the near band's stems and
  // only gives up curvature. Guards against a regression to density-first LOD.
  const lod = config.quality.high.blade.lod;
  assert.equal(lod.medium.density, lod.high.density);
  assert.ok(lod.medium.detail < lod.high.detail);
});

test('the near band still builds the geometry it built before the LOD retune', () => {
  // The retune moved where the near band ends; it must not have touched what the
  // near band is. These are the shipped values from before the change, so a
  // future edit to detail or density in the near band fails here.
  const reference = { high: { detail: 5, density: 3.4 }, ultra: { detail: 5, density: 4.3 } };
  for (const [name, expected] of Object.entries(reference)) {
    const band = config.quality[name].blade.lod.high;
    assert.equal(band.detail, expected.detail, `${name} near detail`);
    assert.equal(band.density, expected.density, `${name} near density`);

    const build = ({ detail, density }) => createGrassGeometry({
      type: 'blade', shape: config.grass.shape, detail, density,
      tileSize: config.grass.tileSize, bladeHeight: config.grass.blade.bladeHeight, stable: true,
    });
    const before = build(expected);
    const after = build(band);
    assert.deepEqual([...after.index.array], [...before.index.array], `${name} index`);
    assert.equal(after.instanceCount, before.instanceCount, `${name} instance count`);
    for (const attribute of ['position', 'instancePosition', 'instanceRotation', 'instanceData']) {
      assert.deepEqual([...after.getAttribute(attribute).array],
        [...before.getAttribute(attribute).array], `${name} ${attribute}`);
    }
  }
});

test('band validation rejects negative, zero and out-of-range distances', () => {
  for (const distance of [-1, 0, 1.5, Number.NaN]) {
    const problems = validateGrassLodBands(bands({ medium: { distance } }), 'lod', []);
    assert.ok(problems.some((p) => p.includes('lod.medium.distance')), `distance ${distance}`);
  }
});

test('band validation rejects non-monotonic distances', () => {
  const problems = validateGrassLodBands(bands({ medium: { distance: 0.1 } }), 'lod', []);
  assert.ok(problems.some((p) => p.includes('must exceed the nearer band')));
});

test('band validation rejects a far band that is more detailed or denser than a near one', () => {
  assert.ok(validateGrassLodBands(bands({ low: { detail: 5 } }), 'lod', [])
    .some((p) => p.includes("exceeds the nearer band's")));
  assert.ok(validateGrassLodBands(bands({ low: { density: 9 } }), 'lod', [])
    .some((p) => p.includes("exceeds the nearer band's")));
});

test('band validation rejects invalid detail values', () => {
  for (const detail of [0, -2, 2.5, MAX_GRASS_DETAIL + 1]) {
    const problems = validateGrassLodBands(bands({ high: { detail } }), 'lod', []);
    assert.ok(problems.some((p) => p.includes('lod.high.detail')), `detail ${detail}`);
  }
});

test('band validation requires the last band to reach maxDistance', () => {
  const problems = validateGrassLodBands(bands({ veryLow: { distance: 0.9 } }), 'lod', []);
  assert.ok(problems.some((p) => p.includes('must be 1 so the bands reach maxDistance')));
});

test('LOD selection uses the configured thresholds rather than hardcoded distances', () => {
  const { maxDistance, lod } = config.quality.high.blade;
  const thresholds = grassLodThresholds(maxDistance, lod, []);
  const at = (metres) => selectGrassLodFromThresholds(metres * metres, thresholds);
  assert.equal(at(0), 'high');
  assert.equal(at(lod.high.distance * maxDistance - 0.1), 'high');
  assert.equal(at(lod.high.distance * maxDistance + 0.1), 'medium');
  assert.equal(at(lod.medium.distance * maxDistance + 0.1), 'low');
  assert.equal(at(lod.low.distance * maxDistance + 0.1), 'veryLow');
  assert.equal(at(maxDistance * 2), 'veryLow');
});

test('a tile overlapping the camera always selects the full-quality band', () => {
  // tileDistanceSquared measures to the nearest tile edge, so the tile holding
  // the player and every tile it touches report distance 0.
  for (const [name, profile] of Object.entries(config.quality)) {
    const { maxDistance, lod } = profile.blade;
    assert.equal(selectGrassLod(0, maxDistance, lod), 'high', `${name} at distance 0`);
    assert.equal(lod.high.detail, Math.max(...LOD_ORDER.map((b) => lod[b].detail)), `${name} peak detail`);
  }
});

test('the near band clears the interaction footprint on every profile', () => {
  // Trampled grass must never be a lower-detail representation. The tile holding
  // the player already reports distance 0, so this only guards the band width
  // against being tuned down into the radius the player actually disturbs.
  const reach = config.grass.interaction.footRadius * 2;
  for (const [name, profile] of Object.entries(config.quality)) {
    const nearRadius = profile.blade.lod.high.distance * profile.blade.maxDistance;
    assert.ok(nearRadius > reach, `${name} near band is ${nearRadius}m, inside the ${reach}m interaction reach`);
  }
});

test('the acceptance profiles hold full detail past the neighbouring tile seam', () => {
  // High and Ultra are the visual reference. The band is picked from the
  // distance to a tile's nearest EDGE, so the camera's own tile always scores 0
  // and the binding case is standing at a tile centre: the neighbouring tile's
  // near edge is half a tile away there, and a shorter near band would leave
  // the tile the player is walking into at medium detail.
  const half = config.grass.tileSize * 0.5;
  for (const name of ['high', 'ultra']) {
    const { lod, maxDistance } = config.quality[name].blade;
    assert.ok(lod.high.distance * maxDistance >= half,
      `${name} near band is under half a ${config.grass.tileSize}m tile`);
  }
});

test('threshold selection is deterministic and free of frame-dependent state', () => {
  const { maxDistance, lod } = config.quality.high.blade;
  const thresholds = grassLodThresholds(maxDistance, lod, []);
  const random = Math.random;
  const now = Date.now;
  try {
    Math.random = () => { throw new Error('LOD selection must not consume randomness'); };
    Date.now = () => { throw new Error('LOD selection must not read the clock'); };
    const first = [0, 10, 40, 80, 200].map((d) => selectGrassLodFromThresholds(d * d, thresholds));
    const second = [0, 10, 40, 80, 200].map((d) => selectGrassLodFromThresholds(d * d, thresholds));
    assert.deepEqual(first, second);
  } finally {
    Math.random = random;
    Date.now = now;
  }
});
