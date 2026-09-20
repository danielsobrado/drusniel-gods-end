import * as THREE from 'three/webgpu';
import { attribute, float, floor, fract, interleavedGradientNoise, mix,
  screenCoordinate, texture, transformNormalToView, uv, vec2, vec3, vec4 } from 'three/tsl';
import { foliageBacklight } from '../rendering/CinematicLighting.js';
import { TREE_LOD_DEFAULTS, vegetationLodWeights } from './vegetationLodPolicy.js';
import { createPlantCards, plantCardNodes } from './StaticPlantCards.js';

const names = ['full', 'medium', 'low', 'billboard'];
const triangles = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
function coverageMask() {
  const interval = attribute('lodInterval', 'vec2');
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  return noise.greaterThanEqual(interval.x).and(noise.lessThan(interval.y));
}
function atlasMaterial(atlas, capture, config, cards) {
  const angle = cards?.angle ?? attribute('lodView', 'float'), view = fract(angle.div(Math.PI * 2).add(1)).mul(capture.views);
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
  material.maskNode = coverageMask();
  if (cards) {
    const noise = interleavedGradientNoise(screenCoordinate.xy);
    material.positionNode = cards.position;
    material.maskNode = noise.greaterThanEqual(cards.minimum).and(noise.lessThan(cards.maximum)).and(cards.density);
  }
  return material;
}

/** Shared four-stage renderer. World-space records are immutable; only compact GPU submissions change. */
export class VegetationLodRenderer {
  constructor({ scene, config, chunkSize = TREE_LOD_DEFAULTS.chunkSize, prepareMaterial, policy }) {
    Object.assign(this, { scene, config, chunkSize, prepareMaterial, policy });
    this.chunks = []; this.templates = []; this.resources = [];
    this.shared = new Map(); this.sharedCapacity = new Map();
    this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4();
    this.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity); this.lastQuaternion = new THREE.Quaternion();
    this.lastProjection = new THREE.Matrix4(); this.localCamera = new THREE.Vector3();
    this.quality = 'high'; this.dirty = true; this.weights = [0, 0, 0, 0];
    this.nearRecords = [];
    this.stats = { full: 0, medium: 0, low: 0, billboard: 0, triangles: 0, visibleInstances: 0, visibleChunks: 0, bookkeepingMs: 0, byKind: {} };
  }
  addVariant({ key, kind = 'tree', full, asset, records, excludeFromReflection = false, castShadow = true }) {
    if (!records.length) return;
    const levels = [full, asset?.levels[1], asset?.levels[2], null];
    const plant = this.policy(records[0], kind, this.quality).plant;
    const cardNodes = plant && asset?.atlas && asset.entry.capture ? plantCardNodes(asset.entry.capture) : null;
    if (asset?.atlas && asset.entry.capture) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = atlasMaterial(asset.atlas, asset.entry.capture, this.config, cardNodes);
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
    this.sharedCapacity.set(key, (this.sharedCapacity.get(key) ?? 0) + records.length);
    const groups = new Map();
    const recordBounds = new THREE.Box3();
    for (const record of records) {
      const cell = `${Math.floor(record.position.x / this.chunkSize)},${Math.floor(record.position.z / this.chunkSize)}`;
      let chunk = groups.get(cell);
      if (!chunk) {
        chunk = { key, kind, templates, cardNodes, excludeFromReflection, castShadow, capture: asset?.entry.capture, records: [], bounds: new THREE.Box3(), draws: [null, null, null, null] };
        groups.set(cell, chunk);
      }
      if (!cardNodes) record.inverse = new THREE.Matrix4().fromArray(record.matrix).invert();
      chunk.records.push(record);
      chunk.bounds.union(record.sphere.getBoundingBox(recordBounds));
    }
    for (const chunk of groups.values()) {
      chunk.bounds.expandByScalar(3);
      if (cardNodes) {
        chunk.cards = createPlantCards(chunk, this.scene);
        // Draw chunks stay broad to limit calls; small CPU cells bound near-mesh work.
        const cells = new Map();
        for (const record of chunk.records) {
          const key = `${Math.floor(record.position.x / 32)},${Math.floor(record.position.z / 32)}`;
          let cell = cells.get(key);
          if (!cell) { cell = { bounds: new THREE.Box3(), records: [] }; cells.set(key, cell); }
          cell.records.push(record); cell.bounds.expandByPoint(record.position);
        }
        chunk.nearCells = [...cells.values()];
      }
      this.chunks.push(chunk);
    }
    this.dirty = true;
  }
  setQuality(name) { this.quality = name; this.dirty = true; }
  prepareNearby(camera, travelDistance = 12) {
    // Prepare only mesh stages reachable on the first walk/turn. Lazy creation
    // at a threshold otherwise compiles pipelines in a visible gameplay frame.
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
    const sphere = new THREE.Sphere();
    for (const chunk of this.chunks) {
      if (chunk.cards) continue;
      for (const record of chunk.records) {
        sphere.copy(record.sphere); sphere.radius += travelDistance;
        if (!this.frustum.intersectsSphere(sphere)) continue;
        const settings = this.policy(record, chunk.kind, this.quality);
        const blend = settings.blend ?? 0.15;
        const distance = record.position.distanceTo(camera.position);
        if (distance - travelDistance >= settings.far) continue;
        for (let level = 0; level < 3; level++) {
          if (!chunk.templates[level]) continue;
          const lower = level ? settings.centers[level - 1] * (1 - blend) : 0;
          const upper = settings.centers[level] * (1 + blend);
          if (distance + travelDistance < lower || distance - travelDistance > upper) continue;
          const draw = this.#draw(chunk, level);
          if (!draw.count) for (const mesh of draw.meshes) mesh.visible = false;
        }
      }
    }
  }
  #draw(chunk, level) {
    // Billboards are two triangles sharing one geometry and material across every
    // chunk of a variant, so one draw per variant replaces one per chunk. Cards
    // keep their own path; they never reach level 3.
    if (level === 3 && !chunk.cards) {
      const existing = this.shared.get(chunk.key);
      if (existing) return existing;
      const built = this.#buildDraw(chunk, level,
        Math.max(64, 2 ** Math.ceil(Math.log2(this.sharedCapacity.get(chunk.key) ?? 64))));
      this.shared.set(chunk.key, built);
      return built;
    }
    if (chunk.draws[level]) return chunk.draws[level];
    // Three includes uniform matrix-array length in the shader key. Exact per-cell
    // capacities compiled a new program for almost every chunk while travelling.
    chunk.draws[level] = this.#buildDraw(chunk, level,
      Math.max(64, 2 ** Math.ceil(Math.log2(chunk.records.length))));
    return chunk.draws[level];
  }
  #buildDraw(chunk, level, capacity) {
    const matrices = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
    const interval = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const bend = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const up = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const view = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    const meshes = chunk.templates[level].map(template => {
      // Chunk wrappers own instance attributes; immutable vertex/index buffers are shared.
      const geometry = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(template.geometry.attributes)) geometry.setAttribute(name, attr);
      // Keep a separate index binding: the WebGL fallback caches it in each VAO.
      geometry.setIndex(template.geometry.index?.clone() ?? null);
      for (const group of template.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      for (const [name, attr] of [['lodInterval', interval], ['lodTint', tint], ['lodRootBend', bend], ['lodUp', up], ['lodView', view]]) geometry.setAttribute(name, attr);
      const mesh = new THREE.InstancedMesh(geometry, template.material, capacity);
      mesh.instanceMatrix = matrices; mesh.count = 0; mesh.frustumCulled = level < 3;
      mesh.boundingSphere = new THREE.Sphere();
      mesh.name = `${chunk.key}:${names[level]}`;
      mesh.castShadow = chunk.castShadow && level < 2; mesh.receiveShadow = level < 3;
      mesh.userData.excludeFromReflection = chunk.excludeFromReflection || level === 3;
      mesh.userData.occlusionCull = false;
      this.scene.add(mesh); return mesh;
    });
    return { meshes, matrices, interval, tint, bend, up, view, bounds: new THREE.Box3(), count: 0 };
  }
  #commitDraw(draw, stats) {
    for (const attr of [draw.matrices, draw.interval, draw.tint, draw.bend, draw.up, draw.view]) {
      attr.clearUpdateRanges(); attr.addUpdateRange(0, draw.count * attr.itemSize); attr.needsUpdate = true;
    }
    for (const mesh of draw.meshes) stats.triangles += triangles(mesh.geometry) * draw.count;
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
    for (const draw of this.shared.values()) {
      draw.count = 0;
      for (const mesh of draw.meshes) mesh.visible = false;
    }
    for (const chunk of this.chunks) {
      if (chunk.cards) chunk.cards.mesh.visible = false;
      for (const draw of chunk.draws) if (draw) { draw.count = 0; draw.bounds.makeEmpty(); for (const mesh of draw.meshes) mesh.visible = false; }
      if (!this.frustum.intersectsBox(chunk.bounds)) continue;
      const chunkPolicy = this.policy(chunk.records[0], chunk.kind, this.quality);
      const chunkDistance = chunk.bounds.distanceToPoint(camera.position);
      if (chunkDistance >= chunkPolicy.far) continue;
      if (chunk.cards) {
        const { centers, blend, far, density = 1 } = chunkPolicy;
        chunk.cards.ranges.value.set(centers[0] * (1 - blend), centers[0] * (1 + blend), far, density);
        chunk.cards.mesh.visible = true;
        const count = chunk.records.length;
        stats.billboard += count; stats.triangles += count * 2; stats.visibleInstances += count;
        stats.byKind[chunk.kind] = (stats.byKind[chunk.kind] ?? 0) + count;
        // Distant chunks require no per-stem CPU work or buffer uploads on movement.
        if (chunkDistance >= centers[0] * (1 + blend)) { stats.visibleChunks++; continue; }
      }
      const available = chunk.templates.map(Boolean);
      let chunkVisible = false;
      let records = chunk.records;
      if (chunk.cards) {
        records = this.nearRecords; records.length = 0;
        const range = chunkPolicy.centers[0] * (1 + chunkPolicy.blend);
        for (const cell of chunk.nearCells) if (cell.bounds.distanceToPoint(camera.position) < range) {
          for (const record of cell.records) records.push(record);
        }
      }
      for (const record of records) {
        if (!this.frustum.intersectsSphere(record.sphere)) continue;
        const distance = record.position.distanceTo(camera.position);
        if (chunk.cards && distance >= chunkPolicy.centers[0] * (1 + chunkPolicy.blend)) continue;
        const settings = this.policy(record, chunk.kind, this.quality);
        if (distance >= settings.far || record.fraction > (settings.density ?? 1)) continue;
        // Reuse policy records; spreading one object per visible jungle stem creates
        // tens of thousands of temporary objects each camera update.
        settings.available = settings.plant ? undefined : available;
        const weights = vegetationLodWeights(distance, settings, this.weights);
        if (settings.plant) {
          // A plant has only full geometry and a billboard; keep the last slot consistent with trees.
          weights[3] = weights[1]; weights[1] = weights[2] = 0;
          if (!available[3]) { weights[0] += weights[3]; weights[3] = 0; }
        }
        let total = 0, shown = false;
        for (let level = 0; level < 4; level++) {
          if (level === 3 && chunk.cards) continue;
          const weight = weights[level];
          if (!(weight > 0) || !available[level]) continue;
          const draw = this.#draw(chunk, level), index = draw.count++;
          if (level < 3) {
            const { center, radius } = record.sphere, { min, max } = draw.bounds;
            min.x = Math.min(min.x, center.x - radius); min.y = Math.min(min.y, center.y - radius); min.z = Math.min(min.z, center.z - radius);
            max.x = Math.max(max.x, center.x + radius); max.y = Math.max(max.y, center.y + radius); max.z = Math.max(max.z, center.z + radius);
          }
          draw.matrices.array.set(record.matrix, index * 16);
          draw.interval.setXY(index, total, total + weight); total += weight;
          draw.tint.setXYZ(index, record.tint?.r ?? 1, record.tint?.g ?? 1, record.tint?.b ?? 1);
          draw.bend.setXY(index, record.bend?.x ?? 0, record.bend?.y ?? 0);
          draw.up.setXYZ(index, record.matrix[4], record.matrix[5], record.matrix[6]);
          if (level === 3) {
            this.localCamera.copy(camera.position).applyMatrix4(record.inverse);
            const center = chunk.capture.center;
            const angle = Math.atan2(this.localCamera.x - center[0], this.localCamera.z - center[2]);
            draw.view.setX(index, angle);
            // Compose the card BEFORE instancing. positionLocal already contains the
            // instance transform in NodeMaterial, so scaling it there stretches world positions.
            const m = record.matrix, out = draw.matrices.array, offset = index * 16;
            const c = Math.cos(angle), s = Math.sin(angle), { width, height } = chunk.capture;
            for (let row = 0; row < 3; row++) {
              out[offset + row] = (m[row] * c - m[8 + row] * s) * width;
              out[offset + 4 + row] = m[4 + row] * height;
              out[offset + 8 + row] = m[row] * s + m[8 + row] * c;
              out[offset + 12 + row] = m[row] * center[0] + m[4 + row] * center[1] + m[8 + row] * center[2] + m[12 + row];
            }
          }
          stats[names[level]]++; shown = chunkVisible = true;
        }
        if (shown && !chunk.cards) { stats.visibleInstances++; stats.byKind[chunk.kind] = (stats.byKind[chunk.kind] ?? 0) + 1; }
      }
      if (chunkVisible || chunk.cards) stats.visibleChunks++;
      for (let level = 0; level < 4; level++) {
        const draw = chunk.draws[level]; if (!draw) continue;
        for (const mesh of draw.meshes) {
          mesh.count = draw.count; mesh.visible = draw.count > 0;
          if (level < 3 && draw.count) draw.bounds.getBoundingSphere(mesh.boundingSphere);
          mesh.castShadow = chunk.castShadow && level < 2 && this.quality !== 'performance' && this.quality !== 'balanced';
        }
        if (draw.count) this.#commitDraw(draw, stats);
      }
    }
    for (const draw of this.shared.values()) {
      for (const mesh of draw.meshes) { mesh.count = draw.count; mesh.visible = draw.count > 0; }
      if (draw.count) this.#commitDraw(draw, stats);
    }
    stats.bookkeepingMs = performance.now() - start;
    return stats;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const chunk of this.chunks) if (chunk.cards) { chunk.cards.mesh.removeFromParent(); chunk.cards.mesh.geometry.dispose(); }
    const draws = [...this.chunks.flatMap(chunk => chunk.draws), ...this.shared.values()];
    for (const draw of draws) if (draw) for (const mesh of draw.meshes) {
      mesh.removeFromParent(); mesh.geometry.dispose(); mesh.dispose();
    }
    this.shared.clear(); this.sharedCapacity.clear();
    for (const release of this.resources) release();
    this.resources.length = this.chunks.length = this.templates.length = 0;
  }
}
