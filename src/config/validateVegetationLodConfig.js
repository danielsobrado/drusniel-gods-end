import { validateCameraTurnEnvelope } from './validateCameraTurnEnvelope.js';

export function validateVegetationLodConfig(config, problems) {
  const viewCulling = config.vegetation?.viewCulling;
  if (viewCulling?.budgetMs !== undefined) {
    const budgetMs = Number(viewCulling.budgetMs);
    if (!(budgetMs >= 0) || !Number.isFinite(budgetMs)) {
      problems.push('vegetation.viewCulling.budgetMs must be a non-negative finite number');
    }
  }
  if (!config.vegetationLod?.enabled) return;
  const positive = (value, path) => {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${path} must be positive and finite`);
  };
  const ktx2 = config.vegetationLod?.ktx2;
  if (ktx2?.enabled) {
    if (typeof ktx2.transcoderPath !== 'string' || ktx2.transcoderPath.length === 0) {
      problems.push('vegetationLod.ktx2.transcoderPath must be a non-empty string');
    }
    const workerLimit = Number(ktx2.workerLimit);
    if (!Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 8) {
      problems.push('vegetationLod.ktx2.workerLimit must be an integer in [1, 8]');
    }
    const maxTransferRatio = Number(ktx2.maxTransferRatio);
    if (!(maxTransferRatio >= 1) || !Number.isFinite(maxTransferRatio)) {
      problems.push('vegetationLod.ktx2.maxTransferRatio must be a finite number greater than or equal to one');
    }
  }
  const update = config.vegetationLod?.update;
  if (update) {
    const moveThreshold = Number(update.cameraMoveThreshold);
    if (!(moveThreshold >= 0) || !Number.isFinite(moveThreshold)) {
      problems.push('vegetationLod.update.cameraMoveThreshold must be a non-negative finite number');
    }
    validateCameraTurnEnvelope(
      problems,
      'vegetationLod.update',
      update.cameraRotationThreshold,
      update.cameraTurnMarginDegrees,
    );
    if (update.shadowCastDistance !== undefined) {
      const shadowCastDistance = Number(update.shadowCastDistance);
      if (!(shadowCastDistance >= 0) || !Number.isFinite(shadowCastDistance)) {
        problems.push('vegetationLod.update.shadowCastDistance must be a non-negative finite number');
      }
    }
    if (update.shadowLodLevel !== undefined && update.shadowLodLevel !== null
      && ![1, 2].includes(update.shadowLodLevel)) {
      problems.push('vegetationLod.update.shadowLodLevel must be 1 (medium), 2 (low) or null');
    }
  }
  const normalRetry = config.vegetationLod?.impostorNormalRetry;
  if (normalRetry) {
    const maxAttempts = Number(normalRetry.maxAttempts);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      problems.push('vegetationLod.impostorNormalRetry.maxAttempts must be an integer in [1, 10]');
    }
    const delayMs = Number(normalRetry.delayMs);
    if (!(delayMs >= 0) || !Number.isFinite(delayMs)) {
      problems.push('vegetationLod.impostorNormalRetry.delayMs must be a non-negative finite number');
    }
  }
  const lod = config.trees?.lod;
  if (!lod) { problems.push('trees.lod is required'); return; }
  // One entry per mesh stage; the impostor always follows the last one.
  if (!Array.isArray(lod.distances) || lod.distances.length < 1 || lod.distances.length > 3
    || lod.distances.some((v, i, a) => !Number.isFinite(v) || v <= (a[i - 1] ?? 0))) {
    problems.push('trees.lod.distances must contain one to three increasing positive distances');
  }
  if (!(lod.blend > 0 && lod.blend < 0.5)) problems.push('trees.lod.blend must be between 0 and 0.5');
  positive(lod.referenceHeight, 'trees.lod.referenceHeight'); positive(lod.chunkSize, 'trees.lod.chunkSize');
  const screenSpace = lod.screenSpace;
  if (screenSpace?.enabled) {
    if (!Array.isArray(screenSpace.heights) || screenSpace.heights.length < 1 || screenSpace.heights.length > 3
      || screenSpace.heights.some((value, index, values) => !Number.isFinite(value)
        || value <= 0 || (index > 0 && value >= values[index - 1]))) {
      problems.push('trees.lod.screenSpace.heights must contain one to three decreasing positive values');
    }
    positive(screenSpace.fallbackViewportHeight, 'trees.lod.screenSpace.fallbackViewportHeight');
    if (screenSpace.referenceViewportHeight !== undefined) {
      positive(screenSpace.referenceViewportHeight, 'trees.lod.screenSpace.referenceViewportHeight');
    }
  }
  for (const [name, settings] of [['medium', lod.medium], ['low', lod.low]]) {
    if (!settings) { problems.push(`trees.lod.${name} is required`); continue; }
    if (!(settings.woodRatio > 0 && settings.woodRatio <= 1)) {
      problems.push(`trees.lod.${name}.woodRatio must be in (0, 1]`);
    }
    positive(settings.woodError, `trees.lod.${name}.woodError`);
  }
  if (lod.low) {
    if (!(lod.low.foliageKeepRatio > 0 && lod.low.foliageKeepRatio <= 1)) {
      problems.push('trees.lod.low.foliageKeepRatio must be in (0, 1]');
    }
    if (!Array.isArray(lod.low.grid) || lod.low.grid.length !== 3
      || lod.low.grid.some(value => !Number.isInteger(value) || value < 1)) {
      problems.push('trees.lod.low.grid must contain three positive integers');
    }
    if (!Number.isInteger(lod.low.minComponents) || lod.low.minComponents < 1) {
      problems.push('trees.lod.low.minComponents must be a positive integer');
    }
    if (!(lod.low.maxComponentShare > 0 && lod.low.maxComponentShare <= 1)) {
      problems.push('trees.lod.low.maxComponentShare must be in (0, 1]');
    }
  }
  const impostor = lod.impostor;
  if (!impostor) {
    problems.push('trees.lod.impostor is required');
  } else {
    const allowedQualities = new Set(['performance', 'balanced', 'high', 'ultra']);
    if (!Array.isArray(impostor.detailedNormalQualities)
      || impostor.detailedNormalQualities.length === 0
      || impostor.detailedNormalQualities.some(quality => !allowedQualities.has(quality))) {
      problems.push('trees.lod.impostor.detailedNormalQualities must contain valid quality names');
    }
    const views = Number(impostor.views);
    if (!Number.isInteger(views) || views < 4 || views > 16) {
      problems.push('trees.lod.impostor.views must be an integer in [4, 16]');
    }
    const tileSize = Number(impostor.tileSize);
    if (!Number.isInteger(tileSize) || tileSize < 64 || tileSize > 512 || tileSize % 4 !== 0) {
      problems.push('trees.lod.impostor.tileSize must be a multiple of four in [64, 512]');
    }
    const gutter = Number(impostor.gutter);
    if (!Number.isInteger(gutter) || gutter < 0 || gutter > Math.floor(tileSize / 4)) {
      problems.push('trees.lod.impostor.gutter must be an integer between zero and one quarter of tileSize');
    }
    positive(impostor.anisotropy, 'trees.lod.impostor.anisotropy');
    const fallback = impostor.fallback;
    if (!fallback) {
      problems.push('trees.lod.impostor.fallback is required');
    } else {
      if (!Number.isInteger(fallback.normalSampleRadius) || fallback.normalSampleRadius < 1) {
        problems.push('trees.lod.impostor.fallback.normalSampleRadius must be a positive integer');
      }
      positive(fallback.normalStrength, 'trees.lod.impostor.fallback.normalStrength');
      for (const [low, high] of [
        ['maskSignalLow', 'maskSignalHigh'],
        ['maskBrightnessLow', 'maskBrightnessHigh'],
      ]) {
        if (!(Number.isFinite(fallback[low]) && Number.isFinite(fallback[high]) && fallback[low] < fallback[high])) {
          problems.push(`trees.lod.impostor.fallback.${low}/${high} must be finite and increasing`);
        }
      }
      for (const name of ['greenRedWeight', 'greenBlueWeight', 'yellowWeight', 'chromaWeight']) {
        const value = Number(fallback[name]);
        if (!(value >= 0) || !Number.isFinite(value)) {
          problems.push(`trees.lod.impostor.fallback.${name} must be non-negative and finite`);
        }
      }
    }
  }
  if (lod.maxHeightScale !== undefined) positive(lod.maxHeightScale, 'trees.lod.maxHeightScale');
  const far = config.grass?.far;
  if (far?.enabled) {
    for (const key of ['chunkSize', 'density', 'width', 'height']) positive(far[key], `grass.far.${key}`);
    if (!(far.transitionStart > 0 && far.transitionStart < 1)) problems.push('grass.far.transitionStart must be between 0 and 1');
    if (!(far.fadeStart > 0 && far.fadeStart < 1)) problems.push('grass.far.fadeStart must be between 0 and 1');
  }
  const jungle = config.biomes?.coastalJungle?.lod;
  if (jungle?.enabled) positive(jungle.chunkSize, 'biomes.coastalJungle.lod.chunkSize');
  for (const quality of ['performance', 'balanced', 'high', 'ultra']) {
    if (far?.enabled) {
      const distance = far.distances?.[quality]; positive(distance, `grass.far.distances.${quality}`);
      const near = Math.max(...['blade', 'billboard'].map(type => config.quality?.[quality]?.[type]?.maxDistance ?? 0));
      if (distance * far.fadeStart <= near) problems.push(`grass.far.distances.${quality} must fade beyond the near grass range`);
    }
    if (jungle?.enabled) {
      const plant = jungle.plantDistances?.[quality], tree = jungle.treeDistances?.[quality];
      positive(plant, `biomes.coastalJungle.lod.plantDistances.${quality}`);
      positive(tree, `biomes.coastalJungle.lod.treeDistances.${quality}`);
      if (tree <= plant) problems.push(`jungle tree distance must exceed plant distance for ${quality}`);
    }
  }
}
