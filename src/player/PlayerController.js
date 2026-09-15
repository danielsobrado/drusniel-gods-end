import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { clampCameraAboveTerrain } from './cameraTerrain.js';
import { MobileControls } from './MobileControls.js';
import { PlayerPhysics } from './PlayerPhysics.js';
import { createLocomotionClips, FootPlacement } from './CharacterMotion.js';
import { measureFootstepContacts } from './FootstepContacts.js';
import { ResourceScope, captureObjectResources } from '../utils/ResourceScope.js';

const MOVEMENT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ShiftLeft',
  'ShiftRight',
]);
const MOVE_EPSILON = 0.001;
const ANIMATION_IDLE_SPEED = 0.1;
const MOBILE_BREAKPOINT = 768;
const DEFAULT_ANIMATION_FADE = 0.25;
const FALL_RESET_HEIGHT = 20;

function isFormControl(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, select, textarea, button, [contenteditable="true"]');
}

function shortestAngleDelta(from, to) {
  return THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
}

export class PlayerController {
  constructor(scene, camera, domElement, config, terrainSampler, terrain) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.terrain = terrain;
    this.cameraControls = config.camera.controls;
    this.motion = config.player.motion;
    this.enabled = true;
    this.scaleRatio = 1;
    this.keys = new Set();
    this.horizontalVelocity = new THREE.Vector3();
    this.movement = new THREE.Vector3();
    this.move = new THREE.Vector3();
    this.desiredDirection = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.cameraTarget = new THREE.Vector3();
    this.desiredCameraPosition = new THREE.Vector3();
    this.cameraOffset = new THREE.Vector3();
    this.cameraRight = new THREE.Vector3();
    this.cameraUp = new THREE.Vector3(0, 1, 0);
    this.pitchAxis = new THREE.Vector3();
    this.yawQuaternion = new THREE.Quaternion();
    this.pitchQuaternion = new THREE.Quaternion();
    this.targetQuaternion = new THREE.Quaternion();
    this.cameraYaw = this.cameraControls.initialYaw ?? 0;
    this.cameraPitch = config.cinematic?.enabled ? config.cinematic.camera.pitch : config.camera.pitch ?? -0.25;
    this.playerYaw = config.cinematic?.enabled ? this.cameraYaw + Math.PI : 0;
    this.mobile = window.innerWidth < (this.cameraControls.mobileBreakpoint ?? MOBILE_BREAKPOINT);
    this.cameraDistance = this.mobile
      ? this.cameraControls.mobileDistance
      : this.cameraControls.desktopDistance;
    this.targetCameraDistance = this.cameraDistance;
    this.mobileMoveX = 0;
    this.mobileMoveY = 0;
    this.mobileSprinting = false;
    this.mobileControls = null;
    this.isLocked = false;
    this.grounded = false;
    this.verticalVelocity = 0;
    this.moving = false;
    this.running = false;
    this.speed = 0;
    this.physics = null;
    this.model = null;
    this.animation = null;
    this.influenceObjects = [];
    this.influencePoints = [];
    this.abortController = new AbortController();
    this.resources = new ResourceScope();
    this.influenceFallback = [
      { position: new THREE.Vector3(), radius: config.grass.interaction.footRadius },
      { position: new THREE.Vector3(), radius: config.grass.interaction.footRadius },
    ];
    this.isSafari = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome');
    this.spawnPosition = new THREE.Vector3().fromArray(config.camera.initialPosition ?? [11.7, 3, 11]);

    this.footBase = new THREE.Vector3();
    this.modelHeight = 0;
    this.metrics = this.#characterMetrics();

    this.root = new THREE.Group();
    this.root.rotation.y = this.playerYaw;
    this.root.position.set(config.player.start[0], 0, config.player.start[2]);
    this.#snapFallbackToTerrain();
    this.placeholder = this.#createPlaceholder();
    this.resources.defer(captureObjectResources(this.placeholder));
    this.root.add(this.placeholder);
    scene.add(this.root);
    this.#initializeCamera();
    this.#bindEvents();
    this.#syncMobileControls();
  }

  async loadModel() {
    this.abortController.signal.throwIfAborted();
    const path = this.config.assets?.player;
    if (!path) {
      await this.#initializePhysics();
      return false;
    }

    const dracoLoader = new DRACOLoader();
    try {
      const loader = new GLTFLoader();
      dracoLoader.setDecoderPath(this.config.assets.dracoDecoderPath);
      loader.setDRACOLoader(dracoLoader);
      const gltf = await loader.loadAsync(assetUrl(path));
      // If disposal won the race, defer releases the late asset immediately.
      this.resources.defer(captureObjectResources(gltf.scene));
      this.abortController.signal.throwIfAborted();
      this.model = gltf.scene;
      // The collider and every vertical offset are derived from the scaled model,
      // so the model must be measured before physics builds the capsule.
      this.#applyModelScale();
      this.metrics = this.#characterMetrics();
      this.model.position.y = this.metrics.modelOffsetY;
      this.model.rotation.y = this.config.player.modelRotationY ?? 0;
      this.model.traverse((object) => {
        if (!object.isMesh) return;
        object.userData.rainRoughness = this.config.player.rainRoughness ?? 0.1;
        object.castShadow = true;
        object.receiveShadow = true;
        object.geometry?.computeVertexNormals?.();
        if (object.name.includes('FootSphere')) object.visible = false;
      });

      this.root.add(this.model);
      this.placeholder.visible = false;
      await this.#initializePhysics();
      this.abortController.signal.throwIfAborted();
      this.handleResize();
      this.#setupAnimations([...gltf.animations, ...await this.#loadExtraClips(loader)]);
      if (this.config.cinematic?.motion.footPlacement) this.footPlacement = new FootPlacement(this.model, this.terrainSampler, this.modelHeight);
      this.#findInfluenceObjects();
      return true;
    } catch (error) {
      this.abortController.signal.throwIfAborted();
      logger.warn('Player GLB failed to load; using procedural fallback.', error);
      await this.#initializePhysics();
      return false;
    } finally {
      dracoLoader.dispose();
    }
  }

  // Every roster rig shares one armature, so a clip authored against another
  // character's skin binds by bone name and plays here unchanged. This is how a
  // character with only a run in its own GLB still gets an authored walk.
  async #loadExtraClips(loader) {
    const clips = [];
    for (const source of this.config.player.animationSources ?? []) {
      try {
        const gltf = await loader.loadAsync(assetUrl(source));
        // Only the clips are retained; their source meshes and textures are not.
        captureObjectResources(gltf.scene)();
        this.abortController.signal.throwIfAborted();
        clips.push(...gltf.animations);
      } catch (error) {
        this.abortController.signal.throwIfAborted();
        logger.warn(`Extra animation source failed to load: ${source}`, error);
      }
    }
    return clips;
  }

  #applyModelScale() {
    if (!this.model) return;
    const targetHeight = this.config.player.targetHeight;
    const referenceScale = this.config.player.modelScale ?? 1.35;

    if (targetHeight && targetHeight > 0) {
      this.model.scale.set(1, 1, 1);
      this.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.model);
      const nativeHeight = box.max.y - box.min.y;

      if (nativeHeight > 0) {
        const computedScale = targetHeight / nativeHeight;
        this.model.scale.setScalar(computedScale);
        this.modelHeight = targetHeight;
        this.scaleRatio = computedScale / referenceScale;
        logger.info(
          `Auto-scaled player model: nativeHeight=${nativeHeight.toFixed(2)}, targetHeight=${targetHeight}, scale=${computedScale.toFixed(3)}, scaleRatio=${this.scaleRatio.toFixed(3)}`,
        );
        return;
      }
    }

    this.model.scale.setScalar(referenceScale);
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    this.modelHeight = Math.max(box.max.y - box.min.y, 0);
    this.scaleRatio = 1;
  }

  // The capsule, the eye offset and the model's vertical placement all have to agree,
  // or the character floats above (or sinks into) the terrain. Everything below is
  // derived from the authored proportions in config, uniformly rescaled so that the
  // collider is exactly as tall as the model actually is on screen.
  #characterMetrics() {
    const player = this.config.player;
    const halfHeight = player.capsuleHalfHeight ?? 1;
    const radius = player.capsuleRadius ?? 0.7;
    const eyeHeight = player.eyeHeight ?? 0.5;
    const groundOffset = player.groundOffset ?? 0;
    const modelOffsetY = player.modelOffsetY ?? 0;

    const authoredHeight = 2 * (halfHeight + radius);
    const scale = this.modelHeight > 0 && authoredHeight > 0
      ? this.modelHeight / authoredHeight
      : 1;

    const metrics = {
      scale,
      halfHeight: halfHeight * scale,
      radius: radius * scale,
      eyeHeight: eyeHeight * scale,
      groundOffset: groundOffset * scale,
    };
    // Distance from the root (which sits at body centre + eyeHeight) down to the soles.
    metrics.rootToFeet = metrics.halfHeight + metrics.radius + metrics.eyeHeight;
    metrics.modelOffsetY = modelOffsetY * scale - metrics.rootToFeet;
    return metrics;
  }

  async #initializePhysics() {
    this.abortController.signal.throwIfAborted();
    try {
      const physics = await PlayerPhysics.create({
        terrain: this.terrain,
        cameraPosition: this.spawnPosition,
        config: this.config,
        capsule: this.metrics,
      });
      if (this.abortController.signal.aborted) {
        physics?.dispose();
        this.abortController.signal.throwIfAborted();
      }
      this.physics = physics;
      this.spawnAtStart();
    } catch (error) {
      this.abortController.signal.throwIfAborted();
      logger.warn('Rapier player physics failed; using terrain-height fallback.', error);
      this.physics = null;
      this.#snapFallbackToTerrain();
    }
  }

  #createPlaceholder() {
    const material = new THREE.MeshStandardMaterial({ color: 0xd7d9d2, roughness: 0.72 });
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.92, 6, 12), material);
    // Half the placeholder's own height, measured up from the soles at the root's foot line.
    mesh.position.y = 0.8 - this.metrics.rootToFeet;
    mesh.castShadow = true;
    return mesh;
  }

  #setupAnimations(clips) {
    if (!this.model || !clips?.length) return;
    const mixer = new THREE.AnimationMixer(this.model);
    const requested = { ...this.config.player.animations };
    if (this.config.cinematic?.enabled) {
      const generated = createLocomotionClips(this.model);
      clips = [...clips, ...generated];
      const find = pattern => clips.find(clip => pattern.test(clip.name))?.name;
      requested.idle = find(/idle/i) ?? requested.idle;
      requested.walk = find(/walk/i) ?? requested.walk;
      requested.run = find(/run/i) ?? requested.run;
    }
    const actions = Object.fromEntries(clips.map((clip) => [clip.name, mixer.clipAction(clip)]));
    const footsteps = Object.fromEntries(['walk', 'run'].map(kind => [kind,
      measureFootstepContacts(this.model, actions[requested[kind]]?.getClip())]));
    this.animation = {
      footsteps,
      mixer,
      actions,
      names: {
        idle: requested.idle,
        walk: requested.walk,
        run: requested.run,
      },
      current: null,
    };

    const idle = actions[requested.idle];
    if (idle) {
      idle.reset().play();
      this.animation.current = idle;
    }
  }

  #fadeToAction(name, fadeSeconds = this.motion.animationFadeSeconds ?? DEFAULT_ANIMATION_FADE) {
    if (!this.animation) return;
    const next = this.animation.actions[name];
    if (!next) {
      this.animation.current?.fadeOut(fadeSeconds);
      this.animation.current = null;
      return;
    }
    if (this.animation.current === next) return;
    next.reset().fadeIn(fadeSeconds).play();
    this.animation.current?.fadeOut(fadeSeconds);
    this.animation.current = next;
  }

  #updateAnimation() {
    if (!this.animation) return;
    const names = this.animation.names;
    if (this.horizontalVelocity.length() < ANIMATION_IDLE_SPEED) this.#fadeToAction(names.idle);
    else if (this.running) this.#fadeToAction(names.run);
    else this.#fadeToAction(names.walk);
    if (this.animation.current && this.moving) {
      const motion = this.config.cinematic?.motion;
      const speed = motion
        ? this.modelHeight * (this.running ? motion.runSpeedInHeights : motion.walkSpeedInHeights)
        : (this.running ? this.config.player.runSpeed : this.config.player.walkSpeed) * this.scaleRatio;
      this.animation.current.setEffectiveTimeScale(THREE.MathUtils.clamp(this.speed / Math.max(speed, 0.01), 0.55, 1.35));
    }
  }

  #findInfluenceObjects() {
    this.influenceObjects = (this.config.player.influenceObjects ?? [])
      .map((name) => this.model?.getObjectByName(name))
      .filter(Boolean);

    const scale = new THREE.Vector3();
    this.influencePoints = this.influenceObjects.map((object) => {
      object.geometry?.computeBoundingSphere?.();
      object.getWorldScale(scale);
      return {
        object,
        position: new THREE.Vector3(),
        radius: (object.geometry?.boundingSphere?.radius ?? this.config.grass.interaction.footRadius)
          * Math.max(scale.x, scale.z),
      };
    });
  }

  #bindEvents() {
    const { signal } = this.abortController;
    this.domElement.addEventListener('click', () => {
      if (!this.enabled || this.mobile || this.isLocked || !this.cameraControls.pointerLockOnClick) return;
      this.domElement.requestPointerLock?.();
    }, { signal });
    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === this.domElement;
    }, { signal });
    document.addEventListener('mousemove', (event) => {
      if (!this.enabled || this.mobile || !this.isLocked) return;
      const multiplier = this.isSafari ? (this.cameraControls.safariLookMultiplier ?? 8) : 1;
      const sensitivity = this.cameraControls.mouseSensitivity ?? 0.001;
      this.#applyLookDelta(event.movementX * sensitivity * multiplier, event.movementY * sensitivity * multiplier);
    }, { signal });
    window.addEventListener('keydown', (event) => {
      if (!this.enabled || isFormControl(event.target) || !MOVEMENT_KEYS.has(event.code)) return;
      this.keys.add(event.code);
    }, { signal });
    this.domElement.addEventListener('wheel', (event) => {
      if (!this.enabled || this.mobile) return;
      event.preventDefault();
      this.#applyZoomDelta(event.deltaY);
    }, { signal, passive: false });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code), { signal });
    window.addEventListener('blur', () => this.#clearInput(), { signal });
  }

  dispose() {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort();
    this.mobileControls?.destroy();
    this.mobileControls = null;
    this.animation?.mixer.stopAllAction();
    this.physics?.dispose();
    this.physics = null;
    if (this.model) this.root.remove(this.model);
    this.resources.dispose();
    this.model = null;
    this.animation = null;
    this.scene.remove(this.root);
  }

  #syncMobileControls() {
    if (this.mobile && !this.mobileControls) {
      this.mobileControls = new MobileControls({
        joystickRadius: this.cameraControls.mobileJoystickRadius ?? 55,
        lookSensitivity: this.cameraControls.mobileLookSensitivity ?? 0.015,
        onMove: (x, y) => {
          this.mobileMoveX = x;
          this.mobileMoveY = y;
        },
        onLook: (dx, dy) => this.#applyLookDelta(dx, dy),
        onSprint: (enabled) => {
          this.mobileSprinting = enabled;
        },
      });
      return;
    }
    if (!this.mobile && this.mobileControls) {
      this.mobileControls.destroy();
      this.mobileControls = null;
    }
  }

  #applyZoomDelta(deltaY) {
    const sensitivity = this.cameraControls.zoomSensitivity ?? 0.01;
    const min = (this.config.camera.minDistance ?? 1.5) * this.scaleRatio;
    const max = (this.config.camera.maxDistance ?? 24) * this.scaleRatio;
    this.targetCameraDistance = THREE.MathUtils.clamp(
      this.targetCameraDistance + deltaY * sensitivity,
      min,
      max,
    );
  }

  #applyLookDelta(deltaX, deltaY) {
    this.cameraYaw -= deltaX;
    this.cameraPitch = THREE.MathUtils.clamp(
      this.cameraPitch - deltaY,
      this.cameraControls.minPitch,
      this.cameraControls.maxPitch,
    );
  }

  #clearInput() {
    this.keys.clear();
    this.mobileMoveX = 0;
    this.mobileMoveY = 0;
    this.mobileSprinting = false;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled) return;
    this.#clearInput();
    this.horizontalVelocity.set(0, 0, 0);
    this.speed = 0;
    this.moving = false;
    this.running = false;
    this.#fadeToAction(this.animation?.names.idle);
  }

  // `player.start` carries a fixed height that suited one character size. Tall
  // characters spawned half a metre inside the ground there, and the Rapier
  // controller treated the surrounding terrain edges as walls, so the player
  // ran in place. Place the start on the terrain for the loaded character.
  spawnAtStart() {
    const [x, , z] = this.config.player.start;
    this.setPosition(
      x,
      this.terrainSampler.sampleHeight(x, z) + this.metrics.rootToFeet + this.metrics.groundOffset,
      z,
    );
    this.verticalVelocity = 0;
  }

  setPosition(x, y, z) {
    if (this.physics) {
      this.physics.setPosition(x, y, z);
      this.physics.getVisualPosition(this.root.position);
    } else {
      this.root.position.set(x, 0, z);
      this.#snapFallbackToTerrain();
    }
    this.camera.position.set(x, y + this.cameraControls.cameraHeight, z + this.cameraDistance);
  }

  translateRoot(x, y, z) {
    const current = this.getPosition();
    this.camera.position.x += x - current.x;
    this.camera.position.y += y - current.y;
    this.camera.position.z += z - current.z;
    if (this.physics) {
      this.physics.setPosition(x, y, z);
      this.physics.getVisualPosition(this.root.position);
    } else {
      this.root.position.set(x, y, z);
    }
    this.verticalVelocity = 0;
  }

  update(deltaSeconds) {
    if (deltaSeconds <= 0) return;
    if (this.enabled) this.#updateMovement(deltaSeconds);
    this.#updateAnimation();
    this.animation?.mixer.update(deltaSeconds);
    this.footPlacement?.update(this.grounded, this.root.position.y - this.metrics.rootToFeet);
    if (this.enabled) this.#updateCamera(deltaSeconds);
  }

  #updateMovement(deltaSeconds) {
    this.move.set(0, 0, 0);
    if (this.mobile) {
      this.move.x = this.mobileMoveX;
      this.move.z = this.mobileMoveY;
    } else {
      if (this.keys.has('KeyW')) this.move.z -= 1;
      if (this.keys.has('KeyS')) this.move.z += 1;
      if (this.keys.has('KeyA')) this.move.x -= 1;
      if (this.keys.has('KeyD')) this.move.x += 1;
    }

    const hasInput = this.move.lengthSq() > MOVE_EPSILON;
    if (hasInput) this.move.clampLength(0, 1);

    this.forward.set(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
    this.right.set(this.forward.z, 0, -this.forward.x);
    this.desiredDirection.set(0, 0, 0)
      .addScaledVector(this.forward, this.move.z)
      .addScaledVector(this.right, this.move.x);

    if (this.desiredDirection.lengthSq() > MOVE_EPSILON) {
      this.desiredDirection.normalize();
      const desiredYaw = Math.atan2(this.desiredDirection.x, this.desiredDirection.z);
      const turn = shortestAngleDelta(this.playerYaw, desiredYaw);
      this.playerYaw += turn * Math.min(1, this.config.player.turnSpeed * deltaSeconds);
    }

    const sprinting = this.mobile
      ? this.mobileSprinting
      : this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const baseWalkSpeed = this.config.player.walkSpeed ?? 2.5;
    const baseRunSpeed = this.config.player.runSpeed ?? 15;
    const cinematicMotion = this.config.cinematic?.enabled && this.config.cinematic.motion;
    const targetSpeed = cinematicMotion && this.modelHeight > 0
      ? this.modelHeight * (sprinting ? cinematicMotion.runSpeedInHeights : cinematicMotion.walkSpeedInHeights)
      : (sprinting ? baseRunSpeed : baseWalkSpeed) * this.scaleRatio;
    const currentSpeed = this.horizontalVelocity.length();

    if (hasInput) {
      const acceleration = this.motion.acceleration * this.scaleRatio * deltaSeconds;
      const nextSpeed = currentSpeed < targetSpeed
        ? Math.min(currentSpeed + acceleration, targetSpeed)
        : Math.max(currentSpeed - acceleration, targetSpeed);
      this.horizontalVelocity.copy(this.desiredDirection).multiplyScalar(nextSpeed);
    } else if (this.grounded || !this.physics) {
      const friction = this.motion.deceleration * this.scaleRatio * deltaSeconds;
      if (currentSpeed <= friction) this.horizontalVelocity.set(0, 0, 0);
      else this.horizontalVelocity.normalize().multiplyScalar(currentSpeed - friction);
    }

    if (this.physics) this.#updatePhysics(deltaSeconds);
    else this.#updateFallbackMovement(deltaSeconds);

    this.speed = this.horizontalVelocity.length();
    this.moving = this.speed >= (ANIMATION_IDLE_SPEED * this.scaleRatio);
    this.running = this.moving && sprinting;
  }

  #updatePhysics(deltaSeconds) {
    this.verticalVelocity += (this.config.player.gravity ?? -25) * deltaSeconds;
    this.movement.copy(this.horizontalVelocity).multiplyScalar(deltaSeconds);
    this.movement.y = this.verticalVelocity * deltaSeconds;
    const result = this.physics.move(this.movement);
    this.grounded = result.grounded;
    if (this.grounded && this.verticalVelocity < 0) this.verticalVelocity = 0;

    this.root.position.set(
      result.position.x,
      result.position.y + this.metrics.eyeHeight,
      result.position.z,
    );
    this.targetQuaternion.setFromAxisAngle(this.cameraUp, this.playerYaw);
    this.root.quaternion.slerp(this.targetQuaternion, this.config.player.turnSpeed * deltaSeconds);

    if (result.position.y < this.spawnPosition.y - FALL_RESET_HEIGHT) {
      this.spawnAtStart();
    }
  }

  #updateFallbackMovement(deltaSeconds) {
    const padding = this.config.player.boundsPadding ?? 0;
    const nextX = this.root.position.x + this.horizontalVelocity.x * deltaSeconds;
    const nextZ = this.root.position.z + this.horizontalVelocity.z * deltaSeconds;

    if (this.terrainSampler.contains(nextX, this.root.position.z, padding)) this.root.position.x = nextX;
    else this.horizontalVelocity.x = 0;
    if (this.terrainSampler.contains(this.root.position.x, nextZ, padding)) this.root.position.z = nextZ;
    else this.horizontalVelocity.z = 0;
    this.#snapFallbackToTerrain();
    this.root.rotation.y = this.playerYaw;
    this.grounded = true;
  }

  #snapFallbackToTerrain() {
    this.root.position.y = this.terrainSampler.sampleHeight(this.root.position.x, this.root.position.z)
      + this.metrics.rootToFeet
      + this.metrics.groundOffset;
  }

  // Cached in handleResize(): reading window.innerWidth every frame is a layout
  // read that can force a synchronous style flush after HUD text updates.
  #targetOffset() {
    return this.cachedTargetOffset ?? this.#computeTargetOffset();
  }

  #computeTargetOffset() {
    const breakpoint = this.cameraControls.mobileBreakpoint ?? MOBILE_BREAKPOINT;
    return window.innerWidth > breakpoint
      ? window.innerWidth * this.cameraControls.desktopTargetOffsetFactor
      : this.cameraControls.mobileTargetOffset;
  }

  #initializeCamera() {
    const start = this.config.player.start;
    this.camera.position.set(
      start[0],
      start[1] + this.cameraControls.cameraHeight,
      start[2] + this.cameraDistance,
    );
  }

  #updateCamera(deltaSeconds) {
    const bodyPosition = this.physics?.getBodyPosition();
    const bodyX = bodyPosition?.x ?? this.root.position.x;
    const bodyY = bodyPosition?.y ?? this.root.position.y - this.metrics.eyeHeight;
    const bodyZ = bodyPosition?.z ?? this.root.position.z;

    const framing = this.config.cinematic?.enabled && this.modelHeight > 0 && this.config.cinematic.camera;
    const targetHeight = framing ? this.modelHeight * (framing.targetInHeights - 0.5) : (this.cameraControls.targetHeight ?? 1.6) * this.scaleRatio;
    const cameraHeight = framing ? this.modelHeight * framing.heightInHeights : (this.cameraControls.cameraHeight ?? 1.2) * this.scaleRatio;
    const shoulderOffset = framing ? this.modelHeight * framing.shoulderInHeights : (this.cameraControls.shoulderOffset ?? 0.6) * this.scaleRatio;

    this.cameraTarget.set(
      bodyX,
      bodyY + targetHeight,
      bodyZ,
    );
    this.cameraRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.cameraTarget.add(this.cameraRight.multiplyScalar(this.#targetOffset()));

    const zoomFactor = 1 - Math.exp(-(this.cameraControls.zoomSharpness ?? 12) * deltaSeconds);
    this.cameraDistance += (this.targetCameraDistance - this.cameraDistance) * zoomFactor;

    this.cameraOffset.set(
      -shoulderOffset,
      cameraHeight,
      this.cameraDistance,
    );
    this.yawQuaternion.setFromAxisAngle(this.cameraUp, this.cameraYaw);
    this.cameraOffset.applyQuaternion(this.yawQuaternion);
    this.forward.set(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
    this.pitchAxis.copy(this.forward).cross(this.cameraUp).normalize();
    this.pitchQuaternion.setFromAxisAngle(this.pitchAxis, this.cameraPitch);
    this.cameraOffset.applyQuaternion(this.pitchQuaternion);
    this.desiredCameraPosition.copy(this.cameraTarget).add(this.cameraOffset);
    clampCameraAboveTerrain(
      this.desiredCameraPosition,
      this.terrainSampler,
      this.cameraControls.terrainClearance,
    );

    const factor = 1 - Math.exp(-(this.cameraControls.followSharpness ?? 8) * deltaSeconds);
    this.camera.position.lerp(this.desiredCameraPosition, factor);
    clampCameraAboveTerrain(
      this.camera.position,
      this.terrainSampler,
      this.cameraControls.terrainClearance,
    );
    this.camera.lookAt(this.cameraTarget);
  }

  handleResize() {
    const breakpoint = this.cameraControls.mobileBreakpoint ?? MOBILE_BREAKPOINT;
    const mobile = window.innerWidth < breakpoint;
    this.cachedTargetOffset = this.#computeTargetOffset();
    const baseDistance = mobile
      ? this.cameraControls.mobileDistance
      : this.cameraControls.desktopDistance;
    this.cameraDistance = this.config.cinematic?.enabled && this.modelHeight > 0
      ? this.modelHeight * this.config.cinematic.camera.distanceInHeights * (mobile ? 1.25 : 1)
      : baseDistance * this.scaleRatio;
    this.targetCameraDistance = this.cameraDistance;
    if (mobile === this.mobile) return;
    this.mobile = mobile;
    this.#clearInput();
    if (this.mobile) {
      this.isLocked = false;
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
    this.#syncMobileControls();
  }

  getPosition() {
    return this.root.position;
  }

  getCharacterModel() {
    return this.model ?? this.root;
  }

  getInfluencePoints() {
    if (this.influencePoints.length > 0) {
      for (const point of this.influencePoints) point.object.getWorldPosition(point.position);
      return this.influencePoints;
    }

    this.forward.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    this.right.set(this.forward.z, 0, -this.forward.x);
    const base = this.footBase.copy(this.root.position);
    base.y -= this.metrics.rootToFeet;
    const footOffset = 0.18 * this.scaleRatio;
    const footRadius = (this.config.grass?.interaction?.footRadius ?? 0.72) * this.scaleRatio;
    this.influenceFallback[0].radius = footRadius;
    this.influenceFallback[1].radius = footRadius;
    this.influenceFallback[0].position.copy(base).addScaledVector(this.right, footOffset).addScaledVector(this.forward, footOffset);
    this.influenceFallback[1].position.copy(base).addScaledVector(this.right, -footOffset).addScaledVector(this.forward, -footOffset);
    return this.influenceFallback;
  }

  getMovementState(surface = 'grass') {
    return {
      moving: this.moving,
      running: this.running,
      speed: this.speed,
      surface,
    };
  }
}
