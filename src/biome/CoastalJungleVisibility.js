const TREE_KINDS = new Set(['tree', 'background_tree', 'palm']);
const UINT32_MAX_PLUS_ONE = 4294967296;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function smoothstep(value, min, max) {
  if (!(max > min)) return value >= max ? 1 : 0;
  const x = clamp01((value - min) / (max - min));
  return x * x * (3 - 2 * x);
}

function stringHash(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function coastalJungleStableFraction(position, kind = '') {
  const x = Math.round(Number(position?.x ?? 0) * 1000);
  const y = Math.round(Number(position?.y ?? 0) * 1000);
  const z = Math.round(Number(position?.z ?? 0) * 1000);
  let hash = stringHash(kind);
  hash ^= Math.imul(x, 73856093);
  hash ^= Math.imul(y, 19349663);
  hash ^= Math.imul(z, 83492791);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822519);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489917);
  hash ^= hash >>> 16;
  return (hash >>> 0) / UINT32_MAX_PLUS_ONE;
}

export function coastalJungleInstanceKey(position, kind = '') {
  const x = Math.round(Number(position?.x ?? 0) * 100);
  const y = Math.round(Number(position?.y ?? 0) * 100);
  const z = Math.round(Number(position?.z ?? 0) * 100);
  return `${kind}:${x}:${y}:${z}`;
}

export function coastalJungleVisibilityLimit(kind, render = {}, quality = {}) {
  const configured = kind === 'grass'
    ? render.grassDistance
    : kind === 'groundcover'
      ? render.groundcoverDistance
      : TREE_KINDS.has(kind)
        ? render.treeDistance
        : render.undergrowthDistance;
  const kindLimit = Math.max(0, Number(configured) || 0);
  const qualityLimit = Math.max(0, Number(quality.maxDistance) || kindLimit);
  return Math.min(kindLimit, qualityLimit);
}

export function coastalJungleKeepFraction(kind, distance, render = {}, quality = {}) {
  const density = clamp01(quality.density?.[kind] ?? 1);
  if (kind !== 'grass') return density;
  const denseDistance = Math.max(0, Number(render.grassDenseDistance) || 0);
  const maxDistance = Math.max(denseDistance, Number(render.grassDistance) || denseDistance);
  if (distance <= denseDistance || maxDistance <= denseDistance) return density;
  const minimum = clamp01(render.grassFarDensity ?? 0.2);
  const fade = smoothstep(distance, denseDistance, maxDistance);
  return density * (1 + (minimum - 1) * fade);
}

export function coastalJungleShouldKeep(kind, distance, stableFraction, render = {}, quality = {}) {
  const limit = coastalJungleVisibilityLimit(kind, render, quality);
  if (distance > limit) return false;
  return stableFraction <= coastalJungleKeepFraction(kind, distance, render, quality);
}

export function isCoastalJungleTreeKind(kind) {
  return TREE_KINDS.has(kind);
}
