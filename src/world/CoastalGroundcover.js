import * as THREE from 'three/webgpu';
import { createSeededRandom } from '../core/math.js';
import { coastX, resolveCoastConfig, sampleCoastField } from './CoastField.js';

const QUALITY_KEYS = Object.freeze({
  performance: 'qualityPerformance',
  balanced: 'qualityBalanced',
  high: 'qualityHigh',
  ultra: 'qualityUltra',
});

function createLeafGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    -0.45, 0.015, 0.45,
    0, 0.025, 1,
    0.45, 0.015, 0.45,
    0, 0, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  geometry.computeBoundingSphere();
  return geometry;
}

function sampleNormal(terrain, x, z) {
  const step = 0.35;
  const left = terrain.sampleHeight(x - step, z);
  const right = terrain.sampleHeight(x + step, z);
  const back = terrain.sampleHeight(x, z - step);
  const front = terrain.sampleHeight(x, z + step);
  return new THREE.Vector3(left - right, step * 2, back - front).normalize();
}

export function createCoastalGroundcover(terrain, seaConfig, initialQuality = 'high') {
  const group = new THREE.Group();
  group.name = 'Coastal groundcover';
  if (!seaConfig?.enabled) return group;

  const sea = resolveCoastConfig(seaConfig);
  const params = sea.coast.vegetation;
  const random = createSeededRandom(params.seed);
  const maxPatches = Math.floor(params.maxPatches);
  const records = [];
  const patchEnds = [];
  const attempts = Math.max(maxPatches * 12, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const object = new THREE.Object3D();

  for (let attempt = 0; attempt < attempts && patchEnds.length < maxPatches; attempt += 1) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 4, terrain.bounds.max.z - 4, random());
    const inland = THREE.MathUtils.lerp(params.groundcoverStart, params.groundcoverEnd, random());
    const x = coastX(z, sea) - inland;
    if (x <= terrain.bounds.min.x + 2 || x >= terrain.bounds.max.x - 2) continue;
    const field = sampleCoastField(x, z, 0, sea, 0);
    if (random() > field.groundcoverSuitability) continue;
    if (field.waterCoverage > 0.001 || field.oceanDepth > 0) continue;

    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y <= sea.level + 0.2) continue;
    const normal = sampleNormal(terrain, x, z);
    const slope = Math.hypot(normal.x, normal.z) / Math.max(normal.y, 0.0001);
    if (slope > params.maxSlope) continue;

    const clumps = Math.round(THREE.MathUtils.lerp(params.minClumps, params.maxClumps, random()));
    for (let clump = 0; clump < clumps; clump += 1) {
      const radius = random() * 0.42;
      const angle = random() * Math.PI * 2;
      const size = THREE.MathUtils.lerp(params.sizeMin, params.sizeMax, random());
      object.position.set(x + Math.cos(angle) * radius, y + 0.025, z + Math.sin(angle) * radius);
      object.quaternion.setFromUnitVectors(up, normal);
      object.rotateY(random() * Math.PI * 2);
      object.scale.set(size * (0.7 + random() * 0.45), size, size * (0.85 + random() * 0.35));
      object.updateMatrix();
      records.push(object.matrix.clone());
    }
    patchEnds.push(records.length);
  }

  const geometry = createLeafGeometry();
  const material = new THREE.MeshStandardMaterial({
    color: params.color,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, records.length);
  mesh.name = 'Creeping coastal leaves';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  for (let index = 0; index < records.length; index += 1) mesh.setMatrixAt(index, records[index]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  group.add(mesh);

  const setQuality = (quality) => {
    const key = QUALITY_KEYS[quality] ?? QUALITY_KEYS.high;
    const fraction = THREE.MathUtils.clamp(params[key], 0, 1);
    const patchCount = Math.min(patchEnds.length, Math.ceil(patchEnds.length * fraction));
    mesh.count = patchCount === 0 ? 0 : patchEnds[patchCount - 1];
    group.userData.stats = { patches: patchCount, clumps: mesh.count, maximumPatches: patchEnds.length };
  };
  group.userData.setQuality = setQuality;
  group.userData.stats = { patches: 0, clumps: 0, maximumPatches: patchEnds.length };
  setQuality(initialQuality);
  return group;
}

export function disposeCoastalGroundcover(group) {
  group.removeFromParent();
  const disposedGeometry = new Set();
  const disposedMaterial = new Set();
  group.traverse((object) => {
    if (object.geometry && !disposedGeometry.has(object.geometry)) {
      disposedGeometry.add(object.geometry);
      object.geometry.dispose();
    }
    if (object.material && !disposedMaterial.has(object.material)) {
      disposedMaterial.add(object.material);
      object.material.dispose();
    }
  });
}
