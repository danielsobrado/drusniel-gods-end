import * as THREE from 'three/webgpu';

const DEFAULT_LOW_TREE_SETTINGS = Object.freeze({
  foliageKeepRatio: 0.62,
  grid: Object.freeze([3, 5, 3]),
  minComponents: 12,
  maxComponentShare: 0.12,
});

function resolveSettings(settings = {}) {
  const grid = Array.isArray(settings.grid) && settings.grid.length === 3
    ? settings.grid.map(value => Math.max(1, Math.floor(Number(value) || 1)))
    : [...DEFAULT_LOW_TREE_SETTINGS.grid];
  return {
    foliageKeepRatio: THREE.MathUtils.clamp(
      Number(settings.foliageKeepRatio) || DEFAULT_LOW_TREE_SETTINGS.foliageKeepRatio,
      0.05,
      1,
    ),
    grid,
    minComponents: Math.max(1, Math.floor(Number(settings.minComponents)
      || DEFAULT_LOW_TREE_SETTINGS.minComponents)),
    maxComponentShare: THREE.MathUtils.clamp(
      Number(settings.maxComponentShare) || DEFAULT_LOW_TREE_SETTINGS.maxComponentShare,
      0.01,
      1,
    ),
  };
}

function findRoot(parent, index) {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  while (parent[index] !== index) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}

function union(parent, rank, a, b) {
  let rootA = findRoot(parent, a), rootB = findRoot(parent, b);
  if (rootA === rootB) return;
  if (rank[rootA] < rank[rootB]) [rootA, rootB] = [rootB, rootA];
  parent[rootB] = rootA;
  if (rank[rootA] === rank[rootB]) rank[rootA] += 1;
}

function componentHash(center) {
  let hash = 2166136261;
  for (const value of center) hash = Math.imul(hash ^ Math.round(value * 1000), 16777619);
  return hash >>> 0;
}

function bucketCoordinate(value, min, max, size) {
  const normalized = (value - min) / Math.max(max - min, 1e-6);
  return Math.min(size - 1, Math.max(0, Math.floor(normalized * size)));
}

function reducedIndices(source, position, settings) {
  if (source.length < 6 || source.length % 3 !== 0) return null;
  const parent = new Int32Array(position.count).fill(-1);
  const rank = new Uint8Array(position.count);
  const activate = index => { if (parent[index] < 0) parent[index] = index; };

  for (let i = 0; i < source.length; i += 3) {
    const a = source[i], b = source[i + 1], c = source[i + 2];
    activate(a); activate(b); activate(c);
    union(parent, rank, a, b); union(parent, rank, b, c);
  }

  const point = new THREE.Vector3(), groups = new Map();
  for (let i = 0; i < source.length; i += 3) {
    const root = findRoot(parent, source[i]);
    let group = groups.get(root);
    if (!group) {
      group = { root, triangles: 0, sum: new THREE.Vector3(), samples: 0 };
      groups.set(root, group);
    }
    group.triangles += 1;
    for (let corner = 0; corner < 3; corner += 1) {
      point.fromBufferAttribute(position, source[i + corner]);
      group.sum.add(point);
      group.samples += 1;
    }
  }

  const components = [...groups.values()].map(group => ({
    ...group,
    center: group.sum.multiplyScalar(1 / group.samples),
  }));
  const triangleCount = source.length / 3;
  if (components.length < settings.minComponents
    || Math.max(...components.map(component => component.triangles)) / triangleCount > settings.maxComponentShare) {
    return null;
  }

  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const component of components) {
    min.min(component.center);
    max.max(component.center);
  }

  const buckets = new Map();
  for (const component of components) {
    const center = component.center;
    const cell = [
      bucketCoordinate(center.x, min.x, max.x, settings.grid[0]),
      bucketCoordinate(center.y, min.y, max.y, settings.grid[1]),
      bucketCoordinate(center.z, min.z, max.z, settings.grid[2]),
    ].join(',');
    const bucket = buckets.get(cell) ?? [];
    bucket.push(component);
    buckets.set(cell, bucket);
  }

  const selectedRoots = new Set();
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => componentHash(a.center.toArray()) - componentHash(b.center.toArray()));
    const keep = Math.max(1, Math.round(bucket.length * settings.foliageKeepRatio));
    for (let i = 0; i < keep; i += 1) selectedRoots.add(bucket[i].root);
  }

  const selected = [];
  for (let i = 0; i < source.length; i += 3) {
    if (!selectedRoots.has(findRoot(parent, source[i]))) continue;
    selected.push(source[i], source[i + 1], source[i + 2]);
  }
  return selected.length >= 3 && selected.length < source.length ? selected : null;
}

function materialsOf(material) {
  return Array.isArray(material) ? material : [material];
}

function isFoliageMaterial(material) {
  return Boolean(material) && (
    Number(material.alphaTest) > 0
    || material.alphaHash === true
    || material.transparent === true
  );
}

function groupsOf(geometry) {
  if (geometry.groups.length) return geometry.groups;
  return [{
    start: 0,
    count: geometry.index?.count ?? geometry.attributes.position.count,
    materialIndex: 0,
  }];
}

function groupIndices(geometry, group) {
  if (geometry.index) return geometry.index.array.subarray(group.start, group.start + group.count);
  return Uint32Array.from({ length: group.count }, (_, index) => group.start + index);
}

function createReducedGeometry(geometry, material, settings) {
  const position = geometry.attributes.position;
  if (!position) return geometry;
  const materials = materialsOf(material), output = [], outputGroups = [];
  let changed = false;

  for (const group of groupsOf(geometry)) {
    const source = groupIndices(geometry, group);
    const groupMaterial = materials[group.materialIndex] ?? materials[0];
    const reduced = isFoliageMaterial(groupMaterial) ? reducedIndices(source, position, settings) : null;
    const selected = reduced ?? source;
    changed ||= Boolean(reduced);
    const start = output.length;
    for (const index of selected) output.push(index);
    outputGroups.push({ start, count: selected.length, materialIndex: group.materialIndex ?? 0 });
  }
  if (!changed) return geometry;

  const IndexArray = position.count > 65535 ? Uint32Array : Uint16Array;
  const low = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) low.setAttribute(name, attribute);
  low.setIndex(new THREE.BufferAttribute(new IndexArray(output), 1));
  for (const group of outputGroups) low.addGroup(group.start, group.count, group.materialIndex);
  low.morphAttributes = geometry.morphAttributes;
  low.morphTargetsRelative = geometry.morphTargetsRelative;
  low.boundingBox = geometry.boundingBox?.clone() ?? null;
  low.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  low.name = geometry.name ? `${geometry.name}:Low` : 'TreeLow';
  return low;
}

export function createLowTreeParts(parts, settings = {}) {
  const resolved = resolveSettings(settings);
  const owned = [];
  const lowParts = parts.map(part => {
    const geometry = createReducedGeometry(part.geometry, part.material, resolved);
    if (geometry !== part.geometry) owned.push(geometry);
    return geometry === part.geometry ? part : { ...part, geometry };
  });
  return {
    parts: lowParts,
    dispose: () => {
      for (const geometry of owned.splice(0)) geometry.dispose();
    },
  };
}
