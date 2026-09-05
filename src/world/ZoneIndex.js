import * as THREE from 'three';

export class ZoneIndex {
  constructor(root, config) {
    this.zones = new Map();
    this.localPoint = new THREE.Vector3();
    if (!root) return;

    for (const [key, name] of Object.entries(config.zones ?? {})) {
      const group = root.getObjectByName(name);
      if (!group) continue;
      const meshes = [];
      group.traverse((object) => {
        if (!object.isMesh || !object.geometry) return;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (!object.geometry.boundingBox?.isEmpty()) meshes.push(object);
        object.visible = false;
      });
      group.visible = false;
      this.zones.set(key, meshes);
    }
  }

  getZone(position) {
    for (const [key, meshes] of this.zones.entries()) {
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, true);
        this.localPoint.copy(position);
        mesh.worldToLocal(this.localPoint);
        if (mesh.geometry.boundingBox.containsPoint(this.localPoint)) return key;
      }
    }
    return null;
  }
}
