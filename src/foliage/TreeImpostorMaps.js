import * as THREE from 'three/webgpu';

const DEFAULT_SETTINGS = Object.freeze({
  detailedNormalQualities: Object.freeze(['high', 'ultra']),
  anisotropy: 2,
  fallback: Object.freeze({
    normalSampleRadius: 2,
    normalStrength: 1.25,
    maskSignalLow: 0.07,
    maskSignalHigh: 0.18,
    maskBrightnessLow: 0.08,
    maskBrightnessHigh: 0.25,
    greenRedWeight: 0.55,
    greenBlueWeight: 0.45,
    yellowWeight: 0.65,
    chromaWeight: 0.12,
  }),
});

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function normalizeSettings(settings = {}) {
  const fallback = settings.fallback ?? {};
  const defaults = DEFAULT_SETTINGS.fallback;
  return {
    detailedNormalQualities: Array.isArray(settings.detailedNormalQualities)
      ? [...settings.detailedNormalQualities]
      : [...DEFAULT_SETTINGS.detailedNormalQualities],
    anisotropy: Math.max(1, Number(settings.anisotropy) || DEFAULT_SETTINGS.anisotropy),
    fallback: {
      normalSampleRadius: Math.max(1, Math.round(Number(fallback.normalSampleRadius)
        || defaults.normalSampleRadius)),
      normalStrength: Math.max(0.01, Number(fallback.normalStrength) || defaults.normalStrength),
      maskSignalLow: Number.isFinite(Number(fallback.maskSignalLow))
        ? Number(fallback.maskSignalLow) : defaults.maskSignalLow,
      maskSignalHigh: Number.isFinite(Number(fallback.maskSignalHigh))
        ? Number(fallback.maskSignalHigh) : defaults.maskSignalHigh,
      maskBrightnessLow: Number.isFinite(Number(fallback.maskBrightnessLow))
        ? Number(fallback.maskBrightnessLow) : defaults.maskBrightnessLow,
      maskBrightnessHigh: Number.isFinite(Number(fallback.maskBrightnessHigh))
        ? Number(fallback.maskBrightnessHigh) : defaults.maskBrightnessHigh,
      greenRedWeight: Number.isFinite(Number(fallback.greenRedWeight))
        ? Number(fallback.greenRedWeight) : defaults.greenRedWeight,
      greenBlueWeight: Number.isFinite(Number(fallback.greenBlueWeight))
        ? Number(fallback.greenBlueWeight) : defaults.greenBlueWeight,
      yellowWeight: Number.isFinite(Number(fallback.yellowWeight))
        ? Number(fallback.yellowWeight) : defaults.yellowWeight,
      chromaWeight: Number.isFinite(Number(fallback.chromaWeight))
        ? Number(fallback.chromaWeight) : defaults.chromaWeight,
    },
  };
}

export function resolveTreeImpostorSettings(config) {
  return normalizeSettings(config.trees?.lod?.impostor);
}

export function isDetailedTreeImpostorQuality(config, quality = config.ui?.initialQuality) {
  return resolveTreeImpostorSettings(config).detailedNormalQualities.includes(quality);
}

function foliageProbability(r, g, b, settings) {
  const maxChannel = Math.max(r, g, b);
  const minChannel = Math.min(r, g, b);
  const green = g - (r * settings.greenRedWeight + b * settings.greenBlueWeight);
  const yellow = (Math.min(r, g) - b) * settings.yellowWeight;
  const chroma = (maxChannel - minChannel) * settings.chromaWeight;
  const signal = Math.max(green, yellow, chroma);
  return smoothstep(settings.maskSignalLow, settings.maskSignalHigh, signal)
    * smoothstep(settings.maskBrightnessLow, settings.maskBrightnessHigh, maxChannel);
}

export function buildFallbackTreeImpostorData(rgba, width, height, capture, settings = {}) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) {
    throw new TypeError('Tree impostor source must be packed RGBA bytes.');
  }
  const resolved = normalizeSettings({ fallback: settings }).fallback;
  const output = new Uint8Array(rgba.length);
  const views = Math.max(1, Number(capture?.views) || 1);
  const tileSize = Math.max(1, Number(capture?.tileSize) || Math.floor(width / views));
  const radius = resolved.normalSampleRadius;
  const alpha = (x, y, tileStart, tileEnd) => {
    const px = Math.max(tileStart, Math.min(tileEnd, x));
    const py = Math.max(0, Math.min(height - 1, y));
    return rgba[(py * width + px) * 4 + 3] / 255;
  };

  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    const coverage = rgba[index + 3];
    if (coverage === 0) {
      output[index] = 128;
      output[index + 1] = 128;
      output[index + 2] = 0;
      output[index + 3] = 0;
      continue;
    }

    const tile = Math.min(views - 1, Math.floor(x / tileSize));
    const tileStart = tile * tileSize;
    const tileEnd = Math.min(width - 1, tileStart + tileSize - 1);
    const nx = (alpha(x - radius, y, tileStart, tileEnd)
      - alpha(x + radius, y, tileStart, tileEnd)) * resolved.normalStrength;
    const ny = (alpha(x, y - radius, tileStart, tileEnd)
      - alpha(x, y + radius, tileStart, tileEnd)) * resolved.normalStrength;
    const length = Math.hypot(nx, ny, 1);
    output[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
    output[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);

    const r = rgba[index] / 255, g = rgba[index + 1] / 255, b = rgba[index + 2] / 255;
    output[index + 2] = Math.round(foliageProbability(r, g, b, resolved) * 255);
    output[index + 3] = coverage;
  }
  return output;
}

function flippedImageData(image, name) {
  if (!image?.width || !image?.height) throw new TypeError(`${name} must have image dimensions`);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas context unavailable for tree impostor map.');
  context.drawImage(image, 0, 0);
  const input = context.getImageData(0, 0, image.width, image.height).data;
  const data = new Uint8Array(input.length), stride = image.width * 4;
  for (let y = 0; y < image.height; y += 1) {
    data.set(input.subarray(y * stride, (y + 1) * stride), (image.height - y - 1) * stride);
  }
  return data;
}

function configureTexture(texture, name, anisotropy) {
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.flipY = false;
  texture.name = name;
  texture.needsUpdate = true;
  return texture;
}

function createTexture(data, width, height, name, anisotropy) {
  return configureTexture(new THREE.DataTexture(data, width, height), name, anisotropy);
}

export function treeImpostorPlaceholderTexture(settings, name = 'Tree normal/mask placeholder') {
  const resolved = normalizeSettings(settings);
  return createTexture(new Uint8Array([128, 128, 0, 255]), 1, 1, name, resolved.anisotropy);
}

export function updatePackedTreeImpostorTextureFromImage(
  target,
  image,
  settings,
  name = 'Tree normal/mask atlas',
) {
  if (!target?.isDataTexture) throw new TypeError('Tree impostor target must be a THREE.DataTexture');
  const resolved = normalizeSettings(settings);
  const previous = target.image;
  const resized = previous?.width !== image.width || previous?.height !== image.height;
  target.image = {
    data: flippedImageData(image, name),
    width: image.width,
    height: image.height,
  };
  // The backend already allocated a GPU texture for the placeholder's size, and
  // needsUpdate alone writes the new data into that old allocation -- a copy
  // outside a 1x1 texture, which WebGPU rejects. Releasing it makes three
  // allocate at the new size; the texture object materials hold stays the same.
  if (resized) target.dispose();
  return configureTexture(target, name, resolved.anisotropy);
}

export function fallbackTreeImpostorTextureFromImage(
  image,
  capture,
  settings,
  name = 'Generated tree normal/mask atlas',
) {
  const resolved = normalizeSettings(settings);
  const source = flippedImageData(image, name);
  const data = buildFallbackTreeImpostorData(source, image.width, image.height, capture, resolved.fallback);
  return createTexture(data, image.width, image.height, name, resolved.anisotropy);
}
