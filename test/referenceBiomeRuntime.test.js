import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry } from 'three';
import { InstancedBufferGeometry, StorageInstancedBufferAttribute } from 'three/webgpu';
import { GrassTile } from '../src/grass/GrassTile.js';
import { commitPresetChange, resolveSafePose } from '../src/biome/presetSwitch.js';
import { BiomeFootprints } from '../src/biome/BiomePlacement.js';
import { getPresetAppearance, setPresetAppearance, disposePresetAppearance } from '../src/rendering/PresetAppearance.js';
import { evaluateBiomeGate } from '../scripts/debug/scene-benchmark.js';

test('grass tile staging does not replace live geometry until commit', () => {
  const live = new BoxGeometry(1, 1, 1);
  const tile = new GrassTile({ add() {} }, {}, live, false);
  const staged = new BoxGeometry(2, 2, 2);
  tile.stageGeometry(staged, 'high', () => true, 4);
  assert.equal(tile.mesh.geometry, live);
  tile.commitStaged(4);
  assert.equal(tile.layoutRevision, 4);
  tile.discardStaging();
  tile.invalidate();
  live.dispose();
  staged.dispose();
});

test('stale and unsafe preset commits never publish a partial world', () => {
  const demo = {
    presetGeneration: 2,
    player: {
      enabled: true,
      setEnabled(value) { this.enabled = value; },
      getPosition: () => ({ x: 0, y: 2, z: 0 }),
      metrics: { radius: 0.7, rootToFeet: 2, groundOffset: 0 },
      translateRoot() { this.moved = true; },
    },
    world: { terrainSampler: { sampleHeight: () => 1, contains: () => true } },
    grass: {
      vegetation: { sampleWorld: () => ({ path: 0, density: 0.9, growth: 0.8 }) },
      pendingLayout: { revision: 1 },
      abortLayout() { this.aborted = true; },
      commitLayout() { this.committed = true; },
    },
    biome: { commit() { this.committed = true; }, setPreset() {} },
    environment: { setPreset() { this.named = true; } },
    config: { water: { position: [0, -4, 0] } },
  };
  const stale = commitPresetChange(demo, { generation: 1, name: 'sunny', layout: { revision: 1 } });
  assert.equal(stale.reason, 'stale');
  assert.equal(demo.biome.committed, undefined);
  assert.equal(demo.player.enabled, true);

  demo.presetGeneration = 1;
  demo.world.terrainSampler.contains = () => false;
  const unsafe = commitPresetChange(demo, {
    generation: 1, name: 'sunny', prepared: { active: true, solids: new BiomeFootprints() }, layout: { revision: 1 },
  });
  assert.equal(unsafe.reason, 'unsafe');
  assert.equal(demo.grass.aborted, true);
  assert.equal(demo.biome.committed, undefined);
});

test('appearance uniforms are reused across weather and do not mutate cinematic style', () => {
  const config = {
    cinematic: { enabled: true, style: { grassFill: 0.06, dryRoot: '#111111' } },
    biomes: { referenceScrub: { enabled: true } },
    presets: {
      sunny: { biomeProfile: 'referenceScrub', referenceLook: { style: { grassFill: 0.04, dryRoot: '#6e6530' } } },
      goldenHour: {},
    },
  };
  const first = getPresetAppearance(config);
  setPresetAppearance(config, 'sunny');
  assert.equal(first.enabled.value, 1);
  assert.equal(first.grassFill, getPresetAppearance(config).grassFill);
  assert.equal(config.cinematic.style.grassFill, 0.06);
  setPresetAppearance(config, 'goldenHour');
  assert.equal(first.enabled.value, 0);
  disposePresetAppearance(config);
});

test('biome gate fails individual scenarios instead of averaging them away', () => {
  const sample = (median, p95, gpu = 1) => ({
    processing: { median, p95 },
    gpuTimestamp: { median: gpu, p95: gpu },
  });
  const baseline = { scenarios: { meadow: { stationary: [sample(10, 12)], moving: [sample(11, 13)] } } };
  const feature = { scenarios: { meadow: { stationary: [sample(12, 12)], moving: [sample(11, 13)] } } };
  const pass = evaluateBiomeGate(baseline, feature);
  assert.equal(pass.pass, false);
  assert.ok(pass.failures.some((line) => line.includes('meadow stationary processing median')));
  const missingGpu = evaluateBiomeGate(
    { scenarios: { meadow: { stationary: [sample(10, 12, null)], moving: [sample(10, 12)] } } },
    { scenarios: { meadow: { stationary: [{ processing: { median: 10, p95: 12 } }], moving: [sample(10, 12)] } } },
  );
  assert.ok(missingGpu.limitations.some((line) => line.includes('GPU timestamps unavailable')));
});

test('compaction keeps original instanceData.y ranks', async () => {
  const { compactGrassGeometry } = await import('../src/grass/compactGrassGeometry.js');
  const geometry = new InstancedBufferGeometry();
  geometry.instanceCount = 3;
  geometry.setAttribute('instancePosition', new StorageInstancedBufferAttribute(new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]), 3));
  geometry.setAttribute('instanceRotation', new StorageInstancedBufferAttribute(new Float32Array(6), 2));
  geometry.setAttribute('instanceData', new StorageInstancedBufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0]), 4));
  const compacted = compactGrassGeometry(geometry, 0, 0, (x) => x !== 10);
  assert.equal(compacted.instanceCount, 2);
  assert.deepEqual([...compacted.attributes.instanceData.array.slice(0, compacted.instanceCount * 4)], [0, 0, 0, 0, 0, 2, 0, 0]);
  compacted.dispose();
  geometry.dispose();
});

test('resolveSafePose uses destination solids rather than the tour camera', () => {
  const solids = new BiomeFootprints();
  solids.add({ x: 0, z: 0, radius: 2 });
  const demo = {
    player: {
      getPosition: () => ({ x: 0, y: 2, z: 0 }),
      metrics: { radius: 0.7, rootToFeet: 2, groundOffset: 0.1 },
    },
    world: { terrainSampler: { sampleHeight: () => 1, contains: () => true } },
    grass: { vegetation: { sampleWorld: () => ({ path: 0, density: 0.9, growth: 0.8 }) } },
    config: { water: { position: [0, -8, 0] } },
  };
  const pose = resolveSafePose(demo, { active: true, solids });
  assert.ok(pose.x !== 0 || pose.z !== 0);
});
