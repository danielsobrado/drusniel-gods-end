import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const backend = process.argv.includes('--webgl') ? 'webgl' : 'webgpu';

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.routeWebSocket('**/*', socket => {
  const server = socket.connectToServer();
  server.onMessage(message => { if (typeof message !== 'string' || !/"type":"(?:update|full-reload)"/.test(message)) socket.send(message); });
});
try {
  const start = performance.now();
  await page.goto(`http://127.0.0.1:5173/?profile=1&renderer=${backend}&character=drusniel`);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms.clock.value > 0.2, null, { timeout: 240000 });
  const loadMs = performance.now() - start;
  console.log('Ready', Math.round(loadMs));
  const report = await page.evaluate(async () => {
    const d = window.__grassDemo;
    d.audio.start = async () => {}; d.tour.stop(); d.tour.update = () => {}; d.navigation.update = () => {};
    d.player.setEnabled(true); d.player.keys.clear();
    const ground = d.world.terrainSampler.sampleHeight(2, -5);
    d.player.setPosition(2, ground + d.player.metrics.rootToFeet + d.player.metrics.groundOffset, -5);
    d.player.cameraYaw = 0;
    const frames = count => new Promise(resolve => { const step = () => --count > 0 ? requestAnimationFrame(step) : resolve(); requestAnimationFrame(step); });
    await frames(30);
    const draws = [];
    const drawTargets = d.world.terrainRender?.batches ?? [d.world.terrainTarget];
    const hooks = drawTargets.map(terrain => {
      const before = terrain.onBeforeRender;
      terrain.onBeforeRender = function(renderer, scene, camera, geometry, material, group) {
        if (draws.length < 24) draws.push({ name: terrain.name, camera: camera.type, cameraName: camera.name,
          main: camera === d.world.camera, target: renderer.getRenderTarget()?.texture.name,
          targetSize: renderer.getRenderTarget()?.width, material: material.type,
          override: scene.overrideMaterial?.name, triangles: geometry.index.count / 3 });
        before?.call(this, renderer, scene, camera, geometry, material, group);
      };
      return { terrain, before };
    });
    await frames(2);
    for (const hook of hooks) hook.terrain.onBeforeRender = hook.before;
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) for (const chunks of [false, true]) {
      d.world.terrainShadows?.setEnabled(chunks); d.world.sun.shadow.needsUpdate = true;
      await frames(20);
      d.profiler.startTimed({ warmupSeconds: 0.3, measureSeconds: 1 });
      while (!d.profiler.done) await frames(2);
      const stats = d.profiler.summarize();
      samples.push({ chunks, triangles: d.world.renderer.info.render.triangles, draws: d.world.renderer.info.render.drawCalls,
        processing: stats.processing, interval: stats.interval });
    }
    d.world.terrainShadows?.setEnabled(true);
    const moving = [];
    const compiled = [], backend = d.world.renderer.backend, createPipeline = backend.createRenderPipeline;
    backend.createRenderPipeline = function (...args) {
      compiled.push({ name: args[0]?.object?.name, time: performance.now() });
      return createPipeline.apply(this, args);
    };
    for (const key of ['KeyW', 'KeyS']) {
      d.player.keys.add(key);
      d.profiler.startTimed({ warmupSeconds: 0.2, measureSeconds: 3 });
      while (!d.profiler.done) await frames(2);
      d.player.keys.clear();
      moving.push({ direction: key, ...d.profiler.summarize(), slowFrames: d.profiler.samples.filter(s => s.intervalMs > 25 || s.processingMs > 25) });
    }
    backend.createRenderPipeline = createPipeline;
    return { draws, samples, moving, shadowMapSize: d.world.sun.shadow.mapSize.x,
      compiled, warmup: d.pipeline.warmupStats, terrainRender: d.world.terrainRender?.stats ?? null,
      grass: d.grass.stats, profile: d.getProfileResults() };
  });
  await mkdir('.cache/opening', { recursive: true });
  await writeFile(`.cache/opening/${backend}.json`, JSON.stringify({ loadMs, ...report, errors }, null, 2));
  console.log(JSON.stringify({ loadMs, samples: report.samples, moving: report.moving.map(m => ({ direction: m.direction, processing: m.processing, interval: m.interval })),
    shadowMapSize: report.shadowMapSize, warmup: report.warmup,
    terrainRender: report.terrainRender, startup: report.profile.startup, errors }));
  await page.screenshot({ path: `.cache/opening/${backend}.png` });
  assert.deepEqual(errors, []);
  assert.equal(report.shadowMapSize, 2048);
  assert.deepEqual(report.compiled.filter(entry => /^tree\d+:/.test(entry.name ?? '')), [],
    'the first walk must not compile tree LOD pipelines');
  const original = report.samples.filter(s => !s.chunks), optimized = report.samples.filter(s => s.chunks);
  assert.ok(optimized.every((sample, i) => sample.triangles < original[i].triangles - 500000), 'shadow sections must cut actual submitted triangles');
} finally { await browser.close(); }
