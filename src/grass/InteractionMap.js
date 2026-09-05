import * as THREE from 'three';

export class InteractionMap {
  constructor(config, terrainSampler) {
    const interaction = config.grass.interaction;
    this.enabled = interaction.enabled !== false;
    this.resolution = interaction.resolution;
    this.worldSize = interaction.worldSize;
    this.halfSize = this.worldSize * 0.5;
    this.recoverySpeed = interaction.recoverySpeed;
    this.strength = interaction.strength;
    this.terrainSampler = terrainSampler;
    this.center = new THREE.Vector2();
    this.lastCenter = new THREE.Vector2();
    this.nextCenter = new THREE.Vector2();
    // High-water mark of the red channel. Math.floor is monotonic, so for any
    // pixel p <= peak, floor(p * r) <= floor(peak * r). Once floor(peak * r)
    // reaches 0 every pixel is 0, and floor(0 * r) = 0 -- the recovery pass is
    // bit-exact idempotent from then on, so skipping it changes nothing.
    this.peak = 0;
    this.pixels = new Uint8Array(this.resolution * this.resolution * 4);
    this.scrollPixels = new Uint8Array(this.pixels.length);
    this.#clearPixels(this.pixels);
    this.texture = new THREE.DataTexture(
      this.pixels,
      this.resolution,
      this.resolution,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  #clearPixels(buffer) {
    buffer.fill(0);
    for (let index = 3; index < buffer.length; index += 4) buffer[index] = 255;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  update(playerPosition, influencePoints = []) {
    const nextCenter = this.nextCenter.set(playerPosition.x, playerPosition.z);
    if (this.lastCenter.lengthSq() === 0) this.lastCenter.copy(nextCenter);
    this.#scroll(nextCenter.x - this.lastCenter.x, nextCenter.y - this.lastCenter.y);
    this.lastCenter.copy(nextCenter);
    this.center.copy(nextCenter);

    // Note: keyed on ink present, not on the enabled flag. Existing influence must keep
    // fading after Foot Interaction is switched off -- see the interaction
    // section of docs/visual-parity-checklist.md.
    const hadInk = this.peak > 0;
    this.#recover();

    let painted = false;
    if (this.enabled) {
      if (influencePoints.length === 0) {
        this.paintSphere(playerPosition.x, playerPosition.y, playerPosition.z, 0.72, this.strength);
      } else {
        for (const point of influencePoints) {
          this.paintSphere(point.position.x, point.position.y, point.position.z, point.radius, this.strength);
        }
      }
      painted = true;
    }

    // Skipping an upload of unchanged bytes is exact.
    if (hadInk || painted) this.texture.needsUpdate = true;
  }

  #recover() {
    if (this.peak === 0) return;
    for (let index = 0; index < this.pixels.length; index += 4) {
      this.pixels[index] = Math.floor(this.pixels[index] * this.recoverySpeed);
    }
    this.peak = Math.floor(this.peak * this.recoverySpeed);
  }

  // Test seams: the differential harness drives a reference implementation that
  // always does the full work, to prove the skips above are byte-exact.
  forceRecover() {
    for (let index = 0; index < this.pixels.length; index += 4) {
      this.pixels[index] = Math.floor(this.pixels[index] * this.recoverySpeed);
    }
    this.peak = Math.floor(this.peak * this.recoverySpeed);
  }

  forceScroll(deltaX, deltaZ) {
    this.#scrollPixels(deltaX, deltaZ);
  }

  #scroll(deltaX, deltaZ) {
    // Scroll only translates values. With an all-zero red channel the result is
    // identical to the input, since G/B are never written non-zero and alpha is
    // 255 in both #clearPixels and the scroll write.
    if (this.peak === 0) return;
    this.#scrollPixels(deltaX, deltaZ);
  }

  #scrollPixels(deltaX, deltaZ) {
    const pixelsPerWorldUnit = this.resolution / this.worldSize;
    const shiftX = Math.trunc(deltaX * pixelsPerWorldUnit);
    const shiftY = Math.trunc(deltaZ * pixelsPerWorldUnit);
    if (shiftX === 0 && shiftY === 0) return;

    this.#clearPixels(this.scrollPixels);
    for (let y = 0; y < this.resolution; y += 1) {
      const sourceY = y + shiftY;
      if (sourceY < 0 || sourceY >= this.resolution) continue;
      for (let x = 0; x < this.resolution; x += 1) {
        const sourceX = x + shiftX;
        if (sourceX < 0 || sourceX >= this.resolution) continue;
        const targetOffset = (y * this.resolution + x) * 4;
        const sourceOffset = (sourceY * this.resolution + sourceX) * 4;
        this.scrollPixels[targetOffset] = this.pixels[sourceOffset];
        this.scrollPixels[targetOffset + 3] = 255;
      }
    }
    this.pixels.set(this.scrollPixels);
  }

  paintSphere(x, y, z, radius, strength = 1) {
    const uvX = (x - this.center.x) / this.worldSize + 0.5;
    const uvY = (z - this.center.y) / this.worldSize + 0.5;
    const centerX = uvX * this.resolution;
    const centerY = uvY * this.resolution;
    const pixelRadius = Math.abs(radius * this.resolution / this.worldSize);
    if (pixelRadius < 0.5) return;

    const minX = Math.max(0, Math.floor(centerX - pixelRadius));
    const maxX = Math.min(this.resolution - 1, Math.ceil(centerX + pixelRadius));
    const minY = Math.max(0, Math.floor(centerY - pixelRadius));
    const maxY = Math.min(this.resolution - 1, Math.ceil(centerY + pixelRadius));
    const radiusSquared = radius * radius;

    for (let py = minY; py <= maxY; py += 1) {
      const worldZ = this.center.y + ((py + 0.5) / this.resolution - 0.5) * this.worldSize;
      for (let px = minX; px <= maxX; px += 1) {
        const worldX = this.center.x + ((px + 0.5) / this.resolution - 0.5) * this.worldSize;
        const dx = worldX - x;
        const dz = worldZ - z;
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared > radiusSquared) continue;
        const terrainHeight = this.terrainSampler.sampleHeight(worldX, worldZ);
        const horizontalRadius = Math.sqrt(Math.max(0, radiusSquared - distanceSquared));
        if (y - horizontalRadius > terrainHeight + 0.3) continue;
        const falloff = 1 - Math.sqrt(distanceSquared) / radius;
        const value = Math.floor(255 * strength * falloff);
        const offset = (py * this.resolution + px) * 4;
        const next = Math.max(this.pixels[offset], value);
        this.pixels[offset] = next;
        if (next > this.peak) this.peak = next;
      }
    }
  }

  clear() {
    this.#clearPixels(this.pixels);
    this.peak = 0;
    this.texture.needsUpdate = true;
  }

  getShaderData() {
    return {
      texture: this.texture,
      center: this.center,
      worldSize: this.worldSize,
    };
  }
}
