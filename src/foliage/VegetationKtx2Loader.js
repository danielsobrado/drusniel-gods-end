import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';

const contexts = new WeakMap();

function createContext(renderer, config) {
  const settings = config.vegetationLod?.ktx2;
  if (!renderer || !settings?.enabled || !settings.transcoderPath) {
    return { loader: null, ready: Promise.resolve(null) };
  }

  let loader;
  try {
    loader = new KTX2Loader()
      .setTranscoderPath(assetUrl(settings.transcoderPath))
      .setWorkerLimit(Math.max(1, Number(settings.workerLimit) || 2));
    loader.detectSupport(renderer);
  } catch (error) {
    logger.warn('KTX2 vegetation support unavailable; using WebP atlases.', error);
    return { loader: null, ready: Promise.resolve(null) };
  }

  const context = { loader, ready: null };
  context.ready = loader.init()
    .then(() => loader)
    .catch((error) => {
      loader.dispose();
      context.loader = null;
      logger.warn('KTX2 vegetation support unavailable; using WebP atlases.', error);
      return null;
    });
  return context;
}

export function getVegetationKtx2Loader(renderer, config, signal) {
  if (!renderer || !config.vegetationLod?.ktx2?.enabled) return null;
  signal?.throwIfAborted();

  let context = contexts.get(renderer);
  if (!context) {
    context = createContext(renderer, config);
    contexts.set(renderer, context);
  }

  // init() starts the transcoder fetch/compile immediately. Do not await it:
  // KTX2 file downloads can overlap that work and loadAsync() joins the same promise.
  return context.loader;
}

export function disposeVegetationKtx2Loader(renderer) {
  const context = renderer ? contexts.get(renderer) : null;
  if (!context) return;
  contexts.delete(renderer);
  context.ready.then((loader) => loader?.dispose()).catch(() => {});
}
