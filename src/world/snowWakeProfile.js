// The snow-surf wake cross-section, shared by the vertex shader and the CPU
// spray emitter so thrown snow leaves exactly the crest the mesh draws.
//
// The section is a breaking wave integrated from a turning tangent. The
// tangent starts just below horizontal at the base and sweeps toward the tip
// angle; one curl parameter moves that tip from a low heaped bank (40 deg) to a
// lip that hangs back across its own face (284 deg). The sweep is eased so the
// base stays shallow and the curvature gathers at the lip.
//
// Lengths below are in reference metres (a 1.8 m rider) and are multiplied by
// the character's body scale at the call site.

export const WAKE_SECTION_STEPS = 20;
export const WAKE_BASE_ANGLE = -8 * Math.PI / 180;
export const WAKE_HEAP_TIP_ANGLE = 40 * Math.PI / 180;
export const WAKE_CURL_TIP_ANGLE = 284 * Math.PI / 180;
export const WAKE_SWEEP_POWER = 1.6;
/** Squashes the section sideways so a full wall is taller than it is wide. */
export const WAKE_LATERAL = 0.7;
/** The lip lags behind the base along the travel direction, per metre of height. */
export const WAKE_SHEAR = 0.35;
/** Outward drift of a collapsing wall, reference metres at the end of its life. */
export const WAKE_SPREAD = 0.45;
/** How far a collapsing wall sinks, reference metres at the end of its life. */
export const WAKE_SINK = 0.18;
/** Seats the base of the wall into the trench so it never floats on a slope. */
export const WAKE_BASE_DROP = 0.06;
/** Lump displacement along the wall, as a fraction of the wall height. */
export const WAKE_LUMP = 0.08;

export function wakeTipAngle(curl) {
  return WAKE_HEAP_TIP_ANGLE + (WAKE_CURL_TIP_ANGLE - WAKE_HEAP_TIP_ANGLE) * curl;
}

export function wakeTangentAngle(s, curl) {
  return WAKE_BASE_ANGLE + (wakeTipAngle(curl) - WAKE_BASE_ANGLE) * s ** WAKE_SWEEP_POWER;
}

// Section point at q in [0, 1], in (outward, up) units where the crest is at
// height 1 for every curl. Midpoint integration with the last step weighted by
// how much of it q covers; the shader runs the identical loop.
export function wakeSection(q, curl, out = { x: 0, y: 0 }) {
  const covered = q * WAKE_SECTION_STEPS;
  let x = 0;
  let y = 0;
  let fullY = 0;
  let peak = 1e-4;
  for (let index = 0; index < WAKE_SECTION_STEPS; index += 1) {
    const angle = wakeTangentAngle((index + 0.5) / WAKE_SECTION_STEPS, curl);
    const weight = Math.min(1, Math.max(0, covered - index));
    const dx = Math.cos(angle) / WAKE_SECTION_STEPS;
    const dy = Math.sin(angle) / WAKE_SECTION_STEPS;
    x += dx * weight;
    y += dy * weight;
    fullY += dy;
    peak = Math.max(peak, fullY);
  }
  out.x = x / peak;
  out.y = y / peak;
  return out;
}

/** Section parameter of the highest point: where curtain spray leaves the wall. */
export function wakeCrestParameter(curl) {
  let fullY = 0;
  let peak = -Infinity;
  let crest = 1;
  for (let index = 0; index < WAKE_SECTION_STEPS; index += 1) {
    fullY += Math.sin(wakeTangentAngle((index + 0.5) / WAKE_SECTION_STEPS, curl));
    if (fullY > peak) {
      peak = fullY;
      crest = (index + 1) / WAKE_SECTION_STEPS;
    }
  }
  return crest;
}

const scratchSection = { x: 0, y: 0 };

// CPU mirror of the shader's wakePoint without the cosmetic lumps. `sample` is
// an interpolated spine sample (see readPackedSpine); side is -1 left, +1 right.
export function wakePointCpu(sample, q, side, scale, halfWidth, out) {
  const amplitude = side > 0 ? sample.ampR : sample.ampL;
  const curl = side > 0 ? sample.curlR : sample.curlL;
  const section = wakeSection(q, curl, scratchSection);
  const rightLength = Math.hypot(sample.rightX, sample.rightZ) || 1;
  const rightX = sample.rightX / rightLength;
  const rightZ = sample.rightZ / rightLength;
  const lateral = scale * (halfWidth + sample.age * WAKE_SPREAD) + section.x * amplitude * WAKE_LATERAL;
  const height = section.y * amplitude - scale * (WAKE_BASE_DROP + sample.age * sample.age * WAKE_SINK);
  const shear = section.y * amplitude * WAKE_SHEAR;
  out.x = sample.x + rightX * side * lateral - rightZ * shear;
  out.y = sample.y + height;
  out.z = sample.z + rightZ * side * lateral + rightX * shear;
  out.outwardX = rightX * side;
  out.outwardZ = rightZ * side;
  return out;
}
