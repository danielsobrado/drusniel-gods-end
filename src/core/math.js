export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function damp(current, target, sharpness, deltaSeconds) {
  const t = 1 - Math.exp(-Math.max(0, sharpness) * Math.max(0, deltaSeconds));
  return current + (target - current) * t;
}

export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
