import * as THREE from 'three';

const TOGGLE_KEY = 'KeyF';
const EXIT_KEY = 'Escape';
const MOVEMENT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
]);

function isFormControl(target) {
  return Boolean(target?.matches?.('input, select, textarea, button, [contenteditable="true"]'));
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`${name} must be a positive finite number.`);
  return number;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function resolveConfig(config) {
  if (!config) throw new Error('navigation.freeFly configuration is required.');
  const minPitch = finiteNumber(config.minPitch, 'navigation.freeFly.minPitch');
  const maxPitch = finiteNumber(config.maxPitch, 'navigation.freeFly.maxPitch');
  if (minPitch >= maxPitch) throw new Error('navigation.freeFly.minPitch must be lower than maxPitch.');
  return {
    moveSpeed: positiveNumber(config.moveSpeed, 'navigation.freeFly.moveSpeed'),
    fastMultiplier: positiveNumber(config.fastMultiplier, 'navigation.freeFly.fastMultiplier'),
    lookSensitivity: positiveNumber(config.lookSensitivity, 'navigation.freeFly.lookSensitivity'),
    minPitch,
    maxPitch,
  };
}

export class FreeFlyController {
  constructor({
    camera,
    player,
    domElement,
    config,
    eventTarget = globalThis.window,
    documentTarget = globalThis.document,
    onBeforeActivate,
    onChange,
  }) {
    this.camera = camera;
    this.player = player;
    this.domElement = domElement;
    this.eventTarget = eventTarget;
    this.documentTarget = documentTarget;
    this.onBeforeActivate = onBeforeActivate;
    this.onChange = onChange;
    this.config = resolveConfig(config);
    this.active = false;
    this.keys = new Set();
    this.savedCamera = null;
    this.yaw = 0;
    this.pitch = 0;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.movement = new THREE.Vector3();
    this.worldUp = new THREE.Vector3(0, 1, 0);

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleBlur = this.handleBlur.bind(this);

    this.eventTarget?.addEventListener?.('keydown', this.handleKeyDown);
    this.eventTarget?.addEventListener?.('keyup', this.handleKeyUp);
    this.eventTarget?.addEventListener?.('mousemove', this.handleMouseMove);
    this.eventTarget?.addEventListener?.('blur', this.handleBlur);
    this.domElement?.addEventListener?.('click', this.handleClick);
  }

  handleKeyDown(event) {
    if (isFormControl(event?.target)) return;
    if (event?.code === TOGGLE_KEY && !event.repeat) {
      this.toggle();
      return;
    }
    if (event?.code === EXIT_KEY && this.active) {
      this.stop();
      return;
    }
    if (this.active && MOVEMENT_KEYS.has(event?.code)) this.keys.add(event.code);
  }

  handleKeyUp(event) {
    this.keys.delete(event?.code);
  }

  handleMouseMove(event) {
    if (!this.active || this.documentTarget?.pointerLockElement !== this.domElement) return;
    this.yaw -= Number(event.movementX ?? 0) * this.config.lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - Number(event.movementY ?? 0) * this.config.lookSensitivity,
      this.config.minPitch,
      this.config.maxPitch,
    );
    this.#applyOrientation();
  }

  handleClick() {
    if (!this.active || this.documentTarget?.pointerLockElement === this.domElement) return;
    this.#requestPointerLock();
  }

  handleBlur() {
    this.keys.clear();
  }

  toggle() {
    return this.active ? this.stop() : this.start();
  }

  start({ requestPointerLock = true } = {}) {
    if (this.active) return false;
    this.onBeforeActivate?.();
    this.savedCamera = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
    };
    this.active = true;
    this.player.setEnabled(false);
    this.player.root.visible = false;
    this.#syncAnglesFromCamera();
    if (requestPointerLock) this.#requestPointerLock();
    this.onChange?.(true);
    return true;
  }

  stop({ restoreCamera = true } = {}) {
    if (!this.active) return false;
    this.active = false;
    this.keys.clear();
    this.player.root.visible = true;
    this.player.setEnabled(true);
    if (restoreCamera && this.savedCamera) {
      this.camera.position.copy(this.savedCamera.position);
      this.camera.quaternion.copy(this.savedCamera.quaternion);
    }
    if (this.documentTarget?.pointerLockElement === this.domElement) this.documentTarget.exitPointerLock?.();
    this.savedCamera = null;
    this.onChange?.(false);
    return true;
  }

  teleport(position, target) {
    if (!this.active) this.start();
    this.camera.position.fromArray(position);
    if (target) this.camera.lookAt(new THREE.Vector3().fromArray(target));
    this.#syncAnglesFromCamera();
  }

  update(deltaSeconds) {
    if (!this.active || deltaSeconds <= 0) return;
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.movement.set(0, 0, 0);

    if (this.keys.has('KeyW')) this.movement.add(this.forward);
    if (this.keys.has('KeyS')) this.movement.sub(this.forward);
    if (this.keys.has('KeyD')) this.movement.add(this.right);
    if (this.keys.has('KeyA')) this.movement.sub(this.right);
    if (this.keys.has('Space')) this.movement.add(this.worldUp);
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) this.movement.sub(this.worldUp);
    if (this.movement.lengthSq() === 0) return;

    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = this.config.moveSpeed * (fast ? this.config.fastMultiplier : 1);
    this.camera.position.addScaledVector(this.movement.normalize(), speed * deltaSeconds);
  }

  captureState() {
    if (!this.active) return { active: false };
    return {
      active: true,
      position: this.camera.position.toArray(),
      quaternion: this.camera.quaternion.toArray(),
      savedCamera: this.savedCamera && {
        position: this.savedCamera.position.toArray(),
        quaternion: this.savedCamera.quaternion.toArray(),
      },
    };
  }

  restoreState(state) {
    if (!state?.active) return false;
    this.onBeforeActivate?.();
    this.active = true;
    this.keys.clear();
    this.player.setEnabled(false);
    this.player.root.visible = false;
    this.camera.position.fromArray(state.position);
    this.camera.quaternion.fromArray(state.quaternion);
    this.savedCamera = state.savedCamera ? {
      position: new THREE.Vector3().fromArray(state.savedCamera.position),
      quaternion: new THREE.Quaternion().fromArray(state.savedCamera.quaternion),
    } : null;
    this.#syncAnglesFromCamera();
    this.onChange?.(true);
    return true;
  }

  dispose() {
    this.eventTarget?.removeEventListener?.('keydown', this.handleKeyDown);
    this.eventTarget?.removeEventListener?.('keyup', this.handleKeyUp);
    this.eventTarget?.removeEventListener?.('mousemove', this.handleMouseMove);
    this.eventTarget?.removeEventListener?.('blur', this.handleBlur);
    this.domElement?.removeEventListener?.('click', this.handleClick);
    if (this.active) this.stop();
  }

  #syncAnglesFromCamera() {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.pitch = THREE.MathUtils.clamp(this.euler.x, this.config.minPitch, this.config.maxPitch);
    this.yaw = this.euler.y;
    this.#applyOrientation();
  }

  #applyOrientation() {
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
  }

  #requestPointerLock() {
    try {
      const result = this.domElement?.requestPointerLock?.();
      result?.catch?.(() => {});
    } catch {
      // Browsers can reject pointer lock when activation did not originate from a user gesture.
    }
  }
}
