export function validateVegetationLodConfig(config, problems) {
  if (!config.vegetationLod?.enabled) return;
  const positive = (value, path) => {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${path} must be positive and finite`);
  };
  const lod = config.trees?.lod;
  if (!lod) { problems.push('trees.lod is required'); return; }
  if (!Array.isArray(lod.distances) || lod.distances.length !== 3
    || lod.distances.some((v, i, a) => !Number.isFinite(v) || v <= (a[i - 1] ?? 0))) {
    problems.push('trees.lod.distances must contain three increasing positive distances');
  }
  if (!(lod.blend > 0 && lod.blend < 0.5)) problems.push('trees.lod.blend must be between 0 and 0.5');
  positive(lod.referenceHeight, 'trees.lod.referenceHeight'); positive(lod.chunkSize, 'trees.lod.chunkSize');
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
