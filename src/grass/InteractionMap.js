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
    // Inclusive pixel rectangle containing every non-zero red pixel (an
    // over-approximation is fine). Empty when maxX < minX. Recovery and
    // scrolling only touch this rectangle: outside it every red byte is 0, and
    // both floor(0 * r) and a translated 0 stay 0, so the result is byte-exact.
    this.ink = { minX: 0, minY: 0, maxX: -1, maxY: -1 };
    this.pixels = new Uint8Array(this.resolution * this.resolution * 4);
    // Red-channel stash used while scrolling the ink rectangle.
    this.scratch = new Uint8Array(this.resolution * this.resolution);
    this.scrollPixels = null;
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

  #clearInk() {
    this.ink.minX = 0;
    this.ink.minY = 0;
    this.ink.maxX = -1;
    this.ink.maxY = -1;
  }

  #addInk(minX, minY, maxX, maxY) {
    const ink = this.ink;
    if (ink.maxX < ink.minX || ink.maxY < ink.minY) {
      ink.minX = minX;
      ink.minY = minY;
      ink.maxX = maxX;
      ink.maxY = maxY;
      return;
    }
    if (minX < ink.minX) ink.minX = minX;
    if (minY < ink.minY) ink.minY = minY;
    if (maxX > ink.maxX) ink.maxX = maxX;
    if (maxY > ink.maxY) ink.maxY = maxY;
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
    const { minX, minY, maxX, maxY } = this.ink;
    const pixels = this.pixels;
    const stride = this.resolution * 4;
    const speed = this.recoverySpeed;
    for (let y = minY; y <= maxY; y += 1) {
      const row = y * stride;
      for (let x = minX; x <= maxX; x += 1) {
        const index = row + x * 4;
        pixels[index] = Math.floor(pixels[index] * speed);
      }
    }
    this.peak = Math.floor(this.peak * speed);
    if (this.peak === 0) this.#clearInk();
  }

  // Test seams: the differential harness drives a reference implementation that
  // always does the full work, to prove the skips above are byte-exact.
  forceRecover() {
    for (let index = 0; index < this.pixels.length; index += 4) {
      this.pixels[index] = Math.floor(this.pixels[index] * this.recoverySpeed);
    }
    this.peak = Math.floor(this.peak * this.recoverySpeed);
    if (this.peak === 0) this.#clearInk();
  }

  forceScroll(deltaX, deltaZ) {
    const { shiftX, shiftY } = this.#pixelShift(deltaX, deltaZ);
    if (shiftX === 0 && shiftY === 0) return;
    this.scrollPixels ??= new Uint8Array(this.pixels.length);
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
    this.#translateInk(shiftX, shiftY);
  }

  #scroll(deltaX, deltaZ) {
    // Scroll only translates values. With an all-zero red channel the result is
    // identical to the input, since G/B are never written non-zero and alpha is
    // 255 in both #clearPixels and the scroll write.
    if (this.peak === 0) return;
    this.#scrollPixels(deltaX, deltaZ);
  }

  #pixelShift(deltaX, deltaZ) {
    const pixelsPerWorldUnit = this.resolution / this.worldSize;
    return {
      shiftX: Math.trunc(deltaX * pixelsPerWorldUnit),
      shiftY: Math.trunc(deltaZ * pixelsPerWorldUnit),
    };
  }

  // Target pixel (x, y) reads source (x + shiftX, y + shiftY), so the ink
  // rectangle moves by (-shiftX, -shiftY) and is clamped to the texture.
  #translateInk(shiftX, shiftY) {
    const ink = this.ink;
    if (ink.maxX < ink.minX || ink.maxY < ink.minY) return;
    const last = this.resolution - 1;
    const minX = Math.max(0, ink.minX - shiftX);
    const maxX = Math.min(last, ink.maxX - shiftX);
    const minY = Math.max(0, ink.minY - shiftY);
    const maxY = Math.min(last, ink.maxY - shiftY);
    if (maxX < minX || maxY < minY) {
      this.#clearInk();
      return;
    }
    ink.minX = minX;
    ink.minY = minY;
    ink.maxX = maxX;
    ink.maxY = maxY;
  }

  #scrollPixels(deltaX, deltaZ) {
    const { shiftX, shiftY } = this.#pixelShift(deltaX, deltaZ);
    if (shiftX === 0 && shiftY === 0) return;
    const ink = this.ink;
    if (ink.maxX < ink.minX || ink.maxY < ink.minY) return;

    const resolution = this.resolution;
    const pixels = this.pixels;
    const scratch = this.scratch;
    const { minX: oldMinX, minY: oldMinY, maxX: oldMaxX, maxY: oldMaxY } = ink;
    const width = oldMaxX - oldMinX + 1;
    // Stash the old rectangle's red channel and zero it in place. Every other
    // red byte is already 0, alpha is already 255 and G/B are already 0, which
    // is exactly the state a full clear-and-copy leaves outside the translated
    // rectangle.
    for (let y = oldMinY; y <= oldMaxY; y += 1) {
      const row = (y - oldMinY) * width - oldMinX;
      const pixelRow = y * resolution;
      for (let x = oldMinX; x <= oldMaxX; x += 1) {
        const offset = (pixelRow + x) * 4;
        scratch[row + x] = pixels[offset];
        pixels[offset] = 0;
      }
    }
    this.#translateInk(shiftX, shiftY);
    if (ink.maxX < ink.minX) return;
    for (let y = ink.minY; y <= ink.maxY; y += 1) {
      const row = (y + shiftY - oldMinY) * width + shiftX - oldMinX;
      const pixelRow = y * resolution;
      for (let x = ink.minX; x <= ink.maxX; x += 1) {
        pixels[(pixelRow + x) * 4] = scratch[row + x];
      }
    }
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
    if (maxX < minX || maxY < minY) return;
    this.#addInk(minX, minY, maxX, maxY);
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
    this.#clearInk();
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
