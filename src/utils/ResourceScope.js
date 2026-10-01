/** Owns construction resources until the scope is transferred to a live world. */
export class ResourceScope {
  constructor() {
    this.callbacks = [];
    this.disposed = false;
  }

  defer(callback) {
    if (this.disposed) {
      callback();
      throw new Error('Cannot publish resources into a disposed scope.');
    }
    this.callbacks.push(callback);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const callback of this.callbacks.splice(0).reverse()) {
      try { callback(); } catch (error) { console.warn('Resource cleanup failed.', error); }
    }
  }
}

/** Capture owned terrain resources before materials are replaced or props cloned. */
export function captureObjectResources(root) {
  const resources = new Set();
  root?.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    if (object.skeleton?.boneTexture) resources.add(object.skeleton.boneTexture);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  return () => {
    root?.removeFromParent();
    for (const resource of resources) {
      try { resource.dispose(); } catch (error) { console.warn('Object resource cleanup failed.', error); }
    }
    resources.clear();
  };
}
