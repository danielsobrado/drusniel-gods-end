import * as THREE from 'three/webgpu';
import { createMeadowGeometry } from './MeadowGeometry.js';
import { attribute, positionGeometry, positionLocal, vec3, sin, uniform, smoothstep, cameraPosition } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { foliageBacklight, foliageLight } from '../rendering/CinematicLighting.js';

function isStoneType(type) {
  return type === 'stone' || String(type).startsWith('stone:');
}

function sourceMaterial(source) {
  return Array.isArray(source?.material) ? source.material[0] : source?.material;
}

function createMeadowLayer({
  scene, config, radius, clock, wind, type, geometry, map = null, roughness = 0.9, key = type, disposeSource = false,
}) {
  const staticDetail = type === 'litter' || isStoneType(type);
  const texturedStone = isStoneType(type) && map;
  const material = new THREE.MeshStandardNodeMaterial({
    side: texturedStone ? THREE.FrontSide : THREE.DoubleSide,
    vertexColors: !texturedStone,
    roughness,
    metalness: 0,
    map: map ?? null,
  });
  const origin = attribute('detailOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const fade = smoothstep(radius - 18, radius, distance).oneMinus();
  const phase = clock.mul(type === 'fern' ? 1.25 : 1.8).add(origin.x.mul(0.13)).add(origin.z.mul(0.08));
  const heightWeight = positionGeometry.y.max(0).pow(2);
  const sway = sin(phase).add(sin(phase.mul(1.7).add(positionGeometry.x.mul(3))).mul(0.16))
    .mul(wind.clamp(0, 3)).mul(heightWeight).mul(staticDetail ? 0 : 0.065);
  const root = origin.sub(vec3(0, 0.015, 0));
  material.positionNode = positionLocal.sub(root).add(vec3(sway, 0, sway.mul(0.35))).mul(fade).add(root);
  if (!texturedStone) {
    const pigment = attribute('color', 'vec3');
    const fill = config.cinematic.style?.enabled ? (config.cinematic.style.foliageFill ?? 0.28) : 0;
    material.emissiveNode = foliageBacklight(pigment, staticDetail ? 0 : config.cinematic.vegetation.backlight)
      .add(pigment.mul(foliageLight.fill).mul(staticDetail ? fill * 0.35 : fill));
  }
  const count = config.cinematic.vegetation.count;
  const instanceGeometry = geometry.clone();
  if (disposeSource) geometry.dispose();
  if (!instanceGeometry.boundingBox) instanceGeometry.computeBoundingBox();
  instanceGeometry.setAttribute('detailOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  const mesh = new THREE.InstancedMesh(instanceGeometry, material, count);
  mesh.name = `Meadow ${key}`;
  mesh.userData.excludeFromReflection = true;
  mesh.userData.rainRoughness = config.props?.rainRoughness ?? 0.1;
  mesh.count = 0;
  mesh.frustumCulled = true;
  mesh.receiveShadow = true;
  mesh.castShadow = isStoneType(type);
  scene.add(mesh);
  return mesh;
}

export class MeadowDetails {
  constructor(scene, config, terrain, grass, trees, pebbleSources = []) {
    this.scene = scene;
    this.config = config;
    this.terrain = terrain;
    this.grass = grass;
    this.trees = trees;
    this.radius = config.cinematic.vegetation.radius;
    this.clock = uniform(0);
    this.wind = uniform(0.2);
    this.lastCell = '';
    this.dummy = new THREE.Object3D();
    this.color = new THREE.Color();
    this.meshes = new Map();
    this.stoneMeshes = [];
    this.quality = config.ui.initialQuality;
    const layer = (type, geometry, extra = {}) => createMeadowLayer({
      scene,
      config,
      radius: this.radius,
      clock: this.clock,
      wind: this.wind,
      type,
      geometry,
      ...extra,
    });
    for (const type of ['flower', 'seed', 'fern', 'reed', 'litter']) {
      this.meshes.set(type, layer(type, createMeadowGeometry(type), { disposeSource: true }));
    }
    const pebbles = (pebbleSources ?? []).filter((source) => source?.geometry);
    if (pebbles.length > 0) {
      for (const [index, pebble] of pebbles.entries()) {
        const material = sourceMaterial(pebble);
        const key = pebbles.length === 1 ? 'stone' : `stone:${index}`;
        const mesh = layer('stone', pebble.geometry, {
          key,
          map: material?.map ?? null,
          roughness: material?.roughness ?? 0.88,
        });
        this.meshes.set(key, mesh);
        this.stoneMeshes.push(mesh);
      }
    } else {
      const mesh = layer('stone', createMeadowGeometry('stone'), { disposeSource: true });
      this.meshes.set('stone', mesh);
      this.stoneMeshes.push(mesh);
    }
  }

  setQuality(name) { this.quality = name; this.lastCell = ''; }

  update(delta, position, environment) {
    this.clock.value += delta * environment.grass.blade.simulationSpeed;
    this.wind.value = environment.grass.blade.windIntensity;
    const cx = Math.floor(position.x / 12);
    const cz = Math.floor(position.z / 12);
    const cell = `${cx},${cz}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    const density = { performance: 3, balanced: 6, high: 10, ultra: 14 }[this.quality] ?? 10;
    const ecologyConfig = this.config.vegetation.details;
    for (const mesh of this.meshes.values()) mesh.count = 0;
    const extent = Math.ceil(this.radius / 12);
    for (let x = cx - extent; x <= cx + extent; x++) {
      for (let z = cz - extent; z <= cz + extent; z++) {
        const random = createSeededRandom(Math.imul(x, 73856093) ^ Math.imul(z, 19349663));
        for (let i = 0; i < density; i++) {
          const px = (x + random()) * 12;
          const pz = (z + random()) * 12;
          if (Math.hypot(px - position.x, pz - position.z) > this.radius || !this.terrain.contains(px, pz, 2)) continue;
          const py = this.terrain.sampleHeight(px, pz);
          if (!Number.isFinite(py) || py < this.config.water.position[1] - 0.1) continue;
          const ecology = this.grass.sampleVegetation(px, pz);
          const patchScale = this.config.cinematic.vegetation.patchScale;
          const patch = Math.sin(px * patchScale + Math.sin(pz * patchScale * 0.62)) * Math.sin(pz * patchScale);
          let type;
          if (ecology.path >= ecologyConfig.pathThreshold) {
            if (random() > ecologyConfig.pathDecorationChance) continue;
            type = random() > ecologyConfig.pathStoneChance ? 'litter' : 'stone';
          } else if (ecology.moisture >= ecologyConfig.wetThreshold && ecology.density >= ecologyConfig.minimumPlantDensity) {
            type = 'reed';
          } else if (ecology.understory >= ecologyConfig.understoryThreshold) {
            type = random() < ecologyConfig.fernChance ? 'fern' : 'litter';
          } else {
            if (ecology.density < ecologyConfig.minimumPlantDensity || patch < ecologyConfig.meadowPatchThreshold) continue;
            type = random() < ecologyConfig.flowerChance ? 'flower' : 'seed';
          }
          const mesh = type === 'stone'
            ? this.stoneMeshes[Math.floor(random() * this.stoneMeshes.length)]
            : this.meshes.get(type);
          if (!mesh || mesh.count >= mesh.instanceMatrix.count) continue;
          const index = mesh.count++;
          this.dummy.position.set(px, type === 'stone' ? py : py - 0.015, pz);
          this.dummy.rotation.set(0, random() * Math.PI * 2, 0);
          const baseScale = ecologyConfig.minScale + random() * (ecologyConfig.maxScale - ecologyConfig.minScale);
          const ecologyScale = type === 'reed'
            ? ecologyConfig.reedBaseScale + ecology.moisture * ecologyConfig.reedMoistureScale
            : type === 'fern'
              ? ecologyConfig.fernBaseScale + ecology.understory * ecologyConfig.fernUnderstoryScale
              : ecologyConfig.plantBaseScale + ecology.growth * ecologyConfig.plantGrowthScale;
          const scale = type === 'stone' ? baseScale : baseScale * ecologyScale;
          const variation = Math.sin(px * 12.9898 + pz * 78.233) * 0.5 + 0.5;
          if (type === 'stone') this.dummy.scale.setScalar(scale);
          else this.dummy.scale.set(scale * (0.85 + variation * 0.3), scale * (1.12 - variation * 0.24), scale);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(index, this.dummy.matrix);
          mesh.geometry.attributes.detailOrigin.setXYZ(index, px, py, pz);
          if (!mesh.material.map) {
            const humidityTint = ecology.moisture * ecologyConfig.humidityTint;
            const shadeTint = ecology.understory * ecologyConfig.shadeTint;
            this.color.setHSL(
              ecologyConfig.hueBase + humidityTint - shadeTint,
              ecologyConfig.saturation,
              ecologyConfig.lightnessBase - shadeTint * ecologyConfig.lightnessShadeScale + random() * ecologyConfig.lightnessVariation,
            );
            mesh.setColorAt(index, this.color);
          }
        }
      }
    }
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.detailOrigin.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      const height = mesh.geometry.boundingBox.max.y;
      const padding = height * height * 3 * 0.065 * 1.16 * 1.5 * 1.15;
      mesh.boundingBox.expandByScalar(padding);
      mesh.boundingSphere ??= new THREE.Sphere();
      mesh.boundingBox.getBoundingSphere(mesh.boundingSphere);
    }
  }

  dispose() {
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
  }
}
