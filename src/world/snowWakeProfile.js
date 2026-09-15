// The snow-surf wake cross-section, ported from Snowflow's `lib/wake.wgsl`
// (MIT, Maksymilian Dendura). The vertex shader in SnowWakeMaterial.js runs the
// same integral; this CPU copy exists for tests and emitters.
//
// The section is a breaking wave integrated from a turning tangent. The tangent
// sweeps from just below horizontal at the base to `WAKE_TIP_ANGLE + curl *
// WAKE_TIP_CURL` at the tip: 95 degrees is a heaped bank, 284 degrees a lip
// that hangs back across its own face. The 1.65 exponent puts most of the arc
// length into the face and compresses the hook into the last fifth, and the
// section thins as it climbs so the lip is fine and the base broad.
//
// Lengths below are in reference metres (a 1.8 m rider) and are multiplied by
// the character's body scale at the call site.

export const WAKE_SECTION_STEPS = 20;
/** Brings the crest near 1 so amplitude can be one number in metres. */
export const WAKE_NORM = 3.35;
/** Squashes the section sideways: a wave, not a three-metre ramp. */
export const WAKE_LATERAL = 0.7;
export const WAKE_BASE_ANGLE = -0.24;
export const WAKE_TIP_ANGLE = 1.65;
export const WAKE_TIP_CURL = 3.3;
/** Tip angle Snowflow uses for the lump displacement normal. */
export const WAKE_NORMAL_TIP_ANGLE = 1.89;
export const WAKE_SWEEP_POWER = 1.65;
export const WAKE_THINNING = 0.4;
/** The walls start close at the bow and spread behind it. */
export const WAKE_BASE_OFFSET = 0.24;
export const WAKE_BASE_SPREAD = 0.44;
export const WAKE_SPREAD_START = 0.3;
export const WAKE_SPREAD_END = 2.6;
/** The lip trails backward along the spine by q^2 * shear * amplitude. */
export const WAKE_SHEAR = 0.34;
/** Seats the base into the trench the spine height knows nothing about. */
export const WAKE_SINK = 0.1;
/** Lump displacement along the section normal, in units of amplitude. */
export const WAKE_LUMP = 0.085;

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Section point at q in [0, 1], in (outward, up) units of amplitude.
export function wakeSection(q, curl, out = { x: 0, y: 0 }) {
  const tip = WAKE_TIP_ANGLE + curl * WAKE_TIP_CURL;
  const dt = q / WAKE_SECTION_STEPS;
  let x = 0;
  let y = 0;
  for (let index = 0; index < WAKE_SECTION_STEPS; index += 1) {
    const t = (index + 0.5) * dt;
    const angle = WAKE_BASE_ANGLE + (tip - WAKE_BASE_ANGLE) * t ** WAKE_SWEEP_POWER;
    const width = (1 - WAKE_THINNING * t) * dt;
    x += Math.cos(angle) * width;
    y += Math.sin(angle) * width;
  }
  out.x = x * WAKE_LATERAL * WAKE_NORM;
  out.y = y * WAKE_NORM;
  return out;
}

/** Lateral offset of the wall base from the spine, reference metres. */
export function wakeBaseOffset(distanceBehindBow) {
  return WAKE_BASE_OFFSET + WAKE_BASE_SPREAD * smoothstep(WAKE_SPREAD_START, WAKE_SPREAD_END, distanceBehindBow);
}
