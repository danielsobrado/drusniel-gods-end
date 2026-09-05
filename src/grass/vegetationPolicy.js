// Path/vegetation policy shared by the GPU blades, the CPU compaction, the meadow
// detail scatter and footstep surface detection, so all four agree on where a
// walking path is.
//
// Mask convention: the red channel of the painted mask is 255 on a path and 0 in
// full grass, so `raw strength = 1 - red / 255`. The backing canvas is uploaded
// with flipY = true, which means row 0 of the ImageData is the top of the image
// and therefore the *maximum* world z:
//
//   col = ((x - minX) / sizeX) * (width  - 1)
//   row = (1 - (z - minZ) / sizeZ) * (height - 1)
//
// Sampling the mask top-down without that inversion reads a vertically mirrored
// path network. Everything must go through sampleGrassMask() with the flip.

export const DEFAULT_VEGETATION_CUTOFF = 0.3;
export const DEFAULT_VEGETATION_SOFTNESS = 0.12;
export const DEFAULT_PATH_CLEARANCE = 0.5;

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value <= edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Gate rather than rescale: above cutoff + softness the strength is unchanged, so
// hand-painted mid-height grass keeps its height and only the path fringe dies.
export function vegetationStrength(raw, cutoff = DEFAULT_VEGETATION_CUTOFF, softness = DEFAULT_VEGETATION_SOFTNESS) {
  if (!(raw > 0)) return 0;
  return raw * smoothstep(cutoff, cutoff + softness, raw);
}

export function allowsVegetation(strength) {
  return strength > 0;
}

// Clearance in metres converted to whole mask pixels per axis. terrainSize is the
// terrain sampler's world extent; width/height are the mask's pixel dimensions.
export function dilationRadius(clearanceMeters, terrainSize, width, height = width) {
  const clearance = Math.max(0, clearanceMeters ?? 0);
  // Rounded, not ceiled: at ~0.36 m per pixel a ceil would nearly double the
  // requested clearance. The cutoff ramp makes up the remaining fraction of a metre.
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

// Separable max filter over the red channel: red 255 is path, so max() grows the
// paths outward. Because max commutes with thresholding, every iso-line moves out
// by exactly the radius regardless of where the cutoff sits. `rect` restricts the
// work to a dirty region; the caller's region is expanded by the radius here.
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

  // Horizontal pass needs rows that the vertical pass will read, so widen by radiusY.
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
  const grass = config?.grass ?? {};
  return {
    cutoff: grass.vegetationCutoff ?? DEFAULT_VEGETATION_CUTOFF,
    softness: grass.maskSoftness ?? DEFAULT_VEGETATION_SOFTNESS,
    clearance: grass.pathClearance ?? DEFAULT_PATH_CLEARANCE,
  };
}
