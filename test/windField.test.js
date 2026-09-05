import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
