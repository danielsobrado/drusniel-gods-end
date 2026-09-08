import * as THREE from 'three';

export const ROCK_MESH_PATTERN = /^SM_Rocks_\d+/i;
export const DEFAULT_STONE_PACK_SCALE = 7;
export const DEFAULT_PEBBLE_MAX_SIZE = 0.8;
export const DEFAULT_PEBBLE_PATTERN = /^SM_Rocks_(06|07|10|11)(_|$)/i;
export const ROCK_PACK_ROOT_NAMES = new Set(['Sketchfab_model', 'Rocks_Stylized']);

export function isRockMesh(object) {
  return Boolean(object?.isMesh && ROCK_MESH_PATTERN.test(object.name ?? ''));
}

export function collectRockMeshes(root) {
  const meshes = [];
  root?.traverse((object) => {
    if (isRockMesh(object)) meshes.push(object);
  });
  meshes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return meshes;
}

export function hideRockPack(meshes) {
  for (const mesh of meshes) {
    mesh.visible = false;
    let current = mesh.parent;
    while (current) {
      if (ROCK_PACK_ROOT_NAMES.has(current.name)) {
        current.visible = false;
        break;
      }
      current = current.parent;
    }
  }
}

export function rockMaxSize(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  return Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
}

export function isPebbleSize(maxSize, pebbleMaxSize = DEFAULT_PEBBLE_MAX_SIZE) {
  return maxSize <= pebbleMaxSize;
}

export function isPebbleMesh(name, maxSize, pebbleMaxSize = DEFAULT_PEBBLE_MAX_SIZE) {
  if (DEFAULT_PEBBLE_PATTERN.test(name ?? '')) return true;
  if (ROCK_MESH_PATTERN.test(name ?? '')) return false;
  return isPebbleSize(maxSize, pebbleMaxSize);
}

export function bakeRockTemplate(source) {
  source.updateWorldMatrix(true, false);
  const geometry = source.geometry.clone();
  geometry.applyMatrix4(source.matrixWorld);
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const embed = (max.y - min.y) * 0.08;
  geometry.translate(-(min.x + max.x) * 0.5, -min.y - embed, -(min.z + max.z) * 0.5);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = Array.isArray(source.material) ? source.material[0] : source.material;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = source.name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.rainRoughness = source.userData.rainRoughness;
  return mesh;
}

export function scaleRockTemplate(template, scale) {
  if (scale === 1) return template;
  template.geometry.scale(scale, scale, scale);
  template.geometry.computeBoundingBox();
  template.geometry.computeBoundingSphere();
  return template;
}

export function classifyRockTemplates(templates, pebbleMaxSize = DEFAULT_PEBBLE_MAX_SIZE) {
  const stones = [];
  const pebbles = [];
  for (const template of templates) {
    (isPebbleMesh(template.name, rockMaxSize(template.geometry), pebbleMaxSize) ? pebbles : stones).push(template);
  }
  return { stones, pebbles };
}
