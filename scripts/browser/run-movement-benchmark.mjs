import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] ?? 'current';
const port = Number(process.argv[3] ?? 5173);
const soak = process.argv.includes('--soak');
const gameplay = process.argv.includes('--gameplay');
if (soak && gameplay) throw new Error('Choose either --soak or --gameplay');
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Use a simple alphanumeric report label');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
const out = new URL('../../.cache/movement-performance/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
  '--enable-unsafe-webgpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info',
] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const report = { label, port, soak, gameplay, startedAt: new Date().toISOString(), runs: [], errors: [] };
page.on('pageerror', error => { report.errors.push(error.message); console.log('PAGE ERROR', error.message); });
page.on('console', message => {
  if (message.type() === 'error') { report.errors.push(message.text()); console.log('CONSOLE ERROR', message.text().slice(0, 300)); }
});
const save = () => writeFile(new URL(`${label}.json`, out), JSON.stringify(report, null, 2));
let loadingLog;
try {
  const system = await browser.newBrowserCDPSession();
  report.system = await system.send('SystemInfo.getInfo');
  await save();
  await page.goto(`http://127.0.0.1:${port}/?profile=1&renderer=webgpu&character=drusniel`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  console.log(label, 'loading scene');
  loadingLog = setInterval(() => {
    page.locator('body').innerText({ timeout: 3000 }).then(text => console.log('LOADING', text.slice(-500))).catch(() => {});
  }, 15000);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms?.clock.value > 0.2, null, { timeout: 180000 });
  clearInterval(loadingLog);
  await page.evaluate(async () => {
    const d = window.__grassDemo;
    await d.coastalJungle?.initTask;
    d.audio.start = async () => {};
    document.querySelector('#startButton').click();
    d.ui.actions.setPixelRatio(1);
  });
  await page.waitForFunction(() => window.__grassDemo?.started, null, { timeout: 30000 });
  report.meta = await page.evaluate(() => window.__grassDemo.getProfileResults());
  if (report.meta.backend !== 'webgpu') throw new Error('The movement benchmark requires WebGPU');
  console.log(label, 'READY', JSON.stringify({ backend: report.meta.backend, quality: report.meta.quality, viewport: report.meta.viewport }));
  const scenarios = gameplay ? [{ id: 'sprint', x: -80, z: -80, radius: 80 }]
    : soak ? [{ id: 'fastTurns', x: -160, z: -160, radius: 180 }] : [
    { id: 'forest', x: -320, z: 20, radius: 80 },
    { id: 'meadow', x: 0, z: -40, radius: 80 },
    { id: 'river', x: 100, z: -20, radius: 65 },
    { id: 'jungleCoast', x: 840, z: 290, radius: 70 },
    { id: 'snow', x: -125, z: -590, radius: 65 },
  ];
  const cdp = await page.context().newCDPSession(page);
  for (const quality of ['high', 'ultra']) {
    await page.evaluate(q => window.__grassDemo.ui.actions.setQuality(q), quality);
    for (const scenario of scenarios) {
      for (const speed of gameplay ? [1, 10] : soak ? [180] : [9, 180]) {
        if (gameplay) {
          const boosted = await page.evaluate(() => {
            document.activeElement?.blur();
            return Boolean(document.querySelector('[data-exploration-speed="10"]'));
          });
          if (boosted !== (speed === 10)) {
            await page.keyboard.press('Shift');
            await page.keyboard.press('Shift');
          }
          await page.keyboard.down('Shift');
          await page.keyboard.down('w');
        }
        const trace = !soak && quality === 'high' && scenario.id === 'forest' && speed === 9;
        if (trace) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
        const run = await page.evaluate(async ({ scenario, speed, soak, gameplay }) => {
          const d = window.__grassDemo;
          d.__benchmarkPlayerUpdate ??= d.player.update.bind(d.player);
          d.player.setEnabled(gameplay);
          d.player.root.visible = gameplay;
          d.tour.stop();
          if (!gameplay) {
            d.tour.update = () => {};
            d.navigation.update = () => {};
          }
          let elapsed = 0;
          let traveled = 0;
          const pose = () => {
            const angle = elapsed * speed / scenario.radius;
            const x = scenario.x + Math.sin(angle) * scenario.radius;
            const z = scenario.z + (1 - Math.cos(angle)) * scenario.radius;
            const y = d.world.terrainSampler.sampleHeight(x, z);
            const ground = Number.isFinite(y) ? y : 0;
            const { rootToFeet, groundOffset } = d.player.metrics;
            d.player.setPosition(x, ground + rootToFeet + groundOffset, z);
            d.world.camera.position.set(x, ground + 6, z);
            const heading = angle + (soak ? Math.sin(elapsed * 2) * Math.PI : 0);
            d.world.camera.lookAt(x + Math.cos(heading) * 30, ground + 3, z + Math.sin(heading) * 30);
          };
          pose();
          const targetSpeed = d.player.modelHeight * d.config.cinematic.motion.runSpeedInHeights;
          if (gameplay && (d.player.keys.has('KeyW') === false || !d.player.physics)) {
            throw new Error('Gameplay capture requires keyboard movement and physics');
          }
          d.player.update = delta => {
            elapsed += delta;
            if (!gameplay) { pose(); return; }
            d.player.cameraYaw = elapsed * targetSpeed / scenario.radius;
            const { x, z } = d.player.root.position;
            d.__benchmarkPlayerUpdate(delta);
            traveled += Math.hypot(d.player.root.position.x - x, d.player.root.position.z - z);
          };
          const memory = () => {
            const arrays = new Set();
            for (const tile of d.grass.tiles) for (const geometry of tile.cache.values()) {
              for (const attribute of Object.values(geometry.attributes)) arrays.add(attribute.array);
            }
            return { seconds: elapsed, grassBytes: [...arrays].reduce((sum, array) => sum + array.byteLength, 0),
              heapBytes: performance.memory?.usedJSHeapSize ?? null,
              geometries: d.world.renderer.info.memory.geometries,
              cachedGrassGeometries: d.grass.tiles.reduce((sum, tile) => sum + tile.cache.size, 0),
              tileCount: d.grass.tiles.length };
          };
          const memorySamples = [memory()];
          let nextMemorySample = 5;
          d.profiler.startTimed({ warmupSeconds: soak ? 5 : gameplay ? 2 : speed === 9 ? 0 : 1,
            measureSeconds: soak ? 60 : gameplay ? 15 : speed === 9 ? 4 : 8 });
          await new Promise((resolve, reject) => {
            const deadline = performance.now() + (soak ? 120000 : 60000);
            const check = () => {
              if (elapsed >= nextMemorySample) {
                memorySamples.push(memory());
                nextMemorySample += 5;
              }
              if (d.profiler.done) return resolve();
              if (performance.now() > deadline) return reject(new Error('Movement capture timed out'));
              requestAnimationFrame(check);
            };
            check();
          });
          return { scenario: scenario.id, speed: gameplay ? targetSpeed : speed,
            boostMultiplier: gameplay ? speed : null, traveled: gameplay ? traveled : elapsed * speed,
            ...d.profiler.summarize(),
            slowest: [...d.profiler.samples].sort((a, b) => b.processingMs - a.processingMs).slice(0, 5),
            slowestIntervals: [...d.profiler.samples].sort((a, b) => b.intervalMs - a.intervalMs).slice(0, 5),
            intervalsOver33ms: d.profiler.samples.filter(s => s.intervalMs > 1000 / 30).length,
            intervalsOver50ms: d.profiler.samples.filter(s => s.intervalMs > 50).length,
            memory: memory(), memorySamples,
            renderError: Boolean(d.renderErrorLogged) };
        }, { scenario, speed, soak, gameplay });
        if (gameplay) {
          await page.keyboard.up('w');
          await page.keyboard.up('Shift');
          if (run.traveled < 10) throw new Error('The player did not move far enough to validate gameplay');
        }
        if (trace) {
          const { profile } = await cdp.send('Profiler.stop');
          await writeFile(new URL(`${label}-forest.cpuprofile`, out), JSON.stringify(profile));
        }
        run.quality = quality;
        report.runs.push(run);
        await save();
        if (run.renderError || !run.frames) throw new Error('Movement capture failed to render valid frames');
        console.log(label, quality, scenario.id, speed, JSON.stringify({ frames: run.frames,
          cpu: run.processing, interval: run.interval, compaction: run.compactionMs,
          grassMiB: run.memory.grassBytes / 1048576, renderError: run.renderError }));
      }
      // URL.pathname yields "/F:/..." on Windows, which Playwright resolves to a bogus drive path.
      if (quality === 'high') await page.screenshot({ path: fileURLToPath(new URL(`${label}-${scenario.id}.png`, out)) });
    }
  }
  if (report.errors.length) throw new Error(`Browser emitted ${report.errors.length} errors`);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  console.log((await page.locator('body').innerText().catch(() => '')).slice(0, 1500));
  process.exitCode = 1;
} finally {
  clearInterval(loadingLog);
  report.completedAt = new Date().toISOString();
  await save();
  await browser.close();
}
