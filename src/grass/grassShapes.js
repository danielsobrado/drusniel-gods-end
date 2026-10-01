// Grass silhouettes, split from the render family that draws them.
//
// `blade` and `billboard` are not cosmetic names: they are dict keys into
// config.grass.*, config.quality.*.*, wind.response.* and presets.*.grass.*,
// most of them read without a guard. Adding a silhouette as a new *type* would
// mean a matching block in every one of those namespaces plus a second compiled
// TSL material at startup. So a shape only names a profile and points at the
// family whose parameters, material, LOD and wind response it borrows.

export const GRASS_SHAPES = Object.freeze({
  slender: Object.freeze({ label: 'Slender', family: 'blade' }),
  reed: Object.freeze({ label: 'Reed', family: 'blade' }),
  broadleaf: Object.freeze({ label: 'Broadleaf', family: 'blade' }),
  tufted: Object.freeze({ label: 'Tufted', family: 'billboard' }),
});

export const DEFAULT_GRASS_SHAPE = 'slender';

// Half-width of the blade at height ratio r, before the bladeWidth uniform
// scales it at draw time. `widthScale` keeps each profile at a believable
// thickness without forcing per-shape preset values.
//
// Grass is fill-rate bound long before it is triangle bound: every shape here
// draws the same vertex count, so the only cost that varies is how many pixels
// a blade covers. That is the integral of width(r) times widthScale. Keep each
// shape within ~1.35x of slender's 0.50 -- broadleaf at widthScale 1.6 measured
// 2.51x and cost 44% frame time at the same triangle count.
export const GRASS_SHAPE_PROFILES = Object.freeze({
  slender: Object.freeze({ width: (r) => 1 - r, widthScale: 1 }),
  reed: Object.freeze({ width: (r) => 1 - r ** 5, widthScale: 0.55 }),
  broadleaf: Object.freeze({ width: (r) => Math.sqrt(Math.max(0, 1 - r * r)), widthScale: 0.85 }),
});

export function isGrassShape(shape) {
  return Object.hasOwn(GRASS_SHAPES, shape);
}

export function resolveGrassShape(grass) {
  if (isGrassShape(grass.shape)) return grass.shape;
  return grass.type === 'billboard' ? 'tufted' : DEFAULT_GRASS_SHAPE;
}

export function grassFamily(shape) {
  return GRASS_SHAPES[shape]?.family ?? GRASS_SHAPES[DEFAULT_GRASS_SHAPE].family;
}

export function grassShapeProfile(shape) {
  return GRASS_SHAPE_PROFILES[shape] ?? GRASS_SHAPE_PROFILES[DEFAULT_GRASS_SHAPE];
}
