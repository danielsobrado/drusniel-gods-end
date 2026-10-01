import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { mountainHeight } from '../src/world/ExpandedLandscape.js';

const controls = yaml.load(fs.readFileSync(new URL('../public/player-controls.yaml', import.meta.url), 'utf8'));
const snow = yaml.load(fs.readFileSync(new URL('../public/snow.yaml', import.meta.url), 'utf8'));

const SUMMIT_RING_RADIUS = 60;
const SUMMIT_RING_SAMPLES = 8;

test('alpine summit teleport sits inside the fully snowy mountain cluster', () => {
  const summit = controls.navigation.locations.find((location) => location.id === 'snowSummit');
  assert.ok(summit);
  assert.equal(summit.mode, 'ground');
  assert.equal(summit.label, 'Alpine Summit');

  const [x, z] = summit.position;
  assert.ok(mountainHeight(x, z) > snow.ground.snow.altitude.full);

  for (let index = 0; index < SUMMIT_RING_SAMPLES; index += 1) {
    const angle = index / SUMMIT_RING_SAMPLES * Math.PI * 2;
    const ringX = x + Math.cos(angle) * SUMMIT_RING_RADIUS;
    const ringZ = z + Math.sin(angle) * SUMMIT_RING_RADIUS;
    assert.ok(
      mountainHeight(ringX, ringZ) > snow.ground.snow.altitude.full,
      `summit ring sample ${index} should remain inside the full-snow mountain band`,
    );
  }
});
