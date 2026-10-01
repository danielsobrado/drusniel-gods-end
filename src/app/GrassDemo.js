import * as THREE from 'three';
import { AudioRegions } from '../audio/audioRegions.js';
import { AudioSystem } from '../audio/AudioSystem.js';
import { BirdSystem } from '../foliage/BirdSystem.js';
import { LeafSystem } from '../foliage/LeafSystem.js';
import { GrassField } from '../grass/GrassField.js';
import { WorldCollisionSystem } from '../physics/WorldCollisionSystem.js';
import { PlayerController } from '../player/PlayerController.js';
import { WorldNavigation } from '../player/WorldNavigation.js';
import { DemoUi } from '../ui/DemoUi.js';
import { Minimap } from '../ui/Minimap.js';
import { IrisTransition } from '../ui/IrisTransition.js';
import { LoadingUi } from '../ui/LoadingUi.js';
import { WaterSurface } from '../water/WaterSurface.js';
import { UnderwaterPerformanceController } from '../water/UnderwaterPerformanceController.js';
import { RainSystem } from '../weather/RainSystem.js';
import { SnowfallSystem } from '../weather/SnowfallSystem.js';
import { AmbientEffectsSystem } from '../weather/AmbientEffectsSystem.js';
import { getSurfaceDetail } from '../rendering/surfaceDetail.js';
import { EnvironmentController } from '../world/EnvironmentController.js';
import { SnowRegionTracker } from '../world/SnowAtmosphere.js';
import { TreeSystem } from '../world/TreeSystem.js';
import { WorldPropSystem } from '../world/WorldPropSystem.js';
import { BoundaryBarrier } from '../world/BoundaryBarrier.js';
import { ZoneIndex } from '../world/ZoneIndex.js';
import { StructureSystem } from '../world/StructureSystem.js';
import { NpcSystem } from '../npc/NpcSystem.js';
import { updateCharacterOcclusion } from '../rendering/CharacterOcclusion.js';
import { logger } from '../utils/logger.js';
import {
  applyCharacter,
  defaultCharacterId,
  getRoster,
  requestedCharacterId,
} from '../config/characterRoster.js';
import { createTrees } from '../world/createTrees.js';
import { createWorld } from '../world/createWorld.js';
import { loadTerrainStreamGroup } from '../world/loadTerrain.js';
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
import { startLoadingProfiler } from '../debug/LoadingProfiler.js';
import { AssetLoadContext } from '../assets/AssetLoadContext.js';
import { GpuCreationProbe } from '../debug/gpuCreationHooks.js';
import { VEGETATION_CPU_BUDGET_MS, createVegetationJobScheduler } from '../foliage/vegetationRebuild.js';
import { FrameSlack } from '../core/FrameSlack.js';
import { LakeFlora } from '../water/LakeFlora.js';
import { BeachStarfish } from '../world/BeachStarfish.js';
import { SerpentSystem } from '../wildlife/SerpentSystem.js';
import { SeaAlgae } from '../water/SeaAlgae.js';
import { BeachPalms } from '../world/BeachPalms.js';
import { SeabedRocks } from '../water/SeabedRocks.js';
import { ViewCullBudget, resolveViewCullBudgetMs } from '../foliage/InstanceViewCuller.js';
import { disposeVegetationKtx2Loader } from '../foliage/VegetationKtx2Loader.js';
import { BiomePropSystem } from '../biome/BiomePropSystem.js';
import { CoastalJungleSystem } from '../biome/CoastalJungleSystem.js';
import { commitPresetChange, preparePresetChange } from '../biome/presetSwitch.js';
import { resolvePresetConfig } from '../config/resolvePresetConfig.js';
import { disposePresetAppearance } from '../rendering/PresetAppearance.js';
import { isMobileStartup, mobileWarmupTravelDistance } from '../config/mobileStartup.js';
import { coastalJungleRegionCenter, coastalJungleRegionRadius } from '../world/CoastalJungleRegion.js';
import { shouldPreloadTerrainGroup, streamedTreeTypeIndices, terrainGroupContainsPreloadPosition } from '../world/terrainStreaming.js';

const MIN_PIXEL_RATIO = 0.5;
const TREE_COLLIDER_HEIGHT_FACTOR = 0.5;
const STARTUP_PROFILE_FRAMES = 8;
const LOADING_JOB_BUDGET_MS = 12;
// Deferred work always advances at least this much per frame, however busy.
const VIEW_CULL_FLOOR_MS = 0.25;
const VEGETATION_JOB_FLOOR_MS = 0.35;

function coastalJunglePreloadBounds(config, qualityName = config.ui?.initialQuality) {
  const profile = config.biomes?.coastalJungle;
  const sea = config.water?.sea;
  if (!profile?.enabled || !sea?.enabled) return null;

  const center = coastalJungleRegionCenter(profile.region, sea);
  const regionRadius = coastalJungleRegionRadius(profile.region, sea);
  if (!center || !(regionRadius > 0)) return null;

  const visibilityDistance = Math.max(
    0,
    Number(profile.render?.treeDistance) || 0,
    Number(profile.quality?.[qualityName]?.maxDistance) || 0,
    Number(profile.lod?.plantDistances?.[qualityName]) || 0,
    Number(profile.lod?.treeDistances?.[qualityName]) || 0,
  );
  const lead = Math.max(0, Number(profile.render?.preloadLeadDistance) || 0);
  return { x: center.x, z: center.z, radius: regionRadius + visibilityDistance + lead };
}

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
    this.tourRequestGeneration = 0;
    this.tourStartTask = null;
    this.understoryBillboardTask = null;
    this.coastalJunglePreload = coastalJunglePreloadBounds(config);
    this.frameSlack = new FrameSlack();
    // One per demo, so renderer recovery starts from a fresh one.
    this.assets = new AssetLoadContext(config);
  }

  async start() {
    const profile = startLoadingProfiler(isProfileRequested());
    this.loadingProfile = profile;
    profile.mark('start');
    const loading = new LoadingUi(this.root, this.config.cinematic?.presentation, {
      roster: getRoster(this.config),
      selectedId: this.resumeState?.characterId ?? requestedCharacterId(window.location.search, this.config),
    });
    this.loading = loading;
    this.world = await profile.measure('world', () => createWorld(this.config, (stage) => loading.stage(stage), {
      signal: this.abortController.signal,
      rendererRequest: this.rendererRequest,
      rendererOptions: { trackTimestamp: isProfileRequested() },
      assets: this.assets,
    }));
    this.abortController.signal.throwIfAborted();
    this.onRendererReady?.(this.world.rendererSession);
    this.abortController.signal.throwIfAborted();
    this.cinematicLighting = new CinematicLighting(this.world, this.config);
    this.root.appendChild(this.world.renderer.domElement);
    // Built now and prefetched once the tree LODs are in, so their model
    // downloads overlap the grass and jungle; placed later, in order.
    this.structures = new StructureSystem({
      scene: this.world.scene,
      renderer: this.world.renderer,
      shadowCamera: this.world.shadowCamera,
      terrainSampler: this.world.terrainSampler,
      config: this.config,
      assets: this.assets,
    });
    this.npcs = new NpcSystem({
      scene: this.world.scene,
      terrainSampler: this.world.terrainSampler,
      config: this.config,
      assets: this.assets,
    });
    if (loading.needsCharacterChoice()) loading.stage('character');
    const chosenId = await profile.measure('characterChoice', () => loading.waitForCharacter());
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
      { assets: this.assets },
    );
    await profile.measure('playerModel', () => this.player.loadModel());
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
    this.player.cameraColliderFilter = (collider) => this.collisions.blocksCamera(collider);
    this.vegetationJobs = createVegetationJobScheduler();

    // The jungle is the longest startup task and needs only the world and the
    // collisions, so it starts here and runs (cooperatively) beside the rest.
    this.coastalJungle = new CoastalJungleSystem({
      scene: this.world.scene,
      renderer: this.world.renderer,
      config: this.config,
      terrain: this.world.terrainSampler,
      expansion: this.world.expansion,
      collisions: this.collisions,
      jobs: this.vegetationJobs,
      assets: this.assets,
    });
    // Built during loading, not on approach: its materials then compile in the
    // loading warmup instead of stalling a gameplay frame when the player first
    // nears the coast (measured 18 pipeline/shader builds mid-route).
    this.coastalJungle.init(this.abortController.signal);
    if (this.coastalJungle.initTask) void profile.measure('coastalJungle', this.coastalJungle.initTask).catch(() => {});

    const [loadedTrees, loadedProps] = await profile.measure('worldData', () => Promise.all([
      loadTreeWorldData(this.config),
      loadWorldPropData(this.config),
    ]));
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
    const endTrees = profile.begin('trees');
    this.trees = new TreeSystem({
      scene: this.world.scene,
      camera: this.world.camera,
      renderer: this.world.renderer,
      shadowCamera: this.world.shadowCamera,
      terrainRoot: this.world.terrain,
      terrainSampler: this.world.terrainSampler,
      zoneIndex: this.zoneIndex,
      config: this.config,
      worldData: treeWorldData,
      fallbackFactory: () => createTrees(this.world.scene, this.config),
      assets: this.assets,
    }).init();
    this.#registerTreeColliders();
    this.#registerWorldColliders();
    endTrees();
    await profile.measure('treeLods', () => this.trees.initLods(this.abortController.signal));
    this.structures.prefetch(this.abortController.signal);
    this.npcs.prefetch(this.abortController.signal);
    this.leaves = new LeafSystem({
      scene: this.world.scene,
      player: this.player,
      zoneIndex: this.zoneIndex,
      config: this.config,
      renderer: this.world.renderer,
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
    // One budget shared by every instance view culler so a camera turn spreads
    // their repacks across frames instead of stacking three spikes into one.
    this.viewCullBudget = new ViewCullBudget({
      budgetMs: resolveViewCullBudgetMs(this.config.vegetation?.viewCulling),
    });
    this.grass = new GrassField(
      this.world.scene,
      this.world.camera,
      this.world.renderer,
      this.config,
      this.world.terrainSampler,
      this.trees.getEcologyTrees(),
      { assets: this.assets },
    );
    await profile.measure('grass', () => this.grass.init(this.abortController.signal));
    this.abortController.signal.throwIfAborted();
    this.world.groundMaterial?.userData.setVegetationField?.(this.grass.vegetation?.vegetationTexture);
    this.#writeGroundContactShade();
    if (this.config.cinematic?.enabled) {
      this.meadow = new MeadowDetails(
        this.world.scene,
        this.config,
        this.world.terrainSampler,
        this.grass,
        this.trees,
        this.props.pebbleSources,
        { jobs: this.vegetationJobs, camera: this.world.camera, viewCullBudget: this.viewCullBudget },
      );
    }
    this.wildGrass = new WildGrassSystem({
      scene: this.world.scene,
      camera: this.world.camera,
      config: this.config,
      terrain: this.world.terrainSampler,
      grass: this.grass,
      jobs: this.vegetationJobs,
      viewCullBudget: this.viewCullBudget,
    });
    await profile.measure('wildGrass', () => this.wildGrass.init());
    this.abortController.signal.throwIfAborted();
    this.understory = new UnderstorySystem({
      scene: this.world.scene,
      renderer: this.world.renderer,
      camera: this.world.camera,
      config: this.config,
      terrain: this.world.terrainSampler,
      grass: this.grass,
      jobs: this.vegetationJobs,
      viewCullBudget: this.viewCullBudget,
      assets: this.assets,
    });
    await profile.measure('understory', () => this.understory.init(this.abortController.signal));
    this.abortController.signal.throwIfAborted();

    this.water = new WaterSurface(
      this.world.scene,
      this.world.renderer,
      this.world.terrain,
      this.grass.grassTerrainData,
      this.config,
      { river: this.world.expansion?.river, terrain: this.world.terrainSampler,
        camera: this.world.camera, collisions: this.collisions, rockSources: this.props.pebbleSources },
    );
    // Lake plants ride the water's clock; both sets are created before the
    // loading warmup so their pipelines compile with the rest of the scene.
    this.lakeFlora = new LakeFlora({
      scene: this.world.scene, terrain: this.world.terrainSampler, config: this.config,
      timeNode: this.water.uniforms?.clock ?? null,
    });
    this.starfish = new BeachStarfish({ scene: this.world.scene, terrain: this.world.terrainSampler, config: this.config });
    this.serpents = new SerpentSystem({
      scene: this.world.scene, terrain: this.world.terrainSampler, config: this.config,
      jungle: this.coastalJungle, lake: this.water.lakeShape, expansion: this.world.expansion,
    });
    this.seaAlgae = new SeaAlgae({
      scene: this.world.scene, terrain: this.world.terrainSampler, config: this.config,
      timeNode: this.water.uniforms?.clock ?? null,
    });
    this.beachPalms = new BeachPalms({
      scene: this.world.scene, terrain: this.world.terrainSampler, config: this.config,
      collisions: this.collisions, assets: this.assets,
    });
    await profile.measure('beachPalms', () => this.beachPalms.init(this.abortController.signal));
    this.abortController.signal.throwIfAborted();
    this.seabedRocks = new SeabedRocks({
      scene: this.world.scene, terrain: this.world.terrainSampler, config: this.config, collisions: this.collisions,
    });
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
    // Live strengths of the procedural surface detail, for tuning and A/B.
    this.surfaceDetail = getSurfaceDetail(this.config);
    // Each biome's air: dust, spray, pollen, fireflies, mist and the rest.
    // Built before the loading warmup so every pipeline compiles with the scene.
    this.ambient = new AmbientEffectsSystem({
      scene: this.world.scene,
      config: this.config,
      terrainSampler: this.world.terrainSampler,
      river: this.water?.river ?? null,
      quality: this.config.ui.initialQuality,
    });

    this.structures.collisions = this.collisions;
    await profile.measure('structures', () => this.structures.init(this.abortController.signal));
    this.abortController.signal.throwIfAborted();
    this.npcs.lake = this.water.lakeShape;
    await profile.measure('npcs', () => this.npcs.init(this.abortController.signal));
    this.abortController.signal.throwIfAborted();

    loading.stage('audio');
    this.audio = new AudioSystem({
      camera: this.world.camera,
      scene: this.world.scene,
      controls: this.player,
      preset: this.config.ui.initialPreset,
      waterMesh: this.water.mesh,
      waterSurface: this.water,
      regions: new AudioRegions({
        config: this.config,
        terrainSampler: this.world.terrainSampler,
        river: this.water?.river ?? null,
        snowWeight: () => this.environment?.snowRegionWeight ?? 0,
      }),
      config: this.config,
    });
    await profile.measure('audio', () => this.audio.init());
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
      trees: this.trees.getEcologyTrees(),
      props: this.props?.instances ?? [],
    });
    if (resolvePresetConfig(this.config, this.config.ui.initialPreset)?.activeBiome) {
      try {
        const endBiome = profile.begin('biome');
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
        endBiome();
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
      // describe the restored scene, including each grass family's defaults.
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
    this.tour.serpentPath = (index) => this.serpents?.serpents?.[index]?.minimapPath() ?? null;
    this.navigation = new WorldNavigation({
      world: this.world,
      player: this.player,
      tour: this.tour,
      config: this.config,
    });
    this.iris = new IrisTransition(this.root);
    // The pipeline owns the post-effect state the settings panel renders.
    this.pipeline = new CinematicPipeline(this.world, this.config);
    this.underwaterPerformance = new UnderwaterPerformanceController({
      camera: this.world.camera,
      water: this.water,
      cinematicLighting: this.cinematicLighting,
      vegetation: [
        this.grass,
        this.trees,
        this.meadow,
        this.wildGrass,
        this.understory,
        this.biome,
        this.coastalJungle,
        this.leaves,
      ],
      atmosphere: [this.birds, this.rain, this.world.clouds],
      config: this.config,
    });
    this.ui = new DemoUi(this.root, this.config, this.#createUiActions());
    this.minimap = new Minimap({
      root: this.ui.element,
      terrain: this.world.terrainSampler,
      config: this.config,
      trees: this.trees.getEcologyTrees(),
      locations: this.navigation.locations,
      markers: () => this.#minimapMarkers(),
      onTravel: (id) => this.#teleportToLocation(id),
    });
    if (isProfileRequested()) {
      this.profiler = new FrameProfiler();
      this.gpuCreationProbe = new GpuCreationProbe(this.world.renderer);
    }

    loading.stage('shaders');
    // Deferred biome content joins the warmup so no gameplay frame compiles it:
    // the jungle, understory billboards and streamed terrain groups (the alpine
    // trees streamed in mid-route near the village, compiling ~50 materials).
    await profile.measure('deferredStartupJobs', () => this.#awaitWithJobs(Promise.all([
      this.coastalJungle?.initTask,
      this.#startUnderstoryBillboards(),
      ...(this.world.terrainDeferredGroups ?? []).map((group) => this.#startTerrainStream(group)),
    ])));
    this.abortController.signal.throwIfAborted();
    this.#resize();
    this.trees.resetLod();
    this.cinematicLighting.activateShadows();
    const endInitialRender = profile.begin('initialRender');
    this.#renderFrame();
    endInitialRender();
    const mobileStartup = isMobileStartup(this.config);
    const warmupTravelDistance = mobileStartup
      ? mobileWarmupTravelDistance(this.config)
      : undefined;
    this.trees.lodRenderer?.prepareNearby(this.world.camera, warmupTravelDistance);
    this.coastalJungle?.lodRenderer?.prepareNearby(this.world.camera, warmupTravelDistance);
    const endPrepareAll = profile.begin('prepareTreeDraws');
    if (!mobileStartup) {
      this.trees.lodRenderer?.prepareAll();
      this.coastalJungle?.lodRenderer?.prepareAll();
    }
    endPrepareAll();
    await profile.measure('warmup', () => this.pipeline.warmup({ water: this.water, signal: this.abortController.signal }));
    const prepareDraws = (targets, signal) => this.pipeline.prepareDraws(targets, {
      water: this.water, signal, waitForFrame: false,
    });
    this.trees.setScheduler(this.vegetationJobs, { prepare: prepareDraws });
    this.coastalJungle.setScheduler(this.vegetationJobs, { prepare: prepareDraws });
    this.grass.setScheduler(this.vegetationJobs);
    this.#renderFrame();
    this.abortController.signal.throwIfAborted();
    window.addEventListener('resize', () => this.#resize(), { signal: this.abortController.signal });
    this.#resize();

    loading.stage('ready');
    profile.mark('ready');
    this.world.renderer.setAnimationLoop(() => this.#render());
    if (this.resumeState?.started) {
      // Resize resets the controller's zoom, so restore the pose only after
      // the final resize (including a restored pixel-ratio override).
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
      profile.mark('interactive');
      this.assets.releaseIdleDecoderWorkers();
      this.profiler?.startFrames({ frames: STARTUP_PROFILE_FRAMES, label: 'startup' });
      this.started = true;
      this.#startUnderstoryBillboards();
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
    profile.mark('interactive');
    this.assets.releaseIdleDecoderWorkers();
    this.profiler?.startFrames({ frames: STARTUP_PROFILE_FRAMES, label: 'startup' });
    this.started = true;
    this.loading = null;
    this.#startUnderstoryBillboards();
  }

  // The vegetation scheduler is normally ticked by the frame loop, which does
  // not run during loading; staged work awaited here (the jungle's LOD staging)
  // is driven directly instead, with a loading-sized budget per frame.
  async #awaitWithJobs(promise) {
    let settled = false;
    const done = Promise.resolve(promise).finally(() => { settled = true; });
    while (!settled) {
      const until = performance.now() + LOADING_JOB_BUDGET_MS;
      while (!settled && performance.now() < until) {
        this.vegetationJobs?.tick({ position: this.world.camera.position, speed: 0 });
        await Promise.resolve();
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return done;
  }

  #startUnderstoryBillboards() {
    if (this.understoryBillboardTask) return this.understoryBillboardTask;
    const task = this.understory?.prepareBillboards(this.abortController.signal);
    if (!task) return null;
    this.understoryBillboardTask = task.catch((error) => {
      if (error?.name === 'AbortError' || this.abortController.signal.aborted) return;
      logger.warn('Deferred understory billboard preparation failed.', error);
    });
    return this.understoryBillboardTask;
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

  // Markers the minimap pins but cannot travel to: the village centre and the
  // NPCs, which move, so this is read on every redraw.
  #minimapMarkers() {
    const markers = [];
    for (const [name, label] of [['Village', 'Village'], ['LakeVillage', 'Lake Hamlet']]) {
      const village = this.world?.scene?.getObjectByName(name);
      if (!village?.children?.length) continue;
      let x = 0, z = 0;
      for (const building of village.children) { x += building.position.x; z += building.position.z; }
      markers.push({
        kind: 'town', label,
        x: x / village.children.length, z: z / village.children.length,
      });
    }
    // One label per kind: twenty goblins would bury the map in text.
    const labelled = new Set();
    for (const entry of this.npcs?.entries ?? []) {
      const name = entry.def.kind === 'goblin' ? 'Goblin' : 'Farmers';
      const first = !labelled.has(name);
      labelled.add(name);
      markers.push({
        kind: 'npc', label: first ? name : null,
        x: entry.root.position.x, z: entry.root.position.z,
      });
    }
    markers.push(...(this.serpents?.minimapMarkers() ?? []));
    return markers;
  }

  // Foliage in front of the player dithers away around the character's centre.
  // Off while free-flying or touring, when the character is not the subject.
  #updateCharacterOcclusion() {
    const player = this.player;
    const enabled = this.characterOcclusionEnabled !== false
      && Boolean(player?.root?.visible) && !this.navigation?.freeFly?.active && !this.tour?.active;
    const height = player?.modelHeight || this.config.player?.targetHeight || 5;
    this.occlusionTarget ??= new THREE.Vector3();
    if (enabled) {
      const root = player.root.position;
      this.occlusionTarget.set(root.x, root.y - player.metrics.rootToFeet + height * 0.5, root.z);
    }
    updateCharacterOcclusion({
      renderer: this.world.renderer, camera: this.world.camera, target: this.occlusionTarget, height, enabled,
    });
  }

  // Ground shade where trunks and rocks meet it; baked once into the path
  // texture the ground already samples.
  #writeGroundContactShade() {
    const sources = [];
    for (const tree of this.trees?.getEcologyTrees?.() ?? []) {
      const collider = this.config.trees.types?.[tree.typeIndex]?.collider;
      if (!collider || !(tree.scale > 0)) continue;
      // The path texture is ~1.3 units a texel, so footprints span the root
      // flare and litter around it, not just the trunk.
      const trunk = Math.max(collider.width, collider.length) * tree.scale * 0.5;
      sources.push({ x: tree.position.x, z: tree.position.z, radius: trunk * 3 + 3, strength: 1 });
    }
    for (const prop of this.props?.instances ?? []) {
      if (!(prop.radius > 0) || !prop.position) continue;
      sources.push({ x: prop.position.x, z: prop.position.z, radius: prop.radius * 1.5 + 1, strength: 0.8 });
    }
    this.world.groundMaterial?.userData.setContactShade?.(sources);
  }

  #registerTreeColliders(trees = this.trees?.trees ?? []) {
    if (!this.collisions || !trees.length) return;
    this.treeColliderIndices ??= new Set();
    for (const tree of trees) {
      if (this.treeColliderIndices.has(tree.index)) continue;
      const collider = this.config.trees.types?.[tree.typeIndex]?.collider;
      if (!collider) continue;
      const treeScale = tree.worldScale ?? tree.high?.scale;
      if (!treeScale) continue;
      const size = new THREE.Vector3(collider.width, collider.height, collider.length).multiply(treeScale);
      this.collisions.addBox(
        new THREE.Vector3(
          tree.position.x,
          tree.position.y + size.y * TREE_COLLIDER_HEIGHT_FACTOR,
          tree.position.z,
        ),
        size,
        { cameraTransparent: true },
      );
      this.treeColliderIndices.add(tree.index);
    }
  }

  #registerWorldColliders() {
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

  #stopTour() {
    this.tourRequestGeneration += 1;
    this.navigation.stopTour();
  }

  #toggleTour() {
    if (this.tour.active) {
      this.#stopTour();
      return false;
    }
    if (this.tourStartTask) {
      this.tourRequestGeneration += 1;
      return false;
    }

    const generation = ++this.tourRequestGeneration;
    const task = this.#prepareTourResources().then(() => {
      if (this.disposed || generation !== this.tourRequestGeneration) return false;
      return this.navigation.startTour();
    }).catch((error) => {
      if (error?.name !== 'AbortError' && !this.disposed) {
        logger.warn('Scenic tour preparation failed; starting with available assets.', error);
      }
      if (this.disposed || generation !== this.tourRequestGeneration) return false;
      return this.navigation.startTour();
    }).finally(() => {
      if (this.tourStartTask === task) this.tourStartTask = null;
    });
    this.tourStartTask = task;
    return task;
  }

  async #prepareTourResources() {
    const points = (this.config.navigation?.scenicTour?.showcasePoints ?? [])
      .map((point) => point?.position)
      .filter((position) => Array.isArray(position) && position.length === 2)
      .map(([x, z]) => ({ x: Number(x), z: Number(z) }))
      .filter(({ x, z }) => Number.isFinite(x) && Number.isFinite(z));
    if (points.length === 0) return;

    const groups = (this.world?.terrainDeferredGroups ?? []).filter((group) => (
      points.some((position) => terrainGroupContainsPreloadPosition(position, group))
    ));
    const tasks = groups
      .filter((group) => !group.loaded && !group.failed)
      .map((group) => this.#startTerrainStream(group));
    const understoryTask = this.#startUnderstoryBillboards();
    if (understoryTask) tasks.push(understoryTask);

    const jungle = this.coastalJunglePreload;
    const junglePoint = jungle && points.find((position) => {
      const dx = position.x - jungle.x;
      const dz = position.z - jungle.z;
      return dx * dx + dz * dz <= jungle.radius * jungle.radius;
    });
    if (junglePoint) tasks.push(this.#ensureCoastalJungleAt(junglePoint));

    await Promise.all(tasks);
    this.abortController.signal.throwIfAborted();
  }

  #createUiActions() {
    return {
      setPreset: (name) => this.#switchPreset(name),
      toggleTour: () => this.#toggleTour(),
      stopTour: () => this.#stopTour(),
      isTourActive: () => this.tour.active,
      toggleFreeFly: () => this.navigation.toggleFreeFly(),
      isFreeFlyActive: () => this.navigation.freeFly.active,
      getTeleportLocations: () => this.navigation.getLocationOptions(),
      teleportToLocation: (id) => this.#teleportToLocation(id),
      setQuality: (name) => {
        this.trees.setQuality(name);
        this.grass.setQuality(name);
        this.environment.setQuality(name);
        this.pipeline?.setQuality(name);
        this.meadow?.setQuality(name);
        this.water?.setQuality(name);
        this.ambient?.setQuality(name);
        this.biome?.setQuality(name);
        this.coastalJungle?.setQuality(name);
        this.coastalJunglePreload = coastalJunglePreloadBounds(this.config, name);
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
      getPostLevels: () => (this.pipeline?.enabled ? { ...this.pipeline.levels } : null),
      setPostLevel: (name, value) => this.pipeline?.setLevel(name, value),
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
      startup: this.profiler?.captures?.startup ?? null,
      loading: this.loadingProfile?.results() ?? null,
      warmup: this.pipeline?.warmupStats ?? null,
      drawPreparation: this.pipeline?.prepareStats ?? null,
      vegetationJobs: this.vegetationJobs ? { ...this.vegetationJobs.stats } : null,
      terrainRender: this.world?.terrainRender?.stats ?? null,
      grass: this.grass?.stats ?? null,
      meadow: this.meadow?.stats ?? null,
      wildGrass: this.wildGrass?.stats ?? null,
      treeLod: this.trees?.stats ?? null,
      occlusion: this.pipeline?.gpuOcclusion.stats ?? null,
      reflections: this.water?.stats ?? null,
      underwaterPerformance: this.underwaterPerformance?.stats ?? null,
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
    this.frameSlack.beginFrame();
    this.gpuCreationProbe?.beginFrame();
    if (this.water) {
      this.water.lastCubeCaptureMs = 0;
      this.water.lastPlanarCaptureMs = 0;
      this.water.collectStats = profiler !== null;
    }
    const time = profiler ? (name, fn) => profiler.time(name, fn) : (_name, fn) => fn();

    this.world.snowWake?.restoreCamera();
    time('player', () => this.player.update(deltaSeconds));
    time('tour', () => this.tour.update(deltaSeconds));
    time('navigation', () => this.navigation.update(deltaSeconds));
    time('underwaterPerformance', () => this.underwaterPerformance?.update());
    time('contactShadow', () => this.contactShadow?.update());
    time('terrainAnimation', () => this.world.terrainAnimations?.update(deltaSeconds));
    time('leaves', () => this.leaves.update(deltaSeconds));
    time('clouds', () => this.world.clouds?.update?.(deltaSeconds));
    time('trees', () => this.trees.update(deltaSeconds));
    time('rain', () => this.rain.update());
    time('birds', () => this.birds.update(deltaSeconds, this.world.camera));
    time('npcs', () => this.npcs.update(deltaSeconds, this.world.camera));
    time('serpents', () => this.serpents?.update(deltaSeconds, this.world.camera, this.player.getPosition()));
    time('structures', () => this.structures?.update(this.world.camera));
    time('audio', () => this.audio.update(deltaSeconds));
    time('collisions', () => this.collisions.update());
    time('terrainLod', () => this.world.terrainRender?.update(
      this.world.camera,
      this.underwaterPerformance?.terrainOptions,
    ));
    const playerPosition = this.player.getPosition();
    const streamFocus = this.navigation?.getPreloadPosition?.() ?? playerPosition;
    this.#maybeStreamTerrain(streamFocus);
    this.#maybeInitCoastalJungle(streamFocus);
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
    time('lighting', () => {
      this.environment.setSnowRegion(this.snowRegion?.update(deltaSeconds, focus) ?? 0);
      this.environment.updateSunTarget(focus);
      this.snowfall?.update(deltaSeconds, focus);
      this.cinematicLighting.update(this.environment.exposureScale, this.environment.snowRegionWeight);
      this.pipeline.setOcclusionScale(this.environment.occlusionScale);
      this.pipeline.setShaftAtmosphere?.(this.environment.snowRegionWeight);
    });
    time('ambient', () => {
      this.ambient?.update(deltaSeconds, {
        focus,
        presetName: this.environment.currentPreset,
        lighting: this.environment.lighting,
        grassWind: this.environment.current.grass.blade,
        snowWeight: this.environment.snowRegionWeight,
        player: this.navigation.freeFly.active || this.tour.active ? null : this.player,
      });
      if (this.ambient?.enabled) {
        const ambient = this.ambient.values;
        this.pipeline.setAmbient?.({
          frost: ambient.frost, shimmer: ambient.heatShimmer, jungleMist: ambient.jungleMist, mistGround: ambient.mistGround,
        });
      }
    });
    // Reset the shared cull budget once per frame so the three foliage systems
    // below amortise their repacks instead of bursting together.
    // Both budgets shrink to the slack the rest of the frame leaves.
    const slack = this.frameSlack;
    this.viewCullBudget.begin(slack.available(VIEW_CULL_FLOOR_MS, this.viewCullBudget.budgetMs));
    slack.defer(() => {
      time('meadow', () => this.meadow?.update(deltaSeconds, focus, this.environment.current));
      time('wildGrass', () => this.wildGrass?.update(deltaSeconds, focus, this.environment.current));
      time('understory', () => this.understory?.update(deltaSeconds, focus, this.environment.current));
    });
    time('biome', () => this.biome?.update(deltaSeconds, this.world.camera, playerPosition));
    slack.defer(() => time('vegetationJobs', () => this.vegetationJobs?.tick({
      position: this.world.camera.position,
      speed: this.player?.speed ?? this.player?.horizontalVelocity?.length() ?? 0,
      budgetMs: slack.available(VEGETATION_JOB_FLOOR_MS, VEGETATION_CPU_BUDGET_MS),
    })));
    time('boundary', () => this.boundaryBarrier?.update(deltaSeconds, playerPosition));
    this.water.setCameraTravelActive?.(this.tour.active || this.navigation.freeFly.active);
    time('water', () => this.water.update(deltaSeconds, this.player, this.environment.lighting));
    time('shoreFlora', () => {
      this.lakeFlora?.update(this.world.camera);
      this.starfish?.update(this.world.camera);
      this.seaAlgae?.update(this.world.camera);
    this.beachPalms?.update(this.world.camera);
    this.seabedRocks?.update(this.world.camera);
    });
    time('terrainMaterial', () => this.world.terrainTarget.material.userData.updateCoast?.(
      deltaSeconds,
      this.water.rippleElapsed,
    ));
    // Depth of field focuses on the character at the end of the camera arm.
    this.pipeline.setFocusDistance(this.player.cameraDistance);
    this.pipeline.setSpeedStreaks(this.world.snowWake?.streak ?? 0);
    this.pipeline.setUnderwater(this.water.underwater);
    time('characterOcclusion', () => this.#updateCharacterOcclusion());
    time('render', () => this.#renderScene(profiler));
    time('ui', () => this.ui.update(deltaSeconds));
    time('minimap', () => this.minimap?.update(focus, this.world.camera, this.tour.active));
    this.frameSlack.endFrame();

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
        profiler.marks.gpuAttribute = created.attributeMs;
        profiler.marks.gpuTexture = created.textureMs;
        profiler.marks.gpuNodeBuild = created.nodeBuildMs;
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
      gpuAttributes: this.gpuCreationProbe?.stats.attributes ?? 0,
      gpuTextures: this.gpuCreationProbe?.stats.textures ?? 0,
      gpuNodeBuilds: this.gpuCreationProbe?.stats.nodeBuilds ?? 0,
      colliders: this.collisions?.activeCount ?? 0,
      biomeNear: this.biome?.stats?.near ?? 0,
      biomeMid: this.biome?.stats?.mid ?? 0,
      biomeFar: this.biome?.stats?.far ?? 0,
      biomeBookkeepingMs: this.biome?.stats?.bookkeepingMs ?? 0,
      biomeTriangles: this.biome?.stats?.triangles ?? 0,
    });
    this.#queueGpuTimestamp();
  }

  // Every render of the scene (main view, shadow map, reflections) walks all
  // ~3,300 objects to update world matrices, about 1 ms each. Nothing moves
  // between those renders, so the frame walks the graph once and the passes
  // reuse the result.
  #renderScene(profiler) {
    const scene = this.world.scene;
    const autoUpdate = scene.matrixWorldAutoUpdate;
    if (autoUpdate) scene.updateMatrixWorld();
    scene.matrixWorldAutoUpdate = false;
    try {
      this.pipeline.render({ occlusionEnabled: true, profiler });
    } finally {
      scene.matrixWorldAutoUpdate = autoUpdate;
    }
  }

  #maybeStreamTerrain(position) {
    if (!this.started) return;
    for (const group of this.world?.terrainDeferredGroups ?? []) {
      if (!shouldPreloadTerrainGroup(position, group)) continue;
      void this.#startTerrainStream(group);
    }
  }

  #startTerrainStream(group) {
    if (group.task) return group.task;
    if (group.loaded || group.failed) return Promise.resolve();
    group.loading = true;
    group.task = this.#streamTerrainGroup(group).finally(() => {
      group.loading = false;
      group.task = null;
    });
    return group.task;
  }

  async #ensureTerrainAt(position) {
    const groups = (this.world?.terrainDeferredGroups ?? [])
      .filter((group) => terrainGroupContainsPreloadPosition(position, group));
    await Promise.all(groups.filter((group) => !group.loaded && !group.failed)
      .map((group) => this.#startTerrainStream(group)));
    this.abortController.signal.throwIfAborted();
    return groups.every((group) => group.loaded);
  }

  async #ensureCoastalJungleAt(position) {
    const preload = this.coastalJunglePreload;
    if (!preload || !this.coastalJungle || this.coastalJungle.ready) return true;
    const dx = Number(position.x) - preload.x;
    const dz = Number(position.z) - preload.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)
      || dx * dx + dz * dz > preload.radius * preload.radius) return true;

    this.coastalJungle.init(this.abortController.signal);
    await this.coastalJungle.initTask;
    this.abortController.signal.throwIfAborted();
    return this.coastalJungle.ready;
  }

  async #teleportToLocation(id) {
    const location = this.navigation?.getLocation(id);
    if (!location) return this.navigation?.teleport(id) ?? false;
    const position = location.mode === 'fly'
      ? { x: Number(location.position[0]), z: Number(location.position[2]) }
      : { x: Number(location.position[0]), z: Number(location.position[1]) };
    try {
      const [terrainReady, jungleReady] = await Promise.all([
        this.#ensureTerrainAt(position),
        this.#ensureCoastalJungleAt(position),
      ]);
      if (!terrainReady || !jungleReady || this.disposed) return false;
      return this.navigation.teleport(id);
    } catch (error) {
      if (error?.name === 'AbortError' || this.disposed) return false;
      logger.warn(`Could not preload navigation destination "${id}".`, error);
      return false;
    }
  }

  async #streamTerrainGroup(group) {
    let loaded = null;
    let committed = false;
    let treeSourcesCommitted = false;
    try {
      loaded = await loadTerrainStreamGroup(this.world.terrain, group, this.config, {
        signal: this.abortController.signal,
        assets: this.assets,
      });
      this.abortController.signal.throwIfAborted();
      if (loaded.parts.size === 0) throw new Error('No terrain parts loaded for stream group.');

      // Streamed tree GLBs are source containers, not world geometry.
      for (const part of loaded.parts.values()) {
        part.visible = false;
        part.userData.skipWarmup = true;
      }

      const treeTypes = streamedTreeTypeIndices(group);
      const trees = treeTypes.length
        ? await this.trees.addStreamedTypes(treeTypes, this.abortController.signal)
        : [];
      treeSourcesCommitted = treeTypes.length > 0;
      this.abortController.signal.throwIfAborted();

      for (const [name, part] of loaded.parts) this.world.terrainParts.set(name, part);
      this.world.registerTerrainStreamRelease?.(loaded.dispose);
      committed = true;
      this.#registerTreeColliders(trees);
      group.loaded = true;

      logger.info('Terrain stream group initialized.', {
        group: group.name,
        parts: loaded.parts.size,
        trees: trees.length,
      });
    } catch (error) {
      if (!committed && loaded) {
        if (treeSourcesCommitted) this.world.registerTerrainStreamRelease?.(loaded.dispose);
        else loaded.dispose();
      }
      if (error?.name === 'AbortError' || this.abortController.signal.aborted) return;
      group.failed = true;
      logger.warn(`Terrain stream group "${group.name}" failed to load.`, error);
    }
  }

  #maybeInitCoastalJungle(position) {
    const preload = this.coastalJunglePreload;
    if (!this.started || !preload || !this.coastalJungle
      || this.coastalJungle.initTask || this.coastalJungle.disposed) return;

    const dx = position.x - preload.x;
    const dz = position.z - preload.z;
    if (dx * dx + dz * dz > preload.radius * preload.radius) return;

    this.coastalJungle.init(this.abortController.signal);
    logger.info('Coastal jungle preload started.', {
      distance: Math.round(Math.hypot(dx, dz)),
      triggerRadius: Math.round(preload.radius),
    });
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
    this.abortController.abort();
    this.world?.renderer?.setAnimationLoop(null);
    for (const resource of [this.loading, this.pipeline, this.underwaterPerformance, this.cinematicLighting,
      this.meadow, this.wildGrass, this.understory, this.biome, this.coastalJungle, this.vegetationJobs, this.minimap, this.ui, this.iris, this.grass, this.trees, this.props,
      this.collisions, this.navigation, this.contactShadow, this.player, this.leaves, this.birds, this.rain, this.snowfall, this.ambient,
      this.structures, this.npcs,
      this.boundaryBarrier, this.lakeFlora, this.starfish, this.serpents, this.seaAlgae, this.beachPalms, this.seabedRocks, this.water, this.audio, this.environment]) {
      try { resource?.dispose?.(); } catch (error) { logger.warn('Demo cleanup failed.', error); }
    }
    disposeVegetationKtx2Loader(this.world?.renderer);
    try { this.world?.dispose?.(); } catch (error) { logger.warn('Demo cleanup failed.', error); }
    // After every consumer and the world, so shared templates outlive their users.
    this.assets.dispose();
    disposePresetAppearance(this.config);
    this.gpuCreationProbe?.dispose();
  }
}
