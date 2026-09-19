import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import assert from 'node:assert/strict';

const backend = process.argv.includes('--webgl') ? 'webgl' : 'webgpu';
const output = `.cache/vegetation-lods/${backend}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [], warnings = [];
page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
page.on('console', m => {
  if (m.type() === 'error') { errors.push(m.text()); if (errors.length < 10) console.error(m.text().slice(0,1000)); }
  if (m.type() === 'warning') { warnings.push(m.text()); if (warnings.length < 8) console.log('Warning:', m.text().slice(0,600)); }
});
try {
  await page.goto(`${process.env.VEGETATION_BASE_URL ?? 'http://127.0.0.1:5173'}/?character=drusniel&renderer=${backend}`, { waitUntil: 'domcontentloaded' });
  console.log('Loading', backend);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms?.clock.value > 0.2, null, { timeout: 180000 });
  console.log('Scene ready');
  await page.evaluate(async () => {
    const d = window.__grassDemo; await d.coastalJungle?.initTask;
    d.audio.start = async () => {}; document.querySelector('#startButton').click();
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
  }
  assert.ok(results.some(r => r.grass.far?.billboards > 0), 'distant grass is submitted');
  assert.ok(results.some(r => r.trees.medium > 0 && r.trees.low > 0 && r.trees.billboard > 0), 'all reduced tree levels are active');
  assert.ok(results.some(r => r.jungle.billboard > 0), 'jungle has a distant representation');
  await writeFile(`${output}/results.json`, JSON.stringify({ backend, results, errors, warnings }, null, 2));
  assert.deepEqual(errors, []);
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ message: error.message, errors, warnings }, null, 2));
  throw error;
} finally { await browser.close(); }
