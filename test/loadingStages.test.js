import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOADING_REVEAL_RADIUS_VMAX,
  LOADING_REVEAL_SECONDS,
  LOADING_STAGES,
  power4InOut,
} from '../src/ui/loadingStages.js';

test('loading stages match the recovered browser sequence', () => {
  assert.deepEqual(LOADING_STAGES, {
    initializing: { message: 'Starting...', progress: 0 },
    renderer: { message: 'Initializing renderer...', progress: 0 },
    environment: { message: 'Loading environment...', progress: 0 },
    world: { message: 'Loading world...', progress: 5 },
    character: { message: 'Choose your character...', progress: 20 },
    player: { message: 'Loading player...', progress: 25 },
    collision: { message: 'Setting up collision system...', progress: 40 },
    foliage: { message: 'Setting up foliage', progress: 55 },
    grass: { message: 'Growing grass...', progress: 65 },
    audio: { message: 'Loading audio...', progress: 75 },
    shaders: { message: 'Compiling shaders...', progress: 80 },
    ready: { message: 'Here we are', progress: 100 },
  });
});

test('loading reveal uses the recovered power4.inOut timing', () => {
  assert.equal(LOADING_REVEAL_SECONDS, 3);
  assert.equal(LOADING_REVEAL_RADIUS_VMAX, 120);
  assert.equal(power4InOut(0), 0);
  assert.equal(power4InOut(0.5), 0.5);
  assert.equal(power4InOut(1), 1);
  assert.ok(power4InOut(0.25) < 0.25);
  assert.ok(power4InOut(0.75) > 0.75);
});
