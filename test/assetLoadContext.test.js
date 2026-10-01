import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AssetLoadContext } from '../src/assets/AssetLoadContext.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function gltfWithGeometry() {
  const geometry = new THREE.BufferGeometry();
  let disposed = 0;
  geometry.addEventListener('dispose', () => { disposed += 1; });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  return { gltf: { scene }, disposals: () => disposed };
}

// A GLTF loader stand-in whose loads are resolved by the test.
function harness() {
  const requests = [];
  const dracos = [];
  const context = new AssetLoadContext({ assets: { dracoDecoderPath: 'decoders/' } }, {
    createLoader: () => ({
      setDRACOLoader(draco) { this.draco = draco; return this; },
      loadAsync(url) { const request = { url, ...deferred() }; requests.push(request); return request.promise; },
    }),
    createDraco: () => {
      const draco = {
        workerPool: [], disposed: 0,
        setDecoderPath(path) { this.path = path; return this; },
        setWorkerLimit(limit) { this.limit = limit; return this; },
        dispose() { this.disposed += 1; },
      };
      dracos.push(draco);
      return draco;
    },
  });
  return { context, requests, dracos };
}

test('every loader shares one Draco decoder with three workers', () => {
  const { context, dracos } = harness();
  const first = context.createGltfLoader();
  const second = context.createGltfLoader();
  assert.equal(dracos.length, 1);
  assert.equal(first.draco, second.draco);
  assert.equal(dracos[0].limit, 3);
  assert.equal(dracos[0].path, 'decoders/');
});

test('concurrent and sequential template requests share one load', async () => {
  const { context, requests } = harness();
  const a = context.loadTemplate('forest.glb');
  const b = context.loadTemplate('forest.glb');
  assert.equal(requests.length, 1);
  const { gltf } = gltfWithGeometry();
  requests[0].resolve(gltf);
  assert.equal(await a, gltf);
  assert.equal(await b, gltf);
  assert.equal(await context.loadTemplate('forest.glb'), gltf);
  assert.equal(requests.length, 1);
});

test('distinct and versioned URLs load separately', () => {
  const { context, requests } = harness();
  context.loadTemplate('forest.glb');
  context.loadTemplate('forest.glb?v=2');
  context.loadTemplate('jungle.glb');
  assert.deepEqual(requests.map((request) => request.url), ['forest.glb', 'forest.glb?v=2', 'jungle.glb']);
});

test('a failed load is evicted so a later request retries', async () => {
  const { context, requests } = harness();
  const failed = context.loadTemplate('forest.glb');
  requests[0].reject(new Error('network'));
  await assert.rejects(failed, /network/);
  const retry = context.loadTemplate('forest.glb');
  assert.equal(requests.length, 2);
  const { gltf } = gltfWithGeometry();
  requests[1].resolve(gltf);
  assert.equal(await retry, gltf);
});

test('an aborted waiter leaves the shared request to the others', async () => {
  const { context, requests } = harness();
  const controller = new AbortController();
  const aborted = context.loadTemplate('forest.glb', { signal: controller.signal });
  const other = context.loadTemplate('forest.glb');
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  const { gltf } = gltfWithGeometry();
  requests[0].resolve(gltf);
  assert.equal(await other, gltf);
  assert.equal(requests.length, 1);
});

test('a load finishing after disposal is released, not cached', async () => {
  const { context, requests } = harness();
  const pending = context.loadTemplate('forest.glb');
  context.dispose();
  const { gltf, disposals } = gltfWithGeometry();
  requests[0].resolve(gltf);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(disposals(), 1);
  await assert.rejects(context.loadTemplate('forest.glb'), { name: 'AbortError' });
});

test('disposal releases templates and the decoder exactly once', async () => {
  const { context, requests, dracos } = harness();
  const pending = context.loadTemplate('forest.glb');
  const { gltf, disposals } = gltfWithGeometry();
  requests[0].resolve(gltf);
  await pending;
  assert.equal(disposals(), 0, 'consumers never release the shared template');
  context.dispose();
  context.dispose();
  assert.equal(disposals(), 1);
  assert.equal(dracos[0].disposed, 1);
});

test('idle decoder workers are ended; busy ones keep their task', () => {
  const { context, dracos } = harness();
  context.createGltfLoader();
  const ended = [];
  const worker = (name, load) => ({ name, _taskLoad: load, terminate() { ended.push(name); } });
  dracos[0].workerPool.push(worker('idle', 0), worker('busy', 120), worker('idle2', 0));
  assert.equal(context.releaseIdleDecoderWorkers(), 2);
  assert.deepEqual(ended, ['idle', 'idle2']);
  assert.deepEqual(dracos[0].workerPool.map((entry) => entry.name), ['busy']);
});

test('prefetch jobs share a bound of three and drain in order', async () => {
  const { context } = harness();
  const jobs = Array.from({ length: 5 }, () => deferred());
  const started = [];
  const results = jobs.map((job, index) => context.schedule(() => { started.push(index); return job.promise; }));
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  jobs[1].resolve('b');
  assert.equal(await results[1], 'b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [0, 1, 2, 3]);
  jobs[0].reject(new Error('failed'));
  await assert.rejects(results[0], /failed/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [0, 1, 2, 3, 4], 'a failure still frees its slot');
});

test('queued prefetch jobs are rejected on disposal', async () => {
  const { context } = harness();
  const running = Array.from({ length: 3 }, () => context.schedule(() => new Promise(() => {})));
  const queued = context.schedule(() => 'never');
  context.dispose();
  await assert.rejects(queued, { name: 'AbortError' });
  await assert.rejects(context.schedule(() => 'late'), { name: 'AbortError' });
  assert.equal(running.length, 3);
});
