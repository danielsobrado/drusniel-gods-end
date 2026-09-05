// Normalized linear texture sampling, including half-texel centers.
export function sampleGrassMask(image, u, v) {
  const { width, height, data } = image;
  const x = Math.max(0, Math.min(width - 1, u * width - 0.5));
  const y = Math.max(0, Math.min(height - 1, v * height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
  const value = (px, py) => data[(py * width + px) * 4] / 255;
  const top = value(x0, y0) * (1 - x + x0) + value(x1, y0) * (x - x0);
  const bottom = value(x0, y1) * (1 - x + x0) + value(x1, y1) * (x - x0);
  return 1 - (top * (1 - y + y0) + bottom * (y - y0));
}
