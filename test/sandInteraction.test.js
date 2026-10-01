import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import { coastX, resolveCoastConfig, sampleSandCoverageCpu } from '../src/world/CoastField.js';
import { SnowDeformationField } from '../src/world/SnowDeformationField.js';
import { SnowPowderSystem } from '../src/world/SnowPowderSystem.js';
import { Scene, PerspectiveCamera } from 'three/webgpu';

test('beach sand is covered above the waterline and dry away from the swash', async () => {
  const config = await loadMergedConfig();
  const sea = resolveCoastConfig(config.water.sea);
  const z = 40;
  const shore = coastX(z, sea);

  const dryBeach = sampleSandCoverageCpu(shore - 70, sea.level + 3, z, config);
  assert.equal(dryBeach.coverage, 1);
  assert.ok(dryBeach.dryness > 0.9);

  const swash = sampleSandCoverageCpu(shore - 5, sea.level + 0.5, z, config);
  assert.ok(swash.coverage > 0.9);
  assert.ok(swash.dryness < 0.2, 'wet sand near the water does not kick up powder');

  assert.equal(sampleSandCoverageCpu(shore - 400, 30, z, config).coverage, 0);
  assert.equal(sampleSandCoverageCpu(shore + 50, sea.level - 8, z, config).coverage, 0);
});

test('the footprint field paints beach sand far below the snow line', async () => {
  const config = await loadMergedConfig();
  const sea = resolveCoastConfig(config.water.sea);
  const z = 40;
  const x = coastX(z, sea) - 40;
  const beachY = sea.level + 3;
  const field = new SnowDeformationField(config, {
    sampleHeight: () => beachY, getHeightRange: () => ({ min: beachY, max: beachY }),
  });
  field.update(1 / 60, { x, y: beachY + 1, z }, [{ position: { x, y: beachY + 0.1, z }, radius: 0.3 }], true);
  assert.ok(field.sampleAt(x, z).depression > 0.2);
  field.dispose();
});

test('snow region rejection keeps kicked beach sand active', async () => {
  const config = await loadMergedConfig();
  const sea = resolveCoastConfig(config.water.sea);
  const z = 40, x = coastX(z, sea) - 70, y = sea.level + 3;
  const powder = new SnowPowderSystem({
    config, scene: new Scene(), camera: new PerspectiveCamera(),
    terrainSampler: { sampleHeight: () => y, getHeightRange: () => ({ min: y, max: y }) },
  });
  powder.update(1 / 60, { x, y: y + 1, z }, [{ position: { x, y: y + 0.1, z }, radius: 0.3 }], true);
  assert.ok(powder.activeCount > 0);
  powder.dispose();
});
