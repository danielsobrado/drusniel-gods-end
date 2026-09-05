(async () => {
  const d = window.__grassDemo, r = d.world.renderer;
  r.setAnimationLoop(null); r._animation.stop();
  const treeMeshes = [];
  d.trees.trees.forEach(t => t.high.traverse(o => { if (o.isMesh) treeMeshes.push(o); }));
  const capture = async () => {
    r._nodes.nodeFrame.frameId++;
    d.pipeline.render();
    const target = d.pipeline.scenePass.renderTarget;
    return r.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height);
  };
  d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
  for (const tile of d.grass.tiles) tile.mesh.geometry = d.grass.geometries[tile.mesh.userData.currentLOD];
  treeMeshes.forEach(m => { m.frustumCulled = false; });
  const before = await capture();
  treeMeshes.forEach(m => { m.frustumCulled = true; });
  d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
  const after = await capture();
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  return {elements: before.length, changed, grass: d.grass.stats, renderError: d.renderErrorLogged ?? false};
})()
