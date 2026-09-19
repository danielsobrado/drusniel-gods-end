import * as THREE from 'three/webgpu';
import { attribute, float, floor, fract, interleavedGradientNoise, mix, positionLocal,
  screenCoordinate, sin, cos, texture, transformNormalToView, uv, vec2, vec3, vec4 } from 'three/tsl';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import { TREE_LOD_DEFAULTS, vegetationLodWeights } from './vegetationLodPolicy.js';

const names = ['full', 'medium', 'low', 'billboard'];
const triangles = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
function coverageMask() {
  const interval = attribute('lodInterval', 'vec2');
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  return noise.greaterThanEqual(interval.x).and(noise.lessThan(interval.y));
}
function atlasMaterial(atlas, capture, config) {
  const angle = attribute('lodView', 'float'), view = fract(angle.div(Math.PI * 2).add(1)).mul(capture.views);
  const first = floor(view), next = first.add(1).mod(capture.views), fraction = fract(view);
  const inset = 1.5 / capture.tileSize;
  const tileUV = uv().clamp(inset, 1 - inset);
  const sample = index => texture(atlas, vec2(tileUV.x.add(index).div(capture.views), tileUV.y));
  const a = sample(first), b = sample(next), alpha = mix(a.a, b.a, fraction);
  const rgb = mix(a.rgb.mul(a.a), b.rgb.mul(b.a), fraction).div(alpha.max(0.001)).mul(attribute('lodTint', 'vec3'));
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.35 });
  material.colorNode = vec4(rgb, alpha);
  material.emissiveNode = foliageBacklight(rgb, 0.2);
  material.normalNode = transformNormalToView(vec3(0, 1, 0));
  material.alphaToCoverage = Boolean(config.cinematic?.enabled);
  const right = vec3(cos(angle), 0, sin(angle).negate());
  material.positionNode = vec3(...capture.center).add(right.mul(positionLocal.x.mul(capture.width)))
    .add(vec3(0, positionLocal.y.mul(capture.height), 0));
  material.maskNode = coverageMask();
  return material;
}

/** Shared four-stage renderer. World-space records are immutable; only compact GPU submissions change. */
export class VegetationLodRenderer {
  constructor({ scene, config, chunkSize = TREE_LOD_DEFAULTS.chunkSize, prepareMaterial, policy }) {
    Object.assign(this, { scene, config, chunkSize, prepareMaterial, policy });
    this.chunks = []; this.templates = []; this.resources = [];
    this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4();
    this.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity); this.lastQuaternion = new THREE.Quaternion();
    this.lastProjection = new THREE.Matrix4(); this.localCamera = new THREE.Vector3();
    this.quality = 'high'; this.dirty = true; this.weights = [0, 0, 0, 0];
    this.stats = { full: 0, medium: 0, low: 0, billboard: 0, triangles: 0, visibleInstances: 0, visibleChunks: 0, bookkeepingMs: 0, byKind: {} };
  }
  addVariant({ key, kind = 'tree', full, asset, records }) {
    if (!records.length) return;
    const levels = [full, asset?.levels[1], asset?.levels[2], null];
    if (asset?.atlas && asset.entry.capture) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = atlasMaterial(asset.atlas, asset.entry.capture, this.config);
      levels[3] = [{ geometry, material, atlas: true }];
      this.resources.push(() => { geometry.dispose(); material.dispose(); });
    }
    const templates = levels.map((parts, level) => parts?.map(part => {
      const source = Array.isArray(part.material) ? part.material : [part.material];
      const materials = source.map(material => {
        if (part.atlas) return material;
        const prepared = this.prepareMaterial(material, { kind, name: part.name, level });
        prepared.opacity = 1; prepared.opacityNode = float(1); prepared.alphaHash = false;
        const mask = coverageMask();
        prepared.maskNode = prepared.maskNode ? prepared.maskNode.and(mask) : mask;
        prepared.maskShadowNode = prepared.maskShadowNode ? prepared.maskShadowNode.and(mask) : mask;
        this.resources.push(() => prepared.dispose()); return prepared;
      });
      return { geometry: part.geometry, material: Array.isArray(part.material) ? materials : materials[0] };
    }) ?? null);
    this.templates.push(templates);
    const groups = new Map();
    for (const record of records) {
      const cell = `${Math.floor(record.position.x / this.chunkSize)},${Math.floor(record.position.z / this.chunkSize)}`;
      let chunk = groups.get(cell);
      if (!chunk) {
        chunk = { key, kind, templates, capture: asset?.entry.capture, records: [], bounds: new THREE.Box3(), draws: [null, null, null, null] };
        groups.set(cell, chunk);
      }
      record.inverse = new THREE.Matrix4().fromArray(record.matrix).invert();
      chunk.records.push(record);
      chunk.bounds.union(record.sphere.getBoundingBox(new THREE.Box3()));
    }
    for (const chunk of groups.values()) { chunk.bounds.expandByScalar(3); this.chunks.push(chunk); }
    this.dirty = true;
  }
  setQuality(name) { this.quality = name; this.dirty = true; }
  #draw(chunk, level) {
    if (chunk.draws[level]) return chunk.draws[level];
    const capacity = chunk.records.length;
    const matrices = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
    const interval = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const bend = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const view = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    const meshes = chunk.templates[level].map(template => {
      const geometry = template.geometry.clone();
      for (const [name, attr] of [['lodInterval', interval], ['lodTint', tint], ['lodRootBend', bend], ['lodView', view]]) geometry.setAttribute(name, attr);
      const mesh = new THREE.InstancedMesh(geometry, template.material, capacity);
      mesh.instanceMatrix = matrices; mesh.count = 0; mesh.frustumCulled = false;
      mesh.name = `${chunk.key}:${names[level]}`;
      mesh.castShadow = level < 2; mesh.receiveShadow = level < 3;
      mesh.userData.excludeFromReflection = level === 3;
      mesh.userData.occlusionCull = false;
      this.scene.add(mesh); return mesh;
    });
    const draw = { meshes, matrices, interval, tint, bend, view, count: 0 };
    chunk.draws[level] = draw; return draw;
  }
  update(camera, force = false) {
    if (this.disposed) return this.stats;
    if (!force && !this.dirty && camera.position.distanceToSquared(this.lastPosition) < 0.0001
      && 1 - Math.abs(camera.quaternion.dot(this.lastQuaternion)) < 0.0000001 && camera.projectionMatrix.equals(this.lastProjection)) return this.stats;
    const start = performance.now(); this.dirty = false;
    this.lastPosition.copy(camera.position); this.lastQuaternion.copy(camera.quaternion); this.lastProjection.copy(camera.projectionMatrix);
    camera.updateMatrixWorld(); this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
    const stats = this.stats;
    for (const key of ['full', 'medium', 'low', 'billboard', 'triangles', 'visibleInstances', 'visibleChunks']) stats[key] = 0;
    stats.byKind = {};
    for (const chunk of this.chunks) {
      for (const draw of chunk.draws) if (draw) { draw.count = 0; for (const mesh of draw.meshes) mesh.visible = false; }
      if (!this.frustum.intersectsBox(chunk.bounds)) continue;
      if (chunk.bounds.distanceToPoint(camera.position) >= this.policy(chunk.records[0], chunk.kind, this.quality).far) continue;
      const available = chunk.templates.map(Boolean);
      let chunkVisible = false;
      for (const record of chunk.records) {
        if (!this.frustum.intersectsSphere(record.sphere)) continue;
        const distance = record.position.distanceTo(camera.position);
        const settings = this.policy(record, chunk.kind, this.quality);
        if (distance >= settings.far || record.fraction > (settings.density ?? 1)) continue;
        const weights = vegetationLodWeights(distance, { ...settings,
          available: settings.plant ? [true, true, true, true] : available }, this.weights);
        if (settings.plant) {
          // A plant has only full geometry and a billboard; keep the last slot consistent with trees.
          weights[3] = weights[1]; weights[1] = weights[2] = 0;
          if (!available[3]) { weights[0] += weights[3]; weights[3] = 0; }
        }
        let total = 0, shown = false;
        for (let level = 0; level < 4; level++) {
          const weight = weights[level];
          if (!(weight > 0) || !available[level]) continue;
          const draw = this.#draw(chunk, level), index = draw.count++;
          draw.matrices.array.set(record.matrix, index * 16);
          draw.interval.setXY(index, total, total + weight); total += weight;
          draw.tint.setXYZ(index, record.tint?.r ?? 1, record.tint?.g ?? 1, record.tint?.b ?? 1);
          draw.bend.setXY(index, record.bend?.x ?? 0, record.bend?.y ?? 0);
          if (level === 3) {
            this.localCamera.copy(camera.position).applyMatrix4(record.inverse);
            const center = chunk.capture.center;
            draw.view.setX(index, Math.atan2(this.localCamera.x - center[0], this.localCamera.z - center[2]));
          }
          stats[names[level]]++; shown = chunkVisible = true;
        }
        if (shown) { stats.visibleInstances++; stats.byKind[chunk.kind] = (stats.byKind[chunk.kind] ?? 0) + 1; }
      }
      if (chunkVisible) stats.visibleChunks++;
      for (let level = 0; level < 4; level++) {
        const draw = chunk.draws[level]; if (!draw) continue;
        for (const mesh of draw.meshes) {
          mesh.count = draw.count; mesh.visible = draw.count > 0;
          mesh.castShadow = level < 2 && this.quality !== 'performance' && this.quality !== 'balanced';
          stats.triangles += triangles(mesh.geometry) * draw.count;
        }
        if (!draw.count) continue;
        for (const attr of [draw.matrices, draw.interval, draw.tint, draw.bend, draw.view]) {
          attr.clearUpdateRanges(); attr.addUpdateRange(0, draw.count * attr.itemSize); attr.needsUpdate = true;
        }
      }
    }
    stats.bookkeepingMs = performance.now() - start;
    return stats;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const chunk of this.chunks) for (const draw of chunk.draws) if (draw) for (const mesh of draw.meshes) {
      mesh.removeFromParent(); mesh.geometry.dispose(); mesh.dispose();
    }
    for (const release of this.resources) release();
    this.resources.length = this.chunks.length = this.templates.length = 0;
  }
}
