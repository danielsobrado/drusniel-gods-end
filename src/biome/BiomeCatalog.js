export const ASSET_LIMITS = Object.freeze({
  cactus: Object.freeze({ near: 2400, mid: 600 }),
  shrubSmall: Object.freeze({ near: 190, mid: 96 }),
  shrubLarge: Object.freeze({ near: 276, mid: 140 }),
  rockA: Object.freeze({ near: 900, mid: 200 }),
  rockB: Object.freeze({ near: 900, mid: 200 }),
});

export const TEXTURE_LIMIT = 1024;
export const FAR_VIEW_SIZE = 128;
export const FAR_VIEWS = 8;
export const MAX_HULL_VERTICES = 32;
export const MAX_MAIN_BATCHES = 13;
export const MAX_SHADOW_BATCHES = 3;
export const LEAF_CUTOFF = 0.35;

export const MAIN_BATCHES = Object.freeze([
  'cactus:near', 'cactus:mid', 'cactus:far',
  'shrubSmall:near', 'shrubSmall:mid', 'shrubSmall:far',
  'shrubLarge:near', 'shrubLarge:mid', 'shrubLarge:far',
  'rockA:near', 'rockA:mid',
  'rockB:near', 'rockB:mid',
]);

export const SHADOW_BATCHES = Object.freeze(['cactus:near', 'rockA:near', 'rockB:near']);

function triangleCount(geometry) {
  if (!geometry) return 0;
  if (geometry.index) return geometry.index.count / 3;
  return (geometry.attributes?.position?.count ?? 0) / 3;
}

function textureSize(texture) {
  return Math.max(texture?.image?.width ?? texture?.source?.data?.width ?? 0,
    texture?.image?.height ?? texture?.source?.data?.height ?? 0);
}

export function pendingProvenance({ author = 'Drusniel Wilds', tool = 'pending Blender 4.5 export' } = {}) {
  return {
    generated: true,
    assetsPending: true,
    author,
    tool,
    license: 'original work; no third-party assets',
    rights: 'internally authored; CC0 or MIT required for any later download',
    files: [],
    scriptChecksum: null,
  };
}

export function validateProvenance(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['missing provenance manifest'];
  if (!manifest.author) problems.push('provenance is missing author');
  if (!manifest.tool) problems.push('provenance is missing tool');
  if (!manifest.license && !manifest.rights) problems.push('provenance is missing license/rights');
  if (manifest.invented === true) problems.push('provenance must not invent third-party attribution');
  return problems;
}

export function validateCatalog(catalog) {
  const problems = [];
  if (!catalog) return ['missing biome catalog'];
  for (const [kind, limits] of Object.entries(ASSET_LIMITS)) {
    const asset = catalog[kind];
    if (!asset) {
      problems.push(`missing ${kind} asset`);
      continue;
    }
    for (const lod of ['near', 'mid']) {
      const triangles = triangleCount(asset[lod]?.geometry);
      if (triangles > limits[lod]) problems.push(`${kind} ${lod} has ${triangles} triangles > ${limits[lod]}`);
    }
    if (kind === 'cactus' || kind.startsWith('shrub')) {
      const atlas = asset.far;
      if (atlas) {
        const views = atlas.views ?? FAR_VIEWS;
        const width = atlas.tileSize ?? FAR_VIEW_SIZE;
        const height = atlas.tileHeight ?? atlas.tileSize ?? FAR_VIEW_SIZE;
        if (views !== FAR_VIEWS) problems.push(`${kind} far atlas must declare 8 views`);
        if (width > FAR_VIEW_SIZE || height > FAR_VIEW_SIZE) {
          problems.push(`${kind} far view exceeds ${FAR_VIEW_SIZE}`);
        }
        if (atlas.viewsReady && atlas.viewsReady.length !== FAR_VIEWS) {
          problems.push(`${kind} far atlas must validate all eight views`);
        }
      }
    }
    for (const map of [asset.color, asset.normal, asset.atlas].filter(Boolean)) {
      const size = textureSize(map);
      if (size > TEXTURE_LIMIT) problems.push(`${kind} texture ${size} exceeds ${TEXTURE_LIMIT}`);
      if (size >= 4096) problems.push(`${kind} must not use runtime 4K textures`);
    }
    if (asset.hull && asset.hull.length / 3 > MAX_HULL_VERTICES) {
      problems.push(`${kind} hull has ${asset.hull.length / 3} vertices > ${MAX_HULL_VERTICES}`);
    }
  }
  if ((catalog.batches?.length ?? MAIN_BATCHES.length) > MAX_MAIN_BATCHES) {
    problems.push(`main batches exceed ${MAX_MAIN_BATCHES}`);
  }
  if ((catalog.shadowBatches?.length ?? SHADOW_BATCHES.length) > MAX_SHADOW_BATCHES) {
    problems.push(`shadow batches exceed ${MAX_SHADOW_BATCHES}`);
  }
  return problems;
}

