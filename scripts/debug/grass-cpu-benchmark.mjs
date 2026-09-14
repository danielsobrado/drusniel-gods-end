import { Scene, MeshBasicMaterial } from 'three';
import { createGrassGeometry } from '../../src/grass/GrassGeometry.js';
import { compactGrassGeometry } from '../../src/grass/compactGrassGeometry.js';
import { GrassTile } from '../../src/grass/GrassTile.js';
import { ProceduralVegetationField } from '../../src/grass/ProceduralVegetationField.js';

const N = 100;
const REPS = 3;
const config = {
  vegetation: { resolution: 64, growthThreshold: 0.3, distributionCellSize: 1, seed: 90210 },
  water: { sea: { enabled: false } },
};
const terrain = {
  bounds: { min: { x: -1250, z: -1250, y: -10 }, max: { x: 1250, z: 1250, y: 10 } },
  size: { x: 2500, z: 2500 },
};
const field = new ProceduralVegetationField(config, terrain);
for (let i = 0; i < field.data.length; i += 5) {
  field.data[i] = 0.42 + ((i / 5) % 7) * 0.01;
  field.data[i + 1] = 0.8;
  field.data[i + 2] = 0.5;
  field.data[i + 3] = 0.8;
  field.data[i + 4] = 0;
}
field.ready = true;
const containsGrass = (x, z) => field.allowsVegetation(x, z);
const positions = Array.from({ length: N }, (_, i) => {
  const x = ((i * 37) % 20) * 25 - 250;
  const z = ((i * 53) % 20) * 25 - 250;
  return [x, z];
});
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const stats = values => ({
  samples: values.length,
  p50Ms: percentile(values, 0.50),
  p95Ms: percentile(values, 0.95),
  maxMs: Math.max(...values),
  meanMs: values.reduce((a, b) => a + b, 0) / values.length,
});

const result = { generatedAt: new Date().toISOString(), resolution: 64, tilesPerRep: N, repetitions: REPS, field: 'ProceduralVegetationField.allowsVegetation', variants: {} };
for (const variant of [
  { name: 'high', density: 4.5, detail: 4 },
  { name: 'ultra', density: 5.5, detail: 5 },
]) {
  const source = createGrassGeometry({ type: 'blade', density: variant.density, detail: variant.detail, tileSize: 25, stable: true });
  const compactSamples = [];
  const recycleSamples = [];
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  const tile = new GrassTile(scene, material, source, true);
  for (let rep = 0; rep < REPS; rep += 1) {
    for (const [x, z] of positions) {
      let start = performance.now();
      const compact = compactGrassGeometry(source, x, z, containsGrass);
      compactSamples.push(performance.now() - start);
      compact.dispose();
      start = performance.now();
      tile.setPosition(x, z, x / 25, z / 25);
      tile.setGeometry(source, variant.name, containsGrass);
      recycleSamples.push(performance.now() - start);
    }
  }
  result.variants[variant.name] = {
    sourceInstances: source.instanceCount,
    compactGrassGeometry: stats(compactSamples),
    grassTileRecycle: stats(recycleSamples),
  };
  tile.dispose(scene);
  material.dispose();
  source.dispose();
}
console.log(JSON.stringify(result, null, 2));
