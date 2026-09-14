import { Object3D } from 'three';

// Three recomposes the local matrix of every matrixAutoUpdate object on every
// render pass and then flags its world matrix dirty, so a scene with thousands
// of static trees, rocks and props pays a compose plus a 4x4 multiply per object
// per pass even though nothing moved. This patch remembers the last composed
// position / quaternion / scale and skips the compose (and the dirty flag) when
// they are unchanged. Objects whose local transform did change, and every
// descendant of an object whose world matrix changed, are updated exactly as
// before, so the resulting matrices are identical.
//
// Re-parenting is the one case where an unchanged local transform still needs a
// fresh world matrix; add() marks the object dirty so the next pass recomputes
// it under the new parent. Objects with a pivot bypass the cache.

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
  const originalAdd = prototype.add;
  const originalRemove = prototype.remove;
  const originalClear = prototype.clear;

  prototype.remove = function remove() {
    sceneGraphVersion += 1;
    return originalRemove.apply(this, arguments);
  };

  prototype.clear = function clear() {
    sceneGraphVersion += 1;
    return originalClear.call(this);
  };

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
