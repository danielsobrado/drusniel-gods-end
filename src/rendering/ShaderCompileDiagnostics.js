export const SHADER_COMPILE_START_EVENT = 'grass:shader-compile-start';
export const SHADER_COMPILE_END_EVENT = 'grass:shader-compile-end';

const CATEGORY_ORDER = Object.freeze([
  'terrain',
  'vegetation',
  'water',
  'character',
  'weather',
  'props',
  'other',
]);

const CATEGORY_LABELS = Object.freeze({
  terrain: 'Terrain',
  vegetation: 'Vegetation',
  water: 'Water',
  character: 'Character',
  weather: 'Weather / VFX',
  props: 'Props',
  other: 'Other',
});

const CATEGORY_PATTERNS = Object.freeze({
  terrain: /terrain|landscape|ground|beach|coast|snow/i,
  vegetation: /grass|tree|leaf|foliage|meadow|understory|shrub|cactus|wild/i,
  water: /water|river|sea|lake|ocean|foam/i,
  character: /player|character|drusniel|enanillo|paladin|armature|skeleton/i,
  weather: /rain|cloud|sky|powder|bird|wind|particle/i,
  props: /rock|stone|lantern|prop|biome/i,
});

function materialsOf(object) {
  if (!object?.material) return [];
  return Array.isArray(object.material) ? object.material.filter(Boolean) : [object.material];
}

function isRenderable(object) {
  return Boolean(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite);
}

function classifyObject(object) {
  const materials = materialsOf(object);
  const haystack = [
    object?.name,
    object?.type,
    ...materials.flatMap((material) => [material?.name, material?.type]),
  ].filter(Boolean).join(' ');
  for (const category of CATEGORY_ORDER) {
    const pattern = CATEGORY_PATTERNS[category];
    if (pattern?.test(haystack)) return category;
  }
  return 'other';
}

function materialDescriptor(material) {
  return material?.name || material?.type || 'Unnamed material';
}

export function collectShaderCompileDiagnostics(scene) {
  const uniqueMaterials = new Map();
  const materialTypes = new Map();
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, {
    id: category,
    label: CATEGORY_LABELS[category],
    renderables: 0,
    materialIds: new Set(),
  }]));
  const samples = [];
  let renderables = 0;

  scene?.traverseVisible?.((object) => {
    if (!isRenderable(object)) return;
    const materials = materialsOf(object);
    if (materials.length === 0) return;
    renderables += 1;
    const category = classifyObject(object);
    categories[category].renderables += 1;

    for (const material of materials) {
      const id = material.uuid ?? `${material.type}:${materialDescriptor(material)}`;
      categories[category].materialIds.add(id);
      if (!uniqueMaterials.has(id)) {
        uniqueMaterials.set(id, material);
        const type = material.type || material.constructor?.name || 'Material';
        materialTypes.set(type, (materialTypes.get(type) ?? 0) + 1);
        if (samples.length < 16) {
          samples.push({
            category: CATEGORY_LABELS[category],
            object: object.name || object.type || 'Object',
            material: materialDescriptor(material),
            type,
          });
        }
      }
    }
  });

  const categorySummary = CATEGORY_ORDER
    .map((category) => categories[category])
    .filter((entry) => entry.renderables > 0)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      renderables: entry.renderables,
      materials: entry.materialIds.size,
    }));
  const materialTypeSummary = [...materialTypes.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    renderables,
    materials: uniqueMaterials.size,
    categories: categorySummary,
    materialTypes: materialTypeSummary,
    samples,
  };
}

export function formatShaderCompileCategories(diagnostics, limit = 4) {
  return diagnostics.categories
    .slice()
    .sort((a, b) => b.materials - a.materials || b.renderables - a.renderables)
    .slice(0, limit)
    .map((entry) => `${entry.label} ${entry.materials}`)
    .join(' · ');
}

export function formatShaderMaterialTypes(diagnostics, limit = 3) {
  return diagnostics.materialTypes
    .slice(0, limit)
    .map((entry) => `${entry.type} ×${entry.count}`)
    .join(' · ');
}
