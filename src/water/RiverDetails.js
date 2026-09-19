import * as THREE from 'three/webgpu';
import { color, materialColor, materialRoughness, mix, positionWorld, sin, uniform } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { findRiverFalls } from './RiverCourse.js';
import { riverField } from './riverNodes.js';
import { coastX, coastXNode } from '../world/coast.js';

const BATCH_CAPACITY = 1400;
// Rock around waterfalls draws from its own sequence, so the stones placed
// after the bank loop keep their places.
const FALL_ROCK_SEED = 5147;
// Bank samples this far above a lip and below a foot take the fall's rock.
const FALL_ZONE_ABOVE = 3;
const FALL_ZONE_BELOW = 8;

function isLakeCrossing(sample, river) {
  return sample.outletProgress <= 0 && sample.y <= river.lakeLevel + 0.05;
}

// A point `across` metres to the left of the course and `along` metres down it.
function courseOffset(p, across, along) {
  return { x: p.x - p.dz * across + p.dx * along, z: p.z + p.dx * across + p.dz * along };
}

/** Bank stones share the shipped rock pack, with a local wet rock response. */
export class RiverDetails {
  constructor(scene, river, terrain, sources = [], collisions) {
    this.meshes = [];
    this.materials = [];
    this.rain = uniform(0);
    const random = createSeededRandom(7319);
    const templates = sources.length ? sources.slice(0, 4) : [new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1))];
    const materialCache = new Map();
    const batches = templates.map(source => {
      const geometry = source.geometry.clone();
      geometry.computeBoundingBox();
      const size = geometry.boundingBox.getSize(new THREE.Vector3());
      geometry.scale(1 / Math.max(size.x, size.y, size.z), 1 / Math.max(size.x, size.y, size.z), 1 / Math.max(size.x, size.y, size.z));
      geometry.computeBoundingBox();
      const center = geometry.boundingBox.getCenter(new THREE.Vector3());
      geometry.translate(-center.x, -geometry.boundingBox.min.y, -center.z);
      const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material;
      let material = materialCache.get(sourceMaterial);
      if (!material) {
        material = new THREE.MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0 });
        if (sourceMaterial) material.copy(sourceMaterial);
        material.name = 'Textured river and upland rock';
        const variation = sin(positionWorld.x.mul(1.7)).mul(sin(positionWorld.z.mul(2.3))).mul(0.5).add(0.5);
        const water = riverField(river);
        let wet = positionWorld.y.sub(water.x).smoothstep(-0.4, 1.3).oneMinus()
          .mul(water.y.smoothstep(2, 7).oneMinus());
        const sea = terrain.config.water.sea;
        if (sea?.enabled) wet = wet.max(positionWorld.y.sub(sea.level).smoothstep(-0.3, 1.5).oneMinus()
          .mul(positionWorld.x.sub(coastXNode(positionWorld.z, sea.shoreX)).smoothstep(-80, -20)));
        // Preserve the source texture maps, then add the local wet response.
        // The procedural replacement discarded every texture for these rocks.
        const pigment = material.map ? materialColor.rgb : mix(color('#566961'), color('#929285'), variation);
        material.colorNode = pigment.mul(wet.mul(0.3).oneMinus());
        material.roughnessNode = mix(materialRoughness.max(0.72), 0.26, wet);
        materialCache.set(sourceMaterial, material);
        this.materials.push(material);
      }
      const mesh = new THREE.InstancedMesh(geometry, material, BATCH_CAPACITY);
      mesh.count = 0;
      mesh.name = 'River bank boulders'; mesh.receiveShadow = true; mesh.castShadow = true;
      this.meshes.push(mesh); scene.add(mesh);
      return mesh;
    });
    const dummy = new THREE.Object3D();
    const falls = river.falls ?? findRiverFalls(river.samples);
    const fallZone = new Uint8Array(river.samples.length);
    for (const fall of falls) {
      const last = Math.min(river.samples.length - 1, fall.foot + FALL_ZONE_BELOW);
      for (let i = Math.max(0, fall.lip - FALL_ZONE_ABOVE); i <= last; i++) fallZone[i] = 1;
    }
    for (let i = 8; i < river.samples.length - 18; i += 2) {
      const p = river.samples[i];
      if (isLakeCrossing(p, river)) continue;
      for (const side of [-1, 1]) {
        if (random() < 0.18) continue;
        const across = side * (p.width * 0.5 - 0.4 + random() ** 2 * 3.8);
        const jitter = (random() - 0.5) * 4;
        const x = p.x - p.dz * across + p.dx * jitter, z = p.z + p.dx * across + p.dz * jitter;
        const scale = 0.45 + random() ** 2 * 3.1 + Math.min(1.5, p.slope ?? 0) * (0.7 + random() * 1.5);
        const mesh = batches[Math.floor(random() * batches.length)];
        const embed = 0.14 + THREE.MathUtils.smoothstep(p.slope ?? 0, 0.2, 0.8) * 0.4;
        const tilt = [random() * 0.4, random() * Math.PI * 2, random() * 0.3];
        const stretch = [1 + random() * 0.6, 0.7 + random() * 0.3];
        // A fall's banks take its own rock below, but every draw above still
        // happens so the stones placed after this loop keep their places.
        if (fallZone[i]) continue;
        dummy.position.set(x, terrain.sampleHeight(x, z) - scale * embed, z);
        dummy.rotation.set(...tilt);
        dummy.scale.set(scale * stretch[0], scale * stretch[1], scale);
        dummy.updateMatrix(); mesh.setMatrixAt(mesh.count++, dummy.matrix);
        if (scale > 2.4) collisions?.addBox(new THREE.Vector3(x, dummy.position.y + dummy.scale.y * 0.4, z), new THREE.Vector3(scale * 0.7, dummy.scale.y * 0.7, scale * 0.7));
      }
    }
    this.#placeFallRock(falls, river, terrain, batches, collisions);
    // Partly submerged stones break up the current, with open gaps for the ford.
    for (let i = 15; i < river.samples.length - 30; i += 13) {
      const p = river.samples[i];
      if (isLakeCrossing(p, river)) continue;
      if ((p.slope ?? 0) > 0.45) continue;
      if (Math.hypot(p.x - 88, p.z + 19) < 12) continue;
      const across = (random() - 0.5) * p.width * 0.7;
      const x = p.x - p.dz * across, z = p.z + p.dx * across;
      const mesh = batches[i % batches.length], scale = 1 + random() * 1.7;
      dummy.position.set(x, p.y - 0.8, z); dummy.rotation.set(0.2, random() * 6, 0.1);
      dummy.scale.set(scale * 1.2, scale, scale); dummy.updateMatrix(); mesh.setMatrixAt(mesh.count++, dummy.matrix);
      collisions?.addBox(new THREE.Vector3(x, p.y - 0.15, z), new THREE.Vector3(scale * 0.8, scale * 0.7, scale * 0.8));
    }
    for (let i = 0; i < 440; i++) {
      const angle = random() * Math.PI * 2, radius = Math.sqrt(random());
      const x = 390 + Math.cos(angle) * radius * 175, z = -220 + Math.sin(angle) * radius * 160;
      if (terrain.paths?.sample(x, z) > 0.02 || (river.sample(x, z)?.edge ?? 100) < 5) continue;
      const y = terrain.sampleHeight(x, z), scale = 1.5 + random() ** 2 * 8;
      const mesh = batches[i % batches.length];
      dummy.position.set(x, y - scale * 0.14, z); dummy.rotation.set(random() * 0.5, random() * 6, random() * 0.4);
      dummy.scale.set(scale * 1.3, scale * (0.6 + random() * 0.8), scale); dummy.updateMatrix(); mesh.setMatrixAt(mesh.count++, dummy.matrix);
      if (scale > 4) collisions?.addBox(new THREE.Vector3(x, y + scale * 0.2, z), new THREE.Vector3(scale * 0.7, scale * 0.8, scale * 0.7));
    }
    if (terrain.config.water.sea?.enabled) for (let i = 0; i < 75; i++) {
      const sea = terrain.config.water.sea;
      const z = (random() - 0.5) * 1300;
      const x = coastX(z, sea.shoreX) - 12 - random() * 65;
      if (terrain.paths?.sample(x, z) > 0.02) continue;
      const y = terrain.sampleHeight(x, z), scale = 0.4 + random() ** 3 * 3.5;
      const mesh = batches[i % batches.length];
      dummy.position.set(x, y - scale * 0.15, z); dummy.rotation.set(0, random() * 6, 0.15);
      dummy.scale.set(scale * 1.4, scale * 0.6, scale); dummy.updateMatrix(); mesh.setMatrixAt(mesh.count++, dummy.matrix);
      if (scale > 2.8) collisions?.addBox(new THREE.Vector3(x, y + scale * 0.1, z), new THREE.Vector3(scale * 0.8, scale * 0.4, scale * 0.8));
    }
    for (const mesh of batches) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingBox(); mesh.computeBoundingSphere(); }
    if (!sources.length) templates[0].geometry.dispose();
  }

  // Falls are rockier than the reaches between them, and their rock is grouped
  // rather than strung along the banks: a boulder frames each side of the lip,
  // stones gather in clusters of mixed size down the sides with bare bank
  // between, and blocks lie tumbled around the plunge pool, a few breaking its
  // surface, with smaller spill below. Sizes are skewed small, with few large.
  #placeFallRock(falls, river, terrain, batches, collisions) {
    const random = createSeededRandom(FALL_ROCK_SEED);
    const samples = river.samples;
    const dummy = new THREE.Object3D();
    const put = ({ x, z }, scale, { stretch = 1 + random() * 0.5, flat = 0.7 + random() * 0.3, embed = 0.2 } = {}) => {
      if (scale > 1.5 && terrain.paths?.sample(x, z) > 0.02) return;
      const mesh = batches[Math.floor(random() * batches.length)];
      if (mesh.count >= BATCH_CAPACITY) return;
      // On a slope, settle most of the way toward the low side, so the stone
      // neither floats off the downhill edge nor sinks out of sight uphill.
      const reach = scale * 0.45;
      const center = terrain.sampleHeight(x, z);
      const low = Math.min(center, terrain.sampleHeight(x + reach, z), terrain.sampleHeight(x - reach, z),
        terrain.sampleHeight(x, z + reach), terrain.sampleHeight(x, z - reach));
      const height = scale * flat;
      dummy.position.set(x, center - (center - low) * 0.7 - height * embed, z);
      dummy.rotation.set(random() * 0.5, random() * Math.PI * 2, random() * 0.4);
      dummy.scale.set(scale * stretch, height, scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(mesh.count++, dummy.matrix);
      if (scale > 2.4) collisions?.addBox(new THREE.Vector3(x, dummy.position.y + height * 0.4, z), new THREE.Vector3(scale * 0.7, height * 0.7, scale * 0.7));
    };
    // One large stone and up to three smaller ones around it, straddling the
    // water line but mostly up the bank.
    const cluster = (p, side, size) => {
      const anchor = (1 + random() ** 2 * 2.6) * size;
      const center = courseOffset(p, side * (p.width * 0.5 + (random() - 0.35) * 2.6), (random() - 0.5) * 3);
      put(center, anchor);
      const count = Math.floor(random() ** 1.5 * 4);
      for (let k = 0; k < count; k += 1) {
        const angle = random() * Math.PI * 2, distance = anchor * 0.55 + random() * 1.6;
        put({ x: center.x + Math.cos(angle) * distance, z: center.z + Math.sin(angle) * distance },
          anchor * (0.22 + random() * 0.45));
      }
    };
    for (const fall of falls) {
      const size = THREE.MathUtils.clamp(0.75 + fall.drop / 60, 0.75, 1.5);
      const lip = samples[Math.max(0, fall.lip - 1)], foot = samples[fall.foot];
      for (const side of [-1, 1]) {
        const boulder = courseOffset(lip, side * (lip.width * 0.5 + (random() - 0.3) * 1.4), (random() - 0.5) * 2);
        const scale = (2.2 + random() * 1.6) * size;
        put(boulder, scale, { embed: 0.25 });
        const companions = Math.floor(random() * 3);
        for (let k = 0; k < companions; k += 1) {
          const angle = random() * Math.PI * 2, distance = scale * 0.6 + random() * 1.2;
          put({ x: boulder.x + Math.cos(angle) * distance, z: boulder.z + Math.sin(angle) * distance },
            scale * (0.2 + random() * 0.35));
        }
      }
      for (let i = fall.lip + 1 + Math.floor(random() * 2); i < fall.foot; i += 2 + Math.floor(random() * 3)) {
        const sides = random() < 0.5 ? [-1, 1] : [random() < 0.5 ? -1 : 1];
        for (const side of sides) cluster(samples[i], side, size);
      }
      for (const side of [-1, 1]) {
        const blocks = 1 + Math.floor(random() * 2.5);
        for (let k = 0; k < blocks; k += 1) {
          const at = courseOffset(foot, side * (foot.width * 0.5 + (random() - 0.45) * 2.4), -1 + random() * 6);
          put(at, (1.4 + random() ** 1.5 * 2.6) * size, { stretch: 1 + random() * 0.7 });
        }
      }
      const inPool = Math.floor(random() * 2.5);
      for (let k = 0; k < inPool; k += 1) {
        const side = random() < 0.5 ? -1 : 1;
        const at = courseOffset(foot, side * foot.width * (0.2 + random() * 0.22), 1 + random() * 5);
        put(at, (1.2 + random() * 1.4) * size, { embed: 0.15 });
      }
      const spillEnd = Math.min(samples.length - 1, fall.foot + FALL_ZONE_BELOW);
      for (let i = fall.foot + 2; i <= spillEnd; i += 2 + Math.floor(random() * 2)) {
        cluster(samples[i], random() < 0.5 ? -1 : 1, size * 0.55);
      }
    }
  }

  dispose() {
    for (const mesh of this.meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.dispose(); }
    for (const material of this.materials) material.dispose();
  }
}
