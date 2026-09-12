import test from 'node:test';
import assert from 'node:assert/strict';
import { ExplorationSpeedMode } from '../src/player/ExplorationSpeedMode.js';

function configFixture() {
  return {
    player: {
      walkSpeed: 4.2,
      runSpeed: 7.2,
      motion: {
        acceleration: 20,
        deceleration: 16,
        explorationBoost: {
          doubleTapWindowMs: 350,
          speedMultiplier: 10,
        },
      },
    },
    cinematic: {
      motion: {
        walkSpeedInHeights: 1.6,
        runSpeedInHeights: 3.2,
      },
    },
  };
}

function assertNormal(config) {
  assert.equal(config.player.walkSpeed, 4.2);
  assert.equal(config.player.runSpeed, 7.2);
  assert.equal(config.player.motion.acceleration, 20);
  assert.equal(config.player.motion.deceleration, 16);
  assert.equal(config.cinematic.motion.walkSpeedInHeights, 1.6);
  assert.equal(config.cinematic.motion.runSpeedInHeights, 3.2);
}

function assertBoosted(config) {
  assert.equal(config.player.walkSpeed, 42);
  assert.equal(config.player.runSpeed, 72);
  assert.equal(config.player.motion.acceleration, 200);
  assert.equal(config.player.motion.deceleration, 160);
  assert.equal(config.cinematic.motion.walkSpeedInHeights, 16);
  assert.equal(config.cinematic.motion.runSpeedInHeights, 32);
}

test('double shift toggles the configured ten-times exploration movement mode', () => {
  let time = 1000;
  const config = configFixture();
  const changes = [];
  const mode = new ExplorationSpeedMode({
    eventTarget: null,
    now: () => time,
    onChange: (state) => changes.push(state),
  });
  mode.setConfig(config);

  assert.equal(mode.handleKeyDown({ code: 'ShiftLeft', repeat: false }), false);
  time += 200;
  assert.equal(mode.handleKeyDown({ code: 'ShiftRight', repeat: false }), true);
  assert.equal(mode.active, true);
  assertBoosted(config);

  time += 500;
  mode.handleKeyDown({ code: 'ShiftLeft', repeat: false });
  time += 120;
  mode.handleKeyDown({ code: 'ShiftLeft', repeat: false });
  assert.equal(mode.active, false);
  assertNormal(config);
  assert.deepEqual(changes, [
    { active: true, multiplier: 10 },
    { active: false, multiplier: 10 },
  ]);

  mode.dispose();
});

test('key repeat and slow shift taps do not toggle exploration movement', () => {
  let time = 0;
  const config = configFixture();
  const mode = new ExplorationSpeedMode({ eventTarget: null, now: () => time });
  mode.setConfig(config);

  mode.handleKeyDown({ code: 'ShiftLeft', repeat: false });
  time += 50;
  mode.handleKeyDown({ code: 'ShiftLeft', repeat: true });
  assert.equal(mode.active, false);
  time += 400;
  mode.handleKeyDown({ code: 'ShiftLeft', repeat: false });
  assert.equal(mode.active, false);
  assertNormal(config);

  mode.dispose();
});

test('renderer recovery captures baseline speeds and reapplies one boost to the replacement config', () => {
  const config = configFixture();
  const mode = new ExplorationSpeedMode({ eventTarget: null, now: () => 0 });
  mode.setConfig(config);
  mode.setActive(true);
  assertBoosted(config);

  const state = mode.captureSessionState({
    captureSessionState: () => ({ config: structuredClone(config) }),
  });
  assertNormal(state.config);

  const replacement = structuredClone(state.config);
  mode.setConfig(replacement);
  assertBoosted(replacement);

  mode.dispose();
  assertNormal(replacement);
});

test('invalid exploration configuration fails fast', () => {
  const mode = new ExplorationSpeedMode({ eventTarget: null });
  const config = configFixture();
  config.player.motion.explorationBoost.speedMultiplier = 1;
  assert.throws(() => mode.setConfig(config), /speedMultiplier/);
  mode.dispose();
});
