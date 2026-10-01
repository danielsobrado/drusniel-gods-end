export const VEGETATION_QUALITY = Object.freeze({
  performance: { scale: 0.65, grassDistance: 300, treeDistance: 600 },
  balanced: { scale: 0.8, grassDistance: 400, treeDistance: 900 },
  high: { scale: 1, grassDistance: 500, treeDistance: 1200 },
  ultra: { scale: 1.25, grassDistance: 600, treeDistance: 1600 },
});
export const TREE_LOD_DEFAULTS = Object.freeze({
  distances: [80, 160, 300],
  referenceHeight: 12,
  blend: 0.15,
  chunkSize: 100,
  screenSpace: Object.freeze({
    enabled: false,
    heights: Object.freeze([260, 125, 80]),
    fallbackViewportHeight: 1080,
  }),
});
export const VEGETATION_UPDATE_DEFAULTS = Object.freeze({
  cameraMoveThreshold: 0.5,
  cameraRotationThreshold: 0.0038,
  cameraTurnMarginDegrees: 12,
});
export const TREE_KINDS = new Set(['tree', 'background_tree', 'palm']);
export function smoothCoverage(start, end, distance) {
  const t = Math.max(0, Math.min(1, (distance - start) / Math.max(0.0001, end - start)));
  return t * t * (3 - 2 * t);
}
/** Cumulative intervals share the same noise test: adjacent levels never leave a coverage hole. */
export function vegetationLodWeights(distance, { centers, blend = 0.15, far, available = [true, true, true, true] }, target = [0, 0, 0, 0]) {
  target.fill(0);
  if (distance >= far) return target;
  let remaining = 1;
  for (let i = 0; i < centers.length; i++) {
    const after = smoothCoverage(centers[i] * (1 - blend), centers[i] * (1 + blend), distance);
    target[i] = remaining * (1 - after);
    remaining *= after;
  }
  // The impostor is always the last slot: a shorter center list drops mesh stages
  // in favour of it rather than shifting what the final representation is.
  target[target.length - 1] = remaining;
  return finishWeights(target, distance, far, available);
}

function finishWeights(target, distance, far, available) {
  const fade = 1 - smoothCoverage(far * 0.9, far, distance);
  for (let i = 0; i < target.length; i++) {
    target[i] *= fade;
    if (available[i] || target[i] === 0) continue;
    let replacement = i - 1;
    while (replacement >= 0 && !available[replacement]) replacement--;
    if (replacement < 0) replacement = available.findIndex(Boolean);
    if (replacement >= 0) target[replacement] += target[i];
    target[i] = 0;
  }
  return target;
}

export function vegetationLodScreenWeights(
  projectedHeight,
  distance,
  { screenHeights, blend = 0.15, far, available = [true, true, true, true] },
  target = [0, 0, 0, 0],
) {
  target.fill(0);
  if (distance >= far) return target;
  let remaining = 1;
  for (let i = 0; i < screenHeights.length; i++) {
    const center = screenHeights[i];
    const after = 1 - smoothCoverage(
      center * (1 - blend),
      center * (1 + blend),
      projectedHeight,
    );
    target[i] = remaining * (1 - after);
    remaining *= after;
  }
  target[target.length - 1] = remaining;
  return finishWeights(target, distance, far, available);
}

export function projectedTreeHeightPixels(height, depth, projectionY, viewportHeight) {
  const h = Number(height), d = Number(depth), projection = Number(projectionY), viewport = Number(viewportHeight);
  if (![h, d, projection, viewport].every(Number.isFinite) || h <= 0 || d <= 0 || viewport <= 0) return 0;
  return h * Math.abs(projection) * viewport / (2 * Math.max(0.001, d));
}

export function treeLodCenters(height, quality = 'high', settings = TREE_LOD_DEFAULTS) {
  const qualityScale = VEGETATION_QUALITY[quality]?.scale ?? VEGETATION_QUALITY.high.scale;
  const scale = Math.min(
    settings.maxHeightScale ?? Infinity,
    Math.max(0.1, height / (settings.referenceHeight ?? 12)),
  ) * qualityScale;
  return (settings.distances ?? TREE_LOD_DEFAULTS.distances).map(distance => distance * scale);
}

export function treeLodScreenHeights(quality = 'high', settings = TREE_LOD_DEFAULTS) {
  const screen = settings.screenSpace;
  if (!screen?.enabled) return null;
  const qualityScale = VEGETATION_QUALITY[quality]?.scale ?? VEGETATION_QUALITY.high.scale;
  return screen.heights.map(height => height / qualityScale);
}
