const TREE_PART_PATTERN = /^trees\/tree(\d+)$/;

export function resolveTerrainStreamGroups(config) {
  const settings = config.assets?.terrainStreaming;
  if (!settings?.enabled) return [];

  return Object.entries(settings.groups ?? {}).map(([name, group]) => ({
    name,
    parts: Array.isArray(group?.parts) ? [...group.parts] : [],
    center: Array.isArray(group?.center) ? [Number(group.center[0]), Number(group.center[1])] : null,
    radius: Number(group?.radius) || 0,
    preloadDistance: Number(group?.preloadDistance) || 0,
    loaded: false,
    loading: false,
    failed: false,
  }));
}

export function splitTerrainSources(sources, config) {
  const groups = resolveTerrainStreamGroups(config);
  if (groups.length === 0) return { immediate: sources, deferredGroups: [] };

  const owner = new Map();
  for (const group of groups) {
    for (const part of group.parts) owner.set(part, group);
  }

  const immediate = [];
  const deferred = new Map(groups.map((group) => [group.name, { ...group, sources: [] }]));
  for (const source of sources) {
    const group = owner.get(source.name);
    if (!group) {
      immediate.push(source);
      continue;
    }
    deferred.get(group.name).sources.push(source);
  }

  return {
    immediate,
    deferredGroups: [...deferred.values()].filter((group) => group.sources.length > 0),
  };
}

export function terrainGroupContainsPreloadPosition(position, group) {
  if (!position || !group?.center) return false;
  const [x, z] = group.center;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const distance = Math.max(0, group.radius) + Math.max(0, group.preloadDistance);
  const dx = Number(position.x) - x;
  const dz = Number(position.z) - z;
  return Number.isFinite(dx) && Number.isFinite(dz) && dx * dx + dz * dz <= distance * distance;
}

export function shouldPreloadTerrainGroup(position, group) {
  return !group?.loaded && !group?.loading && !group?.failed
    && terrainGroupContainsPreloadPosition(position, group);
}

export function streamedTreeTypeIndices(group) {
  const indices = [];
  for (const part of group?.parts ?? []) {
    const match = TREE_PART_PATTERN.exec(part);
    if (!match) continue;
    const typeIndex = Number(match[1]) - 1;
    if (typeIndex >= 0) indices.push(typeIndex);
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}
