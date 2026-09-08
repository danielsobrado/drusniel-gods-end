export const DEFAULT_VEGETATION_CUTOFF = 0.3;
export const DEFAULT_VEGETATION_SOFTNESS = 0.12;
export const DEFAULT_PATH_CLEARANCE = 0.5;

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value <= edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function vegetationStrength(raw, cutoff = DEFAULT_VEGETATION_CUTOFF, softness = DEFAULT_VEGETATION_SOFTNESS) {
  if (!(raw > 0)) return 0;
  return raw * smoothstep(cutoff, cutoff + softness, raw);
}

export function allowsVegetation(strength) {
  return strength > 0;
}

// Legacy helpers remain exported for compatibility with historical tests/tools.
export function dilationRadius(clearanceMeters, terrainSize, width, height = width) {
  const clearance = Math.max(0, clearanceMeters ?? 0);
  const toPixels = (span, pixels) => {
    if (!(span > 0) || !(pixels > 0) || clearance === 0) return 0;
    return Math.max(1, Math.round(clearance / (span / pixels)));
  };
  return {
    x: toPixels(terrainSize?.x, width),
    y: toPixels(terrainSize?.z ?? terrainSize?.y, height),
  };
}

function clampRect(rect, width, height, radiusX, radiusY) {
  if (!rect) return { x: 0, y: 0, width, height };
  const x = Math.max(0, Math.floor(rect.x) - radiusX);
  const y = Math.max(0, Math.floor(rect.y) - radiusY);
  const right = Math.min(width, Math.ceil(rect.x + rect.width) + radiusX);
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height) + radiusY);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function dilatePathMask(source, target, width, height, radiusX, radiusY, rect = null) {
  const area = clampRect(rect, width, height, radiusX, radiusY);
  if (area.width <= 0 || area.height <= 0) return target;
  const endX = area.x + area.width;
  const endY = area.y + area.height;

  if (radiusX <= 0 && radiusY <= 0) {
    for (let y = area.y; y < endY; y += 1) {
      for (let x = area.x; x < endX; x += 1) {
        const index = (y * width + x) * 4;
        const red = source[index];
        target[index] = red;
        target[index + 1] = red;
        target[index + 2] = red;
        target[index + 3] = 255;
      }
    }
    return target;
  }

  const rowStart = Math.max(0, area.y - radiusY);
  const rowEnd = Math.min(height, endY + radiusY);
  const scratch = new Uint8ClampedArray((rowEnd - rowStart) * area.width);

  for (let y = rowStart; y < rowEnd; y += 1) {
    const row = (y - rowStart) * area.width;
    for (let x = area.x; x < endX; x += 1) {
      let best = 0;
      const from = Math.max(0, x - radiusX);
      const to = Math.min(width - 1, x + radiusX);
      for (let sx = from; sx <= to; sx += 1) {
        const red = source[(y * width + sx) * 4];
        if (red > best) best = red;
      }
      scratch[row + (x - area.x)] = best;
    }
  }

  for (let y = area.y; y < endY; y += 1) {
    for (let x = area.x; x < endX; x += 1) {
      let best = 0;
      const from = Math.max(rowStart, y - radiusY);
      const to = Math.min(rowEnd - 1, y + radiusY);
      for (let sy = from; sy <= to; sy += 1) {
        const value = scratch[(sy - rowStart) * area.width + (x - area.x)];
        if (value > best) best = value;
      }
      const index = (y * width + x) * 4;
      target[index] = best;
      target[index + 1] = best;
      target[index + 2] = best;
      target[index + 3] = 255;
    }
  }
  return target;
}

export function resolveVegetationPolicy(config) {
  const vegetation = config?.vegetation ?? {};
  const grass = config?.grass ?? {};
  return {
    cutoff: vegetation.shaderCutoff ?? grass.vegetationCutoff ?? DEFAULT_VEGETATION_CUTOFF,
    softness: vegetation.shaderSoftness ?? grass.maskSoftness ?? DEFAULT_VEGETATION_SOFTNESS,
    clearance: vegetation.path?.clearance ?? grass.pathClearance ?? DEFAULT_PATH_CLEARANCE,
  };
}
