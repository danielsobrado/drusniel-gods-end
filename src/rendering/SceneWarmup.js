// Prepare the actual nested render passes without rasterizing hidden variants.
// Using compileAsync(scene, camera) alone builds a different render-context
// cache from a scene pass inside a post-processing pass (and its reflections).
export function withSceneWarmup(scene, render) {
  const objects = new Map();
  const geometries = new Map();
  scene.traverse(object => {
    objects.set(object, {
      visible: object.visible, frustumCulled: object.frustumCulled,
      autoUpdate: object.isLOD ? object.autoUpdate : undefined,
      count: object.isInstancedMesh ? object.count : undefined,
    });
    if (object.geometry && !geometries.has(object.geometry)) {
      geometries.set(object.geometry, {
        drawRange: { ...object.geometry.drawRange },
        instanceCount: object.geometry.isInstancedBufferGeometry
          ? object.geometry.instanceCount
          : undefined,
      });
    }
  });
  const visibilityUpdater = scene.userData.updateCoastalJungleVisibility;
  try {
    scene.userData.updateCoastalJungleVisibility = undefined;
    for (const object of objects.keys()) {
      let visible = object.userData.skipWarmup !== true;
      if (object.isLight) {
        // Revealing hidden ancestors must not add lights to the shader key.
        for (let ancestor = object; ancestor; ancestor = ancestor.parent) {
          if (objects.get(ancestor)?.visible === false) visible = false;
        }
      }
      object.visible = visible;
      object.frustumCulled = false;
      if (object.isLOD) object.autoUpdate = false;
      if (object.isInstancedMesh && object.count === 0 && object.instanceMatrix.count > 0) {
        object.count = 1;
      }
    }
    for (const geometry of geometries.keys()) {
      if (geometry.isInstancedBufferGeometry && geometry.instanceCount === 0) {
        geometry.instanceCount = 1;
      }
      geometry.setDrawRange(0, 0);
    }
    render();
    return { objects: objects.size, geometries: geometries.size };
  } finally {
    for (const [geometry, state] of geometries) {
      geometry.setDrawRange(state.drawRange.start, state.drawRange.count);
      if (geometry.isInstancedBufferGeometry) geometry.instanceCount = state.instanceCount;
    }
    for (const [object, state] of objects) {
      object.visible = state.visible;
      object.frustumCulled = state.frustumCulled;
      if (object.isLOD) object.autoUpdate = state.autoUpdate;
      if (object.isInstancedMesh) object.count = state.count;
      // Empty preparation draws must not become the cached gameplay shadows.
      if (object.shadow) object.shadow.needsUpdate = true;
    }
    scene.userData.updateCoastalJungleVisibility = visibilityUpdater;
  }
}
