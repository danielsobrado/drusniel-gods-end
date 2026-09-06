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
  }

  async start() {
    const loading = new LoadingUi(this.root, this.config.cinematic?.presentation, {
      roster: getRoster(this.config),
      selectedId: requestedCharacterId(window.location.search, this.config),
    });
    this.loading = loading;
    this.world = await createWorld(this.config, (stage) => loading.stage(stage));
    this.cinematicLighting = new CinematicLighting(this.world, this.config);
    this.root.appendChild(this.world.renderer.domElement);

    // The roster gate decides which GLB and which proportions the controller
    // reads, so it has to close before PlayerController is constructed.
    if (loading.needsCharacterChoice()) loading.stage('character');
    const chosenId = await loading.waitForCharacter();
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
    this.grass = await new GrassField(
      this.world.scene,
      this.world.camera,
      this.world.renderer,
      this.config,
      this.world.terrainSampler,
    ).init();
    this.grass.attachPainter({ terrain: this.world.terrainTarget, player: this.player });
    const groundMaterials = this.world.terrainTarget.material;
    for (const material of Array.isArray(groundMaterials) ? groundMaterials : [groundMaterials]) {
      material?.userData.setGrassMask?.(this.grass.mask);
    }
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

    this.tour = new ScenicTour(this.world, this.player, this.trees, this.water);
    this.iris = new IrisTransition(this.root);
    this.ui = new DemoUi(this.root, this.config, this.#createUiActions());
    this.pipeline = new CinematicPipeline(this.world, this.config);

    loading.stage('shaders');
    this.cinematicLighting.activateShadows();
    await this.world.renderer.compileAsync(this.world.scene, this.world.camera);
    window.addEventListener('resize', () => this.#resize(), { signal: this.abortController.signal });
    this.#resize();

    loading.stage('ready');
    this.world.renderer.setAnimationLoop(() => this.#render());
    await loading.waitForStart(async () => {
      try {
        await this.audio.start();
      } catch (error) {
        logger.warn('Audio context could not start from the start gate.', error);
      }
      this.player.setPosition(...this.config.player.start);
    });
    this.loading = null;
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
      toggleTour: () => {
        if (this.grass.painter?.enabled) this.grass.togglePainter();
        return this.tour.start();
      },
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
      togglePainter: () => { this.tour.stop(); return this.grass.togglePainter(); },
      isPainterEnabled: () => this.grass.painter?.enabled ?? false,
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
    return this.grass.sampleMask(position.x, position.z) > 0 ? 'grass' : 'mud';
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
    this.water.update(deltaSeconds, this.player, this.environment.current.lighting);
    this.pipeline.render({ occlusionEnabled: !this.grass.painter?.enabled });
    this.ui.update(deltaSeconds);
  }

  dispose() {
    this.world?.renderer?.setAnimationLoop(null);
    this.abortController.abort();

    this.loading?.dispose?.();
    this.pipeline?.dispose();
    this.cinematicLighting?.dispose();
    this.meadow?.dispose();
    this.ui?.dispose?.();
    this.iris?.dispose?.();
    this.grass?.painter?.dispose?.();
    this.grass?.dispose?.();
    this.trees?.dispose?.();
    this.props?.dispose?.();
    this.collisions?.dispose?.();
    this.player?.dispose?.();
    this.leaves?.dispose?.();
    this.birds?.dispose?.();
    this.rain?.dispose?.();
    this.water?.dispose?.();
    this.audio?.dispose?.();
    this.environment?.dispose?.();
    this.world?.terrainAnimations?.dispose?.();
    this.world?.sky?.dispose?.();
    this.world?.clouds?.dispose?.();

    const canvas = this.world?.renderer?.domElement;
    this.world?.renderer?.dispose?.();
    canvas?.remove?.();
  }
}
