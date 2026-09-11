import assert from 'node:assert/strict';
import test from 'node:test';
import { ReferenceBiomeField, fieldCoordinates, grassArchetype } from '../src/biome/ReferenceBiomeField.js';

function ecologyAt(moisture = 0.2, growth = 0.8) {
  return {
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 1, z: 8 } },
    sampleWorld: () => ({ moisture, growth, density: 0.9, understory: 0.1, path: 0 }),
  };
}

test('CPU samples match stored texels at texel centres and stay on the endpoint grid', () => {
  const field = new ReferenceBiomeField(ecologyAt(), 28411, 8);
  for (const _ of field.build()) { /* drain */ }
  const at = fieldCoordinates(0, 0, field.bounds, 8);
  assert.equal(at.x, 0);
  assert.equal(at.u, 0.5 / 8);
  const first = field.sampleWorld(0, 0);
  assert.equal(first.dryness, field.data[0] / 255);
  assert.equal(first.vigor, field.data[1] / 255);
  assert.equal(first.mass, field.data[2] / 255);
  const last = field.sampleWorld(8, 8);
  const offset = (7 * 8 + 7) * 4;
  assert.equal(last.dryness, field.data[offset] / 255);
  const ecology = field.ecology.sampleWorld(0, 0);
  assert.ok(Math.abs(first.dryness - (0.65 * (1 - ecology.moisture) + 0.35 * 0)) <= 1);
  assert.ok(first.vigor <= ecology.growth);
});

test('grass archetype blends across 0.08-wide thresholds', () => {
  const short = grassArchetype(0.2);
  const broad = grassArchetype(0.5);
  const tall = grassArchetype(0.9);
  assert.equal(short.height, 0.6);
  assert.equal(short.width, 0.85);
  assert.equal(short.retention, 0.7);
  assert.ok(Math.abs(broad.height - 1) < 1e-6);
  assert.ok(Math.abs(broad.width - 1.15) < 1e-6);
  assert.ok(Math.abs(tall.height - 1.3) < 1e-6);
  assert.ok(Math.abs(tall.width - 0.65) < 1e-6);
  const blend = grassArchetype(0.38);
  assert.ok(blend.height > 0.6 && blend.height < 1);
});

test('retention is stable for the same world coordinate', () => {
  const field = new ReferenceBiomeField(ecologyAt(), 28411, 8);
  for (const _ of field.build()) { /* drain */ }
  assert.equal(field.retainsGrass(1.25, 3.5), field.retainsGrass(1.25, 3.5));
});
