import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { captureObjectResources } from '../utils/ResourceScope.js';
import { loadScenePreprocessing } from './scenePreprocessing.js';

// Each GLTF consumer used to create its own DRACOLoader, and each one fetched
// and compiled the decoder WASM in its own workers (eight copies per startup).
// One context per demo now owns a single decoder pool, plus the parsed
// vegetation bundles, which the tree types that load up front and the ones
// streamed in later both read (forest.glb was parsed twice).
const DRACO_WORKERS = 3;
// Model prefetches (houses, NPCs) share one bound, so a burst of large GLBs
// does not claim every connection and decoder at once.
const PREFETCH_JOBS = 3;

function abortError(message) {
  return new DOMException(message, 'AbortError');
}

// Stops one caller waiting without cancelling the shared request.
function joinWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError('Aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class AssetLoadContext {
  #draco = null;
  #templates = new Map();
  #active = 0;
  #queue = [];
  #preprocessing = null;

  constructor(config, { createLoader = () => new GLTFLoader(), createDraco = () => new DRACOLoader() } = {}) {
    this.config = config;
    this.disposed = false;
    this.createLoader = createLoader;
    this.createDraco = createDraco;
  }

  get dracoLoader() {
    if (this.disposed) throw abortError('Asset load context disposed');
    const path = this.config.assets?.dracoDecoderPath;
    if (!path) return null;
    this.#draco ??= this.createDraco().setDecoderPath(path).setWorkerLimit(DRACO_WORKERS);
    return this.#draco;
  }

  /** A GLTF loader on the shared Draco decoder. Callers own what it loads. */
  createGltfLoader() {
    const loader = this.createLoader();
    const draco = this.dracoLoader;
    if (draco) loader.setDRACOLoader(draco);
    return loader;
  }

  /**
   * A parsed bundle shared by every caller of the same resolved URL, kept
   * until the context is disposed. Callers must not attach, reparent or
   * dispose it: they copy geometry and clone materials out of it.
   */
  loadTemplate(url, { signal } = {}) {
    if (this.disposed) return Promise.reject(abortError('Asset load context disposed'));
    let entry = this.#templates.get(url);
    if (!entry) {
      entry = { release: null, promise: null };
      const current = entry;
      entry.promise = this.createGltfLoader().loadAsync(url).then((gltf) => {
        const release = captureObjectResources(gltf.scene);
        if (this.disposed || this.#templates.get(url) !== current) {
          release();
          throw abortError('Asset load context disposed');
        }
        current.release = release;
        return gltf;
      });
      // A failure is forgotten so a later request retries; the rejection is
      // observed here so an abandoned shared request is never unhandled.
      entry.promise.catch(() => {
        if (this.#templates.get(url) === current) this.#templates.delete(url);
      });
      this.#templates.set(url, entry);
    }
    return joinWithSignal(entry.promise, signal);
  }

  /** The baked house/NPC simplification (scenePreprocessing.js), or null. */
  scenePreprocessing() {
    this.#preprocessing ??= loadScenePreprocessing().catch(() => null);
    return this.#preprocessing;
  }

  /** Runs `task` when one of the shared prefetch slots is free. */
  schedule(task) {
    if (this.disposed) return Promise.reject(abortError('Asset load context disposed'));
    return new Promise((resolve, reject) => {
      const run = () => {
        this.#active += 1;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          this.#active -= 1;
          this.#queue.shift()?.run();
        });
      };
      if (this.#active < PREFETCH_JOBS) run();
      else this.#queue.push({ run, reject });
    });
  }

  /**
   * Ends decoder workers that hold no task, so the pool's WASM heaps are not
   * retained between loading bursts (each loader used to dispose its own after
   * use). A later decode starts a new worker. Reads DRACOLoader's pool
   * internals, which match the pinned three r186; a worker is bound to a task
   * synchronously when it is picked, so an idle one has no task in flight.
   */
  releaseIdleDecoderWorkers() {
    const pool = this.#draco?.workerPool;
    if (!Array.isArray(pool)) return 0;
    const idle = pool.filter((worker) => worker._taskLoad === 0);
    for (const worker of idle) worker.terminate();
    const busy = pool.filter((worker) => !idle.includes(worker));
    pool.length = 0;
    pool.push(...busy);
    return idle.length;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { reject } of this.#queue.splice(0)) reject(abortError('Asset load context disposed'));
    for (const entry of this.#templates.values()) entry.release?.();
    this.#templates.clear();
    this.#draco?.dispose();
    this.#draco = null;
  }
}
