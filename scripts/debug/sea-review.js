// Developer-only camera controls: no production navigation or physics changes.
const frame = document.querySelector('iframe'), output = document.querySelector('output');
const backend = new URLSearchParams(window.location.search).get('renderer') ?? 'webgl';
frame.src = `/?renderer=${backend}`;
const views = {
  offshore: [[1380, -21, 80], [1470, -42, 65]],
  transition: [[1140, -18, 65], [1350, -34, 45]],
  beach: [[1007, -20.5, 0], [1085, -24, 48]],
  curve: [[1070, -15, 260], [1040, -24, 130]],
  lake: [[140, -8, 110], [320, -17, 160]],
  river: [[140, 12, 110], [90, 10, -100]],
};
let currentView = 'offshore';
const demo = () => {
  const d = frame.contentWindow.__grassDemo;
  if (!d?.started) throw new Error('Enter the scene and wait for loading to finish.');
  return d;
};
document.querySelector('#diagnostics').onclick = () => {
  const d = demo(), w = d.water, c = d.world.camera;
  output.textContent = JSON.stringify({camera:c.position.toArray(), matrix:c.matrixWorld.elements,
    waterPosition:w.mesh.position.toArray(), rotation:w.mesh.rotation.toArray(), scale:w.mesh.scale.toArray(),
    sameMaterial:w.mesh.material === w.material, clock:w.uniforms.clock.value,
    sun:w.uniforms.sunStrength.value, sea:w.params.sea, bounds:w.geometry.boundingBox,
    normals:Array.from(w.geometry.attributes.normal.array.slice(-9))});
};
document.querySelector('[aria-label="Surface diagnostic"]').onchange = async event => {
  // Nodes must come from the scene's realm, preserving Three's node identities.
  const { inspectSea } = await frame.contentWindow.eval("import('/scripts/debug/sea-diagnostics.js')");
  inspectSea(demo(), event.target.value);
};
const showView = name => {
  const d = demo(); currentView = name;
  d.player.setEnabled(false); d.player.update = () => {}; d.tour.active = false;
  d.player.root.visible = false;
  const [position, target] = views[name];
  d.player.setPosition(...position); d.world.camera.position.set(...position); d.world.camera.lookAt(...target);
  output.textContent = `${name} | ${d.world.rendererSession.diagnostics.actual} | ${d.water.quality}`;
};
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => {
  try { showView(button.dataset.view); } catch (error) { output.textContent = error.message; }
};
document.querySelector('[aria-label="Weather"]').onchange = event => {
  const d = demo(), name = event.target.value;
  d.environment.setPreset(name); output.textContent = name;
};
document.querySelector('[aria-label="Quality"]').onchange = event => {
  const d = demo(), name = event.target.value;
  d.grass.setQuality(name); d.environment.setQuality(name); d.pipeline?.setQuality(name);
  d.meadow?.setQuality(name); d.water.setQuality(name); output.textContent = name;
};
document.querySelector('#measure').onclick = async () => {
  try {
    const d = demo(), camera = d.world.camera, [position, target] = views[currentView];
    const samples = []; let previous = performance.now(), count = 0;
    output.textContent = 'Measuring 120 moving frames after 30 warmup frames…';
    await new Promise(resolve => {
      const tick = now => {
        camera.position.set(position[0] + Math.sin(count * 0.04) * 3, position[1], position[2]); camera.lookAt(...target);
        if (count++ >= 30) samples.push(now - previous); previous = now;
        if (samples.length < 120) requestAnimationFrame(tick); else resolve();
      }; requestAnimationFrame(tick);
    });
    samples.sort((a, b) => a - b);
    output.textContent = JSON.stringify({ view: currentView, backend: d.world.rendererSession.diagnostics.actual,
      quality: d.water.quality, mean: samples.reduce((a, b) => a + b) / samples.length,
      median: samples[60], p95: samples[114], triangles: d.world.renderer.info.render.triangles });
    camera.position.set(...position); camera.lookAt(...target);
  } catch (error) { output.textContent = error.stack; }
};
document.querySelector('#reflection').onclick = async () => {
  try {
    output.textContent = 'Measuring reflection budget…';
    const module = await frame.contentWindow.eval("import('/scripts/debug/reflection-benchmark.js')");
    output.textContent = JSON.stringify(await module.benchmarkReflections());
  } catch (error) { output.textContent = error.stack; }
};
document.querySelector('#recovery').onclick = async () => {
  try {
    output.textContent = 'Checking renderer recovery…';
    const module = await frame.contentWindow.eval("import('/scripts/gpu/recovery-check.js')");
    output.textContent = JSON.stringify(await module.checkRendererRecovery());
  } catch (error) { output.textContent = error.stack; }
};
