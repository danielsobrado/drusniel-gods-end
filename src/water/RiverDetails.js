import * as THREE from 'three/webgpu';
import { color, materialColor, materialRoughness, mix, positionWorld, sin, uniform } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { riverField } from './riverNodes.js';
import { coastX, coastXNode } from '../world/coast.js';

function isLakeCrossing(sample, river) {
  return sample.outletProgress <= 0 && sample.y <= river.lakeLevel + 0.05;
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
      const mesh = new THREE.InstancedMesh(geometry, material, 1400);
      mesh.count = 0;
      mesh.name = 'River bank boulders'; mesh.receiveShadow = true; mesh.castShadow = true;
      this.meshes.push(mesh); scene.add(mesh);
      return mesh;
    });
    const dummy = new THREE.Object3D();
    for (let i = 8; i < river.samples.length - 18; i += 2) {
      const p = river.samples[i];
      if (isLakeCrossing(p, river)) continue;
      for (const side of [-1, 1]) {
        if (random() < 0.18) continue;
        const across = side * (p.width * 0.5 - 0.4 + random() ** 2 * 3.8);
        const jitter = (random() - 0.5) * 4;
        const x = p.x - p.dz * across + p.dx * jitter, z = p.z + p.dx * across + p.dz * jitter;
        const y = terrain.sampleHeight(x, z);
        const scale = 0.45 + random() ** 2 * 3.1 + Math.min(1.5, p.slope ?? 0) * (0.7 + random() * 1.5);
        const mesh = batches[Math.floor(random() * batches.length)];
        const embed = 0.14 + THREE.MathUtils.smoothstep(p.slope ?? 0, 0.2, 0.8) * 0.4;
        dummy.position.set(x, y - scale * embed, z);
        dummy.rotation.set(random() * 0.4, random() * Math.PI * 2, random() * 0.3);
        dummy.scale.set(scale * (1 + random() * 0.6), scale * (0.7 + random() * 0.3), scale);
        dummy.updateMatrix(); mesh.setMatrixAt(mesh.count++, dummy.matrix);
        if (scale > 2.4) collisions?.addBox(new THREE.Vector3(x, dummy.position.y + dummy.scale.y * 0.4, z), new THREE.Vector3(scale * 0.7, dummy.scale.y * 0.7, scale * 0.7));
      }
    }
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

  dispose() {
    for (const mesh of this.meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.dispose(); }
    for (const material of this.materials) material.dispose();
  }
}
