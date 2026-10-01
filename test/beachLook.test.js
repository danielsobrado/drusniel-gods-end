import test from 'node:test';
import assert from 'node:assert/strict';
import { coastX, DEFAULT_COAST, resolveCoastConfig } from '../src/world/CoastField.js';
import { nearshoreSetEnvelope, resolveSeaWaves, sampleSeaSurface } from '../src/water/seaWaves.js';

const sea = { enabled: true, level: -24, shoreX: 1000, depth: 95 };

test('seabed and palm settings resolve with defaults and reject disordered bands', () => {
  const resolved = resolveCoastConfig({ ...sea });
  assert.deepEqual(resolved.coast.seabed, { ...DEFAULT_COAST.seabed });
  assert.deepEqual(resolved.coast.palms, { ...DEFAULT_COAST.palms });
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { seabed: { start: 2, full: 1 } } }),
    /seabed depth bands/,
  );
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { seabed: { darkening: 1.5 } } }),
    /seabed.darkening/,
  );
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { palms: { inlandMin: 130, inlandMax: 120 } } }),
    /palms inland/,
  );
  assert.throws(
    () => resolveCoastConfig({ ...sea, coast: { palms: { seawardLean: 2 } } }),
    /seawardLean/,
  );
});

test('wave sets keep nearshore crests between the configured floor and full height', () => {
  const params = resolveSeaWaves({ ...sea });
  const floor = 1 - params.detail.setDepth;
  let low = Infinity;
  let high = -Infinity;
  for (let z = -600; z <= 600; z += 7) {
    for (let phase = 0; phase < 40; phase += 0.37) {
      const envelope = nearshoreSetEnvelope(phase, z, params);
      low = Math.min(low, envelope);
      high = Math.max(high, envelope);
    }
  }
  assert.ok(low >= floor - 1e-9 && high <= 1 + 1e-9, `envelope ${low}..${high}`);
  // The envelope really varies, so crests do not all stand at one height.
  assert.ok(high - low > params.detail.setDepth * 0.9);
  // With no set depth the nearshore sea is exactly as before.
  const flat = resolveSeaWaves({ ...sea, detail: { setDepth: 0 } });
  assert.equal(nearshoreSetEnvelope(3.1, 120, flat), 1);
  assert.throws(() => resolveSeaWaves({ ...sea, detail: { setDepth: 1.2 } }), /setDepth/);
  assert.throws(
    () => resolveSeaWaves({ ...sea, detail: { breakDepthFull: 0.2, breakDepthStart: 0.3 } }),
    /breakDepthFull must exceed breakDepthStart/,
  );
});

test('nearshore sea height follows the set envelope and stays within its amplitude', () => {
  const params = resolveSeaWaves({ ...sea });
  const flat = resolveSeaWaves({ ...sea, detail: { setDepth: 0 } });
  let differs = false;
  for (let z = -300; z <= 300; z += 23) {
    // Inside the nearshore band, short of the offshore swell blend.
    const x = coastX(z, params) + 15;
    const shaped = sampleSeaSurface(x, z, 4.2, params);
    const plain = sampleSeaSurface(x, z, 4.2, flat);
    assert.ok(Math.abs(shaped) <= Math.abs(plain) + 1e-9);
    if (Math.abs(shaped - plain) > 1e-4) differs = true;
  }
  assert.ok(differs);
});
