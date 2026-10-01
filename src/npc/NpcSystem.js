import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { assetUrl } from '../assets/assetUrl.js';
import { createRandom } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { captureObjectResources, ResourceScope } from '../utils/ResourceScope.js';
import { calibrateLocomotionClip } from '../player/LocomotionCalibration.js';
import { lakeSignedDistance } from '../world/LakeShape.js';
import { NPC_LOD_RATIOS, npcStageKey, resolveStages } from '../assets/scenePreprocessing.js';
import { resolveWorldScale } from '../world/worldScale.js';
import { NPC_KINDS } from './npcKinds.js';
import { loadingProfiler } from '../debug/LoadingProfiler.js';

const ARRIVE_DISTANCE = 1.5;
const CLIP_FADE = 0.35;
const TURN_RATE = 6;

// Kinds (models, heights, clips) live in npcKinds.js. Speeds scale with the
// height so the locomotion clips keep pace instead of moon-walking.
const WALK_SPEED_IN_HEIGHTS = 0.75;
const RUN_SPEED_IN_HEIGHTS = 2.0;
const KINDS = NPC_KINDS;

const SPAWNS = Object.freeze([
  // Three farmers on separate sides of the village rather than clustered on one
  // patch, so they read as villagers going about their own day. Each home sits
  // outside the ring of house footprints (the boxes span roughly x -236..-158,
  // z -350..-245) with a small radius that stays clear of the walls.
  { kind: 'villager', count: 1, home: [-150, -300], wander: 7, canRun: false },
  { kind: 'villager', count: 1, home: [-204, -236], wander: 7, canRun: false },
  { kind: 'villager', count: 1, home: [-250, -318], wander: 7, canRun: false },
  // Two farmers at the lake hamlet (structurePlacements LAKE_HOUSES), in the
  // open field between the houses, away from the shore the goblins keep to.
  { kind: 'villager', count: 1, home: [338, 262], wander: 9, canRun: false },
  { kind: 'villager', count: 1, home: [334, 312], wander: 9, canRun: false },
  // The lake is a bent blob around (406, 236); every goblin starts on a random
  // shore point inside its bounds and then roams nearby, kept on land by
  // lakeSignedDistance.
  { kind: 'goblin', count: 20, home: [406, 236], wander: 0, canRun: true },
]);

// Distance LODs, baked at build time (scripts/bake-scene-preprocessing.mjs)
// and simplified at load only as a fallback (see meshSimplify.js).
// Measured error at 4% of the triangles is under 1% of the model's extent.
// A 41-47k triangle character was the same cost at 80 m as at 2 m.
const LOD_DISTANCES = Object.freeze([0, 14, 32, 70]);
const LOD_STAGES = Object.freeze(NPC_LOD_RATIOS.map((ratio, index) => ({ ratio, distance: LOD_DISTANCES[index] })));
// Switching back to a finer stage waits until this much nearer, so an NPC
// hovering at a boundary does not flicker between stages every frame.
const LOD_HYSTERESIS = 0.9;

/** Self-contained animated NPCs with per-instance mixers and simple wander AI. */
export class NpcSystem {
  constructor({ scene, terrainSampler, config, lakeShape = null, assets = null }) {
    this.scene = scene;
    this.assets = assets;
    this.terrain = terrainSampler;
    this.config = config;
    this.lake = lakeShape;
    this.root = new THREE.Group();
    this.root.name = 'Npcs';
    this.entries = [];
    this.resources = new ResourceScope();
    this.random = createRandom(config.npcs?.randomSeed ?? 90210);
    this.lodGeometries = new Map();
    this.cameraPosition = new THREE.Vector3();
    // Template GLTF per kind, pending or loaded (see prefetch()).
    this.templateLoads = new Map();
    this.loader = null;
    this.draco = null;
  }

  #template(kind, signal) {
    let pending = this.templateLoads.get(kind);
    if (pending) return pending;
    if (!this.loader) {
      // The demo's shared load context owns the decoder when there is one.
      this.loader = this.assets?.createGltfLoader() ?? new GLTFLoader();
      if (!this.assets) {
        this.draco = new DRACOLoader();
        this.draco.setDecoderPath(this.config.assets?.dracoDecoderPath);
        this.loader.setDRACOLoader(this.draco);
      }
    }
    const loader = this.loader, model = KINDS[kind].model;
    const load = () => {
      signal?.throwIfAborted();
      return loadingProfiler().measure('npc:load', () => loader.loadAsync(assetUrl(model)), model);
    };
    pending = (this.assets ? this.assets.schedule(load) : load()).then((gltf) => {
      // Owned on arrival, so a template that never spawns is released too.
      this.resources.defer(captureObjectResources(gltf.scene));
      return gltf;
    });
    // Observed here; init() awaits it and handles the failure in order.
    pending.catch(() => {});
    this.templateLoads.set(kind, pending);
    return pending;
  }

  /**
   * Starts both character downloads (bounded by the shared load context);
   * init() still simplifies and spawns them in SPAWNS order, so the seeded
   * wander targets are drawn exactly as before.
   */
  prefetch(signal) {
    if (!this.assets) return;
    this.assets.scenePreprocessing();
    for (const spawn of SPAWNS) this.#template(spawn.kind, signal);
  }

  async init(signal) {
    try {
      const preprocessing = await (this.assets?.scenePreprocessing() ?? null);
      const templates = new Map();
      for (const spawn of SPAWNS) {
        signal?.throwIfAborted();
        const spec = KINDS[spawn.kind];
        if (!templates.has(spawn.kind)) {
          const gltf = await this.#template(spawn.kind, signal);
          signal?.throwIfAborted();
          const endLods = loadingProfiler().begin('npc:stages', spec.model);
          await this.#prepareLods(gltf.scene, spec.model, preprocessing);
          signal?.throwIfAborted();
          endLods();
          templates.set(spawn.kind, gltf);
        }
        // One GLB, many instances: each clone gets its own skeleton and mixer.
        for (let index = 0; index < (spawn.count ?? 1); index += 1) {
          signal?.throwIfAborted();
          this.#spawn(spawn, spec, templates.get(spawn.kind));
        }
      }
      this.scene.add(this.root);
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn('NPCs unavailable; continuing without them.', error);
    } finally {
      this.draco?.dispose();
      this.draco = null;
      this.loader = null;
    }
    return this;
  }

  // Each distinct geometry once, in traversal order: the order the bake
  // numbers them in.
  async #prepareLods(scene, path, preprocessing) {
    const geometries = [];
    scene.traverse((object) => {
      if (!object.isMesh || this.lodGeometries.has(object.geometry)) return;
      if (!geometries.includes(object.geometry)) geometries.push(object.geometry);
    });
    const requests = LOD_STAGES.filter(({ ratio }) => ratio < 1).map(({ ratio }) => [npcStageKey(ratio), { ratio }]);
    const resolved = await resolveStages(preprocessing, path, geometries, requests);
    geometries.forEach((geometry, index) => {
      const stages = LOD_STAGES.map(({ ratio }) => (ratio >= 1 ? geometry : resolved[index][npcStageKey(ratio)]));
      this.lodGeometries.set(geometry, stages);
      for (const stage of stages) if (stage !== geometry) this.resources.defer(() => stage.dispose());
    });
  }

  #spawn(spawn, spec, gltf) {
    const model = clone(gltf.scene);
    const lodMeshes = [];
    model.traverse((object) => {
      if (!object.isMesh) return;
      // SkeletonUtils.clone shares the template geometry, which keys its stages.
      const stages = this.lodGeometries.get(object.geometry);
      if (stages) lodMeshes.push({ mesh: object, stages });
      object.castShadow = true;
      object.receiveShadow = true;
      // The cull test caches one sphere, and swinging limbs reach past the pose
      // it captures, so pad that sphere rather than switching culling off. With
      // culling off all 22 characters (3 villagers, 19 goblins, ~41-47k triangles
      // each) were submitted in the main and shadow passes from any distance: a
      // constant 2.1M triangles a frame, about 15% of the village view, even with
      // the whole village behind the camera.
      object.frustumCulled = true;
      object.computeBoundingSphere?.();
      if (object.boundingSphere) {
        // Replace rather than mutate: SkeletonUtils.clone may share the sphere.
        const padded = object.boundingSphere.clone();
        padded.radius *= 1.4;
        object.boundingSphere = padded;
      }
    });
    // Scale to the kind's height on the world's character scale, then lift so
    // the model's own base sits at 0.
    const native = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const targetHeight = resolveWorldScale(this.config).humanHeight * spec.heightRatio;
    model.scale.setScalar(targetHeight / Math.max(0.001, native.y));
    model.updateWorldMatrix(true, true);
    model.position.y -= new THREE.Box3().setFromObject(model).min.y;

    const root = new THREE.Group();
    root.add(model);
    this.root.add(root);

    const mixer = new THREE.AnimationMixer(model);
    // Same rig generation as the playable roster, so reuse whichever character
    // is equipped for the locomotion calibration that strips net root drift.
    const locomotion = this.config.player?.locomotion ?? {};
    const clips = gltf.animations.map((clip) => (
      clip.name === spec.clips.walk || clip.name === spec.clips.run
        ? calibrateLocomotionClip(clip, locomotion) : clip));
    const actions = Object.fromEntries(clips.map((clip) => [clip.name, mixer.clipAction(clip)]));

    const def = { kind: spawn.kind, home: new THREE.Vector3(spawn.home[0], 0, spawn.home[1]),
      wander: spawn.wander, canRun: spawn.canRun };
    const start = this.#pickTarget(def);
    root.position.set(start.x, this.#ground(start.x, start.z), start.z);
    const entry = { def, spec, root, mixer, actions, current: null, lodMeshes, lodLevel: 0,
      walkSpeed: targetHeight * WALK_SPEED_IN_HEIGHTS,
      runSpeed: targetHeight * RUN_SPEED_IN_HEIGHTS,
      target: this.#pickTarget(def, root.position), running: false, wait: 1 + this.random() * 2 };
    this.entries.push(entry);
    this.#fade(entry, spec.clips.idle);
  }

  #ground(x, z) {
    return this.terrain?.sampleHeight?.(x, z) ?? 0;
  }

  // Picks the next wander point. A goblin target sits near where it already is
  // and the straight line to it has to stay on land, so it never cuts across the
  // lake; a villager stays inside its small radius of home, clear of the houses.
  #pickTarget(def, from = null) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      let x, z;
      if (def.kind === 'goblin' && this.lake) {
        if (from) {
          const angle = this.random() * Math.PI * 2;
          const step = 8 + this.random() * 28;
          x = from.x + Math.cos(angle) * step;
          z = from.z + Math.sin(angle) * step;
        } else {
          const bounds = this.lake.bounds;
          x = bounds.minX + this.random() * (bounds.maxX - bounds.minX);
          z = bounds.minZ + this.random() * (bounds.maxZ - bounds.minZ);
        }
        const distance = lakeSignedDistance(x, z, this.lake);
        if (distance < 1.5 || distance > 30) continue;
        if (from && this.#crossesWater(from.x, from.z, x, z)) continue;
      } else {
        x = def.home.x + (this.random() * 2 - 1) * def.wander;
        z = def.home.z + (this.random() * 2 - 1) * def.wander;
        if (this.lake && lakeSignedDistance(x, z, this.lake) < 1) continue;
      }
      return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(def.home.x, 0, def.home.z);
  }

  #crossesWater(ax, az, bx, bz) {
    for (let index = 1; index < 8; index += 1) {
      const t = index / 8;
      if (lakeSignedDistance(ax + (bx - ax) * t, az + (bz - az) * t, this.lake) < 0.5) return true;
    }
    return false;
  }

  #fade(entry, name) {
    const next = entry.actions[name];
    if (!next) {
      entry.current?.fadeOut(CLIP_FADE);
      entry.current = null;
      return;
    }
    if (entry.current === next) return;
    next.reset().fadeIn(CLIP_FADE).play();
    entry.current?.fadeOut(CLIP_FADE);
    entry.current = next;
  }

  // Picks each NPC's stage from its distance to the camera. Scale does not
  // enter: the stages' error is relative to the model, and every NPC is a
  // character-sized figure, so metres are a fair proxy for screen size.
  #updateLod(entry, camera) {
    if (!entry.lodMeshes.length) return;
    const distance = entry.root.position.distanceTo(camera.getWorldPosition(this.cameraPosition));
    let level = 0;
    while (level + 1 < LOD_STAGES.length && distance >= LOD_STAGES[level + 1].distance) level += 1;
    // Only refine once clearly inside the finer stage's range.
    if (level < entry.lodLevel && distance >= LOD_STAGES[entry.lodLevel].distance * LOD_HYSTERESIS) {
      level = entry.lodLevel;
    }
    if (level === entry.lodLevel) return;
    entry.lodLevel = level;
    for (const { mesh, stages } of entry.lodMeshes) mesh.geometry = stages[level];
  }

  update(deltaSeconds, camera = null) {
    if (deltaSeconds <= 0) return;
    const step = Math.min(deltaSeconds, 0.1);
    for (const entry of this.entries) {
      entry.mixer.update(step);
      if (camera) this.#updateLod(entry, camera);
      const { root, target } = entry;
      const dx = target.x - root.position.x;
      const dz = target.z - root.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= ARRIVE_DISTANCE) {
        entry.wait -= step;
        if (entry.wait <= 0) {
          entry.running = entry.def.canRun && this.random() < 0.45;
          entry.wait = 0.6 + this.random() * 3;
          entry.target = this.#pickTarget(entry.def, root.position);
          this.#fade(entry, entry.running ? entry.spec.clips.run : entry.spec.clips.walk);
        } else {
          this.#fade(entry, entry.spec.clips.idle);
        }
        continue;
      }
      const speed = entry.running ? entry.runSpeed : entry.walkSpeed;
      // Keep the locomotion clip on while travelling; only the arrival branch
      // switches to idle, so the first leg would otherwise slide in restpose.
      this.#fade(entry, entry.running ? entry.spec.clips.run : entry.spec.clips.walk);
      const advance = Math.min(distance, speed * step);
      const x = root.position.x + (dx / distance) * advance;
      const z = root.position.z + (dz / distance) * advance;
      root.position.set(x, this.#ground(x, z), z);
      // Turn toward the heading with a shortest-angle smoothing so the model
      // does not snap when a new target is chosen behind it.
      const heading = Math.atan2(dx, dz);
      let turn = heading - root.rotation.y;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      root.rotation.y += turn * Math.min(1, TURN_RATE * step);
    }
  }

  dispose() {
    for (const entry of this.entries) entry.mixer.stopAllAction();
    this.entries.length = 0;
    this.root.removeFromParent();
    this.scene.remove(this.root);
    this.resources.dispose();
  }
}
