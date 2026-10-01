const MAX_TURN_MARGIN_DEGREES = 60;
const RAD_TO_DEG = 180 / Math.PI;

export function cameraRotationThresholdDegrees(metric) {
  const value = Number(metric);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return 2 * Math.acos(1 - value) * RAD_TO_DEG;
}

export function validateCameraTurnEnvelope(problems, prefix, rotationThreshold, marginDegrees) {
  const threshold = Number(rotationThreshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    problems.push(`${prefix}.cameraRotationThreshold must be a finite number in [0, 1]`);
  }

  const margin = Number(marginDegrees);
  if (!Number.isFinite(margin) || margin < 0 || margin > MAX_TURN_MARGIN_DEGREES) {
    problems.push(`${prefix}.cameraTurnMarginDegrees must be a finite number in [0, ${MAX_TURN_MARGIN_DEGREES}]`);
    return;
  }

  const thresholdDegrees = cameraRotationThresholdDegrees(threshold);
  if (thresholdDegrees !== null && margin + 1e-6 < thresholdDegrees) {
    problems.push(
      `${prefix}.cameraTurnMarginDegrees must cover cameraRotationThreshold (${thresholdDegrees.toFixed(2)} degrees)`,
    );
  }
}
