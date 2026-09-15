import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { validateSnowConfig } from '../src/config/validateSnowConfig.js';
import { resolveSnowWakeConfig } from '../src/config/resolveSnowWakeConfig.js';
import { SPINE_ROWS, SnowWakeSpine, readPackedSpine } from '../src/world/snowWakeSpine.js';
import { wakeCrestParameter, wakeSection } from '../src/world/snowWakeProfile.js';

const snowConfig = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));
const wake = resolveSnowWakeConfig(snowConfig.ground.snow.wake);

function trace(curl) {
  const points = [];
  for (let step = 0; step <= 40; step += 1) points.push(wakeSection(step / 40, curl, { x: 0, y: 0 }));
  return points;
}

// The rider heads toward -z, so the bow sits 0.55 m past the newest sample.
function packStraightRun(spine, data, { carve = 0, clock }) {
  return spine.pack(data, {
    clock,
    bowX: 0,
    bowY: 0,
    bowZ: spine.z[spine.head] - 0.55,
    rightX: 1,
    rightZ: 0,
    strength: 1,
    carve,
    life: wake.lifeSeconds,
    maxHeight: wake.maxHeight,
    scale: 1,
    step: wake.spineStep,
  });
}

test('wake section rises to a unit crest and curl turns a heap into an overhanging lip', () => {
  for (const curl of [0.26, 0.6, 1]) {
    const peak = Math.max(...trace(curl).map((point) => point.y));
    assert.ok(Math.abs(peak - 1) < 0.06, `curl ${curl} crest ${peak}`);
  }
  const overhang = (curl) => {
    const points = trace(curl);
    return Math.max(...points.map((point) => point.x)) - points.at(-1).x;
  };
  assert.ok(overhang(1) > overhang(0.26) + 0.3);
  // A full curl finishes below its crest, hanging back over the face.
  assert.ok(trace(1).at(-1).y < 0.8);
  assert.ok(wakeCrestParameter(1) < wakeCrestParameter(0.26));
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
  assert.equal(layout.entries, 12);
  for (let slot = 2; slot < layout.entries; slot += 1) {
    const gap = data[slot * 4 + 3] - data[(slot - 1) * 4 + 3];
    assert.ok(Math.abs(gap - wake.spineStep) < 1e-5);
  }

  // A teleport longer than the ring restarts rather than drawing a wall across it.
  spine.update(0.2, 500, 0, 500, 1, 0, 1, 0, wake.spineStep);
  assert.equal(spine.count, 1);
});

test('carve loads the outside wall, and the wall collapses at the end of its life', () => {
  const spine = new SnowWakeSpine(wake.capacity);
  const data = new Float32Array(wake.capacity * SPINE_ROWS * 4);
  for (let step = 0; step <= 20; step += 1) spine.update(0, 0, 0, -step * 0.3, 1, 0, 1, 0.8, wake.spineStep);

  const layout = packStraightRun(spine, data, { carve: 0.8, clock: 0.2 });
  const sample = readPackedSpine(data, wake.capacity, layout, 3, {});
  assert.ok(sample.ampL > sample.ampR * 3, 'right turn piles snow on the left');
  assert.ok(sample.curlL > sample.curlR);
  assert.ok(sample.ampL <= wake.maxHeight);

  const collapsed = packStraightRun(spine, data, { carve: 0.8, clock: wake.lifeSeconds + 0.01 });
  const late = readPackedSpine(data, wake.capacity, collapsed, 3, {});
  assert.equal(late.ampL, 0);
  assert.equal(collapsed.live, false);
});

test('snow validation rejects an inverted wake speed range', () => {
  const invalid = structuredClone(snowConfig);
  invalid.ground.snow.wake.fullSpeed = invalid.ground.snow.wake.minSpeed;
  assert.throws(() => validateSnowConfig(invalid), /wake\.fullSpeed/);
});
