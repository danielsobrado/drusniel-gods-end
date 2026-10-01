// ETC1S codes 4x4 blocks, so a mip under 8 pixels on a side is one block wide or
// tall and the encoder has nothing to hold a cutout with. Measured on this
// project's atlases, decoded alpha coverage tracks the coverage-preserving chain
// to within a few percent down to 8x8 and then falls apart: a 16x2 understory mip
// and a 4x1 tree mip both decode with no cutout alpha at all, whatever --qlevel
// is set to. Those levels are dropped from the KTX2 rather than shipped blank.
//
// The GPU clamps sampling to the levels a texture actually carries, and a
// billboard that lands on an 8x8 mip covers a few pixels, so nothing visible
// depends on the tail. The WebP fallback keeps its full chain.
export const KTX2_MIN_MIP_SIZE = 8;

/** The prefix of a coverage-preserving chain that ETC1S can carry. */
export function ktx2MipChain(levels) {
  const usable = levels.filter(
    ({ width, height }) => width >= KTX2_MIN_MIP_SIZE && height >= KTX2_MIN_MIP_SIZE,
  );
  // KTX2 vegetation atlases are mipmapped by contract; keep the base pair even
  // for an atlas small enough that the rule above would leave one level.
  return usable.length >= 2 ? usable : levels.slice(0, 2);
}

// The coverage-preserving chain parks a lot of texels within a few steps of the
// cutoff, which is the worst place to put them: ETC1S codes alpha as its own
// lossy slice, so those texels cross the cutoff on decode and the mask thins.
// Steepening alpha around the cutoff moves them clear of it. Coverage is
// untouched because the curve is monotonic and fixes the cutoff itself, and the
// impostors render with alphaTest and no blending (VegetationLodRenderer), so
// only which side of the cutoff a texel lands on is ever sampled. It also codes
// smaller, since the alpha slice ends up flatter.
const CUTOUT_ALPHA_GAIN = 6;

/** A mip whose alpha reads the same through an alphaTest but survives ETC1S. */
export function sharpenCutoutAlpha({ data, width, height }, cutoff) {
  const alpha = new Uint8Array(data);
  const edge = cutoff * 255;
  for (let i = 3; i < alpha.length; i += 4) {
    alpha[i] = Math.max(0, Math.min(255, Math.round(edge + (alpha[i] - edge) * CUTOUT_ALPHA_GAIN)));
  }
  return { data: alpha, width, height };
}
