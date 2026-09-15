import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';
import { resolveSnowWakeConfig } from '../src/config/resolveSnowWakeConfig.js';
import { SPINE_ROWS, SnowWakeSpine, readPackedSpine } from '../src/world/snowWakeSpine.js';
import { wakeBaseOffset, wakeSection } from '../src/world/snowWakeProfile.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
const wake = resolveSnowWakeConfig(snowConfig.ground.snow.wake);

function trace(curl) {
  const points = [];
  for (let step = 0; step <= 40; step += 1) points.push(wakeSection(step / 40, curl, { x: 0, y: 0 }));
  return points;
}

// The rider heads toward -z, so the bow sits 0.55 m past the newest sample.
function packStraightRun(spine, data, { carve = 0, clock, strength = 1 }) {
  return spine.pack(data, {
    clock,
    bowX: 0,
    bowY: 0,
    bowZ: spine.z[spine.head] - 0.55,
    rightX: 1,
    rightZ: 0,
    strength,
    carve,
    life: wake.lifeSeconds,
    maxHeight: wake.maxHeight,
    scale: 1,
  });
}

test('wake section is a unit-height wave whose full curl hangs the lip back over the face', () => {
  for (const curl of [0.26, 0.6, 1]) {
    const peak = Math.max(...trace(curl).map((point) => point.y));
    assert.ok(peak > 0.75 && peak < 1.3, `curl ${curl} crest ${peak}`);
  }
  // Snowflow: at curl 1 the tip sits near 47% of the crest's lateral offset
  // and 65% of its height.
  const plunging = trace(1);
  const crestX = Math.max(...plunging.map((point) => point.x));
  const crestY = Math.max(...plunging.map((point) => point.y));
  assert.ok(plunging.at(-1).x < crestX * 0.6);
  assert.ok(plunging.at(-1).y < crestY * 0.75);
  const overhang = (points) => Math.max(...points.map((point) => point.x)) - points.at(-1).x;
  assert.ok(overhang(plunging) > overhang(trace(0.26)));
  assert.ok(wakeBaseOffset(3) > wakeBaseOffset(0));
});

test('spine resamples at a fixed spacing and packs into a 4.6 KB float texture', () => {
  const spine = new SnowWakeSpine(wake.capacity);
  const data = new Float32Array(wake.capacity * SPINE_ROWS * 4);
  assert.equal(data.byteLength, 4608);

  spine.update(0, 0, 0, 0, 1, 0, 1, 0, wake.spineStep);
  // One large frame step still commits evenly spaced samples.
  spine.update(0.1, 0, 0, -3.05, 1, 0, 1, 0, wake.spineStep);
  assert.equal(spine.count, 11);
  const layout = packStraightRun(spine, data, { clock: 0.1 });
  assert.equal(layout.count, 12);
  for (let slot = 2; slot < layout.count; slot += 1) {
    const gap = data[slot * 4 + 3] - data[(slot - 1) * 4 + 3];
    assert.ok(Math.abs(gap - wake.spineStep) < 1e-5);
  }

  // A teleport longer than the ring restarts rather than drawing a wall across it.
  spine.update(0.2, 500, 0, 500, 1, 0, 1, 0, wake.spineStep);
  assert.equal(spine.count, 1);
});

test('carve loads the outside wall, and collapsed samples retire from the packed spine', () => {
  const spine = new SnowWakeSpine(wake.capacity);
  const data = new Float32Array(wake.capacity * SPINE_ROWS * 4);
  for (let step = 0; step <= 20; step += 1) spine.update(0, 0, 0, -step * 0.3, 1, 0, 1, 0.8, wake.spineStep);

  const layout = packStraightRun(spine, data, { carve: 0.8, clock: 0.2 });
  const sample = readPackedSpine(data, wake.capacity, layout.count, 8, {});
  assert.ok(sample.ampL > sample.ampR * 3, 'right turn piles snow on the left');
  assert.ok(sample.curlL > sample.curlR);
  assert.ok(layout.maxAmp <= wake.maxHeight);

  const collapsed = packStraightRun(spine, data, { carve: 0.8, clock: wake.lifeSeconds + 0.01, strength: 0 });
  assert.equal(collapsed.count, 2, 'the bow plus the first finished sample');
  assert.equal(collapsed.maxAmp, 0);
});

test('snow validation rejects an inverted wake speed range and missing detail textures', () => {
  const invalid = structuredClone(snowConfig);
  invalid.ground.snow.wake.fullSpeed = invalid.ground.snow.wake.minSpeed;
  assert.throws(() => validateSnowConfig(invalid), /wake\.fullSpeed/);

  const missingTexture = structuredClone(snowConfig);
  delete missingTexture.ground.snow.textures.normal;
  assert.throws(() => validateSnowConfig(missingTexture), /textures\.normal/);
});
