import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuCreationProbe } from '../src/debug/gpuCreationHooks.js';

test('GPU creation probe uses the r186 node-builder debug callback and restores it', () => {
  let previousCalls = 0;
  const previous = () => { previousCalls += 1; };
  const renderer = {
    debug: { onNodeBuilderCreated: previous },
    backend: {},
  };
  const probe = new GpuCreationProbe(renderer);
  const builder = {
    build() {
      return 'built';
    },
  };

  renderer.debug.onNodeBuilderCreated(builder, { object: { name: 'Tree' } });
  assert.equal(builder.build(), 'built');
  assert.equal(previousCalls, 1);
  assert.equal(probe.stats.nodeBuilds, 1);
  assert.ok(probe.stats.nodeBuildMs >= 0);

  probe.dispose();
  assert.equal(renderer.debug.onNodeBuilderCreated, previous);
});
