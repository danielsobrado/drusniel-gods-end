(() => {
  const d = window.__grassDemo, c = d.world.camera;
  const savedP = c.position.clone(), savedQ = c.quaternion.clone();
  const cases = [];
  for (const [x, z] of [[0, 0], [40, 0], [80, 20], [140, 50], [150, 120], [-80, -50], [-140, 70]]) {
    for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 2) {
      const y = d.world.terrainSampler.sampleHeight(x, z) + 3;
      c.position.set(x, y, z);
      c.lookAt(x + Math.sin(yaw) * 30, y - 2, z + Math.cos(yaw) * 30);
      c.updateMatrixWorld();
      const t = performance.now(); d.grass.occlusion.update(c); const ms = performance.now() - t;
      d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
      cases.push({x,z,yaw,ms,...d.grass.stats});
    }
  }
  c.position.copy(savedP); c.quaternion.copy(savedQ); c.updateMatrixWorld();
  d.grass.update(0, d.clock.elapsedTime, d.player.getPosition());
  return cases;
})()
