import * as THREE from 'three';

const POSITION_SUFFIX = '.position';
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });

function targetsNodePosition(trackName, nodeName) {
  if (!trackName.endsWith(POSITION_SUFFIX)) return false;
  const target = trackName.slice(0, -POSITION_SUFFIX.length);
  return target === nodeName
    || target.endsWith(`/${nodeName}`)
    || target.endsWith(`.${nodeName}`)
    || target.endsWith(`[${nodeName}]`);
}

function removeNetDrift(track, axes) {
  if (!(track instanceof THREE.VectorKeyframeTrack) || track.times.length < 2) return;

  const cubicSpline = track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline === true;
  const keyStride = track.getValueSize();
  const vectorStride = cubicSpline ? keyStride / 3 : keyStride;
  if (vectorStride !== 3) return;

  const firstTime = track.times[0];
  const lastTime = track.times[track.times.length - 1];
  const duration = lastTime - firstTime;
  if (!(duration > 0)) return;

  const components = axes
    .map((axis) => AXIS_INDEX[axis])
    .filter((index) => index !== undefined);
  if (components.length === 0) return;

  const values = track.values;
  const valueOffset = cubicSpline ? vectorStride : 0;
  const lastOffset = (track.times.length - 1) * keyStride + valueOffset;
  const drift = new Map(components.map((component) => [
    component,
    values[lastOffset + component] - values[valueOffset + component],
  ]));

  for (let key = 0; key < track.times.length; key += 1) {
    const progress = (track.times[key] - firstTime) / duration;
    const offset = key * keyStride;
    for (const component of components) {
      const amount = drift.get(component);
      values[offset + valueOffset + component] -= amount * progress;
      if (!cubicSpline) continue;

      const derivative = amount / duration;
      values[offset + component] -= derivative;
      values[offset + vectorStride * 2 + component] -= derivative;
    }
  }
}

/**
 * Converts authored locomotion to in-place animation without flattening the
 * within-cycle hip sway. Gameplay or AI remains the sole owner of world motion.
 */
export function calibrateLocomotionClip(clip, calibration = {}) {
  const rootMotion = calibration.rootMotion;
  if (!clip || !rootMotion?.inPlace) return clip;

  const nodes = Array.isArray(rootMotion.nodes) ? rootMotion.nodes.filter(Boolean) : [];
  if (nodes.length === 0) return clip;

  const axes = Array.isArray(rootMotion.axes) && rootMotion.axes.length > 0
    ? rootMotion.axes
    : ['x', 'z'];
  const hasRootPositionTrack = clip.tracks.some((track) => (
    nodes.some((node) => targetsNodePosition(track.name, node))
  ));
  if (!hasRootPositionTrack) return clip;

  const calibrated = clip.clone();
  for (const track of calibrated.tracks) {
    if (!nodes.some((node) => targetsNodePosition(track.name, node))) continue;
    removeNetDrift(track, axes);
  }
  return calibrated;
}

export function resolveClipSpeedInHeights(calibration, kind) {
  const value = Number(calibration?.clipSpeedInHeights?.[kind]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
