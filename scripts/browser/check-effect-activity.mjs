import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright';

// Run against an existing dev/preview server. Uses the complete production
// scene so nested captures, warmup and effect switches are exercised together.
const base = process.env.EFFECT_BASE_URL ?? 'http://127.0.0.1:5173';
const backend = process.env.EFFECT_RENDERER ?? 'webgpu';
const baseline = process.argv.includes('--baseline');
const output = process.env.EFFECT_OUTPUT ?? '.cache/effect-performance';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(`${base}/?profile=1&renderer=${backend}&character=drusniel`);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms?.clock.value > 0.2,
    null, { timeout: 240_000 });
  await page.evaluate(async () => {
    const d = window.__grassDemo;
    await d.coastalJungle?.initTask;
    d.audio.start = async () => {};
    document.querySelector('#startButton').click();
  });
  await page.waitForFunction(() => window.__grassDemo.started);
  const result = await page.evaluate(async () => {
    const d = window.__grassDemo;
    const { renderer, camera, sun } = d.world;
    renderer.setAnimationLoop(null);
    d.player.setEnabled(false);
    d.player.root.visible = false;
    d.ui.actions.setPixelRatio(1);
    d.ui.actions.setQuality('ultra');
    const counts = { shafts: 0, depth: 0, water: 0, copies: 0 };
    const countDraw = (mesh, name) => {
      const draw = mesh.render.bind(mesh);
      mesh.render = (...args) => { counts[name]++; return draw(...args); };
    };
    for (const node of d.pipeline.stage.shaftPasses ?? d.pipeline.transient.filter(n => n.isRTTNode)) {
      countDraw(node._quadMesh, 'shafts');
    }
    countDraw(d.pipeline.stage.depth._quadMesh, 'depth');
    d.water.mesh.traverse(mesh => {
      if (!mesh.isMesh || mesh.material !== d.water.material) return;
      mesh.onBeforeRender = () => counts.water++;
    });
    const copy = renderer.copyFramebufferToTexture.bind(renderer);
    renderer.copyFramebufferToTexture = (...args) => { counts.copies++; return copy(...args); };
    const frames = async (count) => {
      const start = { ...counts, lake: d.water.stats.lakePlanarCaptures, sea: d.water.stats.seaPlanarCaptures };
      for (let i = 0; i < count; i++) {
        await new Promise(requestAnimationFrame);
        renderer._nodes.nodeFrame.update();
        d.water.update(0, d.player, d.environment.lighting);
        d.pipeline.render();
      }
      await renderer.backend.device?.queue.onSubmittedWorkDone();
      return Object.fromEntries(Object.entries({ ...counts, lake: d.water.stats.lakePlanarCaptures,
        sea: d.water.stats.seaPlanarCaptures }).map(([key, value]) => [key, value - start[key]]));
    };
    camera.position.set(-600, 150, 250);
    camera.lookAt(-1400, 170, 250);
    camera.updateMatrixWorld();
    sun.position.copy(sun.target.position).add({ x: 0, y: 100, z: 0 });
    await frames(2);
    const away = await frames(12);
    camera.position.set(180, 25, 120);
    camera.lookAt(310, -17, 170);
    camera.updateMatrixWorld();
    const lake = await frames(2);
    const reach = d.water.river.samples.find(point => point.y > d.config.ground.snow.altitude.start + 5);
    const toLakeX = d.water.params.position[0] - reach.x;
    const toLakeZ = d.water.params.position[2] - reach.z;
    const toLakeLength = Math.hypot(toLakeX, toLakeZ);
    camera.position.set(reach.x + toLakeX / toLakeLength * 20, reach.y + 15,
      reach.z + toLakeZ / toLakeLength * 20);
    camera.lookAt(reach.x, reach.y, reach.z);
    camera.updateMatrixWorld();
    const river = await frames(2);
    camera.position.set(1000, 30, 100);
    camera.lookAt(1300, -24, 180);
    camera.updateMatrixWorld();
    const sea = await frames(2);
    camera.position.set(-600, 150, 250);
    camera.lookAt(-1600, 300, 250);
    camera.updateMatrixWorld();
    sun.position.copy(sun.target.position).add({ x: -100, y: 15, z: 0 });
    const shafts = await frames(2);
    const intensity = d.pipeline.shafts.intensity.value;
    sun.position.copy(sun.target.position).add({ x: 100, y: 15, z: 0 });
    const dormantAgain = await frames(3);
    const targetIds = d.pipeline.shafts.passes?.map(node => node.uuid);
    for (const effect of ['sharpen', 'depthOfField', 'lightShafts', 'taa']) {
      d.pipeline.setEffect(effect, true);
      await frames(2);
      d.pipeline.setEffect(effect, false);
      await frames(2);
    }
    d.pipeline.setEffect('lightShafts', true);
    for (const quality of ['performance', 'balanced', 'high', 'ultra']) {
      d.pipeline.setQuality(quality);
      await frames(2);
    }
    return { initialized: d.water.reflectionInitialized, quality: d.water.quality, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl', away, lake, river, sea,
      shafts, intensity, dormantAgain, targetsRetained: targetIds?.every((id, i) => id === d.pipeline.shafts.passes[i].uuid),
      renderError: d.renderErrorLogged };
  });
  await page.screenshot({ path: `${output}/activity-${backend}.png` });
  await writeFile(`${output}/activity-${backend}.json`, JSON.stringify({ result, errors }, null, 2));
  console.log(JSON.stringify({ result, errors }, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(result.backend, backend);
  assert.equal(result.renderError, false);
  if (!baseline) {
    assert.equal(result.away.shafts, 0);
    assert.equal(result.away.water, 0);
    assert.equal(result.away.copies, 0);
    assert.equal(result.away.lake + result.away.sea, 0);
    assert.equal(result.away.depth, 12);
    assert.ok(result.lake.water > 0 && result.lake.lake > 0);
    assert.ok(result.river.water > 0);
    assert.equal(result.river.lake, 0);
    assert.ok(result.sea.water > 0 && result.sea.sea > 0);
    assert.ok(result.shafts.shafts > 0 && result.intensity > 0);
    assert.equal(result.dormantAgain.shafts, 0);
    assert.equal(result.targetsRetained, true);
  }
} finally {
  await browser.close();
}
