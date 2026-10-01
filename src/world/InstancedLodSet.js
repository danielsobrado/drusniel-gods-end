import * as THREE from 'three/webgpu';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

// Small scattered props (lake plants, lily pads, starfish) in a few hundred to
// a few thousand instances: one instanced mesh per level of detail, and each
// instance sits in the level its distance calls for. Instances are only
// re-bucketed after the camera has moved a few metres, so a frame usually
// does nothing; beyond the last level's distance nothing is drawn. Empty
// levels draw nothing (see skipEmptyDraws).
//
// `levels` is [{ geometry, maxDistance }, ...], nearest first.
// `records` are { matrix: Matrix4, position: Vector3, ...extra } where extra
// per-instance values go to `attributes`: { name: { itemSize, read(record, out) } }.
export class InstancedLodSet {
  constructor({ scene, parent = scene, name, levels, material, records, attributes = {}, renderOrder = 0,
    castShadow = false, receiveShadow = true, rebucketDistance = 6 }) {
    this.records = records;
    this.levels = levels;
    this.attributes = attributes;
    this.rebucketDistance = rebucketDistance;
    this.lastCamera = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.maxDistance = levels.at(-1).maxDistance;
    this.bounds = new THREE.Box3();
    for (const record of records) this.bounds.expandByPoint(record.position);
    this.bounds.expandByScalar(2);
    this.meshes = levels.map(({ geometry }, index) => {
      const capacity = Math.max(1, records.length);
      const levelGeometry = geometry.clone();
      for (const [key, { itemSize }] of Object.entries(attributes)) {
        levelGeometry.setAttribute(key, new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize));
      }
      const mesh = adoptInstanceMatrices(new THREE.InstancedMesh(levelGeometry, material, capacity));
      mesh.name = `${name}:${index}`;
      mesh.count = 0;
      mesh.renderOrder = renderOrder;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.frustumCulled = true;
      mesh.userData.excludeFromReflection = true;
      parent.add(mesh);
      return mesh;
    });
    this.scratch = new Float32Array(4);
  }

  get instanceCount() {
    return this.records.length;
  }

  update(camera) {
    const position = camera.position;
    if (position.distanceToSquared(this.lastCamera) < this.rebucketDistance ** 2) return;
    this.lastCamera.copy(position);
    // Far from every record: clear once and stop.
    if (this.bounds.distanceToPoint(position) > this.maxDistance) {
      for (const mesh of this.meshes) mesh.count = 0;
      return;
    }
    const counts = this.meshes.map(() => 0);
    const spheres = this.meshes.map(() => new THREE.Box3());
    for (const record of this.records) {
      const distance = record.position.distanceTo(position);
      const level = this.levels.findIndex(entry => distance < entry.maxDistance);
      if (level < 0) continue;
      const mesh = this.meshes[level];
      const index = counts[level]++;
      mesh.setMatrixAt(index, record.matrix);
      for (const [key, { itemSize, read }] of Object.entries(this.attributes)) {
        read(record, this.scratch);
        const attribute = mesh.geometry.attributes[key];
        for (let c = 0; c < itemSize; c += 1) attribute.array[index * itemSize + c] = this.scratch[c];
      }
      spheres[level].expandByPoint(record.position);
    }
    this.meshes.forEach((mesh, level) => {
      mesh.count = counts[level];
      if (!counts[level]) return;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, counts[level] * 16);
      mesh.instanceMatrix.needsUpdate = true;
      for (const [key, { itemSize }] of Object.entries(this.attributes)) {
        const attribute = mesh.geometry.attributes[key];
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, counts[level] * itemSize);
        attribute.needsUpdate = true;
      }
      // Bounds over this level's instances (plus the plants' own size) so the
      // whole level culls when out of view.
      mesh.boundingSphere ??= new THREE.Sphere();
      spheres[level].expandByScalar(3).getBoundingSphere(mesh.boundingSphere);
    });
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
  }
}
