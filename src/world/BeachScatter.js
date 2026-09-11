import * as THREE from 'three/webgpu';
import { createSeededRandom } from '../core/math.js';
import { coastX } from './coast.js';
import { sampleCoastField } from './CoastField.js';

// Three small instanced batches across the whole coast. Debris never enters the
// active wash and has no collision: it is ground detail, not navigation geometry.
export function createBeachScatter(terrain, sea) {
  const group = new THREE.Group();
  group.name = 'Beach debris';
  if (!sea?.enabled) return group;
  const random = createSeededRandom(58103);
  const records = [[], [], []];
  for (let i = 0; i < 4500; i++) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 4, terrain.bounds.max.z - 4, random());
    const d = -22 - random() * 95;
    const x = coastX(z, sea.shoreX) + d;
    if (x < terrain.bounds.min.x + 2 || x > terrain.bounds.max.x - 2) continue;
    const field = sampleCoastField(x, z, 0, sea);
    const patch = Math.sin(x * 0.17 + Math.sin(z * 0.12)) * Math.sin(z * 0.23) * 0.5 + 0.5;
    if (random() > field.scatterSuitability * patch * 0.3) continue;
    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y <= sea.level + 0.2) continue;
    const normal = new THREE.Vector3(terrain.sampleHeight(x - 0.2, z) - terrain.sampleHeight(x + 0.2, z),
      0.4, terrain.sampleHeight(x, z - 0.2) - terrain.sampleHeight(x, z + 0.2)).normalize();
    if (normal.y < 0.9) continue;
    records[Math.floor(random() * 3)].push({ x, y, z, normal, size: 0.06 + random() * 0.13, yaw: random() * Math.PI * 2 });
  }
  const geometries = [new THREE.IcosahedronGeometry(1, 0), new THREE.SphereGeometry(1, 8, 4), new THREE.CylinderGeometry(0.08, 0.13, 2, 5)];
  geometries[2].rotateZ(Math.PI / 2);
  const colors = ['#625c4e', '#c9bea2', '#655341'];
  const object = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0);
  records.forEach((items, kind) => {
    const material = new THREE.MeshStandardMaterial({ color: colors[kind], roughness: 0.94 });
    const mesh = new THREE.InstancedMesh(geometries[kind], material, items.length);
    mesh.name = ['Beach pebbles', 'Beach shells', 'Washed twigs'][kind];
    mesh.receiveShadow = true;
    items.forEach((item, index) => {
      object.position.set(item.x, item.y + item.size * 0.08, item.z);
      object.quaternion.setFromUnitVectors(up, item.normal);
      object.rotateY(item.yaw);
      object.scale.set(item.size * (kind === 2 ? 3 : 1), item.size * (kind === 2 ? 1 : 0.3), item.size * 0.7);
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
  group.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
}
