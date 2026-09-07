import * as THREE from 'three/webgpu';
import { createMeadowGeometry } from './MeadowGeometry.js';
import { attribute, positionGeometry, positionLocal, vec3, sin, uniform, smoothstep, cameraPosition } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { foliageBacklight, foliageLight } from '../rendering/CinematicLighting.js';

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
      const staticDetail = type === 'litter' || type === 'stone';
      const phase = this.clock.mul(type === 'fern' ? 1.25 : 1.8).add(origin.x.mul(0.13)).add(origin.z.mul(0.08));
      // positionLocal already includes the instance transform in Three r185.
      // Bend by the plant's own height, never its elevation above world zero.
      const heightWeight = positionGeometry.y.max(0).pow(2);
      const sway = sin(phase).add(sin(phase.mul(1.7).add(positionGeometry.x.mul(3))).mul(0.16))
        .mul(this.wind.clamp(0, 3)).mul(heightWeight).mul(staticDetail ? 0 : 0.065);
      const root = origin.sub(vec3(0, 0.015, 0));
      material.positionNode = positionLocal.sub(root).add(vec3(sway, 0, sway.mul(0.35))).mul(fade).add(root);
      const pigment = attribute('color', 'vec3');
      const fill = config.cinematic.style?.enabled ? (config.cinematic.style.foliageFill ?? 0.28) : 0;
      material.emissiveNode = foliageBacklight(pigment, staticDetail ? 0 : config.cinematic.vegetation.backlight)
        .add(pigment.mul(foliageLight.fill).mul(staticDetail ? fill * 0.35 : fill));
      const geometry = createMeadowGeometry(type);
      const count = config.cinematic.vegetation.count;
      geometry.setAttribute('detailOrigin', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.name = `Meadow ${type}`;
      mesh.userData.excludeFromReflection = true;
      mesh.count = 0;
      mesh.frustumCulled = true;
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
          const strength = this.grass.sampleMask(px, pz);
          const patchScale = this.config.cinematic.vegetation.patchScale;
          const patch = Math.sin(px * patchScale + Math.sin(pz * patchScale * 0.62)) * Math.sin(pz * patchScale);
          const bank = Math.abs(py - this.config.water.position[1]) < 1.8;
          let type;
          // The path test comes first: reeds on the bank and woodland ferns used to
          // short-circuit it and grow straight across the trails.
          if (strength <= 0) { if (random() > 0.16) continue; type = random() > 0.5 ? 'stone' : 'litter'; }
          else if (bank) type = 'reed';
          else if (wooded) type = random() > 0.4 ? 'litter' : 'fern';
          else { if (patch < 0.12) continue; type = random() > 0.65 ? 'flower' : 'seed'; }
          const mesh = this.meshes.get(type);
          if (mesh.count >= mesh.instanceMatrix.count) continue;
          const index = mesh.count++;
          this.dummy.position.set(px, py - 0.015, pz);
          this.dummy.rotation.set(0, random() * Math.PI * 2, 0);
          const scale = 0.65 + random() * 0.85;
          // Independent width and height avoid identical silhouettes without
          // changing the deterministic candidate locations or grass mask.
          const variation = Math.sin(px * 12.9898 + pz * 78.233) * 0.5 + 0.5;
          this.dummy.scale.set(scale * (0.85 + variation * 0.3), scale * (1.12 - variation * 0.24), scale);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(index, this.dummy.matrix);
          mesh.geometry.attributes.detailOrigin.setXYZ(index, px, py, pz);
          this.color.setHSL(0.12 + random() * 0.05, 0.09, 0.83 + random() * 0.12);
          mesh.setColorAt(index, this.color);
        }
      }
    }
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.detailOrigin.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // CPU bounds include the shader's maximum wind bend (wind is capped at 3).
      // Rebuild after relocation so frustum culling never uses the old meadow.
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
