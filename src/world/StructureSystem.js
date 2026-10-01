import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { DRAW_ORDER, setOpaqueDrawOrder } from '../rendering/drawOrder.js';
import { assetUrl } from '../assets/assetUrl.js';
import { logger } from '../utils/logger.js';
import { captureObjectResources, ResourceScope } from '../utils/ResourceScope.js';
import { resolveStages, STRUCTURE_STAGES } from '../assets/scenePreprocessing.js';
import { SHADOW_LAYER } from './TerrainShadowChunks.js';
import { resolveWorldScale } from './worldScale.js';
import { PLACEMENTS, resolveVillageSource } from './structurePlacements.js';
import { buildHouse, createHouseMaterials, disposeHouseMaterials } from './village/proceduralHouses.js';
import { computeFootprint } from './structureFootprint.js';
import { getVegetationKtx2Loader } from '../foliage/VegetationKtx2Loader.js';
import { loadingProfiler } from '../debug/LoadingProfiler.js';

// Static structures (structurePlacements.js): the village houses are
// generated (src/world/village) and everything else loads from GLBs. The ground
// height is sampled at each (x, z) so a piece sits on the terrain rather than at
// an authored Y -- for the chest that sampled height is the carved lake bed.
// The house kit is authored in real metres (doors are 2.0 m), so each house
// scales by the world-scale contract's units per metre (config world.scale):
// a door then stands a little above a human character.
// Below the lowest sampled ground point, so no gap opens under a wall.
const SINK_MARGIN = 0.5;
const SINK_SAMPLES = 6;

// The baked houses are 70-200k triangles each and heavily over-tessellated:
// within 0.1% of their extent (a few centimetres of the house) 9-51% of the triangles
// remain (STRUCTURE_STAGES.detail). Beyond DETAIL_DISTANCE they draw that stage;
// shadows always come from a coarser stage on the sun's shadow layer, since a
// shadow needs only outline. The stages are baked at build time
// (scripts/bake-scene-preprocessing.mjs) and simplified here only as a fallback.
const DETAIL_DISTANCE = 30;
// Metre-kit footprints: the lower storey (a door is 2.0 m) on a 25 cm grid.
// Porch posts and steps below half a square metre get no collider.
const GROUND_FLOOR_METRES = 3;
const FOOTPRINT_CELL_METRES = 0.25;
const FOOTPRINT_MIN_AREA = 0.5;
// Ground under at most this many footprint cells is sampled per placement.
const GROUND_SAMPLES = 400;
// Steps and porches may pull a house down this far below its wall grounding
// so they reach a falling slope; past it the walls would bury doors.
const MAX_STEP_SINK_METRES = 0.6;
// A generated house stands level with the terrain at this percentile of the
// ground under its walls, a little sunk: the uphill walls stay clear (on the
// lowest point they were buried up to 2 m) and its foundation plinth shows
// on the downhill side, as on a real hillside.
const GENERATED_GROUND_PERCENTILE = 0.8;
const GENERATED_SINK_METRES = 0.12;

/** Loads each placed GLB once and instances it as a static structure. */
export class StructureSystem {
  constructor({ scene, terrainSampler, config, collisionSystem = null, shadowCamera = null, renderer = null, assets = null }) {
    this.scene = scene;
    this.assets = assets;
    this.renderer = renderer;
    this.shadowCamera = shadowCamera;
    this.worldScale = resolveWorldScale(config);
    this.stages = new Map();
    this.lodMeshes = [];
    this.footprints = new Map();
    this.cameraPosition = new THREE.Vector3();
    this.terrain = terrainSampler;
    this.config = config;
    this.collisions = collisionSystem;
    this.groups = new Map();
    this.instances = [];
    this.resources = new ResourceScope();
    // Template scene per path, pending or loaded (see prefetch()).
    this.templateLoads = new Map();
    this.villageSource = resolveVillageSource(config);
    this.houseMaterials = null;
    this.loader = null;
    this.draco = null;
  }

  #group(name) {
    let group = this.groups.get(name);
    if (!group) {
      group = new THREE.Group();
      group.name = name;
      this.groups.set(name, group);
      this.scene.add(group);
    }
    return group;
  }

  #gltfLoader(signal) {
    if (this.loader) return this.loader;
    // The demo's shared load context owns the decoder when there is one.
    this.loader = this.assets?.createGltfLoader() ?? new GLTFLoader();
    if (!this.assets) {
      this.draco = new DRACOLoader();
      this.draco.setDecoderPath(this.config.assets?.dracoDecoderPath);
      this.loader.setDRACOLoader(this.draco);
    }
    // The baked house textures are KTX2 (scripts/encode-structure-ktx2.mjs):
    // the same shared transcoder as the vegetation atlases.
    const ktx2 = getVegetationKtx2Loader(this.renderer, this.config, signal);
    if (ktx2) this.loader.setKTX2Loader(ktx2);
    return this.loader;
  }

  #template(path, signal) {
    let pending = this.templateLoads.get(path);
    if (pending) return pending;
    const loader = this.#gltfLoader(signal);
    const load = () => {
      signal?.throwIfAborted();
      return loadingProfiler().measure('structure:load', () => loader.loadAsync(assetUrl(path)), path);
    };
    pending = (this.assets ? this.assets.schedule(load) : load()).then((gltf) => {
      // The template owns the geometry/textures; instances only clone it. It is
      // owned on arrival, so one that is never placed is released too.
      this.resources.defer(captureObjectResources(gltf.scene));
      return gltf.scene;
    });
    // Observed here; init() awaits it and handles the failure in order.
    pending.catch(() => {});
    this.templateLoads.set(path, pending);
    return pending;
  }

  #isGenerated(placement) {
    return Boolean(placement.procedural) && this.villageSource === 'procedural';
  }

  // The generated houses' shared materials. Their textures are generated in
  // workers, so starting this early overlaps the rest of the load.
  #houseMaterials(signal) {
    if (!this.houseMaterials) {
      this.houseMaterials = loadingProfiler().measure('structure:houseTextures', () => createHouseMaterials({ signal }))
        .then((materials) => {
          this.resources.defer(() => disposeHouseMaterials(materials));
          return materials;
        });
      this.houseMaterials.catch(() => {});
    }
    return this.houseMaterials;
  }

  // A generated house in the same frame as its GLB. The template owns only
  // its geometry; the materials are shared and released once.
  async #generatedTemplate(placement, signal) {
    const materials = await this.#houseMaterials(signal);
    signal?.throwIfAborted();
    const house = buildHouse(placement.procedural, materials);
    const geometries = [];
    house.traverse((object) => { if (object.isMesh) geometries.push(object.geometry); });
    this.resources.defer(() => { for (const geometry of geometries) geometry.dispose(); });
    return house;
  }

  /**
   * Starts every template download at once (bounded by the shared load
   * context), so the files arrive while the rest of the world is built.
   * init() still simplifies and places them in PLACEMENTS order.
   */
  prefetch(signal) {
    for (const placement of PLACEMENTS) if (this.#isGenerated(placement)) this.#houseMaterials(signal);
    if (!this.assets) return;
    this.assets.scenePreprocessing();
    for (const placement of PLACEMENTS) if (!this.#isGenerated(placement)) this.#template(placement.path, signal);
  }

  async init(signal) {
    try {
      const preprocessing = await (this.assets?.scenePreprocessing() ?? null);
      this.shadowCamera?.layers.enable(SHADOW_LAYER);
      const templates = new Map();
      for (const placement of PLACEMENTS) {
        signal?.throwIfAborted();
        const generated = this.#isGenerated(placement);
        const key = generated ? `generated:${placement.procedural}` : placement.path;
        if (!templates.has(key)) {
          if (generated) {
            const endBuild = loadingProfiler().begin('structure:generate', key);
            templates.set(key, await this.#generatedTemplate(placement, signal));
            endBuild();
          } else {
            const scene = await this.#template(placement.path, signal);
            signal?.throwIfAborted();
            const endStages = loadingProfiler().begin('structure:stages', placement.path);
            await this.#prepareStages(scene, placement.path, preprocessing);
            signal?.throwIfAborted();
            endStages();
            templates.set(key, scene);
          }
        }
        const endPlace = loadingProfiler().begin('structure:place', key);
        this.#place(placement, templates.get(key));
        endPlace();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn('Static structures unavailable; continuing without them.', error);
    } finally {
      this.draco?.dispose();
      this.draco = null;
      this.loader = null;
    }
    return this;
  }

  // Each distinct geometry once, in traversal order: the order the bake
  // numbers them in.
  async #prepareStages(scene, path, preprocessing) {
    const geometries = [];
    scene.traverse((object) => {
      if (!object.isMesh || object.isSkinnedMesh || this.stages.has(object.geometry)) return;
      if (!geometries.includes(object.geometry)) geometries.push(object.geometry);
    });
    const resolved = await resolveStages(preprocessing, path, geometries, Object.entries(STRUCTURE_STAGES));
    geometries.forEach((geometry, index) => {
      const { detail, shadow } = resolved[index];
      for (const stage of new Set([detail, shadow])) {
        if (stage !== geometry) this.resources.defer(() => stage.dispose());
      }
      this.stages.set(geometry, { full: geometry, detail, shadow });
    });
  }

  // The template's ground-floor footprint in its own frame. The kit's mesh
  // nodes are translated (up to 7.5 m), so positions go through the mesh's
  // transform relative to the template; measuring mesh-local grounded each
  // house on ground metres away from its walls and left it floating.
  #footprint(template) {
    if (this.footprints.has(template)) return this.footprints.get(template);
    if (template.userData.procedural) return this.#generatedFootprint(template);
    const mesh = template.getObjectByProperty('isMesh', true);
    const geometry = mesh?.geometry;
    let positions = geometry?.attributes.position.array;
    if (geometry?.index) {
      template.updateWorldMatrix(true, true);
      const local = new THREE.Matrix4().copy(template.matrixWorld).invert().multiply(mesh.matrixWorld);
      if (!local.equals(new THREE.Matrix4())) {
        const vertex = new THREE.Vector3();
        positions = new Float32Array(positions.length);
        const source = geometry.attributes.position;
        for (let i = 0; i < source.count; i++) vertex.fromBufferAttribute(source, i).applyMatrix4(local).toArray(positions, i * 3);
      }
    }
    const footprint = geometry?.index
      ? computeFootprint(positions, geometry.index.array, {
        bandHeight: GROUND_FLOOR_METRES, cell: FOOTPRINT_CELL_METRES, minArea: FOOTPRINT_MIN_AREA,
      })
      : null;
    this.footprints.set(template, footprint);
    return footprint;
  }

  // A generated house is one mesh per surface, all in the template's frame
  // (identity transforms): its footprint comes from all of them together.
  #generatedFootprint(template) {
    const positions = [], indices = [];
    template.traverse((object) => {
      if (!object.isMesh) return;
      const base = positions.length / 3;
      positions.push(...object.geometry.attributes.position.array);
      for (const index of object.geometry.index.array) indices.push(base + index);
    });
    const footprint = computeFootprint(positions, indices, {
      bandHeight: GROUND_FLOOR_METRES, cell: FOOTPRINT_CELL_METRES, minArea: FOOTPRINT_MIN_AREA,
    });
    this.footprints.set(template, footprint);
    return footprint;
  }

  // Ground a piece on the LOWEST terrain under its footprint, sunk a little
  // further. Terrain undulates several metres across a 30 m building, so a single
  // centre sample leaves the walls hanging over dips -- which reads as missing or
  // see-through lower walls -- and buried on the high side.
  #lowestGround(placement, bounds, cells = null, toWorld = null, footprint = null, scale = 1) {
    const centre = this.terrain?.sampleHeight?.(placement.x, placement.z) ?? 0;
    if (!this.terrain?.sampleHeight) return centre;
    let lowest = Infinity;
    // With a footprint, only the ground under the walls counts; the bounds
    // include eaves that overhang lower ground and sank houses too deep.
    if (cells?.length && toWorld) {
      const step = Math.max(1, Math.ceil(cells.length / GROUND_SAMPLES));
      const point = { x: 0, z: 0 };
      // Where the house's lowest point may sit so each cell's own bottom
      // (a step higher than the plinth reaches less far down) touches ground.
      let reach = Infinity;
      for (let i = 0; i < cells.length; i += step) {
        toWorld(cells[i].x, cells[i].z, point);
        const height = this.terrain.sampleHeight(point.x, point.z);
        if (!Number.isFinite(height)) continue;
        if (height < lowest) lowest = height;
        const raise = footprint && Number.isFinite(cells[i].y) ? (cells[i].y - footprint.minY) * scale : 0;
        if (height - raise < reach) reach = height - raise;
      }
      if (!Number.isFinite(lowest)) return centre;
      const maxStepSink = MAX_STEP_SINK_METRES * this.worldScale.unitsPerMetre;
      return Math.max(Math.min(lowest, reach), lowest - maxStepSink);
    }
    const steps = SINK_SAMPLES;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        const x = placement.x + bounds.min.x + ((bounds.max.x - bounds.min.x) * i) / steps;
        const z = placement.z + bounds.min.z + ((bounds.max.z - bounds.min.z) * j) / steps;
        const height = this.terrain.sampleHeight(x, z);
        if (Number.isFinite(height) && height < lowest) lowest = height;
      }
    }
    return Number.isFinite(lowest) ? Math.min(lowest, centre) : centre;
  }

  // The ground height at GENERATED_GROUND_PERCENTILE under a footprint, or
  // null when there is nothing to sample.
  #settledGround(cells, toWorld) {
    if (!cells?.length || !this.terrain?.sampleHeight) return null;
    const step = Math.max(1, Math.ceil(cells.length / GROUND_SAMPLES));
    const point = { x: 0, z: 0 };
    const heights = [];
    for (let i = 0; i < cells.length; i += step) {
      toWorld(cells[i].x, cells[i].z, point);
      const height = this.terrain.sampleHeight(point.x, point.z);
      if (Number.isFinite(height)) heights.push(height);
    }
    if (!heights.length) return null;
    heights.sort((a, b) => a - b);
    return heights[Math.min(heights.length - 1, Math.floor(GENERATED_GROUND_PERCENTILE * heights.length))];
  }

  #place(placement, template) {
    const object = template.clone(true);
    object.rotation.y = placement.rotationY ?? 0;
    object.scale.setScalar(placement.metres ? this.worldScale.unitsPerMetre : (placement.scale ?? 1));
    const group = this.#group(placement.group);
    group.add(object);
    object.updateWorldMatrix(true, true);
    // Rotate and measure at the origin so the base offset is independent of the
    // world position; the object then drops onto the sampled ground.
    const bounds = new THREE.Box3().setFromObject(object);
    const scale = object.scale.x, rotation = object.rotation.y;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    // Template-local XZ to world XZ, matching Object3D's Y rotation.
    const toWorld = (x, z, target) => {
      target.x = placement.x + (x * cos + z * sin) * scale;
      target.z = placement.z + (-x * sin + z * cos) * scale;
      return target;
    };
    const footprint = placement.metres ? this.#footprint(template) : null;
    const settled = Number.isFinite(template.userData.groundY) ? this.#settledGround(footprint?.cells, toWorld) : null;
    const base = settled !== null
      ? settled - template.userData.groundY * scale - GENERATED_SINK_METRES * this.worldScale.unitsPerMetre
      : this.#lowestGround(placement, bounds, footprint?.cells, toWorld, footprint, scale) - bounds.min.y - (placement.sink ?? 0) - SINK_MARGIN;
    object.position.set(placement.x, base, placement.z);
    // World bounds for the detail test, derived like the collider rather than
    // from matrices, which are only refreshed by the next render traversal.
    const placed = bounds.clone().translate(object.position);
    const meshes = [];
    object.traverse((child) => { if (child.isMesh) meshes.push(child); });
    for (const child of meshes) {
      setOpaqueDrawOrder(child, DRAW_ORDER.props);
      child.castShadow = true;
      child.receiveShadow = true;
      const stages = this.stages.get(child.geometry);
      if (!stages) continue;
      if (stages.detail !== stages.full) {
        this.lodMeshes.push({ mesh: child, stages, bounds: placed, detail: false });
      }
      if (this.shadowCamera && stages.shadow !== stages.full) {
        // A sibling with the same local transform, seen only by the shadow camera.
        const proxy = new THREE.Mesh(stages.shadow, child.material);
        proxy.name = `${child.name}:shadow`;
        proxy.position.copy(child.position); proxy.quaternion.copy(child.quaternion); proxy.scale.copy(child.scale);
        proxy.layers.set(SHADOW_LAYER);
        proxy.castShadow = true; proxy.receiveShadow = false;
        proxy.userData.excludeFromReflection = true; proxy.userData.occlusionCull = false;
        child.parent.add(proxy);
        child.castShadow = false;
      }
    }
    this.instances.push(object);
    if (placement.collide && footprint?.rectangles.length && this.collisions?.addOrientedBox) {
      // One turned box per footprint rectangle, from the lowest point to the
      // roof, so walls block and the ground under the eaves stays walkable.
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
      const height = (footprint.maxY - footprint.minY) * scale;
      const centreY = base + (footprint.minY + (footprint.maxY - footprint.minY) / 2) * scale;
      const point = { x: 0, z: 0 };
      for (const rectangle of footprint.rectangles) {
        toWorld(rectangle.x, rectangle.z, point);
        this.collisions.addOrientedBox(
          new THREE.Vector3(point.x, centreY, point.z),
          new THREE.Vector3(rectangle.width * scale, height, rectangle.depth * scale),
          quaternion,
        );
      }
    } else if (placement.collide && this.collisions?.addBox) {
      // addBox stores and clones the vectors, so it needs real Vector3s.
      const center = bounds.getCenter(new THREE.Vector3());
      this.collisions.addBox(
        new THREE.Vector3(center.x + placement.x, center.y + base, center.z + placement.z),
        bounds.getSize(new THREE.Vector3()),
      );
    }
    object.userData.footprint = footprint;
    object.userData.footprintToWorld = toWorld;
  }

  // Houses within DETAIL_DISTANCE of the camera (measured to their bounds, so
  // standing beside a long wall counts as near) draw full geometry.
  update(camera) {
    if (!camera || !this.lodMeshes.length) return;
    const position = camera.getWorldPosition(this.cameraPosition);
    for (const entry of this.lodMeshes) {
      const detail = entry.bounds.distanceToPoint(position) > DETAIL_DISTANCE;
      if (detail === entry.detail) continue;
      entry.detail = detail;
      entry.mesh.geometry = detail ? entry.stages.detail : entry.stages.full;
    }
  }

  dispose() {
    this.lodMeshes.length = 0;
    for (const object of this.instances) object.removeFromParent();
    this.instances.length = 0;
    for (const group of this.groups.values()) group.removeFromParent();
    this.groups.clear();
    this.resources.dispose();
  }
}
