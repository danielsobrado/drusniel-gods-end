import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { classifyRockTemplates } from '../world/rockPack.js';
import { FAR_VIEWS, FAR_VIEW_SIZE, LEAF_CUTOFF, pendingProvenance, validateCatalog, validateProvenance } from './BiomeCatalog.js';
import { hullFromGeometry } from './convexHull.js';
import { configureBiomeAtlas } from './BiomeMaterial.js';

const PLANT_KINDS = ['cactus', 'shrubSmall', 'shrubLarge'];
const ROCK_KINDS = ['rockA', 'rockB'];

function meshNamed(root, name) {
  let found = null;
  root?.traverse((object) => {
    if (!found && object.name === name) found = object;
  });
  return found;
}

function bakeLod(source) {
  if (!source?.isMesh || !source.geometry) return null;
  const geometry = source.geometry.clone();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = Array.isArray(source.material) ? source.material[0] : source.material;
  return { geometry, material, height: Math.max(geometry.boundingBox?.max.y ?? 1, 0.01) };
}

function emptyFarAtlas() {
  const data = new Uint8Array(FAR_VIEW_SIZE * FAR_VIEWS * FAR_VIEW_SIZE * 4);
  const texture = new THREE.DataTexture(data, FAR_VIEW_SIZE * FAR_VIEWS, FAR_VIEW_SIZE);
  texture.needsUpdate = true;
  configureBiomeAtlas(texture);
  return {
    texture,
    views: FAR_VIEWS,
    tileSize: FAR_VIEW_SIZE,
    width: 1,
    height: 1,
    viewsReady: Array.from({ length: FAR_VIEWS }, (_, i) => i),
  };
}

export function createSyntheticCatalog() {
  const cactusNear = new THREE.CylinderGeometry(0.28, 0.38, 1, 8, 3);
  const cactusMid = new THREE.CylinderGeometry(0.28, 0.38, 1, 6, 1);
  const shrubNear = new THREE.ConeGeometry(0.35, 1, 6, 1);
  const shrubMid = new THREE.ConeGeometry(0.35, 1, 5, 1);
  const largeNear = new THREE.ConeGeometry(0.48, 1, 7, 1);
  const largeMid = new THREE.ConeGeometry(0.48, 1, 6, 1);
  const rockNear = new THREE.DodecahedronGeometry(0.45, 0);
  const rockMid = new THREE.DodecahedronGeometry(0.45, 0);
  const color = new THREE.DataTexture(new Uint8Array(1024 * 1024 * 4).fill(160), 1024, 1024);
  color.needsUpdate = true;
  configureBiomeAtlas(color);
  const far = emptyFarAtlas();
  const cactus = {
    near: { geometry: cactusNear, height: 1 },
    mid: { geometry: cactusMid, height: 1 },
    far,
    hull: hullFromGeometry(cactusNear),
    radius: 0.55,
    color,
  };
  const shrubSmall = {
    near: { geometry: shrubNear, height: 1 },
    mid: { geometry: shrubMid, height: 1 },
    far,
    radius: 0.4,
    atlas: color,
  };
  const shrubLarge = {
    near: { geometry: largeNear, height: 1 },
    mid: { geometry: largeMid, height: 1 },
    far,
    radius: 0.65,
    atlas: color,
  };
  const rockA = {
    near: { geometry: rockNear, height: 0.7 },
    mid: { geometry: rockMid, height: 0.7 },
    hull: hullFromGeometry(rockNear),
    radius: 0.85,
  };
  const rockB = {
    near: { geometry: rockNear.clone(), height: 0.8 },
    mid: { geometry: rockMid.clone(), height: 0.8 },
    hull: hullFromGeometry(rockNear),
    radius: 0.95,
  };
  return { cactus, shrubSmall, shrubLarge, rockA, rockB, synthetic: true, cutoff: LEAF_CUTOFF };
}

export async function loadBiomeCatalog({ config, stones = [], required = false, fallback = null } = {}) {
  const profile = config.biomes?.referenceScrub ?? {};
  let manifest = pendingProvenance();
  if (profile.manifest) {
    try {
      const response = await fetch(assetUrl(profile.manifest), { cache: 'no-store' });
      if (response.ok) manifest = await response.json();
    } catch {
      if (required) throw new Error('Biome provenance manifest failed to load.');
    }
  }
  const provenanceProblems = validateProvenance(manifest);
  if (provenanceProblems.length && required) throw new Error(provenanceProblems.join('; '));

  let catalog = fallback;
  if (profile.asset) {
    try {
      const gltf = await new GLTFLoader().loadAsync(assetUrl(profile.asset));
      catalog = catalogFromGltf(gltf.scene, stones);
      catalog.release = () => gltf.scene.traverse((object) => object.geometry?.dispose?.());
    } catch (error) {
      if (required) throw error;
    }
  }
  if (!catalog && stones.length >= 2) {
    catalog = catalogFromRocks(stones);
  }
  if (!catalog) return { missing: true, manifest, problems: provenanceProblems };
  catalog.manifest = manifest;
  const problems = [...provenanceProblems, ...validateCatalog(catalog)];
  catalog.problems = problems;
  if (problems.length && required) throw new Error(problems.join('; '));
  return catalog;
}

function catalogFromGltf(root, stones) {
  const catalog = {};
  for (const kind of PLANT_KINDS) {
    const near = bakeLod(meshNamed(root, `${kind}_near`) ?? meshNamed(root, kind));
    const mid = bakeLod(meshNamed(root, `${kind}_mid`)) ?? near;
    if (!near) continue;
    catalog[kind] = {
      near,
      mid,
      far: emptyFarAtlas(),
      hull: kind === 'cactus' ? hullFromGeometry(near.geometry) : null,
      radius: Math.max(near.geometry.boundingSphere?.radius ?? 0.5, 0.2),
      color: near.material?.map ?? null,
      atlas: near.material?.map ?? null,
      normal: near.material?.normalMap ?? null,
    };
    configureBiomeAtlas(catalog[kind].atlas);
    configureBiomeAtlas(catalog[kind].color);
  }
  const classified = classifyRockTemplates(stones);
  const rockTemplates = classified.stones.slice(0, 2);
  rockTemplates.forEach((template, index) => {
    const kind = ROCK_KINDS[index];
    catalog[kind] = {
      near: { geometry: template.geometry, material: template.material, height: template.geometry.boundingBox?.max.y ?? 1 },
      mid: { geometry: template.geometry, material: template.material, height: template.geometry.boundingBox?.max.y ?? 1 },
      hull: hullFromGeometry(template.geometry),
      radius: template.geometry.boundingSphere?.radius ?? 0.85,
    };
  });
  return catalog;
}

function catalogFromRocks(stones) {
  const catalog = createSyntheticCatalog();
  classifyRockTemplates(stones).stones.slice(0, 2).forEach((template, index) => {
    const kind = ROCK_KINDS[index];
    catalog[kind] = {
      near: { geometry: template.geometry, material: template.material, height: template.geometry.boundingBox?.max.y ?? 1 },
      mid: { geometry: template.geometry, material: template.material, height: template.geometry.boundingBox?.max.y ?? 1 },
      hull: hullFromGeometry(template.geometry),
      radius: template.geometry.boundingSphere?.radius ?? 0.85,
    };
  });
  return catalog;
}
