import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, cos, dFdx, dFdy, dot, positionLocal, sin, time, uv, vec2, vec3 } from 'three/tsl';
import { assetUrl } from '../assets/assetUrl.js';
import { createSeededRandom } from '../core/math.js';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';
import { ambientUniforms } from '../weather/ambientUniforms.js';
import { coastX, resolveCoastConfig } from './CoastField.js';
import { InstancedLodSet } from './InstancedLodSet.js';

// Coconut palms along the top of the beach, from the coastal jungle's own
// palm models (472 triangles each, one bark and one alpha-cut frond material).
// They stand in groves along the shore, thickest at the vegetation line and
// thinning toward the sea, and most lean seaward, as palms on a windward
// beach grow toward the light over the sand.
const VARIANTS = [
  'Assets/terrain/coastal-jungle/objects/forest/palm_01.glb',
  'Assets/terrain/coastal-jungle/objects/forest/palm_02.glb',
];
// Model height (metres) the sway is normalised to.
const PALM_HEIGHT = 10.8;

function palmMaterials(source, params) {
  const phase = attribute('palmPhase', 'float').mul(Math.PI * 2);
  const height = positionLocal.y.div(PALM_HEIGHT).clamp(0, 1.2);
  const bend = height.mul(height);
  // A slow lean with the wind plus gusts; stronger in windy weather.
  const wind = ambientUniforms.windiness.mul(0.7).add(0.3);
  const gust = sin(time.mul(0.62).add(phase)).mul(0.55)
    .add(sin(time.mul(1.73).add(phase.mul(1.7))).mul(0.25)).add(0.45);
  const sway = bend.mul(gust).mul(wind).mul(params.sway * PALM_HEIGHT * 0.1);
  const swayed = positionLocal.add(vec3(sway, sway.mul(-0.12), sway.mul(0.35)));
  return source.map((material) => {
    const fronds = material.alphaTest > 0 || material.transparent;
    const tint = fronds
      ? material.color.clone().multiply(new THREE.Color(params.frondTint)).multiplyScalar(params.frondBrightness)
      : material.color;
    const node = new THREE.MeshStandardNodeMaterial({
      map: material.map,
      color: tint,
      roughness: fronds ? 0.72 : 0.9,
      metalness: 0,
      alphaTest: fronds ? Math.max(material.alphaTest, 0.35) : 0,
      side: fronds ? THREE.DoubleSide : THREE.FrontSide,
    });
    node.name = `Beach palm ${fronds ? 'fronds' : 'bark'}`;
    if (fronds) {
      // Leaflets flutter on top of the whole tree's sway.
      const flutter = sin(time.mul(4.1).add(positionLocal.x.mul(1.9)).add(positionLocal.z.mul(1.3)).add(phase))
        .mul(height).mul(wind).mul(params.flutter);
      node.positionNode = swayed.add(vec3(flutter.mul(0.4), flutter, cos(phase.add(time.mul(3.3))).mul(flutter.mul(0.3))));
      // Mipmapping averages the thin leaflets' alpha toward zero, so past a few
      // tens of metres the cutoff ate the crowns and left bare trunks. Scale
      // alpha up with the mip level being sampled to keep their coverage.
      const size = vec2(material.map?.image?.width ?? 1024, material.map?.image?.height ?? 1024);
      const texel = uv().mul(size);
      const dx = dFdx(texel), dy = dFdy(texel);
      const mip = dot(dx, dx).max(dot(dy, dy)).max(1).log2().mul(0.5);
      node.opacityNode = mip.mul(0.32).add(1);
      // Sunlight through the leaflets when the palm stands against the sun.
      node.emissiveNode = foliageBacklight(vec3(0.55, 0.62, 0.22), 0.35);
    } else {
      node.positionNode = swayed;
    }
    return node;
  });
}

// A palm's parts, one geometry per material (bark, fronds). Each part gets its
// own instanced mesh: an instanced mesh drawing a material array through
// geometry groups freed a per-object binding buffer still in use on WebGPU.
function palmParts(root) {
  root.updateMatrixWorld(true);
  const byMaterial = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    if (Array.isArray(object.material)) throw new Error(`Palm mesh ${object.name} has several materials.`);
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
    }
    if (!byMaterial.has(object.material)) byMaterial.set(object.material, []);
    byMaterial.get(object.material).push(geometry);
  });
  return [...byMaterial].map(([material, geometries]) => {
    const geometry = geometries.length > 1 ? mergeGeometries(geometries) : geometries[0];
    if (geometries.length > 1) for (const part of geometries) part.dispose();
    return { geometry, material };
  });
}

function samplePalmSites(terrain, sea, params) {
  const random = createSeededRandom(params.seed);
  const records = [];
  const cell = params.minSpacing;
  const occupied = new Map();
  const key = (i, j) => `${i},${j}`;
  const crowded = (x, z) => {
    const i = Math.floor(x / cell), j = Math.floor(z / cell);
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        for (const other of occupied.get(key(i + di, j + dj)) ?? []) {
          if ((other.x - x) ** 2 + (other.z - z) ** 2 < cell * cell) return true;
        }
      }
    }
    return false;
  };
  const up = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();
  const leanQuat = new THREE.Quaternion();
  const minZ = terrain.bounds.min.z + 8, maxZ = terrain.bounds.max.z - 8;
  for (let attempt = 0; attempt < params.attempts && records.length < params.count; attempt += 1) {
    const z = THREE.MathUtils.lerp(minZ, maxZ, random());
    // Groves: a slowly wandering density along the shore, with open beach
    // between them.
    const grove = Math.sin(z * params.groveFrequency + Math.sin(z * params.groveFrequency * 0.37) * 2.3) * 0.5 + 0.5;
    if (random() > THREE.MathUtils.smoothstep(grove, params.groveThreshold, params.groveThreshold + 0.45)) continue;
    // Thickest at the vegetation line, a few standing out on the sand.
    const inland = params.inlandMax - (params.inlandMax - params.inlandMin) * random() ** params.inlandBias;
    const x = coastX(z, sea) - inland;
    if (x < terrain.bounds.min.x + 4 || x > terrain.bounds.max.x - 4) continue;
    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y < sea.level + params.minHeightAboveSea) continue;
    const slope = Math.hypot(
      terrain.sampleHeight(x + 1, z) - terrain.sampleHeight(x - 1, z),
      terrain.sampleHeight(x, z + 1) - terrain.sampleHeight(x, z - 1),
    ) / 2;
    if (1 / Math.sqrt(1 + slope * slope) < params.minNormalY) continue;
    if ((terrain.paths?.sample(x, z) ?? 0) > params.pathClearance) continue;
    if ((terrain.river?.sample(x, z)?.edge ?? Infinity) < params.riverClearance) continue;
    if (crowded(x, z)) continue;

    const scale = THREE.MathUtils.lerp(params.scaleMin, params.scaleMax, random() ** 1.3);
    // Lean: mostly toward the sea (+x), the rest any way.
    const seaward = random() < params.seawardLean;
    const heading = seaward ? (random() - 0.5) * 1.3 : random() * Math.PI * 2;
    const lean = THREE.MathUtils.lerp(params.leanMin, params.leanMax, random()) * (seaward ? 1 : 0.6);
    // Turning about up x (cos heading, 0, sin heading) tips the crown that way.
    axis.set(Math.sin(heading), 0, -Math.cos(heading));
    leanQuat.setFromAxisAngle(axis, lean);
    yawQuat.setFromAxisAngle(up, random() * Math.PI * 2);
    const position = new THREE.Vector3(x, y - 0.15 * scale, z);
    const matrix = new THREE.Matrix4().compose(
      position,
      leanQuat.clone().multiply(yawQuat),
      new THREE.Vector3(scale, scale, scale),
    );
    const record = { position, matrix, phase: random(), variant: random() < 0.5 ? 0 : 1, scale, x, z };
    records.push(record);
    const i = Math.floor(x / cell), j = Math.floor(z / cell);
    if (!occupied.has(key(i, j))) occupied.set(key(i, j), []);
    occupied.get(key(i, j)).push(record);
  }
  return records;
}

export class BeachPalms {
  constructor({ scene, terrain, config, collisions = null, assets = null }) {
    this.scene = scene;
    this.terrain = terrain;
    this.config = config;
    this.collisions = collisions;
    this.assets = assets;
    this.sets = [];
    this.records = [];
    this.materials = [];
  }

  async init(signal) {
    const seaConfig = this.config.water?.sea;
    if (!seaConfig?.enabled || !this.config.terrain?.expansion?.enabled || !this.terrain?.bounds) return this;
    const sea = resolveCoastConfig(seaConfig);
    const params = sea.coast.palms;
    if (!params.count) return this;
    const loader = this.assets?.createGltfLoader() ?? new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const templates = await Promise.all(VARIANTS.map(async (path) => {
      const gltf = await loader.loadAsync(assetUrl(path));
      const parts = palmParts(gltf.scene);
      gltf.scene.traverse((object) => { if (object.isMesh) object.geometry.dispose(); });
      return parts;
    }));
    signal?.throwIfAborted();
    this.records = samplePalmSites(this.terrain, sea, params);
    // Stretches of shore, each its own set: one set's bounds spanning the whole
    // coast never culled, so every palm was drawn (and cast shadow) even with
    // the camera facing out to sea.
    const chunks = new Map();
    for (const record of this.records) {
      const key = `${record.variant}:${Math.floor(record.z / params.chunkSize)}`;
      if (!chunks.has(key)) chunks.set(key, []);
      chunks.get(key).push(record);
    }
    templates.forEach((parts, variant) => {
      const materials = palmMaterials(parts.map((part) => part.material), params);
      this.materials.push(...materials);
      parts.forEach((part, index) => {
        part.material.dispose();
        for (const [key, records] of chunks) {
          if (!key.startsWith(`${variant}:`)) continue;
          this.sets.push(new InstancedLodSet({
            scene: this.scene,
            name: `${materials[index].name} ${key}`,
            records,
            material: materials[index],
            levels: [{ geometry: part.geometry, maxDistance: params.distance }],
            attributes: { palmPhase: { itemSize: 1, read: (record, out) => { out[0] = record.phase; } } },
            renderOrder: DRAW_ORDER.foliage,
            castShadow: true,
            rebucketDistance: 10,
          }));
        }
        part.geometry.dispose();
      });
    });
    if (this.collisions) {
      for (const record of this.records) {
        const width = params.colliderWidth * record.scale;
        const height = params.colliderHeight * record.scale;
        this.collisions.addBox(
          new THREE.Vector3(record.x, record.position.y + height * 0.5, record.z),
          new THREE.Vector3(width, height, width),
          { cameraTransparent: true },
        );
      }
    }
    return this;
  }

  get count() {
    return this.records.length;
  }

  update(camera) {
    for (const set of this.sets) set.update(camera);
  }

  dispose() {
    for (const set of this.sets) set.dispose();
    for (const material of this.materials) material.dispose();
    this.sets.length = 0;
    this.materials.length = 0;
  }
}
