// Prepare named draws in the real nested render passes.
//
// withSceneWarmup reveals the whole scene at once. That is right behind the
// loading screen and far too expensive during play, where a region arriving
// lazily needs only its own draws prepared. This reveals a chosen set instead:
// everything else stays hidden so only these compile, and their geometries draw
// nothing. The passes, lights, render targets and render context are the
// gameplay ones, which is the part compileAsync cannot reproduce -- a material
// cache key covers the mesh UUID and the render context, so a program prepared
// in a standalone scene is not the program the scene pass will ask for.
//
// Targets do not have to be in the scene already. Staged meshes are parented
// for this render and restored afterward, which is how a future draw can share
// the gameplay cache key without becoming a permanent scene child first.
// Explicitly requested draws ignore skipWarmup: that flag only excludes unused
// plant cards from whole-scene loading warmup.
//
// The caller supplies `render`, so the same nested pass structure that
// CinematicPipeline.warmup uses applies here without this module knowing it.

function keepBranch(object, keep) {
  for (let node = object; node; node = node.parent) keep.add(node);
}

function isInScene(object, scene) {
  for (let node = object; node; node = node.parent) {
    if (node === scene) return true;
  }
  return false;
}

// Pinned Three r186 adapter: render preparation must neither reuse the current
// frame's cached scene pass nor leave its empty pass cached for gameplay. Advance
// only the cache identity, not animation time/delta. Temporal history is not a
// preparation resource and must not ingest an empty beauty pass.
export function withPreparationFrame(renderer, temporalResolve, render) {
  const frame = renderer._nodes?.nodeFrame;
  if (renderer.isRenderer && !Number.isFinite(frame?.frameId)) {
    throw new Error('Draw preparation requires the pinned Three node-frame adapter.');
  }
  const before = temporalResolve?.updateBefore;
  const after = temporalResolve?.updateAfter;
  if (frame) frame.frameId += 1;
  try {
    if (temporalResolve) {
      temporalResolve.updateBefore = () => false;
      temporalResolve.updateAfter = () => false;
    }
    return render();
  } finally {
    if (temporalResolve) {
      temporalResolve.updateBefore = before;
      temporalResolve.updateAfter = after;
    }
    if (frame) frame.frameId += 1;
  }
}

/**
 * Renders `render()` with only `targets` (and the gameplay lighting) visible.
 * Returns counts for diagnostics. Scene state is restored even if render throws.
 */
export function withDrawPreparation(scene, targets, render) {
  const activeLights = new Set();
  scene.traverseVisible(object => { if (object.isLight) activeLights.add(object); });
  const attached = [];
  for (const target of targets) {
    if (!target || isInScene(target, scene)) continue;
    attached.push({ object: target, parent: target.parent, index: target.parent?.children.indexOf(target),
      position: target.position.clone(), quaternion: target.quaternion.clone(), scale: target.scale.clone(),
      matrix: target.matrix.clone() });
    scene.attach(target);
  }

  const objects = new Map();
  const geometries = new Map();
  scene.traverse((object) => {
    objects.set(object, {
      visible: object.visible,
      frustumCulled: object.frustumCulled,
      autoUpdate: object.isLOD ? object.autoUpdate : undefined,
      count: object.isInstancedMesh ? object.count : undefined,
    });
  });

  const keep = new Set();
  let prepared = 0;
  for (const target of targets) {
    if (!target || !objects.has(target)) continue;
    prepared += 1;
    keepBranch(target, keep);
    target.traverse((child) => {
      keep.add(child);
      if (child.geometry && !geometries.has(child.geometry)) {
        geometries.set(child.geometry, {
          drawRange: { ...child.geometry.drawRange },
          instanceCount: child.geometry.isInstancedBufferGeometry
            ? child.geometry.instanceCount
            : undefined,
        });
      }
    });
  }

  // The set of lights that reach a draw is part of its shader key, so the
  // lighting present during preparation has to be the lighting that was already
  // active. A light under a hidden ancestor was contributing nothing and must
  // stay dark, exactly as withSceneWarmup treats it.
  for (const object of objects.keys()) {
    if (object.isLight && activeLights.has(object)) keepBranch(object, keep);
  }

  const visibilityUpdater = scene.userData.updateCoastalJungleVisibility;
  try {
    // A visibility pass would cull the very draws being prepared.
    scene.userData.updateCoastalJungleVisibility = undefined;
    for (const object of objects.keys()) {
      // skipWarmup hides unused cards during whole-scene warmup. An explicit
      // target is the draw we came to compile, so it must be visible here.
      object.visible = keep.has(object) && (!object.isLight || activeLights.has(object));
      if (!keep.has(object)) continue;
      object.frustumCulled = false;
      if (object.isLOD) object.autoUpdate = false;
      if (object.isInstancedMesh && object.count === 0 && object.instanceMatrix.count > 0) object.count = 1;
    }
    for (const geometry of geometries.keys()) {
      if (geometry.isInstancedBufferGeometry && geometry.instanceCount === 0) {
        geometry.instanceCount = 1;
      }
      geometry.setDrawRange(0, 0);
    }
    render();
    return { prepared, revealed: keep.size, geometries: geometries.size, objects: objects.size };
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
    for (let index = attached.length - 1; index >= 0; index -= 1) {
      const state = attached[index];
      const { object, parent } = state;
      if (parent) parent.add(object);
      else object.removeFromParent();
      if (parent && state.index >= 0) {
        parent.children.splice(parent.children.indexOf(object), 1);
        parent.children.splice(state.index, 0, object);
      }
      object.position.copy(state.position);
      object.quaternion.copy(state.quaternion);
      object.scale.copy(state.scale);
      object.matrix.copy(state.matrix);
      object.updateWorldMatrix(false, true);
    }
  }
}
