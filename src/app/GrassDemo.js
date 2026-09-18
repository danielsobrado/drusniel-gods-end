import * as THREE from 'three';
import { AudioSystem } from '../audio/AudioSystem.js';
import { BirdSystem } from '../foliage/BirdSystem.js';
import { LeafSystem } from '../foliage/LeafSystem.js';
import { GrassField } from '../grass/GrassField.js';
import { WorldCollisionSystem } from '../physics/WorldCollisionSystem.js';
import { PlayerController } from '../player/PlayerController.js';
import { WorldNavigation } from '../player/WorldNavigation.js';
import { DemoUi } from '../ui/DemoUi.js';
import { IrisTransition } from '../ui/IrisTransition.js';
import { LoadingUi } from '../ui/LoadingUi.js';
import { WaterSurface } from '../water/WaterSurface.js';
import { RainSystem } from '../weather/RainSystem.js';
import { SnowfallSystem } from '../weather/SnowfallSystem.js';
import { EnvironmentController } from '../world/EnvironmentController.js';
import { SnowRegionTracker } from '../world/SnowAtmosphere.js';
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
import { ContactShadow } from '../player/ContactShadow.js';
import { getRendererPixelRatio } from '../world/getRendererPixelRatio.js';
import { loadTreeWorldData } from '../world/loadTreeWorldData.js';
import { loadWorldPropData } from '../world/loadWorldPropData.js';
import { CinematicLighting } from '../rendering/CinematicLighting.js';
import { CinematicPipeline } from '../rendering/CinematicPipeline.js';
import { MeadowDetails } from '../foliage/MeadowDetails.js';
import { UnderstorySystem } from '../foliage/UnderstorySystem.js';
import { WildGrassSystem } from '../foliage/WildGrassSystem.js';
import { ScenicTour } from '../rendering/ScenicTour.js';
import { adaptLandscapeRecords } from '../world/ExpandedLandscape.js';
import { findCharacter } from '../config/characterRoster.js';
import { FrameProfiler, isProfileRequested } from '../debug/FrameProfiler.js';
import { GpuCreationProbe } from '../debug/gpuCreationHooks.js';
import { createVegetationJobScheduler } from '../foliage/vegetationRebuild.js';
import { BiomePropSystem } from '../biome/BiomePropSystem.js';
import { CoastalJungleSystem } from '../biome/CoastalJungleSystem.js';
import { commitPresetChange, preparePresetChange } from '../biome/presetSwitch.js';
import { resolvePresetConfig } from '../config/resolvePresetConfig.js';
import { disposePresetAppearance } from '../rendering/PresetAppearance.js';

const MIN_PIXEL_RATIO = 0.5;
const TREE_COLLIDER_HEIGHT_FACTOR = 0.5;

export class GrassDemo {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.clock = new THREE.Clock();
    this.pixelRatioOverride = null;
    this.pixelRatio = getRendererPixelRatio(config);
    this.abortController = new AbortController();
    this.renderErrorLogged = false;
    this.loading = null;
    this.disposed = false;
    this.profiler = null;
    this.lastReflectionCaptures = 0;
    this.gpuTimestamp = null;
    this.gpuTimestampPending = false;
    this.presetGeneration = 0;
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
      rendererOptions: { trackTimestamp: isProfileRequested() },
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
    this.contactShadow = new ContactShadow({
      scene: this.world.scene,
      player: this.player,
      terrain: this.world.terrainSampler,
      config: this.config,
    });

    loading.stage('collision');
    this.collisions = new WorldCollisionSystem({
      physics: this.player.physics,
      player: this.player.getCharacterModel(),
      scene: this.world.scene,
      config: this.config.collisions,
    });

    const [loadedTrees, loadedProps] = await Promise.all([
      loadTreeWorldData(this.config),
      loadWorldPropData(this.config),
    ]);
    const { trees: treeWorldData, props: worldPropData } = adaptLandscapeRecords(
      loadedTrees, loadedProps, this.world.expansion, this.world.terrainSampler,
    );
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
    this.vegetationJobs = createVegetationJobScheduler();
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
      this.meadow = new MeadowDetails(
        this.world.scene,
        this.config,
        this.world.terrainSampler,
        this.grass,
        this.trees,
        this.props.pebbleSources,
        { jobs: this.vegetationJobs },
      );
    }
    this.wildGrass = new WildGrassSystem({
      scene: this.world.scene,
      config: this.config,
      terrain: this.world.terrainSampler,
      grass: this.grass,
      jobs: this.vegetationJobs,
    });
    await this.wildGrass.init();
    this.abortController.signal.throwIfAborted();
    this.understory = new UnderstorySystem({
      scene: this.world.scene,
      renderer: this.world.renderer,
      camera: this.world.camera,
      config: this.config,
      terrain: this.world.terrainSampler,
      grass: this.grass,
      jobs: this.vegetationJobs,
    });
    await this.understory.init();
    this.abortController.signal.throwIfAborted();

    this.coastalJungle = new CoastalJungleSystem({
      scene: this.world.scene,
      config: this.config,
      terrain: this.world.terrainSampler,
      expansion: this.world.expansion,
      collisions: this.collisions,
    });
    try {
      await this.coastalJungle.init(this.abortController.signal);
      this.abortController.signal.throwIfAborted();
    } catch (error) {
      this.coastalJungle.dispose();
      this.coastalJungle = null;
      if (error?.name === 'AbortError') throw error;
      logger.warn('Coastal jungle could not start; continuing without it.', error);
    }

    this.water = new WaterSurface(
      this.world.scene,
      this.world.renderer,
      this.world.terrain,
      this.grass.grassTerrainData,
      this.config,
      { river: this.world.expansion?.river, terrain: this.world.terrainSampler,
        camera: this.world.camera, collisions: this.collisions, rockSources: this.props.pebbleSources },
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
    // Snowfall is driven by the snow underfoot rather than by the weather
    // preset, so it belongs to the snow systems rather than to the environment.
    this.snowfall = this.config.ground.snow?.enabled && this.config.ground.snow.snowfall?.enabled
      ? new SnowfallSystem({
        scene: this.world.scene,
        terrainSampler: this.world.terrainSampler,
        config: this.config,
      })
      : null;

    loading.stage('audio');
    this.audio = new AudioSystem({
      camera: this.world.camera,
      scene: this.world.scene,
      controls: this.player,
      preset: this.config.ui.initialPreset,
      waterMesh: this.water.mesh,
      waterSurface: this.water,
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
      wildGrass: this.wildGrass,
      understory: this.understory,
      config: this.config,
    });
    // How far up the mountain the view is; the environment leans toward
    // snow-country light by it.
    this.snowRegion = this.environment.snowAtmosphere
      ? new SnowRegionTracker({ terrainSampler: this.world.terrainSampler, settings: this.environment.snowAtmosphere })
      : null;
    this.biome = new BiomePropSystem({
      scene: this.world.scene,
      camera: this.world.camera,
      config: this.config,
      jobs: this.vegetationJobs,
      collisions: this.collisions,
      grass: this.grass,
      stones: this.props?.stoneSources ?? [],
      trees: this.trees?.trees ?? [],
      props: this.props?.instances ?? [],
    });
    if (resolvePresetConfig(this.config, this.config.ui.initialPreset)?.activeBiome) {
      try {
        const prepared = await this.biome.prepare(
          resolvePresetConfig(this.config, this.config.ui.initialPreset).biome,
          this.player.getPosition(),
          {
            signal: this.abortController.signal,
            ecology: this.grass.vegetation,
            terrain: this.world.terrainSampler,
          },
        );
        if (prepared?.active) {
          await this.grass.prepareLayout({ field: prepared.field, solids: prepared.solids }, {
            signal: this.abortController.signal,
          });
          this.biome.commit(prepared);
          this.grass.commitLayout();
          this.biome.setPreset(this.config.ui.initialPreset);
        }
      } catch (error) {
        logger.warn('Reference biome could not start; continuing with the original look.', error);
        this.grass.abortLayout();
      }
    }

    if (this.resumeState) {
      const moisture = this.world.terrainTarget.material.userData.beachMoisture;
      if (moisture && Number.isFinite(this.resumeState.beachMoisture)) moisture.value = this.resumeState.beachMoisture;
      if (Number.isFinite(this.resumeState.waveClock)) this.water.rippleElapsed = this.resumeState.waveClock;
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
    this.navigation = new WorldNavigation({
      world: this.world,
      player: this.player,
      tour: this.tour,
      config: this.config,
    });
    this.iris = new IrisTransition(this.root);
    // The pipeline owns the post-effect state the settings panel renders.
    this.pipeline = new CinematicPipeline(this.world, this.config);
    this.ui = new DemoUi(this.root, this.config, this.#createUiActions());
    if (isProfileRequested()) {
      this.profiler = new FrameProfiler();
      this.gpuCreationProbe = new GpuCreationProbe(this.world.renderer);
    }

    loading.stage('shaders');
    this.#resize();
    this.trees.resetLod();
    this.cinematicLighting.activateShadows();
    await this.coastalJungle?.initTask;
    this.abortController.signal.throwIfAborted();
    this.#renderFrame();
    await this.pipeline.warmup({ water: this.water, signal: this.abortController.signal });
    this.#renderFrame();
    this.abortController.signal.throwIfAborted();
    window.addEventListener('resize', () => this.#resize(), { signal: this.abortController.signal });
    this.#resize();

    loading.stage('ready');
    this.world.renderer.setAnimationLoop(() => this.#render());
    if (this.resumeState?.started) {
      // Resize resets the controller's zoom, so restore the pose only after
      // the final resize (including a recovered pixel-ratio override).
      this.#restorePose(this.resumeState);
      this.navigation.restoreState(this.resumeState.navigation);
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
      this.player.spawnAtStart();
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
    if (this.pipeline && config.cinematic?.post) config.cinematic.post.effects = { ...this.pipeline.effects };
    const characterId = this.character?.id ?? defaultCharacterId(config);
    if (!findCharacter(config, characterId)) throw new Error('Cannot recover unknown character.');
    return {
      config, characterId, started: Boolean(this.started), soundEnabled: Boolean(this.audio?.enabled),
      beachMoisture: this.world?.terrainTarget?.material?.userData.beachMoisture?.value,
      waveClock: this.water?.rippleElapsed,
      pixelRatioOverride: this.pixelRatioOverride,
      grassParameters: { ...this.environment?.grassOverrides },
      audioVolumes: this.audio && { master: this.audio.masterVolume,
        ambient: this.audio.ambientVolume, environment: this.audio.environmentVolume },
      interactionEnabled: this.grass?.interactionMap.enabled,
      navigation: this.navigation?.captureState(),
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
      const size = new THREE.Vector3(collider.width, collider.height, collider.length).multiply(tree.high.scale);
      this.collisions.addBox(
        new THREE.Vector3(
          tree.position.x,
          tree.position.y + size.y * TREE_COLLIDER_HEIGHT_FACTOR,
          tree.position.z,
        ),
        size,
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

  async #switchPreset(name) {
    const generation = ++this.presetGeneration;
    try {
      const payload = await preparePresetChange(this, name, generation);
      if (generation !== this.presetGeneration) return;
      return this.iris.run(() => {
        const result = commitPresetChange(this, payload);
        if (!result.applied && result.reason === 'unsafe') {
          logger.warn('Preset switch had no safe pose; keeping the current world.');
        }
      }, 'preset');
    } catch (error) {
      this.grass?.abortLayout();
      logger.error('Preset preparation failed; keeping the current world.', error);
    }
  }

  #createUiActions() {
    return {
      setPreset: (name) => this.#switchPreset(name),
      toggleTour: () => this.navigation.startTour(),
      stopTour: () => this.navigation.stopTour(),
      isTourActive: () => this.tour.active,
      toggleFreeFly: () => this.navigation.toggleFreeFly(),
      isFreeFlyActive: () => this.navigation.freeFly.active,
      getTeleportLocations: () => this.navigation.getLocationOptions(),
      teleportToLocation: (id) => this.navigation.teleport(id),
      setQuality: (name) => {
        this.grass.setQuality(name);
        this.environment.setQuality(name);
        this.pipeline?.setQuality(name);
        this.meadow?.setQuality(name);
        this.water?.setQuality(name);
        this.biome?.setQuality(name);
        this.coastalJungle?.setQuality(name);
      },
      setGrassShape: (shape) => this.iris.run(() => this.grass.setGrassShape(shape), 'grassShape'),
      getGrassParameters: (family) => this.environment.current.grass[family],
      setGrassParameter: (name, value) => {
        const apply = () => this.environment.setGrassParameter(name, value);
        if (this.iris.running) return this.iris.run(apply, `grassParam:${name}`);
        return apply();
      },
      getPostEffects: () => (this.pipeline?.enabled ? { ...this.pipeline.effects } : null),
      setPostEffect: (name, value) => this.pipeline?.setEffect(name, value),
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
      getProfileResults: () => this.getProfileResults(),
    };
  }

  getProfileResults() {
    const renderer = this.world?.renderer;
    const size = new THREE.Vector2();
    const drawing = new THREE.Vector2();
    renderer?.getSize(size);
    renderer?.getDrawingBufferSize?.(drawing);
    const capabilities = this.world?.rendererSession?.capabilities;
    return {
      backend: this.world?.rendererSession?.diagnostics?.actual ?? renderer?.backend?.constructor?.name ?? null,
      requestedBackend: this.world?.rendererSession?.diagnostics?.requested ?? null,
      viewport: { width: size.x, height: size.y, drawingBuffer: { width: drawing.x, height: drawing.y } },
      pixelRatio: this.pixelRatio,
      gpuTiming: capabilities?.gpuTiming ?? false,
      quality: this.grass?.qualityName,
      frames: this.profiler?.summarize() ?? null,
      warmup: this.pipeline?.warmupStats ?? null,
      grass: this.grass?.stats ?? null,
      occlusion: this.pipeline?.gpuOcclusion.stats ?? null,
      reflections: this.water?.stats ?? null,
      understory: this.understory?.stats ?? null,
      biome: this.biome?.stats ?? null,
      coastalJungle: this.coastalJungle?.stats ?? null,
      referenceBiome: this.config.biomes?.referenceScrub?.enabled === true,
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
    const profiler = this.profiler;
    profiler?.beginFrame();
    this.gpuCreationProbe?.beginFrame();
    if (this.water) {
      this.water.lastCubeCaptureMs = 0;
      this.water.lastPlanarCaptureMs = 0;
      this.water.collectStats = profiler !== null;
    }
    const time = profiler ? (name, fn) => profiler.time(name, fn) : (_name, fn) => fn();

    this.world.snowWake?.restoreCamera();
    time('player', () => this.player.update(deltaSeconds));
    this.tour.update(deltaSeconds);
    this.navigation.update(deltaSeconds);
    this.contactShadow?.update();
    this.world.terrainAnimations?.update(deltaSeconds);
    this.leaves.update(deltaSeconds);
    this.world.clouds?.update?.(deltaSeconds);
    this.trees.update(deltaSeconds);
    this.rain.update();
    this.birds.update(deltaSeconds);

    this.audio.update(deltaSeconds);
    this.collisions.update();
    const playerPosition = this.player.getPosition();
    const influencePoints = this.player.getInfluencePoints();
    // Snow deformation and powder are stepped once per frame by
    // WorldNavigation.update(); stepping them here as well ran their
    // integration and recovery twice per frame.
    time('grass', () => this.grass.update(
      deltaSeconds,
      elapsedSeconds,
      playerPosition,
      influencePoints,
    ));
    const focus = this.navigation.getFocusPosition();
    this.environment.setSnowRegion(this.snowRegion?.update(deltaSeconds, focus) ?? 0);
    this.environment.updateSunTarget(focus);
    this.snowfall?.update(deltaSeconds, focus);
    this.cinematicLighting.update(this.environment.exposureScale);
    this.pipeline.setOcclusionScale(this.environment.occlusionScale);
    time('meadow', () => this.meadow?.update(deltaSeconds, focus, this.environment.current));
    time('wildGrass', () => this.wildGrass?.update(deltaSeconds, focus, this.environment.current));
    time('understory', () => this.understory?.update(deltaSeconds, focus, this.environment.current));
    time('biome', () => this.biome?.update(deltaSeconds, this.world.camera, playerPosition));
    time('vegetationJobs', () => this.vegetationJobs?.tick());
    this.boundaryBarrier?.update(deltaSeconds, playerPosition);
    time('water', () => this.water.update(deltaSeconds, this.player, this.environment.lighting));
    this.world.terrainTarget.material.userData.updateCoast?.(deltaSeconds, this.water.rippleElapsed);
    // Depth of field focuses on the character at the end of the camera arm.
    this.pipeline.setFocusDistance(this.player.cameraDistance);
    this.pipeline.setSpeedStreaks(this.world.snowWake?.streak ?? 0);
    time('render', () => this.pipeline.render({ occlusionEnabled: true, profiler }));
    this.ui.update(deltaSeconds);

    const captures = (this.water?.stats.cubeCaptures ?? 0)
      + (this.water?.stats.lakePlanarCaptures ?? 0)
      + (this.water?.stats.seaPlanarCaptures ?? 0);
    const reflectionDelta = captures - this.lastReflectionCaptures;
    this.lastReflectionCaptures = captures;
    const info = this.world.renderer.info.render;
    if (profiler) {
      const created = this.gpuCreationProbe?.stats;
      if (created) {
        profiler.marks.gpuProgram = created.programMs;
        profiler.marks.gpuPipeline = created.pipelineMs;
      }
      if (this.water) {
        profiler.marks.cubeReflections = this.water.lastCubeCaptureMs ?? 0;
        profiler.marks.planarReflections = this.water.lastPlanarCaptureMs ?? 0;
      }
    }
    profiler?.endFrame({
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      gpuTimestamp: this.gpuTimestamp,
      reflectionCaptures: reflectionDelta,
      compactionMs: this.grass?.stats.compactionMs ?? 0,
      occlusionMs: this.pipeline?.gpuOcclusion.lastPrepareMs ?? 0,
      gpuPrograms: this.gpuCreationProbe?.stats.programs ?? 0,
      gpuPipelines: this.gpuCreationProbe?.stats.pipelines ?? 0,
      colliders: this.collisions?.activeCount ?? 0,
      biomeNear: this.biome?.stats?.near ?? 0,
      biomeMid: this.biome?.stats?.mid ?? 0,
      biomeFar: this.biome?.stats?.far ?? 0,
      biomeBookkeepingMs: this.biome?.stats?.bookkeepingMs ?? 0,
      biomeTriangles: this.biome?.stats?.triangles ?? 0,
    });
    this.#queueGpuTimestamp();
  }

  #queueGpuTimestamp() {
    if (!this.profiler || this.gpuTimestampPending || this.disposed) return;
    const renderer = this.world?.renderer;
    if (!renderer?.backend?.trackTimestamp || typeof renderer.resolveTimestampsAsync !== 'function') {
      this.gpuTimestamp = null;
      return;
    }
    this.gpuTimestampPending = true;
    Promise.resolve(renderer.resolveTimestampsAsync('render')).then((duration) => {
      this.gpuTimestamp = Number.isFinite(duration) && duration > 0 ? duration : null;
    }).catch(() => {
      this.gpuTimestamp = null;
    }).finally(() => {
      this.gpuTimestampPending = false;
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.world?.renderer?.setAnimationLoop(null);
    for (const resource of [this.loading, this.pipeline, this.cinematicLighting,
      this.meadow, this.wildGrass, this.understory, this.biome, this.coastalJungle, this.vegetationJobs, this.ui, this.iris, this.grass, this.trees, this.props,
      this.collisions, this.navigation, this.contactShadow, this.player, this.leaves, this.birds, this.rain, this.snowfall,
      this.boundaryBarrier, this.water, this.audio, this.environment, this.world]) {
      try { resource?.dispose?.(); } catch (error) { logger.warn('Demo cleanup failed.', error); }
    }
    disposePresetAppearance(this.config);
    this.gpuCreationProbe?.dispose();
    this.abortController.abort();
  }
}
