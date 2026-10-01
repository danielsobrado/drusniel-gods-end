import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshoptEncoder } from 'meshoptimizer';
import { meshSimplifierReady, simplifiedStage } from '../src/rendering/meshSimplify.js';
import {
  BakedScenePreprocessing,
  geometrySignature,
  resolveStages,
  scenePreprocessingSettings,
  SCENE_PREPROCESSING_VERSION,
  STRUCTURE_STAGES,
  validateScenePreprocessing,
} from '../src/assets/scenePreprocessing.js';

await meshSimplifierReady;
await MeshoptEncoder.ready;

const PATH = 'Assets/house.glb';
const REQUESTS = Object.entries(STRUCTURE_STAGES);

function sphere() {
  return new THREE.SphereGeometry(1, 96, 48);
}

// What scripts/bake-scene-preprocessing.mjs writes for these geometries.
function bake(geometries) {
  const chunks = [];
  let offset = 0;
  const primitives = geometries.map((geometry, ordinal) => {
    const stages = {};
    for (const [key, options] of REQUESTS) {
      const stage = simplifiedStage(geometry, options);
      if (stage === geometry) { stages[key] = 'source'; continue; }
      const indices = Uint32Array.from(stage.index.array);
      const encoded = MeshoptEncoder.encodeIndexSequence(indices, indices.length, 4);
      stages[key] = { offset, bytes: encoded.length, count: indices.length };
      chunks.push(encoded);
      offset += encoded.length;
    }
    return { ordinal, signature: geometrySignature(geometry), vertexCount: geometry.attributes.position.count, stages };
  });
  const data = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
  const manifest = {
    version: SCENE_PREPROCESSING_VERSION,
    settings: scenePreprocessingSettings(),
    dataBytes: data.length,
    sources: { [PATH]: { primitives } },
  };
  return { manifest, buffer: data.buffer };
}

test('baked stages equal the runtime simplifier exactly and share the source attributes', async () => {
  const geometry = sphere();
  const { manifest, buffer } = bake([geometry]);
  assert.ok(validateScenePreprocessing(manifest, buffer.byteLength));
  const [baked] = await resolveStages(new BakedScenePreprocessing(manifest, buffer), PATH, [geometry], REQUESTS);
  for (const [key, options] of REQUESTS) {
    const runtime = simplifiedStage(geometry, options);
    assert.notEqual(runtime, geometry, 'the fixture must actually simplify');
    assert.deepEqual(Array.from(baked[key].index.array), Array.from(runtime.index.array), `${key} indices`);
    for (const name of Object.keys(geometry.attributes)) {
      assert.equal(baked[key].attributes[name], geometry.attributes[name], `${key} shares ${name}`);
    }
  }
});

test('a primitive whose geometry differs from the bake is simplified at runtime', async () => {
  const geometry = sphere();
  const { manifest, buffer } = bake([geometry]);
  const changed = sphere();
  changed.attributes.position.array[0] += 1e-4;
  const [stages] = await resolveStages(new BakedScenePreprocessing(manifest, buffer), PATH, [changed], REQUESTS);
  const runtime = simplifiedStage(changed, STRUCTURE_STAGES.detail);
  assert.deepEqual(Array.from(stages.detail.index.array), Array.from(runtime.index.array));
});

test('unknown sources, missing bakes and stale settings fall back', async () => {
  const geometry = sphere();
  const { manifest, buffer } = bake([geometry]);
  const baked = new BakedScenePreprocessing(manifest, buffer);
  assert.equal(baked.stagesFor('Assets/other.glb', 0, geometry), null);
  assert.equal(baked.stagesFor(PATH, 1, geometry), null);
  const [fallback] = await resolveStages(null, PATH, [geometry], REQUESTS);
  assert.ok(fallback.detail.index.count < geometry.index.count);
  assert.equal(validateScenePreprocessing({ ...manifest, settings: '{}' }, buffer.byteLength), false);
  assert.equal(validateScenePreprocessing({ ...manifest, version: SCENE_PREPROCESSING_VERSION + 1 }, buffer.byteLength), false);
});

test('malformed data is rejected before any view is built', () => {
  const geometry = sphere();
  const { manifest, buffer } = bake([geometry]);
  const primitive = manifest.sources[PATH].primitives[0];
  assert.equal(validateScenePreprocessing(manifest, buffer.byteLength - 1), false, 'truncated data');
  const overrun = structuredClone(manifest);
  overrun.sources[PATH].primitives[0].stages.detail.bytes = buffer.byteLength + 1;
  assert.equal(validateScenePreprocessing(overrun, buffer.byteLength), false, 'range past the end');
  const partial = structuredClone(manifest);
  partial.sources[PATH].primitives[0].stages.detail.count = primitive.stages.detail.count - 1;
  assert.equal(validateScenePreprocessing(partial, buffer.byteLength), false, 'not whole triangles');
});

test('indices past the vertex count invalidate a primitive', () => {
  const small = new THREE.PlaneGeometry(1, 1, 1, 1);
  const indices = Uint32Array.from([0, 1, 2, 2, 1, 7]);
  const encoded = MeshoptEncoder.encodeIndexSequence(indices, indices.length, 4);
  const manifest = {
    version: SCENE_PREPROCESSING_VERSION,
    settings: scenePreprocessingSettings(),
    dataBytes: encoded.length,
    sources: { [PATH]: { primitives: [{
      ordinal: 0, signature: geometrySignature(small), vertexCount: 4,
      stages: { detail: { offset: 0, bytes: encoded.length, count: 6 }, shadow: 'source' },
    }] } },
  };
  assert.ok(validateScenePreprocessing(manifest, encoded.length));
  assert.equal(new BakedScenePreprocessing(manifest, encoded.buffer).stagesFor(PATH, 0, small), null);
});

test('a stage the simplifier cannot improve is the source geometry itself', async () => {
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  const { manifest, buffer } = bake([geometry]);
  assert.deepEqual(manifest.sources[PATH].primitives[0].stages, { detail: 'source', shadow: 'source' });
  const [stages] = await resolveStages(new BakedScenePreprocessing(manifest, buffer), PATH, [geometry], REQUESTS);
  assert.equal(stages.detail, geometry);
  assert.equal(stages.shadow, geometry);
});

test('the signature covers index, position and UV values and the layout', () => {
  const base = geometrySignature(sphere());
  assert.equal(geometrySignature(sphere()), base);
  const uv = sphere(); uv.attributes.uv.array[5] += 1e-3;
  const index = sphere(); index.index.array[3] = index.index.array[4];
  const normalized = sphere(); normalized.attributes.uv.normalized = true;
  for (const changed of [uv, index, normalized]) assert.notEqual(geometrySignature(changed), base);
});
