/* global GPUBufferUsage, GPUTextureUsage, GPUMapMode, GPUShaderStage */
import {
  REVISION, Box3, DepthTexture, Frustum, IndirectStorageBufferAttribute, Matrix4, Mesh,
  MeshBasicNodeMaterial, RenderTarget, Scene, UnsignedIntType, Vector2,
} from 'three/webgpu';
import { logger } from '../utils/logger.js';
import { isSolidOccluder, occlusionDrawRange, projectOcclusionBounds } from './occlusionBounds.js';
import { depthCopyShader, depthReduceShader, visibilityShader } from './occlusionShaders.js';

const nextPowerOfTwo = (value) => 2 ** Math.ceil(Math.log2(Math.max(1, value)));

/** Same-frame Hi-Z culling. Readback is diagnostic only, never a visibility dependency. */
export class GpuOcclusion {
  constructor(world, settings = {}) {
    this.world = world;
    this.renderer = world.renderer;
    // Private indirect-draw hooks were verified only against r180. Keep normal
    // rendering on newer versions until that optimization is separately ported.
    this.enabled = settings.enabled !== false && REVISION === '180';
    this.settings = {
      minTriangles: 256, minOccluderArea: 0.002, boundsPadding: 0.15,
      pixelPadding: 2, depthBias: 0.00002, minSavedTriangles: 25000, probeInterval: 30, ...settings,
    };
    this.scene = new Scene();
    this.proxies = new Map();
    this.materials = new Map();
    this.records = new Map();
    this.active = new Map();
    this.box = new Box3();
    this.frustum = new Frustum();
    this.projectionView = new Matrix4();
    this.size = new Vector2();
    this.frame = 0;
    this.cooldown = 0;
    this.stats = { supported: false, candidates: 0, occluders: 0, culledDraws: 0, culledTriangles: 0 };
  }

  #init() {
    const backend = this.renderer.backend;
    // The bridge below targets the installed Three WebGPU backend. Other backends
    // retain their ordinary draws; no node_modules patches or shader fallbacks.
    if (!backend?.isWebGPUBackend || !backend.device || this.renderer.reversedDepthBuffer || this.renderer.logarithmicDepthBuffer
      || !backend.createIndirectStorageAttribute) return false;
    this.device = backend.device;
    const pipeline = (label, code, bindings) => {
      const layout = this.device.createBindGroupLayout({ entries: bindings.map((entry, binding) => ({
        binding, visibility: GPUShaderStage.COMPUTE, ...entry,
      })) });
      return this.device.createComputePipeline({
        label, layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: this.device.createShaderModule({ label, code }), entryPoint: 'main' },
      });
    };
    const sampled = { texture: { sampleType: 'unfilterable-float' } };
    const stored = { storageTexture: { access: 'write-only', format: 'r32float' } };
    this.copyPipeline = pipeline('Occlusion depth copy', depthCopyShader, [{ texture: { sampleType: 'depth' } }, stored]);
    this.reducePipeline = pipeline('Occlusion max depth', depthReduceShader, [sampled, stored]);
    this.visibilityPipeline = pipeline('Occlusion visibility', visibilityShader,
      [sampled, { buffer: { type: 'read-only-storage' } }, { buffer: { type: 'storage' } }]);
    this.readback = this.device.createBuffer({ size: 20 * 8192, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.stats.supported = true;
    return true;
  }

  #resize(width, height) {
    if (this.target?.width === width && this.target?.height === height) return;
    this.target?.dispose();
    this.pyramid?.destroy();
    this.target = new RenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
    this.target.depthTexture = new DepthTexture(width, height, UnsignedIntType);
    const w = nextPowerOfTwo(width);
    const h = nextPowerOfTwo(height);
    this.levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    this.pyramid = this.device.createTexture({
      label: 'Occlusion max-depth pyramid', size: [w, h], mipLevelCount: this.levels,
      format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.pyramidSize = [w, h];
    this.reduceGroups = [];
    for (let level = 1; level < this.levels; level++) {
      this.reduceGroups.push(this.device.createBindGroup({
        layout: this.reducePipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: this.pyramid.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.pyramid.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
        ],
      }));
    }
  }

  #bounds(object) {
    if (object.userData.occlusionBounds) return this.box.copy(object.userData.occlusionBounds);
    // Unknown shader/skinning/morph deformation cannot safely use rest-pose bounds.
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (object.isSkinnedMesh || object.morphTargetInfluences?.length
      || materials.some((m) => (m.positionNode || m.vertexNode || m.displacementMap)
        && object.userData.occlusionPadding === undefined)) return null;
    if (object.isInstancedMesh) {
      object.computeBoundingBox();
      this.box.copy(object.boundingBox);
    } else {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      this.box.copy(object.geometry.boundingBox);
    }
    this.box.expandByScalar(object.userData.occlusionPadding ?? 0);
    this.box.applyMatrix4(object.matrixWorld).expandByScalar(this.settings.boundsPadding);
    return this.box;
  }

  #proxy(object) {
    const side = object.material.side;
    if (!this.materials.has(side)) {
      const material = new MeshBasicNodeMaterial({ side, colorWrite: false });
      material.name = 'Occlusion depth only';
      this.materials.set(side, material);
    }
    let proxy = this.proxies.get(object);
    if (!proxy) {
      proxy = new Mesh(object.geometry, this.materials.get(side));
      proxy.matrixAutoUpdate = false;
      proxy.name = `Occluder: ${object.name}`;
      this.scene.add(proxy);
      this.proxies.set(object, proxy);
    }
    proxy.material = this.materials.get(side);
    proxy.geometry = object.geometry;
    proxy.matrix.copy(object.matrixWorld);
    proxy.visible = true;
  }

  #collect(width, height) {
    const { scene, camera } = this.world;
    if (camera.coordinateSystem !== this.renderer.coordinateSystem) {
      camera.coordinateSystem = this.renderer.coordinateSystem;
      camera.updateProjectionMatrix();
    }
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView, camera.coordinateSystem);
    const entries = [];
    const used = new Set();
    for (const proxy of this.proxies.values()) proxy.visible = false;
    this.active.clear();
    this.stats.occluders = 0;
    scene.traverseVisible((object) => {
      if (!object.isMesh || !object.layers.test(camera.layers) || object.userData.occlusionCull === false) return;
      const bounds = this.#bounds(object);
      if (!bounds || bounds.isEmpty() || !this.frustum.intersectsBox(bounds)) return;
      const rect = projectOcclusionBounds(bounds, this.projectionView, width, height, this.settings.pixelPadding);
      // Near-plane intersections still occlude other objects, but cannot themselves be culled.
      const area = rect ? (rect.maxX - rect.minX + 1) * (rect.maxY - rect.minY + 1) / (width * height) : 1;
      if (area >= this.settings.minOccluderArea && isSolidOccluder(object)) {
        this.#proxy(object);
        this.stats.occluders++;
      }
      if (!rect) return;
      const groups = Array.isArray(object.material) ? object.geometry.groups : [null];
      for (const group of groups) {
        const material = group ? object.material[group.materialIndex] : object.material;
        if (!material?.visible) continue;
        const draw = occlusionDrawRange(object, material, group);
        if (!draw || draw.count * draw.instances / 3 < this.settings.minTriangles) continue;
        let records = this.records.get(object);
        if (!records) this.records.set(object, records = new Map());
        let record = records.get(group);
        if (!record) {
          const indirect = new IndirectStorageBufferAttribute(new Uint32Array(5), 1);
          this.renderer.backend.createIndirectStorageAttribute(indirect);
          record = { indirect };
          records.set(group, record);
        }
        Object.assign(record, { rect, draw });
        used.add(record);
        entries.push(record);
        this.active.set(object, records);
      }
    });
    // Tile pools/LODs can be rebuilt while the app is running.
    for (const [object, records] of this.records) {
      for (const [group, record] of records) {
        if (used.has(record)) continue;
        this.renderer.backend.destroyAttribute(record.indirect);
        records.delete(group);
      }
      if (!records.size) this.records.delete(object);
    }
    for (const [object, proxy] of this.proxies) {
      if (proxy.visible) continue;
      this.scene.remove(proxy);
      this.proxies.delete(object);
    }
    this.stats.candidates = entries.length;
    return entries;
  }

  prepare() {
    this.active.clear();
    if (!this.enabled || this.disposed) return;
    // In open views, periodically probe instead of paying for a depth pass that
    // saves almost no geometry. Bypassed frames draw everything normally; no old
    // visibility result is reused, even if the camera teleports during cooldown.
    if (this.cooldown > 0) {
      this.cooldown--;
      this.stats.culledDraws = this.stats.culledTriangles = 0;
      return;
    }
    try {
      if (!this.device && !this.#init()) return;
      this.renderer.getDrawingBufferSize(this.size);
      this.#resize(this.size.x, this.size.y);
      const entries = this.#collect(this.size.x, this.size.y);
      if (!entries.length || !this.stats.occluders) {
        this.active.clear();
        this.stats.culledDraws = this.stats.culledTriangles = 0;
        return;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      try {
        this.renderer.autoClear = true;
        this.renderer.setRenderTarget(this.target);
        this.renderer.render(this.scene, this.world.camera);
      } finally {
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.autoClear = previousAutoClear;
      }
      this.#dispatch(entries);
    } catch (error) {
      this.active.clear();
      this.enabled = false;
      logger.warn('GPU occlusion disabled; ordinary rendering remains active.', error);
    }
  }

  #dispatch(entries) {
    const count = entries.length;
    if (!this.capacity || count > this.capacity) {
      this.input?.destroy();
      this.output?.destroy();
      this.capacity = nextPowerOfTwo(count);
      this.input = this.device.createBuffer({ size: this.capacity * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.output = this.device.createBuffer({ size: this.capacity * 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    }
    const data = new ArrayBuffer(count * 48);
    const floats = new Float32Array(data);
    const ints = new Uint32Array(data);
    entries.forEach(({ rect, draw }, i) => {
      floats.set([rect.minX, rect.minY, rect.maxX, rect.maxY, rect.depth, this.settings.depthBias, 0, 0], i * 12);
      ints.set([draw.count, draw.instances, draw.first, 0], i * 12 + 8);
    });
    this.device.queue.writeBuffer(this.input, 0, data);
    const encoder = this.device.createCommandEncoder({ label: 'Same-frame occlusion' });
    const run = (pipeline, group, x, y = 1) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y);
      pass.end();
    };
    const copyGroup = this.device.createBindGroup({ layout: this.copyPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.renderer.backend.get(this.target.depthTexture).texture.createView() },
      { binding: 1, resource: this.pyramid.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
    ] });
    run(this.copyPipeline, copyGroup, Math.ceil(this.pyramidSize[0] / 8), Math.ceil(this.pyramidSize[1] / 8));
    this.reduceGroups.forEach((group, i) => run(this.reducePipeline, group,
      Math.ceil(Math.max(1, this.pyramidSize[0] >> (i + 1)) / 8),
      Math.ceil(Math.max(1, this.pyramidSize[1] >> (i + 1)) / 8)));
    const visibilityGroup = this.device.createBindGroup({ layout: this.visibilityPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.pyramid.createView() },
      { binding: 1, resource: { buffer: this.input, size: count * 48 } },
      { binding: 2, resource: { buffer: this.output, size: count * 20 } },
    ] });
    run(this.visibilityPipeline, visibilityGroup, Math.ceil(count / 64));
    entries.forEach((record, i) => encoder.copyBufferToBuffer(this.output, i * 20,
      this.renderer.backend.get(record.indirect).buffer, 0, 20));
    const readStats = !this.reading && count <= 8192 && this.frame++ % 30 === 0;
    if (readStats) encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, count * 20);
    this.device.queue.submit([encoder.finish()]);
    if (readStats) this.#readStats(entries.map(({ draw }) => draw.count * draw.instances / 3));
  }

  async #readStats(triangles) {
    this.reading = true;
    try {
      await this.readback.mapAsync(GPUMapMode.READ);
      if (this.disposed) return;
      const data = new Uint32Array(this.readback.getMappedRange());
      let culledDraws = 0;
      let culledTriangles = 0;
      triangles.forEach((count, i) => {
        if (data[i * 5 + 1] === 0) { culledDraws++; culledTriangles += count; }
      });
      Object.assign(this.stats, { culledDraws, culledTriangles });
      if (culledTriangles < this.settings.minSavedTriangles) {
        this.cooldown = Math.max(0, this.settings.probeInterval - 1);
        this.frame = 0;
      }
    } catch (error) {
      if (!this.disposed) logger.warn('Occlusion statistics readback unavailable.', error);
    } finally {
      if (!this.disposed) this.readback.unmap();
      this.reading = false;
    }
  }

  // Install at backend submission, AFTER material nodes have updated shadows.
  // A renderer-level hook would temporarily leak indirect arguments into nested
  // shadow renders. This bridge is deliberately isolated to the WebGPU backend.
  render(draw) {
    if (!this.active.size) return draw();
    const backend = this.renderer.backend;
    const previous = backend.draw;
    backend.draw = (renderObject, info) => {
      const { object, scene, camera, geometry, group } = renderObject;
      const record = scene === this.world.scene && camera === this.world.camera
        ? this.active.get(object)?.get(group ?? null) : null;
      const indirect = geometry.indirect;
      if (record) geometry.indirect = record.indirect;
      try { previous.call(backend, renderObject, info); }
      finally { geometry.indirect = indirect; }
    };
    try { draw(); }
    finally { backend.draw = previous; }
  }

  dispose() {
    this.disposed = true;
    this.active.clear();
    for (const records of this.records.values()) {
      for (const record of records.values()) this.renderer.backend.destroyAttribute(record.indirect);
    }
    this.records.clear();
    this.proxies.clear();
    this.scene.clear();
    for (const material of this.materials.values()) material.dispose();
    this.target?.dispose();
    this.pyramid?.destroy();
    this.input?.destroy();
    this.output?.destroy();
    this.readback?.destroy();
  }
}
