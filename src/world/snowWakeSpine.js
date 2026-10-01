// The wake spine: the path the board has taken, resampled at a fixed spacing
// into a ring, then packed each frame into a capacity x 3 float texture.
//
//   row 0  x, y, z, distance behind the bow
//   row 1  right.x, right.z, left wall height, right wall height
//   row 2  left curl, right curl, age / life, strength
//
// Slot 0 is always the live bow just ahead of the board; slot 1 onward are
// committed samples from newest to oldest, stopping at the first one that has
// finished collapsing. Heights and curls are resolved here from the carve so
// the shader only reads them, as in Snowflow's surfWake.js.

export const SPINE_ROWS = 3;
const CHANNELS = 4;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function smoothstep01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export class SnowWakeSpine {
  constructor(capacity) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.rightX = new Float32Array(capacity);
    this.rightZ = new Float32Array(capacity);
    this.laid = new Float32Array(capacity);
    this.strength = new Float32Array(capacity);
    this.carve = new Float32Array(capacity);
    this.head = 0;
    this.count = 0;
  }

  reset() {
    this.count = 0;
  }

  // Commits a sample every `step` metres of horizontal travel, placed exactly
  // on the segment from the last sample to the board so spacing stays uniform
  // however large the frame step is. A jump longer than the whole ring (a
  // teleport) restarts the spine instead of drawing a wall across the gap.
  update(clock, x, y, z, rightX, rightZ, strength, carve, step) {
    if (this.count > 0) {
      let lastX = this.x[this.head];
      let lastY = this.y[this.head];
      let lastZ = this.z[this.head];
      let dx = x - lastX;
      let dz = z - lastZ;
      let distance = Math.hypot(dx, dz);
      if (distance <= step * this.capacity) {
        while (distance >= step) {
          const t = step / distance;
          lastX += dx * t;
          lastY += (y - lastY) * t;
          lastZ += dz * t;
          this.#commit(clock, lastX, lastY, lastZ, rightX, rightZ, strength, carve);
          dx = x - lastX;
          dz = z - lastZ;
          distance = Math.hypot(dx, dz);
        }
        return;
      }
      this.reset();
    }
    this.#commit(clock, x, y, z, rightX, rightZ, strength, carve);
  }

  #commit(clock, x, y, z, rightX, rightZ, strength, carve) {
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.z[this.head] = z;
    this.rightX[this.head] = rightX;
    this.rightZ[this.head] = rightZ;
    this.laid[this.head] = clock;
    this.strength[this.head] = strength;
    this.carve[this.head] = carve;
  }

  // Returns the number of packed slots and the tallest wall anywhere on them.
  // The shader clamps every fetch to `count - 1`, so slots past it are unread.
  pack(data, {
    clock, bowX, bowY, bowZ, rightX, rightZ, strength, carve, life, maxHeight, scale,
  }) {
    const capacity = this.capacity;
    const available = Math.min(this.count + 1, capacity);
    let distance = 0;
    let previousX = bowX;
    let previousZ = bowZ;
    let count = 0;
    let maxAmp = 0;

    for (let slot = 0; slot < available; slot += 1) {
      const index = (this.head - (slot - 1) + capacity) % capacity;
      const bow = slot === 0;
      const x = bow ? bowX : this.x[index];
      const z = bow ? bowZ : this.z[index];
      const sampleStrength = bow ? strength : this.strength[index];
      const sampleCarve = bow ? carve : this.carve[index];
      distance += Math.hypot(x - previousX, z - previousZ);
      previousX = x;
      previousZ = z;

      const age = bow ? 0 : clamp((clock - this.laid[index]) / life, 0, 1);
      // Rise: small at the bow and full a metre and a half behind it. Fall:
      // quadratic to exactly zero, so the tail degenerates onto its spine
      // instead of ending in a cut edge.
      const shape = 0.34 + 0.66 * smoothstep01((distance / scale - 0.3) / 1.3);
      const envelope = (1 - age) * (1 - age);
      const base = maxHeight * sampleStrength * shape * envelope;
      // Positive carve is a right turn and loads the left (outside) wall.
      const bias = clamp(sampleCarve, -1, 1);
      const ampL = base * clamp(0.45 + 0.55 * bias, 0.05, 1);
      const ampR = base * clamp(0.45 - 0.55 * bias, 0.05, 1);
      maxAmp = Math.max(maxAmp, ampL, ampR);

      const row0 = slot * CHANNELS;
      const row1 = (capacity + slot) * CHANNELS;
      const row2 = (capacity * 2 + slot) * CHANNELS;
      data[row0] = x;
      data[row0 + 1] = bow ? bowY : this.y[index];
      data[row0 + 2] = z;
      data[row0 + 3] = distance;
      data[row1] = bow ? rightX : this.rightX[index];
      data[row1 + 1] = bow ? rightZ : this.rightZ[index];
      data[row1 + 2] = ampL;
      data[row1 + 3] = ampR;
      // A wall that is barely there does not curl; a hard carve hangs its lip
      // back across its own face.
      data[row2] = clamp(0.42 + 0.58 * bias, 0.26, 1);
      data[row2 + 1] = clamp(0.42 - 0.58 * bias, 0.26, 1);
      data[row2 + 2] = age;
      data[row2 + 3] = sampleStrength;
      count = slot + 1;
      if (!bow && age >= 1) break;
    }
    return { count, maxAmp };
  }
}

// Linear read of the packed spine at a fractional slot, for emitters.
export function readPackedSpine(data, capacity, count, fractional, out) {
  const last = Math.max(count - 1, 0);
  const lower = clamp(Math.floor(fractional), 0, last);
  const upper = Math.min(lower + 1, last);
  const t = clamp(fractional - lower, 0, 1);
  const read = (row, slot, channel) => data[(capacity * row + slot) * CHANNELS + channel];
  const mixed = (row, channel) => read(row, lower, channel) + (read(row, upper, channel) - read(row, lower, channel)) * t;
  out.x = mixed(0, 0);
  out.y = mixed(0, 1);
  out.z = mixed(0, 2);
  out.distance = mixed(0, 3);
  out.rightX = mixed(1, 0);
  out.rightZ = mixed(1, 1);
  out.ampL = mixed(1, 2);
  out.ampR = mixed(1, 3);
  out.curlL = mixed(2, 0);
  out.curlR = mixed(2, 1);
  out.age = mixed(2, 2);
  return out;
}
