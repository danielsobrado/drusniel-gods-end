import { Frustum, Matrix4 } from 'three';

const MAX_TURN_MARGIN_DEGREES = 60;
const MAX_HALF_ANGLE_RADIANS = 85 * Math.PI / 180;

function expandedSlope(slope, marginRadians, direction) {
  const angle = Math.atan(slope) + marginRadians * direction;
  const clamped = Math.max(-MAX_HALF_ANGLE_RADIANS, Math.min(MAX_HALF_ANGLE_RADIANS, angle));
  return Math.tan(clamped);
}

export class TurnEnvelopeFrustum {
  constructor() {
    this.frustum = new Frustum();
    this.projectionView = new Matrix4();
    this.expandedProjection = new Matrix4();
  }

  update(camera, marginDegrees = 0) {
    camera.updateMatrixWorld();

    let projection = camera.projectionMatrix;
    const margin = Math.min(
      MAX_TURN_MARGIN_DEGREES,
      Math.max(0, Number(marginDegrees) || 0),
    );

    if (margin > 0 && camera.isPerspectiveCamera) {
      const elements = camera.projectionMatrix.elements;
      const horizontalScale = elements[0];
      const verticalScale = elements[5];
      if (horizontalScale !== 0 && verticalScale !== 0) {
        const marginRadians = margin * Math.PI / 180;
        const near = camera.near;
        const left = expandedSlope((-1 + elements[8]) / horizontalScale, marginRadians, -1) * near;
        const right = expandedSlope((1 + elements[8]) / horizontalScale, marginRadians, 1) * near;
        const bottom = expandedSlope((-1 + elements[9]) / verticalScale, marginRadians, -1) * near;
        const top = expandedSlope((1 + elements[9]) / verticalScale, marginRadians, 1) * near;
        this.expandedProjection.makePerspective(
          left,
          right,
          top,
          bottom,
          near,
          camera.far,
          camera.coordinateSystem,
        );
        projection = this.expandedProjection;
      }
    }

    this.projectionView.multiplyMatrices(projection, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView, camera.coordinateSystem);
    return this.frustum;
  }
}
