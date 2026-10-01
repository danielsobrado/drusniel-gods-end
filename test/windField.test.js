import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gradientNoise2dCpu,
  getSharedWindState,
  resolveWindConfig,
  sampleCinematicWindCpu,
  setSharedWindState,
} from '../src/weather/WindField.js';

test('cinematic wind config exposes the three physical scales', () => {
  const wind = resolveWindConfig({});
  assert.equal(wind.model, 'cinematic');
  assert.ok(wind.large.scale < wind.medium.scale);
  assert.ok(wind.medium.scale < wind.flutter.scale);
  assert.ok(wind.large.speed < wind.medium.speed);
  assert.ok(wind.medium.speed < wind.flutter.speed);
});

test('cinematic wind sampling is deterministic, directional, and bounded', () => {
  const sample = {
    x: 12.5,
    z: -7.25,
    time: 9.75,
    directionDegrees: 75,
    intensity: 2.8,
    simulationSpeed: 1.08,
  };
  const first = sampleCinematicWindCpu(sample);
  const second = sampleCinematicWindCpu(sample);

  assert.deepEqual(first, second);
  assert.ok(Math.abs(Math.hypot(first.direction.x, first.direction.z) - 1) < 1e-12);
  assert.ok(first.strength >= 0);
  assert.ok(first.gust >= 0 && first.gust <= 1);
  assert.ok(first.turbulence >= -1 && first.turbulence <= 1);
  assert.ok(first.flutter >= -1 && first.flutter <= 1);
});

test('large gust structures advect through world space instead of oscillating in place', () => {
  const config = {
    wind: {
      baseStrength: 0,
      minStrength: 0,
      direction: { variationDegrees: 0 },
      medium: { strength: 0 },
      flutter: { strength: 0 },
      // Pure advection only holds with the domain warp off; the warp deliberately deforms the
      // field as it travels, which the next test covers.
      warp: { amplitude: 0 },
      gust: { inertiaGain: 0 },
    },
  };
  const wind = resolveWindConfig(config);
  const delta = 2.5;
  const worldVelocity = wind.large.speed / wind.large.scale;
  const first = sampleCinematicWindCpu({
    x: 4,
    z: -3,
    time: 1,
    directionDegrees: 0,
    intensity: 1,
    simulationSpeed: 1,
    noiseScale: 1,
    config,
  });
  const second = sampleCinematicWindCpu({
    x: 4 + worldVelocity * delta,
    z: -3,
    time: 1 + delta,
    directionDegrees: 0,
    intensity: 1,
    simulationSpeed: 1,
    noiseScale: 1,
    config,
  });

  assert.ok(Math.abs(first.gust - second.gust) < 1e-10);
});

test('shared wind state carries preset direction and spatial scale to other systems', () => {
  setSharedWindState({ directionDegrees: 42, noiseScale: 1.25, simulationSpeed: 0.9 });
  assert.deepEqual(getSharedWindState(), {
    directionDegrees: 42,
    noiseScale: 1.25,
    simulationSpeed: 0.9,
  });
});

test('gust cadence stays stationary as elapsed time grows', () => {
  const sampleWindow = (startTime) => {
    const seconds = 60;
    const step = 1 / 60;
    let previousStrength = null;
    let previousSign = null;
    let reversals = 0;
    for (let index = 0; index * step < seconds; index += 1) {
      const { strength } = sampleCinematicWindCpu({
        x: 12.5,
        z: -7.25,
        time: startTime + index * step,
      });
      if (previousStrength !== null) {
        const sign = Math.sign(strength - previousStrength);
        if (previousSign !== null && sign !== 0 && sign !== previousSign) reversals += 1;
        if (sign !== 0) previousSign = sign;
      }
      previousStrength = strength;
    }
    return reversals / seconds;
  };

  // Advecting along a time-varying direction displaces the noise sample by `wobble * elapsedTime`,
  // which made the wind accelerate without bound (~0.45 reversals/s at t=0, ~15/s an hour in).
  const atStart = sampleWindow(0);
  const afterAnHour = sampleWindow(3600);
  const afterADay = sampleWindow(86400);

  assert.ok(atStart > 0, 'wind should vary at all');
  assert.ok(afterAnHour < atStart * 3, `cadence drifted after an hour: ${atStart} -> ${afterAnHour}`);
  assert.ok(afterADay < atStart * 3, `cadence drifted after a day: ${atStart} -> ${afterADay}`);
});

test('the domain warp deforms gust fronts instead of translating them rigidly', () => {
  // Only the large layer drives the envelope here, so "riding the gust front" is well defined.
  const isolateLargeLayer = {
    direction: { variationDegrees: 0 },
    medium: { strength: 0 },
    flutter: { strength: 0 },
    gust: { inertiaGain: 0 },
  };
  const warped = { wind: { ...isolateLargeLayer } };
  const rigid = { wind: { ...isolateLargeLayer, warp: { amplitude: 0 } } };
  const wind = resolveWindConfig(warped);
  const worldVelocity = wind.large.speed / wind.large.scale;

  // Travel with the front and see how much of it survives. Averaged over many probes, because a
  // single one can land where the gust is flat in both fields.
  const frontDecay = (config, delta) => {
    let total = 0;
    const probes = 64;
    for (let index = 0; index < probes; index += 1) {
      const time = 20 + index * 7.3;
      const z = -3 + index * 2.9;
      const common = { z, directionDegrees: 0, intensity: 1, simulationSpeed: 1, noiseScale: 1, config };
      const first = sampleCinematicWindCpu({ ...common, x: 4, time });
      const second = sampleCinematicWindCpu({ ...common, x: 4 + worldVelocity * delta, time: time + delta });
      total += Math.abs(first.gust - second.gust);
    }
    return total / probes;
  };

  assert.ok(frontDecay(rigid, 30) < 1e-10, 'unwarped field should translate rigidly');
  assert.ok(frontDecay(warped, 30) > 0.05, 'warped field should evolve while it travels');

  // The warp is an additive coordinate offset, never a factor on the advection clock, so how much
  // it reshapes the field cannot grow with elapsed time -- that was the runaway-wind bug.
  const influence = (startTime) => {
    let total = 0;
    const probes = 200;
    for (let index = 0; index < probes; index += 1) {
      const common = {
        x: 4 + index * 1.7,
        z: -3 + index * 2.3,
        time: startTime + index * 0.25,
        directionDegrees: 0,
        intensity: 1,
        simulationSpeed: 1,
        noiseScale: 1,
      };
      total += Math.abs(
        sampleCinematicWindCpu({ ...common, config: warped }).gust
        - sampleCinematicWindCpu({ ...common, config: rigid }).gust,
      );
    }
    return total / probes;
  };
  const early = influence(10);
  const late = influence(86400);
  assert.ok(early > 0, 'warp should change the field at all');
  assert.ok(late < early * 3, `warp influence grew with time: ${early} -> ${late}`);
});

test('the noise lattice carries no strongly preferred orientation', () => {
  // Banding seen from above is a directional bias in the field: some orientations carry much more
  // gradient energy than others, so fronts keep lining up the same way. Measure the
  // magnitude-weighted distribution of gradient orientations (mod 180 degrees, since a front and
  // its reverse present the same axis).
  const bins = new Array(18).fill(0);
  let total = 0;
  const step = 1e-3;
  for (let index = 0; index < 40000; index += 1) {
    const x = (index % 200) * 0.31 + 0.13;
    const y = Math.floor(index / 200) * 0.29 + 0.07;
    const dx = (gradientNoise2dCpu(x + step, y) - gradientNoise2dCpu(x - step, y)) / (2 * step);
    const dy = (gradientNoise2dCpu(x, y + step) - gradientNoise2dCpu(x, y - step)) / (2 * step);
    const magnitude = Math.hypot(dx, dy);
    if (magnitude < 1e-9) continue;
    const orientation = ((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI;
    bins[Math.min(17, Math.floor((orientation / Math.PI) * 18))] += magnitude;
    total += magnitude;
  }
  const expected = total / 18;
  const chiSquare = bins.reduce((sum, value) => sum + ((value - expected) ** 2) / expected, 0);
  const starved = Math.min(...bins) / expected;

  // The old (0.1, 0.7) hash coefficients score ~283 here with a starved orientation at 0.81 of
  // the mean; large mutually irrational coefficients roughly halve the bias.
  assert.ok(chiSquare < 200, `field orientation is biased: chi-square ${chiSquare}`);
  assert.ok(starved > 0.85, `an orientation is starved of gradient energy: ${starved}`);
});
