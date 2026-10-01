import * as THREE from 'three';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { nearGrassDrawOrder } from '../rendering/drawOrder.js';

// Near grass drew one mesh per 25-unit tile: ~36 draws a frame, each paying
// the renderer's per-draw uniform and binding work for a few hundred blades.
// Tiles now only compact their blades; every in-range tile at a given LOD is
// drawn by one batch, so near grass costs one draw per LOD level.
//
// Blade positions stay tile-local and each instance carries its tile's origin
// (`instanceTile`), which the batched material adds only where a position
// becomes world space (GrassBladeMaterial `batched`). Per-blade hashes and
// wind noise therefore see exactly the inputs they saw per tile.
//
// Each tile owns a fixed slot sized to its LOD's uncompacted blade count, so a
// tile entering, leaving or recompacting rewrites and uploads only its own
// slot. (Repacking the whole batch on every membership change re-uploaded tens
// of MiB a frame at fly speed and cost more than the draws it saved.) Unused
// instances in a slot sit far outside the grass range, where the shader's
// visibility test collapses them before any blade shaping.
//
// Membership is every in-range tile, visible or not, so a camera turn never
// touches a batch; blades behind the camera are culled by the GPU clipper.
const INSTANCE_ATTRIBUTES = [['instancePosition', 4], ['instanceRotation', 2], ['instanceData', 4]];
const MIN_SLOTS = 16;
const EMPTY_POSITION = 1e7;

function copyInstances(target, source, offset, count) {
  const out = target.array, input = source.array;
  const outSize = target.itemSize, inSize = source.itemSize;
  if (outSize === inSize) {
    out.set(input.subarray(0, count * inSize), offset * outSize);
    return;
  }
  const components = Math.min(outSize, inSize);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < components; c++) out[(offset + i) * outSize + c] = input[i * inSize + c];
  }
}

class GrassLodBatch {
  constructor(scene, template, material, name, slots = MIN_SLOTS) {
    this.scene = scene;
    this.template = template;
    this.stride = Math.max(1, template.attributes.instancePosition.count);
    this.slots = new Map(); // tile -> { index, key }
    this.free = [];
    this.used = 0;
    this.present = new Set();
    this.geometry = this.#createGeometry(Math.max(MIN_SLOTS, slots));
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = `Grass batch ${name}`;
    this.mesh.renderOrder = nearGrassDrawOrder(name);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.excludeFromReflection = true;
    this.mesh.userData.occlusionCull = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // Growing builds a new geometry: the WebGPU renderer caches a geometry's
  // attribute bindings, so attributes replaced in place kept drawing from the
  // old, smaller buffers.
  #createGeometry(slotCapacity) {
    this.slotCapacity = slotCapacity;
    const capacity = slotCapacity * this.stride;
    const geometry = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'uv', 'bladeSide']) {
      if (this.template.attributes[name]) geometry.setAttribute(name, this.template.attributes[name]);
    }
    geometry.index = this.template.index;
    geometry.instanceCount = 0;
    for (const [name, itemSize] of INSTANCE_ATTRIBUTES) {
      geometry.setAttribute(name, new StorageInstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize));
    }
    geometry.setAttribute('instanceTile', new StorageInstancedBufferAttribute(new Float32Array(capacity * 2), 2));
    return geometry;
  }

  #grow() {
    const previous = this.geometry;
    this.geometry = this.#createGeometry(this.slotCapacity * 2);
    for (const [name] of [...INSTANCE_ATTRIBUTES, ['instanceTile']]) {
      const attribute = this.geometry.attributes[name];
      attribute.array.set(previous.attributes[name].array);
      attribute.clearUpdateRanges();
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = previous.instanceCount;
    this.mesh.geometry = this.geometry;
    for (const [name] of INSTANCE_ATTRIBUTES) previous.deleteAttribute(name);
    previous.dispose();
  }

  #markRange(start, count) {
    for (const [name, itemSize] of [...INSTANCE_ATTRIBUTES, ['instanceTile', 2]]) {
      const attribute = this.geometry.attributes[name];
      attribute.addUpdateRange(start * itemSize, count * itemSize);
      attribute.needsUpdate = true;
    }
  }

  #writeSlot(index, tile) {
    const start = index * this.stride;
    const source = tile?.mesh.geometry;
    const count = source ? Math.min(source.instanceCount, this.stride) : 0;
    if (count > 0) {
      for (const [name] of INSTANCE_ATTRIBUTES) copyInstances(this.geometry.attributes[name], source.attributes[name], start, count);
      const { x, z } = tile.mesh.position, origins = this.geometry.attributes.instanceTile.array;
      for (let i = start; i < start + count; i++) { origins[i * 2] = x; origins[i * 2 + 1] = z; }
    }
    const positions = this.geometry.attributes.instancePosition.array;
    for (let i = start + count; i < start + this.stride; i++) {
      positions[i * 4] = EMPTY_POSITION; positions[i * 4 + 1] = 0; positions[i * 4 + 2] = EMPTY_POSITION;
    }
    this.#markRange(start, this.stride);
  }

  #clearUpdateRanges() {
    for (const [name] of [...INSTANCE_ATTRIBUTES, ['instanceTile']]) this.geometry.attributes[name].clearUpdateRanges();
  }

  // `tiles` share this batch's LOD and carry valid compacted geometry.
  update(tiles, material) {
    this.mesh.material = material;
    let dirty = false;
    const present = this.present;
    present.clear();
    for (const tile of tiles) present.add(tile);
    for (const [tile, slot] of this.slots) {
      if (present.has(tile)) continue;
      if (!dirty) { this.#clearUpdateRanges(); dirty = true; }
      this.#writeSlot(slot.index, null);
      this.free.push(slot.index);
      this.slots.delete(tile);
    }
    for (const tile of tiles) {
      const geometry = tile.mesh.geometry;
      const { x, z } = tile.mesh.position;
      const key = `${geometry.id}:${geometry.attributes.instancePosition.version}:${geometry.instanceCount}:${x}:${z}`;
      let slot = this.slots.get(tile);
      if (slot?.key === key) continue;
      if (!slot) {
        // Lowest free slot first keeps the drawn range short.
        let index = this.free.length ? this.free.splice(this.free.indexOf(Math.min(...this.free)), 1)[0] : undefined;
        if (index === undefined) {
          if (this.used === this.slotCapacity) this.#grow();
          index = this.used++;
        }
        slot = { index, key };
        this.slots.set(tile, slot);
      }
      slot.key = key;
      if (!dirty) { this.#clearUpdateRanges(); dirty = true; }
      this.#writeSlot(slot.index, tile);
    }
    // Trailing free slots stop being drawn.
    if (dirty) {
      this.free.sort((a, b) => a - b);
      while (this.used > 0 && this.free[this.free.length - 1] === this.used - 1) { this.free.pop(); this.used--; }
      this.geometry.instanceCount = this.used * this.stride;
    }
    this.mesh.visible = this.slots.size > 0;
    return this.geometry.instanceCount;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    for (const [name] of INSTANCE_ATTRIBUTES) this.geometry.deleteAttribute(name);
    this.geometry.dispose();
  }
}

export class GrassBatches {
  constructor(scene) {
    this.scene = scene;
    this.batches = new Map();
    this.members = new Map();
  }

  // One batch per LOD source geometry; rebuilt when the LOD geometries change.
  setTemplates(geometries, material, slots = {}) {
    this.dispose();
    for (const [name, template] of Object.entries(geometries)) {
      this.batches.set(name, new GrassLodBatch(this.scene, template, material, name, slots[name]));
      this.members.set(name, []);
    }
  }

  begin() {
    for (const list of this.members.values()) list.length = 0;
  }

  add(lodName, tile) {
    this.members.get(lodName)?.push(tile);
  }

  commit(material) {
    for (const [name, batch] of this.batches) batch.update(this.members.get(name), material);
  }

  hide() {
    for (const batch of this.batches.values()) batch.hide();
  }

  get meshes() {
    return [...this.batches.values()].map((batch) => batch.mesh);
  }

  dispose() {
    for (const batch of this.batches.values()) batch.dispose();
    this.batches.clear();
    this.members.clear();
  }
}
