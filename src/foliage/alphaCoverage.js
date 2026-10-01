/** Premultiplied downsampling avoids dark halos; alpha scaling retains thin foliage through mips. */
export function foliageMipmaps(data, width, height, cutoff = 0.35) {
  const levels = [{ data, width, height }];
  let covered = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] / 255 >= cutoff) covered++;
  const coverage = covered / (width * height);
  while (width > 1 || height > 1) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1), next = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let alpha = 0; const rgb = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (Math.min(height - 1, y * 2 + dy) * width + Math.min(width - 1, x * 2 + dx)) * 4;
        alpha += data[i + 3]; for (let c = 0; c < 3; c++) rgb[c] += data[i + c] * data[i + 3];
      }
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) next[i + c] = alpha ? Math.round(rgb[c] / alpha) : 0;
      next[i + 3] = Math.round(alpha / 4);
    }
    let lo = 0, hi = 8;
    for (let step = 0; step < 12; step++) {
      const scale = (lo + hi) / 2;
      // Measure the alpha that actually ships (clamped and rounded), not the raw
      // product: rounding down across the cutoff is what silently thins foliage.
      let count = 0; for (let i = 3; i < next.length; i += 4) if (Math.min(255, Math.round(next[i] * scale)) >= cutoff * 255) count++;
      if (count / (w * h) < coverage) lo = scale; else hi = scale;
    }
    // hi is the only endpoint the search proved meets the coverage target; the
    // midpoint may sit just under it and lose the thinnest cutout pixels.
    for (let i = 3; i < next.length; i += 4) next[i] = Math.min(255, Math.round(next[i] * hi));
    levels.push({ data: next, width: w, height: h }); data = next; width = w; height = h;
  }
  return levels;
}
