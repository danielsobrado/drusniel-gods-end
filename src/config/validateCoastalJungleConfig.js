const QUALITY_NAMES = ['performance', 'balanced', 'high', 'ultra'];
const REGION_KEYS = ['zStart', 'zEnd', 'inlandStart', 'inlandEnd'];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(problems, path, value, allowZero = false) {
  const number = finiteNumber(value);
  if (number === null || (allowZero ? number < 0 : number <= 0)) {
    problems.push(`${path} must be ${allowZero ? 'a non-negative' : 'a positive'} finite number`);
  }
}

function unitInterval(problems, path, value, includeOne = true) {
  const number = finiteNumber(value);
  if (number === null || number < 0 || (includeOne ? number > 1 : number >= 1)) {
    problems.push(`${path} must be a finite number in [0, ${includeOne ? '1]' : '1)'}`);
  }
}

function validateMaterial(problems, profile) {
  const material = profile.material;
  if (!material) return;
  unitInterval(problems, 'biomes.coastalJungle.material.alphaTest', material.alphaTest);
  unitInterval(problems, 'biomes.coastalJungle.material.shadowAlphaTest', material.shadowAlphaTest);
  unitInterval(problems, 'biomes.coastalJungle.material.foliageRoughnessMin', material.foliageRoughnessMin);
  unitInterval(problems, 'biomes.coastalJungle.material.surfaceRoughnessMin', material.surfaceRoughnessMin);
  unitInterval(problems, 'biomes.coastalJungle.material.ambientLift', material.ambientLift);
  unitInterval(problems, 'biomes.coastalJungle.material.backlight', material.backlight);
  if (material.alphaToCoverage !== undefined && typeof material.alphaToCoverage !== 'boolean') {
    problems.push('biomes.coastalJungle.material.alphaToCoverage must be boolean');
  }

  const haze = material.haze;
  if (haze) {
    if (haze.enabled !== undefined && typeof haze.enabled !== 'boolean') {
      problems.push('biomes.coastalJungle.material.haze.enabled must be boolean');
    }
    if (typeof haze.color !== 'string' || haze.color.trim() === '') {
      problems.push('biomes.coastalJungle.material.haze.color must be a non-empty string');
    }
    positive(problems, 'biomes.coastalJungle.material.haze.start', haze.start, true);
    positive(problems, 'biomes.coastalJungle.material.haze.end', haze.end);
    unitInterval(problems, 'biomes.coastalJungle.material.haze.strength', haze.strength);
    const start = finiteNumber(haze.start);
    const end = finiteNumber(haze.end);
    if (start !== null && end !== null && end <= start) {
      problems.push('biomes.coastalJungle.material.haze.end must be greater than haze.start');
    }
  }

  const wind = material.wind;
  if (!wind) return;
  if (wind.enabled !== undefined && typeof wind.enabled !== 'boolean') {
    problems.push('biomes.coastalJungle.material.wind.enabled must be boolean');
  }
  positive(problems, 'biomes.coastalJungle.material.wind.amplitude', wind.amplitude, true);
  positive(problems, 'biomes.coastalJungle.material.wind.speed', wind.speed, true);
  positive(problems, 'biomes.coastalJungle.material.wind.spatialX', Math.abs(Number(wind.spatialX)), true);
  positive(problems, 'biomes.coastalJungle.material.wind.spatialZ', Math.abs(Number(wind.spatialZ)), true);
  unitInterval(problems, 'biomes.coastalJungle.material.wind.turbulence', wind.turbulence);
  unitInterval(problems, 'biomes.coastalJungle.material.wind.flutterRatio', wind.flutterRatio);
  for (const [kind, scale] of Object.entries(wind.kindScale ?? {})) {
    positive(problems, `biomes.coastalJungle.material.wind.kindScale.${kind}`, scale, true);
  }
}

function validateRender(problems, profile) {
  const render = profile.render ?? {};
  unitInterval(problems, 'biomes.coastalJungle.render.lodHysteresis', render.lodHysteresis);
  positive(problems, 'biomes.coastalJungle.render.chunkSize', render.chunkSize);
  positive(problems, 'biomes.coastalJungle.render.grassDenseDistance', render.grassDenseDistance, true);
  positive(problems, 'biomes.coastalJungle.render.grassDistance', render.grassDistance);
  unitInterval(problems, 'biomes.coastalJungle.render.grassFarDensity', render.grassFarDensity);
  positive(problems, 'biomes.coastalJungle.render.groundcoverDistance', render.groundcoverDistance);
  positive(problems, 'biomes.coastalJungle.render.undergrowthDistance', render.undergrowthDistance);
  positive(problems, 'biomes.coastalJungle.render.treeDistance', render.treeDistance);
  positive(problems, 'biomes.coastalJungle.render.cameraMoveThreshold', render.cameraMoveThreshold, true);
  unitInterval(problems, 'biomes.coastalJungle.render.cameraRotationThreshold', render.cameraRotationThreshold);

  const denseDistance = finiteNumber(render.grassDenseDistance);
  const grassDistance = finiteNumber(render.grassDistance);
  if (denseDistance !== null && grassDistance !== null && denseDistance > grassDistance) {
    problems.push('biomes.coastalJungle.render.grassDenseDistance must not exceed grassDistance');
  }
}

export function validateCoastalJungleConfig(config) {
  const profile = config?.biomes?.coastalJungle;
  if (!profile?.enabled) return config;

  const problems = [];
  if (typeof profile.asset !== 'string' || profile.asset.trim() === '') {
    problems.push('biomes.coastalJungle.asset must be a non-empty string');
  }

  const region = profile.region ?? {};
  for (const key of REGION_KEYS) {
    if (finiteNumber(region[key]) === null) problems.push(`biomes.coastalJungle.region.${key} must be finite`);
  }
  const zStart = finiteNumber(region.zStart);
  const zEnd = finiteNumber(region.zEnd);
  const inlandStart = finiteNumber(region.inlandStart);
  const inlandEnd = finiteNumber(region.inlandEnd);
  if (zStart !== null && zEnd !== null && zStart === zEnd) {
    problems.push('biomes.coastalJungle.region must span a non-zero Z range');
  }
  if (inlandStart !== null && inlandEnd !== null && inlandStart === inlandEnd) {
    problems.push('biomes.coastalJungle.region must span a non-zero inland range');
  }
  if (inlandStart !== null && inlandStart < 0) {
    problems.push('biomes.coastalJungle.region.inlandStart must not be negative');
  }
  if (inlandEnd !== null && inlandEnd < 0) {
    problems.push('biomes.coastalJungle.region.inlandEnd must not be negative');
  }

  positive(problems, 'biomes.coastalJungle.anisotropy', profile.anisotropy);
  validateMaterial(problems, profile);
  positive(problems, 'biomes.coastalJungle.ecology.edgeFade', profile.ecology?.edgeFade, true);
  unitInterval(problems, 'biomes.coastalJungle.ecology.baseVegetationScale', profile.ecology?.baseVegetationScale);
  validateRender(problems, profile);

  const placement = profile.placement ?? {};
  positive(problems, 'biomes.coastalJungle.placement.slopeSampleDistance', placement.slopeSampleDistance);
  positive(problems, 'biomes.coastalJungle.placement.maxSlope', placement.maxSlope);
  unitInterval(problems, 'biomes.coastalJungle.placement.routeMaskMax', placement.routeMaskMax);
  unitInterval(problems, 'biomes.coastalJungle.placement.routeFloorRevealStart', placement.routeFloorRevealStart, false);
  positive(problems, 'biomes.coastalJungle.placement.routeFloorRevealDepth', placement.routeFloorRevealDepth, true);
  if (placement.surfaceEdgeFade !== undefined) {
    positive(problems, 'biomes.coastalJungle.placement.surfaceEdgeFade', placement.surfaceEdgeFade, true);
  }
  positive(problems, 'biomes.coastalJungle.placement.riverClearance', placement.riverClearance, true);
  positive(problems, 'biomes.coastalJungle.placement.boundsPadding', placement.boundsPadding, true);

  const quality = profile.quality ?? {};
  for (const name of QUALITY_NAMES) {
    const settings = quality[name];
    if (!settings || typeof settings !== 'object') {
      problems.push(`biomes.coastalJungle.quality.${name} is required`);
      continue;
    }
    positive(problems, `biomes.coastalJungle.quality.${name}.maxDistance`, settings.maxDistance);
    if (settings.shadows !== undefined && typeof settings.shadows !== 'boolean') {
      problems.push(`biomes.coastalJungle.quality.${name}.shadows must be boolean`);
    }
    for (const [kind, density] of Object.entries(settings.density ?? {})) {
      unitInterval(problems, `biomes.coastalJungle.quality.${name}.density.${kind}`, density);
    }
  }

  for (const [kind, collider] of Object.entries(profile.collider ?? {})) {
    positive(problems, `biomes.coastalJungle.collider.${kind}.radius`, collider?.radius);
    positive(problems, `biomes.coastalJungle.collider.${kind}.height`, collider?.height);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid coastal jungle config:\n- ${problems.join('\n- ')}`);
  }
  return config;
}
