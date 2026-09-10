import { Matrix4 } from 'three';

/** Reuse screen-space reflections only while their captured view is unchanged. */
export class ReflectionBudget {
  constructor() {
    this.worldMatrix = new Matrix4();
    this.projectionMatrix = new Matrix4();
    this.reset();
  }

  reset() { this.lastTime = -Infinity; }

  shouldRender(camera, quality, now) {
    if (quality === 'performance') return false;
    camera.updateWorldMatrix(true, false);
    const viewChanged = !camera.matrixWorld.equals(this.worldMatrix)
      || !camera.projectionMatrix.equals(this.projectionMatrix);
    // The shader samples in current screen coordinates. Even a small change
    // makes a cached capture slide, then snap when the old timer expires.
    if (!viewChanged && now - this.lastTime < 250) return false;
    this.lastTime = now;
    this.worldMatrix.copy(camera.matrixWorld);
    this.projectionMatrix.copy(camera.projectionMatrix);
    return true;
  }
}
