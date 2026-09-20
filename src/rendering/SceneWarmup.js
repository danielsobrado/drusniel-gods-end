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
    });
    if (object.geometry && !geometries.has(object.geometry)) {
      geometries.set(object.geometry, { ...object.geometry.drawRange });
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
    }
    for (const geometry of geometries.keys()) geometry.setDrawRange(0, 0);
    render();
    return { objects: objects.size, geometries: geometries.size };
  } finally {
    for (const [geometry, range] of geometries) geometry.setDrawRange(range.start, range.count);
    for (const [object, state] of objects) {
      object.visible = state.visible;
      object.frustumCulled = state.frustumCulled;
      if (object.isLOD) object.autoUpdate = state.autoUpdate;
      // Empty preparation draws must not become the cached gameplay shadows.
      if (object.shadow) object.shadow.needsUpdate = true;
    }
    scene.userData.updateCoastalJungleVisibility = visibilityUpdater;
  }
}
