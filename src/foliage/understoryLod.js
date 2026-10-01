// The overlap leaves room for camera movement between CPU partition updates.
// Pixel coverage is evaluated every frame by the two materials.
export class UnderstoryLod {
  constructor(capacity) {
    this.near = new Uint32Array(capacity);
    this.far = new Uint32Array(capacity);
    this.nearCount = 0;
    this.farCount = 0;
  }

  partition(origins, count, camera, start, end, padding = 2, visibleIndices = null, visibleCount = count) {
    this.nearCount = this.farCount = 0;
    const nearLimit = (end + padding) ** 2;
    const farLimit = Math.max(0, start - padding) ** 2;
    const candidates = visibleIndices ? Math.min(visibleCount, visibleIndices.length) : count;
    for (let offset = 0; offset < candidates; offset += 1) {
      const index = visibleIndices ? visibleIndices[offset] : offset;
      if (index >= count) continue;
      const distance = (origins[index * 3] - camera.x) ** 2 + (origins[index * 3 + 2] - camera.z) ** 2;
      if (distance <= nearLimit) this.near[this.nearCount++] = index;
      if (distance >= farLimit) this.far[this.farCount++] = index;
    }
    return this;
  }
}
