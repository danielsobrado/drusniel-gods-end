import assert from 'node:assert/strict';
import test from 'node:test';
import { captureShaderPrograms } from '../scripts/gpu/grass-shader-check.js';

test('shader capture reads program.code from createProgram and restores the backend method', async () => {
  class Backend {
    constructor() { this.calls = 0; }
    createProgram(program) { this.calls += 1; this.last = program; }
  }
  const backend = new Backend();
  const renderer = { backend };
  const codes = await captureShaderPrograms(renderer, async () => {
    backend.createProgram({ stage: 'vertex', code: 'fn main() { let h = 24634.6345; }' });
    backend.createProgram({ stage: 'fragment', code: 'fn main() {}' });
  });
  assert.deepEqual(codes, ['fn main() { let h = 24634.6345; }', 'fn main() {}']);
  assert.equal(backend.createProgram, Backend.prototype.createProgram);
  assert.equal(backend.calls, 2);
});

test('shader capture restores createProgram after a compile failure', async () => {
  function original() {}
  const renderer = { backend: { createProgram: original } };
  await assert.rejects(captureShaderPrograms(renderer, async () => {
    renderer.backend.createProgram({ code: '24634.6345' });
    throw new Error('compile failed');
  }), /compile failed/);
  assert.equal(renderer.backend.createProgram, original);
});
