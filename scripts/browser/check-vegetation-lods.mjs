import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const backend = process.argv.includes('--webgl') ? 'webgl' : 'webgpu';
const baseline = process.argv.includes('--baseline');
const output = `.cache/vegetation-lods/${backend}${baseline ? '-baseline' : ''}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
if (process.argv.includes('--diagnose-gl')) await page.addInitScript(() => {
  const original = window.WebGL2RenderingContext.prototype.drawElementsInstanced;
  window.WebGL2RenderingContext.prototype.drawElementsInstanced = function (...args) {
    if (!this.getParameter(this.ELEMENT_ARRAY_BUFFER_BINDING)) console.warn('Missing index binding', JSON.stringify({ args, mesh: window.__lastDrawMesh }));
    return original.apply(this, args);
  };
  setInterval(() => window.__grassDemo?.world?.scene.traverse(object => {
    if (!object.isMesh || object.userData.drawDiagnostic) return;
    object.userData.drawDiagnostic = true;
    const before = object.onBeforeRender;
    object.onBeforeRender = function (...args) { window.__lastDrawMesh = { name: this.name, vertices: this.geometry.attributes.position?.count, indices: this.geometry.index?.count }; before.apply(this, args); };
  }), 50);
});
// Keep route captures stable while documentation and tests are edited in the workspace.
await page.routeWebSocket('**/*', socket => {
  const server = socket.connectToServer();
  server.onMessage(message => {
    if (typeof message === 'string' && /"type":"(?:update|full-reload)"/.test(message)) return;
    socket.send(message);
  });
});
const errors = [], warnings = [];
if (baseline) await page.route('**/vegetation-lod.yaml', route => route.fulfill({
  contentType: 'text/yaml', body: 'vegetationLod:\n  enabled: false\ngrass:\n  far:\n    enabled: false\n',
}));
page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
page.on('console', m => {
  if (m.type() === 'error') { errors.push(m.text()); if (errors.length < 10) console.error(m.text().slice(0,1000)); }
  if (m.type() === 'warning') { warnings.push(m.text()); if (warnings.length < 8) console.log('Warning:', m.text().slice(0,600)); }
});
try {
  const loadStart = performance.now();
  await page.goto(`${process.env.VEGETATION_BASE_URL ?? (process.argv.includes('--production') ? 'http://127.0.0.1:5174' : 'http://127.0.0.1:5173')}/?character=drusniel&renderer=${backend}`, { waitUntil: 'domcontentloaded' });
  console.log('Loading', backend);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms?.clock.value > 0.2, null, { timeout: 300000 });
  const loadMs = performance.now() - loadStart;
  console.log('Scene ready', Math.round(loadMs), 'ms');
  await page.evaluate(() => {
    window.__grassDemo.audio.start = async () => {};
  });
  await page.waitForFunction(() => window.__grassDemo.started, null, { timeout: 30000 });
  const results = [];
  for (const route of [
    { name: 'meadow', position: [2, 18, -5], target: [0, 5, -230] },
    { name: 'lake', position: [170, 8, 120], target: [310, -6, 200] },
    { name: 'jungle', position: [846, 30, 293], target: [846, 24, 370] },
    { name: 'jungle-distant', position: [600, 110, 300], target: [860, 25, 300] },
    { name: 'alpine', position: [-125, 170, -590], target: [-80, 210, -735] },
  ]) {
    await page.evaluate(({ position, target }) => {
      const d = window.__grassDemo; d.navigation.freeFly.start(); d.navigation.freeFly.teleport(position, target);
    }, route);
    if (route.name.startsWith('jungle')) {
      await page.waitForFunction(
        () => window.__grassDemo?.coastalJungle?.ready,
        null,
        { timeout: 120000 },
      );
    }
    if (route.name === 'alpine') {
      await page.waitForFunction(
        () => window.__grassDemo?.world?.terrainDeferredGroups
          ?.find((group) => group.name === 'alpineTrees')?.loaded,
        null,
        { timeout: 120000 },
      );
    }
    await page.evaluate(() => new Promise(resolve => { let frames = 0; const tick = () => ++frames < 12 ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick); }));
    const result = await page.evaluate(async () => {
      const d = window.__grassDemo, times = []; let previous;
      await new Promise(resolve => {
        const tick = time => { if (previous !== undefined) times.push(time - previous); previous = time; if (times.length < 30) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
      });
      times.sort((a, b) => a - b);
      return { hiddenCollider: !d.world.terrain.getObjectByName('WaterCollider').visible,
        trees: { ...d.trees.stats }, grass: structuredClone(d.grass.stats), jungle: structuredClone(d.coastalJungle.stats),
        frameMs: { median: times[15], p95: times[28] }, render: { ...d.world.renderer.info.render },
        memory: { ...d.world.renderer.info.memory } };
    });
    assert.equal(result.hiddenCollider, true);
    results.push({ route: route.name, ...result }); console.log(JSON.stringify(results.at(-1)));
    await page.screenshot({ path: `${output}/${route.name}.png` });
    const movement = await page.evaluate(async ({ position, target }) => {
      const d = window.__grassDemo, times = [], culling = []; let previous;
      await new Promise(resolve => {
        let frame = 0;
        const tick = time => {
          if (previous !== undefined) { times.push(time - previous); culling.push(d.coastalJungle.stats.bookkeepingMs ?? 0); }
          previous = time;
          // Cross chunk boundaries and reverse, keeping the same view target.
          const offset = frame < 60 ? frame * 0.5 : (120 - frame) * 0.5;
          d.navigation.freeFly.teleport([position[0] + offset, position[1], position[2]], target);
          if (++frame <= 120) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      times.sort((a, b) => a - b); culling.sort((a, b) => a - b);
      return { median: times[60], p95: times[114], max: times.at(-1), jungleCullingP95: culling[114] };
    }, route);
    results.at(-1).movementMs = movement;
    console.log('Movement', route.name, JSON.stringify(movement));
  }
  if (!baseline) {
    // Fixed High-quality views previously doubled after extending tree meshes.
    const triangleBudgets = { meadow: 3600000, lake: 3200000, jungle: 6500000, 'jungle-distant': 4600000, alpine: 2300000 };
    for (const result of results) assert.ok(result.render.triangles <= triangleBudgets[result.route],
      `${result.route}: ${result.render.triangles} triangles exceeds the original-view budget`);
    assert.ok(results.some(r => r.grass.far?.billboards > 0), 'distant grass is submitted');
    // Trees carry two mesh stages and then the impostor: the decimated "low"
    // canopy was dropped deliberately (trees.lod.distances, vegetation-lod.yaml),
    // so requiring it here would assert a stage that can no longer be built.
    assert.ok(results.some(r => r.trees.medium > 0 && r.trees.billboard > 0), 'all reduced tree levels are active');
    assert.ok(results.some(r => r.jungle.billboard > 0), 'jungle has a distant representation');
    // Freeze visibility within one synchronous render: only cards beyond the OLD near cutoff remain.
    const png = await page.evaluate(() => {
      const d = window.__grassDemo, { scene, camera, renderer } = d.world;
      d.navigation.freeFly.teleport([2, 18, -5], [0, 5, -230]);
      camera.updateMatrixWorld();
      d.grass.update(0, d.water.uniforms.clock.value, camera.position);
      const far = d.grass.farGrass, controller = far.controller();
      controller.handoff.value = d.config.quality[d.grass.qualityName][d.grass.type].maxDistance / d.config.grass.far.transitionStart;
      const visible = []; scene.traverse(o => { if (o.isMesh || o.isPoints || o.isLine) { visible.push([o, o.visible]); o.visible = o.name === 'Far grass clumps' && o.visible; } });
      const background = scene.background, fog = scene.fog; scene.background = null; scene.fog = null;
      renderer.setClearColor(0, 1); renderer.render(scene, camera);
      const image = renderer.domElement.toDataURL('image/png').split(',')[1];
      for (const [object, value] of visible) object.visible = value;
      scene.background = background; scene.fog = fog;
      return image;
    });
    await writeFile(`${output}/far-grass-pixels.png`, Buffer.from(png, 'base64'));
    const { data, info } = await sharp(await readFile(`${output}/far-grass-pixels.png`)).raw().toBuffer({ resolveWithObject: true });
    let colored = 0;
    for (let i = 0; i < data.length; i += info.channels) if (Math.max(data[i], data[i + 1], data[i + 2]) > 15) colored++;
    assert.ok(colored > 500, `distant grass must produce real pixels, found ${colored}`);
    console.log(`Far grass pixels beyond old range: ${colored}`);
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ backend, loadMs, results, errors, warnings }, null, 2));
  assert.equal(warnings.some(w => /GL_INVALID_|Shader Error|VALIDATION_ERROR/.test(w)), false, 'no invalid GPU draws');
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  const state = await page.evaluate(() => ({ text: document.body.innerText.slice(-5000),
    ready: Boolean(window.__grassDemo?.grass), clock: window.__grassDemo?.water?.uniforms?.clock?.value })).catch(() => null);
  console.error('Failure state', state);
  await writeFile(`${output}/failure.json`, JSON.stringify({ message: error.message, errors, warnings, state }, null, 2));
  throw error;
} finally { await browser.close(); }
