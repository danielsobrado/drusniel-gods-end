import * as THREE from 'three';
import { AudioSystem } from '../audio/AudioSystem.js';
import { BirdSystem } from '../foliage/BirdSystem.js';
import { LeafSystem } from '../foliage/LeafSystem.js';
import { GrassField } from '../grass/GrassField.js';
import { WorldCollisionSystem } from '../physics/WorldCollisionSystem.js';
import { PlayerController } from '../player/PlayerController.js';
import { DemoUi } from '../ui/DemoUi.js';
import { IrisTransition } from '../ui/IrisTransition.js';
import { LoadingUi } from '../ui/LoadingUi.js';
import { WaterSurface } from '../water/WaterSurface.js';
import { RainSystem } from '../weather/RainSystem.js';
import { EnvironmentController } from '../world/EnvironmentController.js';
import { TreeSystem } from '../world/TreeSystem.js';
import { WorldPropSystem } from '../world/WorldPropSystem.js';
import { BoundaryBarrier } from '../world/BoundaryBarrier.js';
import { ZoneIndex } from '../world/ZoneIndex.js';
import { logger } from '../utils/logger.js';
import {
  applyCharacter,
  defaultCharacterId,
  getRoster,
  requestedCharacterId,
} from '../config/characterRoster.js';
import { createTrees } from '../world/createTrees.js';
import { createWorld } from '../world/createWorld.js';
import { getRendererPixelRatio } from '../world/getRendererPixelRatio.js';
import { loadTreeWorldData } from '../world/loadTreeWorldData.js';
import { loadWorldPropData } from '../world/loadWorldPropData.js';
import { CinematicLighting } from '../rendering/CinematicLighting.js';
import { CinematicPipeline } from '../rendering/CinematicPipeline.js';
import { MeadowDetails } from '../foliage/MeadowDetails.js';
import { ScenicTour } from '../rendering/ScenicTour.js';
import { findCharacter } from '../config/characterRoster.js';

const MIN_PIXEL_RATIO = 0.5;
const TREE_COLLIDER_HEIGHT_FACTOR = 0.5;

export class GrassDemo {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.clock = new THREE.Clock();
    this.surface = 'grass';
    this.pixelRatioOverride = null;
    this.pixelRatio = getRendererPixelRatio(config);
    this.abortController = new AbortController();
    this.renderErrorLogged = false;
    this.loading = null;
    this.disposed = false;
  }

  async start() {
    const loading = new LoadingUi(this.root, this.config.cinematic?.presentation, {
      roster: getRoster(this.config),
      selectedId: this.resumeState?.characterId ?? requestedCharacterId(window.location.search, this.config),
    });
    this.loading = loading;
    this.world = await createWorld(this.config, (stage) => loading.stage(stage), {
      signal: this.abortController.signal,
      rendererRequest: this.rendererRequest,
    });
    this.abortController.signal.throwIfAborted();
    this.onRendererReady?.(this.world.rendererSession);
    this.abortController.signal.throwIfAborted();
    this.cinematicLighting = new CinematicLighting(this.world, this.config);
    this.root.appendChild(this.world.renderer.domElement);

    if (loading.needsCharacterChoice()) loading.stage('character');
    const chosenId = await loading.waitForCharacter();
    this.abortController.signal.throwIfAborted();
    this.character = applyCharacter(this.config, chosenId ?? defaultCharacterId(this.config));

    loading.stage('player');
    this.player = new PlayerController(
      this.world.scene,
      this.world.camera,
      this.world.renderer.domElement,
      this.config,
      this.world.terrainSampler,
      this.world.terrainTarget,
    );
    await this.player.loadModel();
    this.abortController.signal.throwIfAborted();

    loading.stage('collision');
    this.collisions = new WorldCollisionSystem({
      physics: this.player.physics,
      player: this.player.getCharacterModel(),
      scene: this.world.scene,
      config: this.config.collisions,
    });

    const [treeWorldData, worldPropData] = await Promise.all([
      loadTreeWorldData(this.config),
      loadWorldPropData(this.config),
    ]);
    this.abortController.signal.throwIfAborted();
    this.props = new WorldPropSystem({
      scene: this.world.scene,
      terrainRoot: this.world.terrain,
      config: this.config,
      data: worldPropData,
      collisionSystem: this.collisions,
    }).init();
    this.zoneIndex = new ZoneIndex(this.world.terrain, this.config);
    this.trees = new TreeSystem({
      scene: this.world.scene,
      camera: this.world.camera,
      terrainRoot: this.world.terrain,
      zoneIndex: this.zoneIndex,
      config: this.config,
      worldData: treeWorldData,
      fallbackFactory: () => createTrees(this.world.scene, this.config),
    }).init();
    this.#registerTreeColliders();
    this.#registerRecoveredWorldColliders();
    this.leaves = new LeafSystem({
      scene: this.world.scene,
      player: this.player,
      zoneIndex: this.zoneIndex,
      config: this.config,
    });

    loading.stage('foliage');
    this.birds = new BirdSystem({
      scene: this.world.scene,
      terrainRoot: this.world.terrain,
      clips: this.world.terrainAnimationClips ?? [],
      terrainSampler: this.world.terrainSampler,
      config: this.config,
    });

    loading.stage('grass');
    this.grass = new GrassField(
      this.world.scene,
      this.world.camera,
      this.world.renderer,
      this.config,
      this.world.terrainSampler,
      this.trees.trees,
    );
    await this.grass.init(this.abortController.signal);
    this.abortController.signal.throwIfAborted();
    if (this.config.cinematic?.enabled) {
      this.meadow = new MeadowDetails(this.world.scene, this.config, this.world.terrainSampler, this.grass, this.trees);
    }

    this.water = new WaterSurface(
      this.world.scene,
      this.world.renderer,
      this.world.terrain,
      this.grass.grassTerrainData,
      this.config,
    );
    this.boundaryBarrier = new BoundaryBarrier({
      scene: this.world.scene,
      terrainRoot: this.world.terrain,
      terrainSampler: this.world.terrainSampler,
      config: this.config,
    }).init();
    this.boundaryBarrier.update(0, this.player.getPosition());
    this.rain = new RainSystem(
      this.world.scene,
      this.player.getCharacterModel(),
      this.config,
    );

    loading.stage('audio');
    this.audio = new AudioSystem({
      camera: this.world.camera,
      scene: this.world.scene,
      controls: this.player,
      preset: this.config.ui.initialPreset,
      waterMesh: this.water.mesh,
      config: this.config,
    });
    await this.audio.init();
    this.abortController.signal.throwIfAborted();
    this.environment = new EnvironmentController({
      scene: this.world.scene,
      sun: this.world.sun,
      hemisphere: this.world.hemisphere,
      ambient: this.world.ambient,
      sky: this.world.sky,
      clouds: this.world.clouds,
      grass: this.grass,
      rain: this.rain,
      water: this.water,
      trees: this.trees,
      leaves: this.leaves,
      audio: this.audio,
      terrain: this.world.terrainTarget,
      config: this.config,
    });

    if (this.resumeState) {
      // Restore state before constructing controls so their initial values
      // describe the recovered scene, including each grass family's defaults.
      for (const [name, value] of Object.entries(this.resumeState.grassParameters ?? {})) {
        this.environment.setGrassParameter(name, value);
      }
      this.grass.setInteractionEnabled(this.resumeState.interactionEnabled ?? true);
      if (Number.isFinite(this.resumeState.pixelRatioOverride)) {
        this.pixelRatioOverride = this.resumeState.pixelRatioOverride;
        this.pixelRatio = this.pixelRatioOverride;
      }
      if (this.resumeState.audioVolumes) {
        this.audio.setMasterVolume(this.resumeState.audioVolumes.master);
        this.audio.setAmbientVolume(this.resumeState.audioVolumes.ambient);
        this.audio.setEnvironmentVolume(this.resumeState.audioVolumes.environment);
      }
    }
    this.tour = new ScenicTour(this.world, this.player, this.trees, this.water);
    this.iris = new IrisTransition(this.root);
    this.ui = new DemoUi(this.root, this.config, this.#createUiActions());
    this.pipeline = new CinematicPipeline(this.world, this.config);

    loading.stage('shaders');
    this.cinematicLighting.activateShadows();
    await this.world.renderer.compileAsync(this.world.scene, this.world.camera);
    this.abortController.signal.throwIfAborted();
    window.addEventListener('resize', () => this.#resize(), { signal: this.abortController.signal });
    this.#resize();

    loading.stage('ready');
    this.world.renderer.setAnimationLoop(() => this.#render());
    if (this.resumeState?.started) {
      // Resize resets the controller's zoom, so restore the pose only after
      // the final resize (including a recovered pixel-ratio override).
      this.#restorePose(this.resumeState);
      if (this.resumeState.soundEnabled) {
        try {
          await this.audio.start();
        } catch (error) {
          logger.warn('Audio context could not resume after renderer recovery.', error);
        }
      }
      this.abortController.signal.throwIfAborted();
      loading.dispose();
      this.loading = null;
      this.started = true;
      return;
    }
    await loading.waitForStart(async () => {
      try {
        await this.audio.start();
      } catch (error) {
        logger.warn('Audio context could not start from the start gate.', error);
      }
      this.player.setPosition(...this.config.player.start);
    });
    this.abortController.signal.throwIfAborted();
    this.started = true;
    this.loading = null;
  }

  captureSessionState() {
    const config = structuredClone(this.config);
    config.ui.initialPreset = this.environment?.currentPreset ?? config.ui.initialPreset;
    config.ui.initialQuality = this.grass?.qualityName ?? config.ui.initialQuality;
    if (this.grass) config.grass.shape = this.grass.shape;
    const characterId = this.character?.id ?? defaultCharacterId(config);
    if (!findCharacter(config, characterId)) throw new Error('Cannot recover unknown character.');
    return {
      config, characterId, started: Boolean(this.started), soundEnabled: Boolean(this.audio?.enabled),
      pixelRatioOverride: this.pixelRatioOverride,
      grassParameters: { ...this.environment?.grassOverrides },
      audioVolumes: this.audio && { master: this.audio.masterVolume,
        ambient: this.audio.ambientVolume, environment: this.audio.environmentVolume },
      interactionEnabled: this.grass?.interactionMap.enabled,
      position: this.player?.getPosition().toArray(),
      camera: this.world?.camera.position.toArray(),
      quaternion: this.world?.camera.quaternion.toArray(),
      cameraYaw: this.player?.cameraYaw, cameraPitch: this.player?.cameraPitch,
      cameraDistance: this.player?.cameraDistance, playerYaw: this.player?.playerYaw,
    };
  }

  #restorePose(state) {
    if (state.position) this.player.setPosition(...state.position);
    for (const key of ['cameraYaw', 'cameraPitch', 'cameraDistance', 'playerYaw']) {
      if (Number.isFinite(state[key])) this.player[key] = state[key];
    }
    this.player.targetCameraDistance = this.player.cameraDistance;
    if (state.camera) this.world.camera.position.fromArray(state.camera);
    if (state.quaternion) this.world.camera.quaternion.fromArray(state.quaternion);
  }

  #registerTreeColliders() {
    if (!this.collisions || !this.trees?.trees?.length) return;
    for (const tree of this.trees.trees) {
      const collider = this.config.trees.types?.[tree.typeIndex]?.collider;
      if (!collider) continue;
      this.collisions.addBox(
        new THREE.Vector3(
          tree.position.x,
          tree.position.y + collider.height * TREE_COLLIDER_HEIGHT_FACTOR,
          tree.position.z,
        ),
        new THREE.Vector3(
          collider.width * tree.scale,
          collider.height * tree.scale,
          collider.length * tree.scale,
        ),
      );
    }
  }

  #registerRecoveredWorldColliders() {
    if (!this.collisions || !this.world.terrain) return;
    for (const record of this.config.collisions?.worldBounds ?? []) {
      this.collisions.addBox(
        new THREE.Vector3().fromArray(record.position),
        new THREE.Vector3().fromArray(record.size),
      );
    }

    for (const name of this.config.collisions?.trimeshObjects ?? []) {
      const object = this.world.terrain.getObjectByName(name);
      if (!object) continue;
      object.visible = false;
      this.collisions.addTrimeshFromObject(object);
    }
  }

  #createUiActions() {
    return {
      setPreset: (name) => this.iris.run(() => this.environment.setPreset(name), 'preset'),
      toggleTour: () => this.tour.start(),
      stopTour: () => this.tour.stop(),
      isTourActive: () => this.tour.active,
      setQuality: (name) => {
        this.grass.setQuality(name);
        this.environment.setQuality(name);
        this.pipeline?.setQuality(name);
        this.meadow?.setQuality(name);
        this.water?.setQuality(name);
      },
      setGrassShape: (shape) => this.iris.run(() => this.grass.setGrassShape(shape), 'grassShape'),
      getGrassParameters: (family) => this.environment.current.grass[family],
      setGrassParameter: (name, value) => {
        const apply = () => this.environment.setGrassParameter(name, value);
        if (this.iris.running) return this.iris.run(apply, `grassParam:${name}`);
        return apply();
      },
      getPixelRatio: () => this.pixelRatio,
      setPixelRatio: (value) => {
        const cap = this.config.renderer.pixelRatioCap;
        this.pixelRatioOverride = THREE.MathUtils.clamp(Number(value), MIN_PIXEL_RATIO, cap);
        this.pixelRatio = this.pixelRatioOverride;
        this.#resize();
      },
      setInteractionEnabled: (enabled) => this.grass.setInteractionEnabled(enabled),
      getInteractionEnabled: () => this.grass.interactionMap.enabled,
      getTriangleCount: () => this.world.renderer.info.render.triangles,
      getOcclusionStats: () => this.pipeline?.gpuOcclusion.stats,
    };
  }

  #resize() {
    const { camera, renderer } = this.world;
    this.player?.handleResize();
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (this.pixelRatioOverride === null) this.pixelRatio = getRendererPixelRatio(this.config);
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    this.cinematicLighting?.resize();
  }

  #detectSurface() {
    const position = this.player.getPosition();
    if (this.water.containsPoint(position)) return 'water';
    const ecology = this.grass.sampleVegetation(position.x, position.z);
    return ecology.path >= this.config.vegetation.surfacePathThreshold ? 'mud' : 'grass';
  }

  #render() {
    try {
      this.#renderFrame();
    } catch (error) {
      if (!this.renderErrorLogged) {
        this.renderErrorLogged = true;
        logger.error('Render loop threw; continuing. Further errors are suppressed.', error);
      }
    }
  }

  #renderFrame() {
    if (this.disposed) return;
    const deltaSeconds = Math.min(this.clock.getDelta(), 0.05);
    const elapsedSeconds = this.clock.elapsedTime;

    this.player.update(deltaSeconds);
    this.tour.update(deltaSeconds);
    this.world.terrainAnimations?.update(deltaSeconds);
    this.leaves.update(deltaSeconds);
    this.world.clouds?.update?.(deltaSeconds);
    this.trees.update(deltaSeconds);
    this.rain.update();
    this.birds.update(deltaSeconds);

    this.surface = this.#detectSurface();
    this.audio.update(deltaSeconds);
    this.collisions.update();
    this.grass.update(
      deltaSeconds,
      elapsedSeconds,
      this.player.getPosition(),
      this.player.getInfluencePoints(),
    );
    const focus = this.tour.active ? this.world.camera.position : this.player.getPosition();
    this.environment.updateSunTarget(focus);
    this.cinematicLighting.update();
    this.meadow?.update(deltaSeconds, focus, this.environment.current);
    this.boundaryBarrier?.update(deltaSeconds, this.player.getPosition());
    this.water.update(deltaSeconds, this.player, this.environment.current.lighting);
    this.pipeline.render({ occlusionEnabled: true });
    this.ui.update(deltaSeconds);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.world?.renderer?.setAnimationLoop(null);
    for (const resource of [this.loading, this.pipeline, this.cinematicLighting,
      this.meadow, this.ui, this.iris, this.grass, this.trees, this.props,
      this.collisions, this.player, this.leaves, this.birds, this.rain,
      this.boundaryBarrier, this.water, this.audio, this.environment, this.world]) {
      try { resource?.dispose?.(); } catch (error) { logger.warn('Demo cleanup failed.', error); }
    }
    this.abortController.abort();
  }
}
