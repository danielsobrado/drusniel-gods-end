function number(value, path, problems, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, exclusiveMin = false } = {}) {
  const numeric = Number(value);
  const lowerInvalid = exclusiveMin ? !(numeric > min) : numeric < min;
  if (!Number.isFinite(numeric) || lowerInvalid || numeric > max) {
    problems.push(`${path} must be a finite number${Number.isFinite(min) ? `${exclusiveMin ? ' >' : ' >='} ${min}` : ''}${Number.isFinite(max) ? ` and <= ${max}` : ''}`);
  }
  return numeric;
}

function object(value, path, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path} must be an object`);
    return false;
  }
  return true;
}

function interval(value, path, problems) {
  if (!object(value, path, problems)) return;
  const start = number(value.start, `${path}.start`, problems);
  const full = number(value.full, `${path}.full`, problems);
  if (Number.isFinite(start) && Number.isFinite(full) && full <= start) {
    problems.push(`${path}.full must be greater than ${path}.start`);
  }
}

export function validateSnowConfig(config) {
  const snow = config.ground?.snow;
  if (!snow?.enabled) return config;
  const problems = [];

  interval(snow.altitude, 'ground.snow.altitude', problems);
  interval(snow.slope, 'ground.snow.slope', problems);
  if (snow.slope) {
    number(snow.slope.start, 'ground.snow.slope.start', problems, { min: 0, max: 1 });
    number(snow.slope.full, 'ground.snow.slope.full', problems, { min: 0, max: 1 });
  }

  if (object(snow.wind, 'ground.snow.wind', problems)) {
    for (const name of ['driftFrequency', 'crossFrequency', 'exposureFrequency', 'exposureCrossFrequency']) {
      number(snow.wind[name], `ground.snow.wind.${name}`, problems, { min: 0, exclusiveMin: true });
    }
    for (const name of ['angleDegrees', 'warp', 'driftHeight', 'scourStrength']) {
      number(snow.wind[name], `ground.snow.wind.${name}`, problems);
    }
  }

  if (object(snow.sastrugi, 'ground.snow.sastrugi', problems)) {
    for (const name of ['frequency', 'crossFrequency', 'secondaryFrequency']) {
      number(snow.sastrugi[name], `ground.snow.sastrugi.${name}`, problems, { min: 0, exclusiveMin: true });
    }
    for (const name of ['warp', 'amplitude', 'secondaryAmplitude']) {
      number(snow.sastrugi[name], `ground.snow.sastrugi.${name}`, problems);
    }
  }

  if (object(snow.ripples, 'ground.snow.ripples', problems)) {
    for (const name of ['frequency', 'crossFrequency']) {
      number(snow.ripples[name], `ground.snow.ripples.${name}`, problems, { min: 0, exclusiveMin: true });
    }
    number(snow.ripples.amplitude, 'ground.snow.ripples.amplitude', problems);
  }

  if (object(snow.grain, 'ground.snow.grain', problems)) {
    for (const name of ['frequencyX', 'frequencyZ']) {
      number(snow.grain[name], `ground.snow.grain.${name}`, problems, { min: 0, exclusiveMin: true });
    }
    number(snow.grain.amplitude, 'ground.snow.grain.amplitude', problems);
    const fadeStart = number(snow.grain.fadeStart, 'ground.snow.grain.fadeStart', problems, { min: 0 });
    const fadeEnd = number(snow.grain.fadeEnd, 'ground.snow.grain.fadeEnd', problems, { min: 0 });
    if (Number.isFinite(fadeStart) && Number.isFinite(fadeEnd) && fadeEnd <= fadeStart) {
      problems.push('ground.snow.grain.fadeEnd must be greater than fadeStart');
    }
  }

  if (object(snow.colors, 'ground.snow.colors', problems)) {
    for (const name of ['shadow', 'base', 'sun']) {
      if (typeof snow.colors[name] !== 'string' || snow.colors[name].length === 0) {
        problems.push(`ground.snow.colors.${name} must be a color string`);
      }
    }
    number(snow.colors.driftVariation, 'ground.snow.colors.driftVariation', problems, { min: 0, max: 1 });
  }

  if (object(snow.roughness, 'ground.snow.roughness', problems)) {
    for (const name of ['base', 'compressed', 'berm']) {
      number(snow.roughness[name], `ground.snow.roughness.${name}`, problems, { min: 0, max: 1 });
    }
  }

  if (object(snow.lighting, 'ground.snow.lighting', problems)) {
    for (const name of ['sssStrength', 'glintStrength']) {
      number(snow.lighting[name], `ground.snow.lighting.${name}`, problems, { min: 0 });
    }
    for (const name of ['backscatterPower', 'glintPower', 'sparkleFrequency']) {
      number(snow.lighting[name], `ground.snow.lighting.${name}`, problems, { min: 0, exclusiveMin: true });
    }
  }

  const deformation = snow.deformation;
  if (object(deformation, 'ground.snow.deformation', problems) && deformation.enabled !== false) {
    const resolution = number(deformation.resolution, 'ground.snow.deformation.resolution', problems, { min: 64, max: 2048 });
    if (Number.isFinite(resolution) && !Number.isInteger(resolution)) {
      problems.push('ground.snow.deformation.resolution must be an integer');
    }
    const worldSize = number(deformation.worldSize, 'ground.snow.deformation.worldSize', problems, { min: 1, exclusiveMin: true });
    for (const name of ['paintMinCoverage', 'depressionStrength', 'bermStrength']) {
      number(deformation[name], `ground.snow.deformation.${name}`, problems, { min: 0, max: 1 });
    }
    for (const name of ['footRadiusScale', 'minRadius', 'maxRadius', 'contactHeight', 'recenterDistance', 'decaySeconds', 'bermDecaySeconds', 'recoveryInterval']) {
      number(deformation[name], `ground.snow.deformation.${name}`, problems, { min: 0, exclusiveMin: true });
    }
    const minRadius = Number(deformation.minRadius);
    const maxRadius = Number(deformation.maxRadius);
    if (Number.isFinite(minRadius) && Number.isFinite(maxRadius) && maxRadius < minRadius) {
      problems.push('ground.snow.deformation.maxRadius must be greater than or equal to minRadius');
    }
    const recenterDistance = Number(deformation.recenterDistance);
    if (Number.isFinite(worldSize) && Number.isFinite(recenterDistance) && recenterDistance >= worldSize * 0.5) {
      problems.push('ground.snow.deformation.recenterDistance must be lower than half of worldSize');
    }
    if (Number.isFinite(worldSize) && Number.isFinite(recenterDistance) && Number.isFinite(maxRadius)
      && recenterDistance + maxRadius * 1.55 >= worldSize * 0.5) {
      problems.push('ground.snow.deformation.recenterDistance must leave room for the maximum footprint berm');
    }
    for (const name of ['normalStrength', 'darkenStrength', 'bermLighten']) {
      number(deformation[name], `ground.snow.deformation.${name}`, problems, { min: 0 });
    }
  }

  if (problems.length > 0) {
    throw new Error(`Snow configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}
