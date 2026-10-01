import { LOD_ORDER } from './GrassFieldLayout.js';

// Blade templates are fans of `detail` segments: GrassGeometry builds
// 2 * detail - 1 triangles, so detail is the segmentation knob and density the
// population knob. They are tuned independently, but neither may grow with
// distance or a nearer band would look cheaper than the one behind it.
export const MAX_GRASS_DETAIL = 8;

export function grassTrianglesPerBlade(detail) {
  return Math.max(1, Math.round(detail)) * 2 - 1;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function validateGrassLodBands(lod, path, problems) {
  if (typeof lod !== 'object' || lod === null) {
    problems.push(`${path} is missing or not an object`);
    return problems;
  }

  let previousDistance = 0;
  let previousDetail = Infinity;
  let previousDensity = Infinity;

  for (const name of LOD_ORDER) {
    const band = lod[name];
    const bandPath = `${path}.${name}`;
    if (typeof band !== 'object' || band === null) {
      problems.push(`${bandPath} is missing or not an object`);
      return problems;
    }

    const { detail, density, distance } = band;
    if (!positiveInteger(detail) || detail > MAX_GRASS_DETAIL) {
      problems.push(`${bandPath}.detail must be an integer between 1 and ${MAX_GRASS_DETAIL}`);
    } else if (detail > previousDetail) {
      problems.push(`${bandPath}.detail (${detail}) exceeds the nearer band's ${previousDetail}`);
    } else previousDetail = detail;

    if (!(Number.isFinite(density) && density > 0)) {
      problems.push(`${bandPath}.density must be a positive number`);
    } else if (density > previousDensity) {
      problems.push(`${bandPath}.density (${density}) exceeds the nearer band's ${previousDensity}`);
    } else previousDensity = density;

    // Distances are fractions of the profile's maxDistance.
    if (!(Number.isFinite(distance) && distance > 0 && distance <= 1)) {
      problems.push(`${bandPath}.distance must be greater than 0 and at most 1`);
    } else if (distance <= previousDistance) {
      problems.push(`${bandPath}.distance (${distance}) must exceed the nearer band's ${previousDistance}`);
    } else previousDistance = distance;
  }

  const last = lod[LOD_ORDER.at(-1)];
  if (last && last.distance !== 1) {
    problems.push(`${path}.${LOD_ORDER.at(-1)}.distance must be 1 so the bands reach maxDistance`);
  }
  return problems;
}

export function validateGrassQualityLod(config, problems) {
  for (const [name, profile] of Object.entries(config.quality ?? {})) {
    for (const family of ['blade', 'billboard']) {
      const settings = profile?.[family];
      if (typeof settings !== 'object' || settings === null) continue;
      if (!(Number.isFinite(settings.maxDistance) && settings.maxDistance > 0)) {
        problems.push(`quality.${name}.${family}.maxDistance must be a positive number`);
      }
      validateGrassLodBands(settings.lod, `quality.${name}.${family}.lod`, problems);
    }
  }
  return problems;
}
