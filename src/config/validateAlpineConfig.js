function number(value, path, problems, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, exclusiveMin = false } = {}) {
  const numeric = Number(value);
  const lowerInvalid = exclusiveMin ? !(numeric > min) : numeric < min;
  if (!Number.isFinite(numeric) || lowerInvalid || numeric > max) {
    problems.push(`${path} must be a finite number in the configured range`);
  }
  return numeric;
}

function integer(value, path, problems, options) {
  const numeric = number(value, path, problems, options);
  if (Number.isFinite(numeric) && !Number.isInteger(numeric)) problems.push(`${path} must be an integer`);
  return numeric;
}

function point2(value, path, problems) {
  if (!Array.isArray(value) || value.length !== 2) {
    problems.push(`${path} must contain [x, z]`);
    return;
  }
  number(value[0], `${path}[0]`, problems);
  number(value[1], `${path}[1]`, problems);
}

export function validateAlpineConfig(config) {
  const alpine = config.terrain?.alpine;
  if (!alpine?.enabled) return config;
  const problems = [];

  point2(alpine.center, 'terrain.alpine.center', problems);
  const basinRadius = number(alpine.basinRadius, 'terrain.alpine.basinRadius', problems, { min: 0, exclusiveMin: true });
  const rimRadius = number(alpine.rimRadius, 'terrain.alpine.rimRadius', problems, { min: 0, exclusiveMin: true });
  const outerBlendStart = number(alpine.outerBlendStart, 'terrain.alpine.outerBlendStart', problems, { min: 0, exclusiveMin: true });
  const outerRadius = number(alpine.outerRadius, 'terrain.alpine.outerRadius', problems, { min: 0, exclusiveMin: true });
  if (rimRadius <= basinRadius) problems.push('terrain.alpine.rimRadius must be greater than basinRadius');
  if (outerBlendStart <= rimRadius) problems.push('terrain.alpine.outerBlendStart must be greater than rimRadius');
  if (outerRadius <= outerBlendStart) problems.push('terrain.alpine.outerRadius must be greater than outerBlendStart');

  for (const name of ['basinHeight', 'basinRelief', 'rimHeight', 'detailAmplitude', 'treeLine']) {
    number(alpine[name], `terrain.alpine.${name}`, problems, { min: 0 });
  }
  for (const name of ['rimWidth', 'detailScale', 'refineRadius', 'treeClearRadius']) {
    number(alpine[name], `terrain.alpine.${name}`, problems, { min: 0, exclusiveMin: true });
  }
  number(alpine.angularVariation, 'terrain.alpine.angularVariation', problems, { min: 0, max: 0.75 });
  number(alpine.angularPhase, 'terrain.alpine.angularPhase', problems);
  integer(alpine.angularPeaks, 'terrain.alpine.angularPeaks', problems, { min: 2, max: 12 });
  integer(alpine.detailOctaves, 'terrain.alpine.detailOctaves', problems, { min: 1, max: 6 });
  integer(alpine.seed, 'terrain.alpine.seed', problems, { min: 0, max: 4294967295 });
  integer(alpine.refinePasses, 'terrain.alpine.refinePasses', problems, { min: 0, max: 2 });
  if (Number(alpine.refineRadius) < outerRadius) problems.push('terrain.alpine.refineRadius must cover outerRadius');
  if (Number(alpine.treeClearRadius) < outerRadius) problems.push('terrain.alpine.treeClearRadius must cover outerRadius');

  const route = alpine.route;
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    problems.push('terrain.alpine.route must be an object');
  } else {
    if (typeof route.name !== 'string' || route.name.length === 0) problems.push('terrain.alpine.route.name must be set');
    number(route.width, 'terrain.alpine.route.width', problems, { min: 0, exclusiveMin: true });
    number(route.terrainWidth, 'terrain.alpine.route.terrainWidth', problems, { min: 0, exclusiveMin: true });
    number(route.maxGrade, 'terrain.alpine.route.maxGrade', problems, { min: 0, exclusiveMin: true });
    if (!Array.isArray(route.points) || route.points.length < 2) problems.push('terrain.alpine.route.points must contain at least two points');
    else route.points.forEach((point, index) => point2(point, `terrain.alpine.route.points[${index}]`, problems));
    if (Number(route.terrainWidth) <= Number(route.width)) problems.push('terrain.alpine.route.terrainWidth must be greater than width');
  }

  if (problems.length > 0) {
    throw new Error(`Alpine configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}
