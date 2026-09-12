import * as THREE from 'three/webgpu';
import { createSeededRandom } from '../core/math.js';
import { coastX, resolveCoastConfig, sampleCoastField } from './CoastField.js';

export function createBeachScatter(terrain, seaConfig) {
  const group = new THREE.Group();
  group.name = 'Beach debris';
  if (!seaConfig?.enabled) return group;

  const sea = resolveCoastConfig(seaConfig);
  const params = sea.coast.scatter;
  const random = createSeededRandom(params.seed);
  const records = [[], [], []];
  for (let i = 0; i < Math.floor(params.attempts); i += 1) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 4, terrain.bounds.max.z - 4, random());
    const inland = THREE.MathUtils.lerp(params.inlandMin, params.inlandMax, random());
    const x = coastX(z, sea) - inland;
    if (x < terrain.bounds.min.x + 2 || x > terrain.bounds.max.x - 2) continue;
    const field = sampleCoastField(x, z, 0, sea);
    const patch = Math.sin(x * params.patchFrequencyX + Math.sin(z * params.patchWarpFrequency))
      * Math.sin(z * params.patchFrequencyZ) * 0.5 + 0.5;
    if (random() > field.scatterSuitability * patch * params.density) continue;
    if (field.waterCoverage > 0.001) continue;
    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y <= sea.level + 0.2) continue;
    const normal = new THREE.Vector3(
      terrain.sampleHeight(x - 0.2, z) - terrain.sampleHeight(x + 0.2, z),
      0.4,
      terrain.sampleHeight(x, z - 0.2) - terrain.sampleHeight(x, z + 0.2),
    ).normalize();
    if (normal.y < params.minNormalY) continue;
    records[Math.floor(random() * 3)].push({
      x,
      y,
      z,
      normal,
      size: THREE.MathUtils.lerp(params.sizeMin, params.sizeMax, random()),
      yaw: random() * Math.PI * 2,
    });
  }

  const geometries = [
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.SphereGeometry(1, 8, 4),
    new THREE.CylinderGeometry(0.08, 0.13, 2, 5),
  ];
  geometries[2].rotateZ(Math.PI / 2);
  const colors = [params.pebbleColor, params.shellColor, params.twigColor];
  const object = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0);
  records.forEach((items, kind) => {
    const material = new THREE.MeshStandardMaterial({ color: colors[kind], roughness: params.roughness });
    const mesh = new THREE.InstancedMesh(geometries[kind], material, items.length);
    mesh.name = ['Beach pebbles', 'Beach shells', 'Washed twigs'][kind];
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    items.forEach((item, index) => {
      object.position.set(item.x, item.y + item.size * 0.08, item.z);
      object.quaternion.setFromUnitVectors(up, item.normal);
      object.rotateY(item.yaw);
      object.scale.set(
        item.size * (kind === 2 ? 3 : 1),
        item.size * (kind === 2 ? 1 : 0.3),
        item.size * 0.7,
      );
      object.updateMatrix();
      mesh.setMatrixAt(index, object.matrix);
    });
    mesh.computeBoundingSphere();
    group.add(mesh);
  });
  return group;
}

export function disposeBeachScatter(group) {
  group.removeFromParent();
  group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
}
