export function brushRadiusPixels(brushRadius, resolution, terrainSpan) {
  return Math.floor((brushRadius / terrainSpan) * resolution);
}

export function strokeSpacingUv(brushRadius, terrainSpan, spacingFactor) {
  return (brushRadius / terrainSpan) * spacingFactor;
}

export function heightToPaintValue(height, { minHeight, maxHeight, maskRange }) {
  const clampedHeight = Math.max(minHeight, Math.min(maxHeight, Math.floor(Number(height))));
  return Math.round(
    ((maxHeight - clampedHeight) * maskRange) / (maxHeight - minHeight),
  );
}
