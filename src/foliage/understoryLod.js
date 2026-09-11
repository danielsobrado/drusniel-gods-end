// The overlap leaves room for camera movement between CPU partition updates.
// Pixel coverage is evaluated every frame by the two materials.
export class UnderstoryLod {
  constructor(capacity) {
    this.near = new Uint32Array(capacity);
    this.far = new Uint32Array(capacity);
    this.nearCount = 0;
    this.farCount = 0;
  }

  partition(origins, count, camera, start, end, padding = 2) {
    this.nearCount = this.farCount = 0;
    const nearLimit = (end + padding) ** 2;
    const farLimit = Math.max(0, start - padding) ** 2;
    for (let i = 0; i < count; i++) {
      const distance = (origins[i * 3] - camera.x) ** 2 + (origins[i * 3 + 2] - camera.z) ** 2;
      if (distance <= nearLimit) this.near[this.nearCount++] = i;
      if (distance >= farLimit) this.far[this.farCount++] = i;
    }
    return this;
  }
}
