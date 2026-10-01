import { Object3D } from 'three';

// Three recomposes the local matrix of every matrixAutoUpdate object on every
// render pass and then flags its world matrix dirty, so a scene with thousands
// of static trees, rocks and props pays a compose plus a 4x4 multiply per object
// per pass even though nothing moved. This patch remembers the last composed
// position / quaternion / scale and skips the compose (and the dirty flag) when
// they are unchanged.
//
// Skipping the dirty flag means the world matrix must be re-derived by other
// means whenever the parent's world matrix changes. Every world-matrix
// recompute therefore bumps a per-object version, and updateMatrixWorld()
// recomputes a child whenever its own transform changed, it was re-parented,
// its parent's version moved, or the parent manages its world matrix by hand
// (matrixWorldAutoUpdate === false). Descendants of a recomputed object are
// forced exactly as in stock three, so the resulting matrices are identical.
// Objects with a pivot bypass the compose cache.

let installed = false;
let sceneGraphVersion = 0;

// Incremented on every add()/remove()/clear() once the patch is installed, so
// callers can cache traversal results until the graph structure changes.
// Returns -1 while the patch is not installed (callers must not cache then).
export function getSceneGraphVersion() {
  return installed ? sceneGraphVersion : -1;
}

export function installMatrixUpdateCache() {
  if (installed) return false;
  installed = true;

  const prototype = Object3D.prototype;
  const originalUpdateMatrix = prototype.updateMatrix;
  const originalUpdateWorldMatrix = prototype.updateWorldMatrix;
  const originalAdd = prototype.add;
  const originalRemove = prototype.remove;
  const originalClear = prototype.clear;

  prototype.updateMatrix = function updateMatrix() {
    const position = this.position;
    const quaternion = this.quaternion;
    const scale = this.scale;
    let cache = this.composedTransform;
    if (cache !== undefined && !this.pivot
      && cache[0] === position.x && cache[1] === position.y && cache[2] === position.z
      && cache[3] === quaternion.x && cache[4] === quaternion.y
      && cache[5] === quaternion.z && cache[6] === quaternion.w
      && cache[7] === scale.x && cache[8] === scale.y && cache[9] === scale.z) {
      return;
    }
    if (cache === undefined) {
      cache = new Float64Array(10);
      this.composedTransform = cache;
    }
    cache[0] = position.x;
    cache[1] = position.y;
    cache[2] = position.z;
    cache[3] = quaternion.x;
    cache[4] = quaternion.y;
    cache[5] = quaternion.z;
    cache[6] = quaternion.w;
    cache[7] = scale.x;
    cache[8] = scale.y;
    cache[9] = scale.z;
    originalUpdateMatrix.call(this);
  };

  prototype.updateMatrixWorld = function updateMatrixWorld(force) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    const parent = this.parent;
    const parentId = parent === null ? -1 : parent.id;
    const parentVersion = parent === null ? 0 : (parent.worldVersion ?? 0);
    if (this.matrixWorldNeedsUpdate || force === true
      || this.worldParentId !== parentId || this.parentWorldVersion !== parentVersion
      || (parent !== null && parent.matrixWorldAutoUpdate === false)) {
      if (this.matrixWorldAutoUpdate === true) {
        if (parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      this.worldVersion = (this.worldVersion ?? 0) + 1;
      this.worldParentId = parentId;
      this.parentWorldVersion = parentVersion;
      force = true;
    }
    const children = this.children;
    for (let index = 0, length = children.length; index < length; index += 1) {
      children[index].updateMatrixWorld(force);
    }
  };

  // updateWorldMatrix() recomputes matrices outside the traversal (e.g. from
  // getWorldPosition, every frame for the player and camera). Bump the version
  // only when the world matrix actually changed, so cached children re-derive
  // when needed without forcing the whole graph every frame.
  // The original recurses into parents and children through this wrapper, so
  // snapshots are pooled per recursion depth.
  const snapshots = [];
  let depth = 0;
  prototype.updateWorldMatrix = function updateWorldMatrix(updateParents, updateChildren) {
    const previous = snapshots[depth] ??= new Float64Array(16);
    const elements = this.matrixWorld.elements;
    for (let index = 0; index < 16; index += 1) previous[index] = elements[index];
    depth += 1;
    try {
      originalUpdateWorldMatrix.call(this, updateParents, updateChildren);
    } finally {
      depth -= 1;
    }
    for (let index = 0; index < 16; index += 1) {
      if (previous[index] !== elements[index]) {
        this.worldVersion = (this.worldVersion ?? 0) + 1;
        break;
      }
    }
    return this;
  };

  prototype.remove = function remove() {
    sceneGraphVersion += 1;
    return originalRemove.apply(this, arguments);
  };

  prototype.clear = function clear() {
    sceneGraphVersion += 1;
    return originalClear.call(this);
  };

  prototype.add = function add(object) {
    if (arguments.length > 1) {
      for (let index = 0; index < arguments.length; index += 1) this.add(arguments[index]);
      return this;
    }
    originalAdd.call(this, object);
    if (object && object.isObject3D && object.parent === this) {
      object.matrixWorldNeedsUpdate = true;
      sceneGraphVersion += 1;
    }
    return this;
  };

  return true;
}
