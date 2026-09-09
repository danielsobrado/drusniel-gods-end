import { Quaternion, Vector3 } from 'three';

/** Reflection rendering has its own cadence; the main view remains unrestricted. */
export class ReflectionBudget {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Quaternion();
    this.reset();
  }

  reset() { this.lastTime = -Infinity; }

  shouldRender(camera, quality, now) {
    if (quality === 'performance') return false;
    const moving = camera.position.distanceToSquared(this.position) > 0.0025
      || camera.quaternion.angleTo(this.rotation) > 0.002;
    const interval = moving ? ({ ultra: 80, high: 100, balanced: 160 }[quality] ?? 100) : 250;
    if (now - this.lastTime < interval) return false;
    this.lastTime = now;
    this.position.copy(camera.position);
    this.rotation.copy(camera.quaternion);
    return true;
  }
}
