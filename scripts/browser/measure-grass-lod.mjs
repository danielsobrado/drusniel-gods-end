// Grass LOD triangle/draw-call capture at the starting meadow.
// Parks the gameplay camera at fixed poses so before/after runs are comparable,
// then reports grass triangles by LOD band alongside whole-scene renderer totals.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] ?? 'current';
const port = Number(process.argv[3] ?? 5173);
const only = process.argv.find(a => a.startsWith('--quality='))?.split('=')[1];
const qualities = only ? [only] : process.argv.includes('--all')
  ? ['performance', 'balanced', 'high', 'ultra'] : ['high', 'ultra'];
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Use a simple alphanumeric report label');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');

const out = new URL('../../.cache/grass-lod/', import.meta.url);
await mkdir(out, { recursive: true });

// The starting meadow: player.start from config.yaml, then the gameplay camera
// rig (camera.distance / camera.pitch) sampled around a full turn.
const START = { x: 2, z: -5 };
const YAWS = [0, 45, 90, 135, 180, 225, 270, 315];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const report = { label, port, startedAt: new Date().toISOString(), poses: [], errors: [] };
page.on('pageerror', error => { report.errors.push(error.message); console.log('PAGE ERROR', error.message); });
page.on('console', message => {
  if (message.type() === 'error') report.errors.push(message.text().slice(0, 300));
});
const save = () => writeFile(new URL(`${label}.json`, out), JSON.stringify(report, null, 2));

let loadingLog;
try {
  await page.goto(`http://127.0.0.1:${port}/?profile=1&renderer=webgpu&character=drusniel`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  console.log(label, 'loading scene');
  loadingLog = setInterval(() => {
    page.locator('body').innerText({ timeout: 3000 })
      .then(text => console.log('LOADING', text.slice(-300))).catch(() => {});
  }, 15000);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms?.clock.value > 0.2,
    null, { timeout: 180000 });
  clearInterval(loadingLog);
  await page.evaluate(async () => {
    const d = window.__grassDemo;
    await d.coastalJungle?.initTask;
    d.audio.start = async () => {};
    d.ui.actions.setPixelRatio(1);
    d.tour.stop();
    d.tour.update = () => {};
    d.navigation.update = () => {};
    d.player.setEnabled(true);
  });
  await page.waitForFunction(() => window.__grassDemo?.started, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.__grassDemo.getProfileResults());
  if (meta.backend !== 'webgpu') throw new Error('The grass LOD capture requires WebGPU');
  report.meta = { backend: meta.backend, viewport: meta.viewport, pixelRatio: meta.pixelRatio };
  console.log(label, 'READY', JSON.stringify(report.meta));

  for (const quality of qualities) {
    await page.evaluate(q => window.__grassDemo.ui.actions.setQuality(q), quality);
    for (const yaw of YAWS) {
      const pose = await page.evaluate(async ({ start, yaw, quality }) => {
        const d = window.__grassDemo;
        const rad = yaw * Math.PI / 180;
        const ground = d.world.terrainSampler.sampleHeight(start.x, start.z) || 0;
        const { rootToFeet, groundOffset } = d.player.metrics;
        // Drive the real gameplay rig rather than placing the camera by hand:
        // PlayerController#updateCamera owns the orbit distance, height and pitch.
        d.player.keys.clear();
        const place = () => {
          d.player.setPosition(start.x, ground + rootToFeet + groundOffset, start.z);
          d.player.cameraYaw = rad;
        };
        place();
        await new Promise(r => setTimeout(r, 700));
        d.profiler.startTimed({ warmupSeconds: 1, measureSeconds: 3 });
        await new Promise((resolve, reject) => {
          const deadline = performance.now() + 30000;
          const check = () => {
            place();
            if (d.profiler.done) return resolve();
            if (performance.now() > deadline) return reject(new Error('Pose capture timed out'));
            requestAnimationFrame(check);
          };
          check();
        });
        const g = d.grass.stats;
        const nearDraws = d.grass.tiles.filter(t => t.mesh.visible).length;
        const farDraws = d.grass.farGrass?.tiles.filter(t => t.mesh.visible).length ?? 0;
        const frames = d.profiler.summarize();
        return {
          quality, yaw,
          grassTriangles: g.triangles,
          nearGrassTriangles: g.triangles - (g.far?.triangles ?? 0),
          farGrassTriangles: g.far?.triangles ?? 0,
          submittedBlades: g.submittedBlades,
          proceduralCulledBlades: g.proceduralCulledBlades,
          visibleTiles: g.visibleTiles,
          lodTiles: { ...g.lods },
          lodInstances: { ...g.lodInstances },
          lodTriangles: Object.fromEntries(Object.entries(g.lodInstances).map(([k, v]) => {
            const geometry = d.grass.geometries[k];
            const per = (geometry.index?.count ?? geometry.attributes.position.count) / 3;
            return [k, v * per];
          })),
          farCards: g.far?.billboards ?? 0,
          farChunks: g.far?.chunks ?? 0,
          grassDrawCalls: nearDraws + farDraws,
          nearDraws, farDraws,
          tilePool: d.grass.tiles.length,
          tileSize: d.config.grass.tileSize,
          sceneDrawCalls: frames.drawCalls,
          sceneTriangles: frames.triangles,
          cpuMs: frames.processing,
          frameMs: frames.interval,
          compactionMs: frames.compactionMs ?? null,
          subsystems: Object.fromEntries(Object.entries(frames.subsystems ?? {})
            .map(([name, value]) => [name, value.median])),
        };
      }, { start: START, yaw, quality });
      report.poses.push(pose);
      await save();
      console.log(label, quality, `yaw ${yaw}`.padEnd(8),
        `grass ${(pose.grassTriangles / 1e6).toFixed(2)}M`,
        `(near ${(pose.nearGrassTriangles / 1e6).toFixed(2)}M far ${(pose.farGrassTriangles / 1e6).toFixed(2)}M)`,
        `draws ${pose.grassDrawCalls}`,
        `scene ${(pose.sceneTriangles?.median / 1e6).toFixed(2)}M/${pose.sceneDrawCalls?.median}`,
        `frame ${pose.frameMs?.median?.toFixed(2)}ms`);
      if (yaw === 0 || yaw === 180) {
        await page.screenshot({
          path: fileURLToPath(new URL(`${label}-${quality}-yaw${yaw}.png`, out)),
        });
      }
    }
  }

  // Aggregate per quality so before/after comparison is one number per profile.
  report.summary = qualities.map((quality) => {
    const rows = report.poses.filter(p => p.quality === quality);
    const mean = (pick) => rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;
    return {
      quality,
      tileSize: rows[0].tileSize,
      tilePool: rows[0].tilePool,
      meanGrassTriangles: Math.round(mean(r => r.grassTriangles)),
      meanNearGrassTriangles: Math.round(mean(r => r.nearGrassTriangles)),
      meanFarGrassTriangles: Math.round(mean(r => r.farGrassTriangles)),
      meanGrassDrawCalls: Math.round(mean(r => r.grassDrawCalls)),
      meanSceneTriangles: Math.round(mean(r => r.sceneTriangles?.median ?? 0)),
      meanSceneDrawCalls: Math.round(mean(r => r.sceneDrawCalls?.median ?? 0)),
      meanFrameMs: Number(mean(r => r.frameMs?.median ?? 0).toFixed(3)),
      meanCpuMs: Number(mean(r => r.cpuMs?.median ?? 0).toFixed(3)),
      lodTriangles: Object.fromEntries(['high', 'medium', 'low', 'veryLow']
        .map(k => [k, Math.round(mean(r => r.lodTriangles[k] ?? 0))])),
      lodInstances: Object.fromEntries(['high', 'medium', 'low', 'veryLow']
        .map(k => [k, Math.round(mean(r => r.lodInstances[k] ?? 0))])),
      meanFarCards: Math.round(mean(r => r.farCards)),
    };
  });
  await save();
  console.log('\n=== SUMMARY ===');
  for (const row of report.summary) {
    console.log(`${row.quality.padEnd(12)} tile ${row.tileSize}m  grass ${(row.meanGrassTriangles / 1e6).toFixed(2)}M tri`
      + ` (near ${(row.meanNearGrassTriangles / 1e6).toFixed(2)}M + far ${(row.meanFarGrassTriangles / 1e6).toFixed(2)}M)`
      + `  ${row.meanGrassDrawCalls} grass draws  scene ${(row.meanSceneTriangles / 1e6).toFixed(2)}M/${row.meanSceneDrawCalls}`
      + `  frame ${row.meanFrameMs}ms cpu ${row.meanCpuMs}ms`);
    console.log(`             by band: ${Object.entries(row.lodTriangles)
      .map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}M`).join('  ')}  far cards ${row.meanFarCards}`);
  }
  if (report.errors.length) throw new Error(`Browser emitted ${report.errors.length} errors`);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(loadingLog);
  report.completedAt = new Date().toISOString();
  await save();
  await browser.close();
}
