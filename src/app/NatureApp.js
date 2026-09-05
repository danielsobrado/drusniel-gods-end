import * as THREE from 'three';
import { damp, clamp } from '../core/math.js';
import { PlayerController } from '../player/PlayerController.js';
import { Hud } from '../ui/Hud.js';
import { GrassField } from '../world/GrassField.js';
import { RainSystem } from '../world/RainSystem.js';
import { createWorld } from '../world/createWorld.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class NatureApp {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.elapsedSeconds = 0;
    this.cameraYaw = 0;
    this.cameraPitch = config.camera.pitch;
    this.dragging = false;
    this.animationFrame = null;
    this.cameraTarget = new THREE.Vector3();
    this.cameraOffset = new THREE.Vector3();
    this.cameraForward = new THREE.Vector3();
    this.cameraPitchAxis = new THREE.Vector3();
    this.desiredCameraPosition = new THREE.Vector3();

    this.camera = new THREE.PerspectiveCamera(
      config.camera.fov,
      window.innerWidth / window.innerHeight,
      config.camera.near,
      config.camera.far,
    );
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.#getPixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = config.renderer.exposure;
    this.root.appendChild(this.renderer.domElement);

    this.world = createWorld(this.scene, config);
    this.grass = new GrassField(this.scene, config.grass);
    this.rain = new RainSystem(this.scene, config.rain);
    this.player = new PlayerController(this.scene, config.player);
    this.hud = new Hud(root, config.presets, config.ui.initialPreset, (preset) => this.setPreset(preset));

    this.#bindEvents();
    this.setPreset(config.ui.initialPreset);
    this.#updateCamera(1);
  }

  #bindEvents() {
    this.onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.#getPixelRatio());
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    this.onPointerDown = () => { this.dragging = true; };
    this.onPointerUp = () => { this.dragging = false; };
    this.onPointerMove = (event) => {
      if (!this.dragging) return;
      this.cameraYaw -= event.movementX * this.config.camera.lookSensitivityX;
      this.cameraPitch = clamp(
        this.cameraPitch - event.movementY * this.config.camera.lookSensitivityY,
        this.config.camera.minPitch,
        this.config.camera.maxPitch,
      );
    };
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
  }

  setPreset(name) {
    const preset = this.config.presets[name];
    if (!preset) return;
    this.scene.background.set(preset.background);
    this.scene.fog.color.set(preset.fog);
    this.world.sun.intensity = preset.sunIntensity;
    this.rain.setIntensity(preset.rain);
  }

  #getPixelRatio() {
    const configured = Number(this.config.renderer.pixelRatio);
    return Number.isFinite(configured)
      ? configured
      : Math.min(window.devicePixelRatio, this.config.renderer.pixelRatioCap);
  }

  #updateCamera(deltaSeconds) {
    this.cameraTarget.copy(this.player.position);
    this.cameraTarget.y += this.config.camera.targetHeight;

    this.cameraOffset.set(
      -this.config.camera.shoulderOffset,
      this.config.camera.height,
      this.config.camera.distance,
    );
    this.cameraOffset.applyAxisAngle(WORLD_UP, this.cameraYaw);

    this.cameraForward.set(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
    this.cameraPitchAxis.copy(this.cameraForward).cross(WORLD_UP).normalize();
    this.cameraOffset.applyAxisAngle(this.cameraPitchAxis, this.cameraPitch);

    this.desiredCameraPosition.copy(this.cameraTarget).add(this.cameraOffset);
    const sharpness = this.config.camera.followSharpness;
    this.camera.position.x = damp(this.camera.position.x, this.desiredCameraPosition.x, sharpness, deltaSeconds);
    this.camera.position.y = damp(this.camera.position.y, this.desiredCameraPosition.y, sharpness, deltaSeconds);
    this.camera.position.z = damp(this.camera.position.z, this.desiredCameraPosition.z, sharpness, deltaSeconds);
    this.camera.lookAt(this.cameraTarget);
  }

  start() {
    const frame = () => {
      const deltaSeconds = Math.min(this.clock.getDelta(), 0.05);
      this.elapsedSeconds += deltaSeconds;
      this.player.update(deltaSeconds, this.cameraYaw);
      this.grass.update(this.elapsedSeconds);
      this.rain.update(deltaSeconds, this.player.position);
      this.#updateCamera(deltaSeconds);
      this.renderer.render(this.scene, this.camera);
      this.animationFrame = requestAnimationFrame(frame);
    };
    frame();
  }

  dispose() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.hud.dispose();
    this.player.dispose();
    this.rain.dispose();
    this.grass.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
