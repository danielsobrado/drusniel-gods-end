function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// Keep automatic orbit out of the movement basis: a held diagonal must stay
// straight in world space, even as the camera catches up behind the player.
export class CameraFollow {
  constructor() {
    this.movementYaw = null;
    this.wasMoving = false;
    this.idleTime = 0;
    this.movingTime = 0;
    this.manual = false;
    this.recenterTarget = null;
  }

  manualLook(deltaYaw) {
    this.manual = true;
    this.idleTime = 0;
    this.recenterTarget = null;
    if (this.movementYaw !== null) this.movementYaw += deltaYaw;
  }

  recenter(yaw) {
    this.manual = false;
    this.recenterTarget = yaw;
  }

  resetGesture() {
    this.wasMoving = false;
    this.movementYaw = null;
    this.movingTime = 0;
  }

  // `touch` is true on phones and tablets (touch-primary devices), where
  // steering and turning the view at once is awkward; only there does the
  // camera swing round behind the player by itself.
  update({ yaw, x, z, dt, touch, looking = false }) {
    const moving = x * x + z * z > 0.001;
    if (looking) this.idleTime = 0;
    if (moving) {
      if (!this.wasMoving) {
        this.movementYaw = yaw;
        if (this.idleTime >= 0.8 && !looking) this.manual = false;
        this.movingTime = 0;
      }
      this.idleTime = 0;
      this.movingTime += dt;
    } else {
      if (!looking) this.idleTime += dt;
      this.movingTime = 0;
      this.movementYaw = yaw;
    }
    this.wasMoving = moving;

    let target = this.recenterTarget;
    // Automatic orbit is touch-only; a mouse keeps full control of the view,
    // whatever the window size, and only recenters on request. Ignore backward
    // movement, strafing and tiny corrections.
    if (touch && target === null && !this.manual && this.movingTime >= 0.2 && z < -0.25) {
      const turn = Math.atan2(-x, -z);
      if (Math.abs(turn) > 0.08) target = this.movementYaw + turn;
    }
    if (target !== null && !looking && !this.manual) {
      const delta = angleDelta(yaw, target);
      yaw += delta * (1 - Math.exp(-(touch ? 3 : 1.5) * dt));
      if (Math.abs(delta) < 0.001) this.recenterTarget = null;
    }
    return { yaw, movementYaw: this.movementYaw };
  }
}
