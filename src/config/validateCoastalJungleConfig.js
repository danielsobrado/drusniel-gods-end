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

function unitInterval(problems, path, value) {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 1) {
    problems.push(`${path} must be a finite number in [0, 1]`);
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

  const placement = profile.placement ?? {};
  positive(problems, 'biomes.coastalJungle.placement.slopeSampleDistance', placement.slopeSampleDistance);
  positive(problems, 'biomes.coastalJungle.placement.maxSlope', placement.maxSlope);
  unitInterval(problems, 'biomes.coastalJungle.placement.routeMaskMax', placement.routeMaskMax);
  unitInterval(problems, 'biomes.coastalJungle.placement.routeFloorRevealStart', placement.routeFloorRevealStart);
  positive(problems, 'biomes.coastalJungle.placement.routeFloorRevealDepth', placement.routeFloorRevealDepth, true);
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
