(() => {
  const d = window.__grassDemo, r = d.world.renderer, c = d.world.camera;
  r.setAnimationLoop(null); r._animation.stop();
  d.player.enabled = false;
  d.player.getCharacterModel().visible = false;
  c.position.set(178, d.world.terrainSampler.sampleHeight(178, 40) + 7, 40);
  c.lookAt(230, -4, 120);
  c.updateMatrixWorld();
  d.ui.actions.setGrassType('blade');
  d.ui.actions.setQuality('ultra');
  d.world.clouds.mesh.visible = false;
  d.world.clouds.update(0);
  for (let i = 0; i < 30; i++) d.trees.update(0.1);
  d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
  r._nodes.nodeFrame.frameId++;
  d.pipeline.render();
  return {camera: c.position.toArray(), grass: d.grass.stats, error: d.renderErrorLogged ?? false};
})()
