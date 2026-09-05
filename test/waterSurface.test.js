import test from 'node:test';
import assert from 'node:assert/strict';
import CubeRenderTarget from 'three/src/renderers/common/CubeRenderTarget.js';
import { createReflectionRenderTarget } from '../src/water/WaterSurface.js';

test('water reflection render target uses the WebGPU-compatible cube target', () => {
  const renderTarget = createReflectionRenderTarget({ reflectionResolution: 16 });

  try {
    assert.ok(renderTarget instanceof CubeRenderTarget);
    assert.equal(renderTarget.isCubeRenderTarget, true);
    assert.equal(renderTarget.width, 16);
    assert.equal(renderTarget.height, 16);
  } finally {
    renderTarget.dispose();
  }
});
