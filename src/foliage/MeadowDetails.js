import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, positionLocal, vec3, sin, uniform, smoothstep, cameraPosition } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { foliageBacklight } from '../rendering/CinematicLighting.js';

function colored(geometry, color) {
  const c = new THREE.Color(color);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function leaf(length, width, color) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, -width, length * 0.48, 0.06, 0, length, 0.01,
    0, 0, 0, 0, length, 0.01, width, length * 0.48, 0.06,
  ], 3));
  geometry.computeVertexNormals();
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 0, 0, 0.5, 0.5, 1, 0.5, 0, 0.5, 1, 1, 0.5], 2));
  return colored(geometry, color);
}

function plantGeometry(type) {
  const parts = [];
  const add = geometry => parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
  if (type === 'litter') {
    const geometry = leaf(0.34, 0.11, '#715636');
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0.045, 0);
    return geometry;
  }
  if (type === 'stone') {
    const geometry = new THREE.IcosahedronGeometry(0.2, 1);
    geometry.scale(1.4, 0.55, 0.9);
    geometry.translate(0, 0.065, 0);
    return colored(geometry, '#777967');
  }
  const height = type === 'reed' ? 1.65 : type === 'seed' ? 1.05 : 0.7;
  add(colored(new THREE.CylinderGeometry(0.009, 0.018, height, 4).translate(0, height / 2, 0), '#53623a'));
  const count = type === 'fern' ? 12 : 4;
  for (let i = 0; i < count; i++) {
    const blade = leaf(type === 'fern' ? 0.62 : 0.38, type === 'fern' ? 0.12 : 0.06, '#587344');
    blade.rotateZ((i % 2 ? 1 : -1) * 0.85);
    blade.rotateY(i * 2.4);
    blade.translate(0, height * (0.18 + i / count * 0.55), 0);
    add(blade);
  }
  if (type === 'flower') {
    for (let i = 0; i < 5; i++) {
      const petal = new THREE.SphereGeometry(0.075, 5, 3);
      petal.scale(0.8, 0.35, 1.5);
      const angle = i * Math.PI * 2 / 5;
      petal.rotateY(angle);
      petal.translate(Math.sin(angle) * 0.07, height, Math.cos(angle) * 0.07);
      add(colored(petal, '#e8dec2'));
    }
    add(colored(new THREE.SphereGeometry(0.045, 5, 3).translate(0, height + 0.012, 0), '#bca052'));
  } else if (type === 'seed' || type === 'reed') {
    add(colored(new THREE.CylinderGeometry(0.025, 0.045, 0.26, 5).translate(0, height, 0), '#9c8656'));
  }
  const result = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return result;
}

export class MeadowDetails {
  constructor(scene, config, terrain, grass, trees) {
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
    this.quality = config.ui.initialQuality;
    this.treeCells = new Set((trees.trees ?? []).map(tree => `${Math.floor(tree.position.x / 12)},${Math.floor(tree.position.z / 12)}`));
    for (const type of ['flower', 'seed', 'fern', 'reed', 'litter', 'stone']) {
      const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.9 });
      const origin = attribute('detailOrigin', 'vec3');
      const distance = origin.xz.sub(cameraPosition.xz).length();
      const fade = smoothstep(this.radius - 18, this.radius, distance).oneMinus();
      const heightWeight = positionLocal.y.max(0).pow(2);
      const sway = sin(this.clock.mul(1.8).add(origin.x.mul(0.13)).add(origin.z.mul(0.08)))
        .mul(this.wind).mul(heightWeight).mul(type === 'litter' || type === 'stone' ? 0 : 0.1);
      material.positionNode = positionLocal.mul(fade).add(vec3(sway, 0, sway.mul(0.35)));
      material.emissiveNode = foliageBacklight(vec3(0.18, 0.24, 0.08), 0.22);
      const geometry = plantGeometry(type);
      const count = config.cinematic.vegetation.count;
      geometry.setAttribute('detailOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.name = `Meadow ${type}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.meshes.set(type, mesh);
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
    for (const mesh of this.meshes.values()) mesh.count = 0;
    const extent = Math.ceil(this.radius / 12);
    for (let x = cx - extent; x <= cx + extent; x++) {
      for (let z = cz - extent; z <= cz + extent; z++) {
        const random = createSeededRandom(Math.imul(x, 73856093) ^ Math.imul(z, 19349663));
        const wooded = this.treeCells.has(`${x},${z}`);
        for (let i = 0; i < density; i++) {
          const px = (x + random()) * 12;
          const pz = (z + random()) * 12;
          if (Math.hypot(px - position.x, pz - position.z) > this.radius || !this.terrain.contains(px, pz, 2)) continue;
          const py = this.terrain.sampleHeight(px, pz);
          if (!Number.isFinite(py) || py < this.config.water.position[1] - 0.1) continue;
          const slope = Math.abs(this.terrain.sampleHeight(px + 1, pz) - py) + Math.abs(this.terrain.sampleHeight(px, pz + 1) - py);
          if (slope > 1.1) continue;
          const mask = this.grass.sampleMask(px, pz);
          const patch = Math.sin(px * 0.065 + Math.sin(pz * 0.04)) * Math.sin(pz * 0.065);
          const bank = Math.abs(py - this.config.water.position[1]) < 1.8;
          let type;
          if (bank) type = 'reed';
          else if (wooded) type = random() > 0.4 ? 'litter' : 'fern';
          else if (mask < 0.35) { if (random() > 0.16) continue; type = 'stone'; }
          else { if (patch < 0.12) continue; type = random() > 0.65 ? 'flower' : 'seed'; }
          const mesh = this.meshes.get(type);
          if (mesh.count >= mesh.instanceMatrix.count) continue;
          const index = mesh.count++;
          this.dummy.position.set(px, py - 0.015, pz);
          this.dummy.rotation.set(0, random() * Math.PI * 2, 0);
          this.dummy.scale.setScalar(0.65 + random() * 0.85);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(index, this.dummy.matrix);
          mesh.geometry.attributes.detailOrigin.setXYZ(index, px, py, pz);
          this.color.setHSL(0.12 + random() * 0.05, 0.12, 0.7 + random() * 0.15);
          mesh.setColorAt(index, this.color);
        }
      }
    }
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.detailOrigin.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
