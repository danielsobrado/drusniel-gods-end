(async () => {
  const d = window.__grassDemo, r = d.world.renderer;
  r.setAnimationLoop(null);
  d.player.enabled = false;
  d.tour.active = false;
  const treeMeshes = [];
  d.trees.trees.forEach(t => t.high.traverse(o => { if (o.isMesh) treeMeshes.push(o); }));
  const original = r.info.update;
  let counts = {};
  r.info.update = function(object, count, instances) {
    if (object.isMesh) {
      const target = r.getRenderTarget();
      const pass = target?.texture.name === 'ShadowMap' ? 'shadow' : target === d.water.reflection.renderTarget ? 'reflection' : object.isQuadMesh ? 'post' : 'main';
      const type = object.name === 'GrassTile' ? 'grass' : 'other';
      const key = `${pass}.${type}`;
      counts[key] = (counts[key] ?? 0) + count * instances / 3;
    }
    return original.call(this, object, count, instances);
  };
  const render = () => { counts = {}; r._nodes.nodeFrame.update(); r.info.frame = r._nodes.nodeFrame.frameId; d.pipeline.render(); return {...counts}; };
  try {
    d.grass.occlusion.enabled = false;
    d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
    for (const tile of d.grass.tiles) tile.mesh.geometry = d.grass.geometries[tile.mesh.userData.currentLOD];
    treeMeshes.forEach(m => { m.frustumCulled = false; });
    render();
    const uncull = render();
    treeMeshes.forEach(m => { m.frustumCulled = true; });
    d.grass.occlusion.enabled = true;
    const start = performance.now();
    d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
    const cullMs = performance.now() - start;
    render();
    const optimized = render();
    counts = {};
    d.water.reflectionInitialized = false;
    d.water.update(1, d.player, d.environment.current.lighting);
    return {uncull, optimized, reflection: counts, cullMs, grass: d.grass.stats, quality: d.grass.qualityName, camera: d.world.camera.position.toArray()};
  } finally { r.info.update = original; }
})()
