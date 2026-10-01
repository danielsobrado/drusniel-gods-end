import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pinBrowserToCores, resolvePinMask } from './pinPerformanceCores.mjs';

const label = process.argv[2] ?? 'current';
const port = Number(process.argv[3] ?? 5173);
const soak = process.argv.includes('--soak');
const gameplay = process.argv.includes('--gameplay');
const onlyScenario = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1];
const onlyQuality = process.argv.find(arg => arg.startsWith('--quality='))?.split('=')[1];
const compareTrees = process.argv.includes('--compare-tree-traversal');
const assertWarmedTrees = process.argv.includes('--assert-warmed-trees');
const replay = process.argv.includes('--replay');
const rendererRequest = process.argv.find(arg => arg.startsWith('--renderer='))?.split('=')[1] ?? 'webgpu';
if (!['webgpu', 'webgl'].includes(rendererRequest)) throw new Error('renderer must be webgpu or webgl');
const expectedBackend = rendererRequest === 'webgl' ? 'webgl2' : 'webgpu';
const cpuTrace = process.argv.includes('--cpu-trace');
// GPU cost scales with pixels, so a 720p capture cannot show whether the
// user's 3440x1440 display holds its 144 Hz budget; --viewport=3440x1440 does.
const [viewportWidth, viewportHeight] = (process.argv.find(arg => arg.startsWith('--viewport='))?.split('=')[1] ?? '1280x720')
  .split('x').map(Number);
if (!(viewportWidth > 0 && viewportHeight > 0)) throw new Error('viewport must look like 3440x1440');
const FRAME_BUDGET_MS = 1000 / 144;
// The soak used to be a fixed 60 s iteration window; qualification needs a
// 10-minute movement/turn/return run, so the measured window is configurable.
const soakSeconds = Number(process.argv.find(arg => arg.startsWith('--soak-seconds='))?.split('=')[1] ?? 60);
if (!Number.isFinite(soakSeconds) || soakSeconds <= 0) throw new Error('soak-seconds must be a positive number');
// Cold measures first entry into a lazily initialized region; warm waits for it
// to be fully ready first. The old harness always awaited the jungle's initTask,
// so whether a capture was cold depended on whether the preload had already
// fired -- the one thing a cold-entry measurement must not leave implicit.
const cold = process.argv.includes('--cold');
const warm = process.argv.includes('--warm');
if (cold && warm) throw new Error('Choose either --cold or --warm');
const readiness = cold ? 'cold' : 'warm';
if (compareTrees && !gameplay) throw new Error('Tree traversal comparison requires --gameplay');
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
const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 });
// Keep a capture on one code revision if a build refreshes generated files.
await page.routeWebSocket('**/*', socket => {
  const server = socket.connectToServer();
  server.onMessage(message => {
    if (typeof message === 'string' && /"type":"(?:update|full-reload)"/.test(message)) return;
    socket.send(message);
  });
});
// Provenance: a capture is only comparable against another when the code, the
// renderer and the machine behind it are known, so record them beside the runs.
const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(); } catch { return null; }
};
const source = {
  commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain') || '',
  three: JSON.parse(readFileSync(new URL('../../node_modules/three/package.json', import.meta.url), 'utf8')).version,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};
source.dirtyFiles = source.dirty ? source.dirty.split('\n').length : 0;
const dirtyDiff = git('diff', 'HEAD', '--binary');
source.diffSha256 = dirtyDiff === null ? null : createHash('sha256').update(dirtyDiff).digest('hex');
source.threeBuildSha256 = createHash('sha256').update(readFileSync(new URL('../../node_modules/three/build/three.webgpu.js', import.meta.url))).digest('hex');
source.untracked = {};
for (const path of (git('ls-files', '-z', '--others', '--exclude-standard', 'src', 'scripts', 'public') ?? '').split('\0').filter(Boolean)) {
  source.untracked[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
}
const report = { label, port, soak, gameplay, readiness, replay, rendererRequest, cpuTrace, source,
  viewport: { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1 },
  startedAt: new Date().toISOString(), runs: [], errors: [] };
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
  await page.goto(`http://127.0.0.1:${port}/?profile=1&renderer=${rendererRequest}&character=drusniel`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  console.log(label, 'loading scene');
  loadingLog = setInterval(() => {
    page.locator('body').innerText({ timeout: 3000 }).then(text => console.log('LOADING', text.slice(-500))).catch(() => {});
  }, 15000);
  await page.waitForFunction(() => window.__grassDemo?.water?.uniforms?.clock.value > 0.2, null, { timeout: 180000 });
  clearInterval(loadingLog);
  await page.evaluate(async (mode) => {
    const d = window.__grassDemo;
    // A cold capture must reach the region with its initialization still ahead
    // of it, so record what was already pending instead of awaiting it.
    if (mode === 'warm') await d.coastalJungle?.initTask;
    window.__benchmarkReadiness = {
      mode,
      jungleInitStarted: Boolean(d.coastalJungle?.initTask),
      jungleReady: Boolean(d.coastalJungle?.ready),
    };
    d.audio.start = async () => {};
    d.ui.actions.setPixelRatio(1);
    d.__benchmarkPasses = new Map();
    const backend = d.world.renderer.backend;
    const createPipeline = backend.createRenderPipeline;
    backend.createRenderPipeline = function (renderObject, ...args) {
      if (d.profiler.recording && d.__benchmarkPipelines) {
        // Frame and pass identity: a pipeline built for a shadow or a nested
        // reflection pass is a different miss from one built for the scene pass,
        // and without the frame number a stall cannot be tied to its cause.
        // Three exposes no pass name here, so passes are told apart by the
        // identity of their render context rather than by a guessed label.
        const context = renderObject.context;
        let pass = null;
        if (context) {
          pass = d.__benchmarkPasses.get(context);
          if (pass === undefined) {
            pass = { id: d.__benchmarkPasses.size, width: context.width, height: context.height,
              depth: Boolean(context.depth), targets: context.textures?.length ?? 0 };
            d.__benchmarkPasses.set(context, pass);
          }
        }
        // renderer.info.render.frame does not advance on this backend, so the
        // profiler's own sample count is the frame clock: a pipeline built
        // during a recorded frame carries that frame's sample index.
        d.__benchmarkPipelines.push({ name: renderObject.object?.name,
          material: renderObject.material?.name, capacity: renderObject.object?.instanceMatrix?.count,
          sample: d.profiler.samples.length, pass,
          measured: performance.now() >= d.profiler.warmupUntil,
          preparation: Boolean(d.pipeline.warming) });
      }
      return createPipeline.call(this, renderObject, ...args);
    };
    const nodes = d.world.renderer._nodes;
    const build = nodes?._createNodeBuilder;
    if (build) nodes._createNodeBuilder = function (renderObject, ...args) {
      if (d.profiler.recording && d.__benchmarkNodeBuilds) {
        d.__benchmarkNodeBuilds.push({ name: renderObject.object?.name,
          sample: d.profiler.samples.length, measured: performance.now() >= d.profiler.warmupUntil,
          preparation: Boolean(d.pipeline.warming) });
      }
      return build.call(this, renderObject, ...args);
    };
  }, readiness);
  await page.waitForFunction(() => window.__grassDemo?.started, null, { timeout: 30000 });
  report.meta = await page.evaluate(() => window.__grassDemo.getProfileResults());
  report.pinned = await pinBrowserToCores(browser, resolvePinMask());
  if (report.meta.backend !== expectedBackend) throw new Error(`Expected ${expectedBackend}, received ${report.meta.backend}`);
  console.log(label, 'READY', JSON.stringify({ backend: report.meta.backend, quality: report.meta.quality, viewport: report.meta.viewport }));
  const scenarios = gameplay ? [{ id: 'sprint', x: -80, z: -80, radius: 80 },
    { id: 'jungleCoast', x: 840, z: 290, radius: 70 }]
    : soak ? [{ id: 'fastTurns', x: -160, z: -160, radius: 180 }] : [
    { id: 'forest', x: -320, z: 20, radius: 80 },
    { id: 'meadow', x: 0, z: -40, radius: 80 },
    { id: 'river', x: 100, z: -20, radius: 65 },
    { id: 'jungleCoast', x: 840, z: 290, radius: 70 },
    { id: 'snow', x: -125, z: -590, radius: 65 },
    // Houses, villagers and their LOD/shadow proxies; none of the routes above see them.
    { id: 'village', x: -212, z: -305, radius: 45 },
  ];
  if (onlyScenario && !scenarios.some(s => s.id === onlyScenario)) throw new Error(`Unknown scenario: ${onlyScenario}`);
  const cdp = await page.context().newCDPSession(page);
  for (const quality of onlyQuality ? [onlyQuality] : ['high', 'ultra']) {
    await page.evaluate(q => window.__grassDemo.ui.actions.setQuality(q), quality);
    for (const scenario of scenarios) {
      if (onlyScenario && scenario.id !== onlyScenario) continue;
      // --replay runs the identical route a second time in the same session.
      // First-use work tracks route coverage rather than time spent in a region,
      // so a second pass over the same ground is the only honest "warm", and the
      // pair is the decisive comparison: cold misses and their stalls must fall
      // away together on the replay.
      const passes = replay ? [0, 1] : [0];
      const captures = (gameplay ? (compareTrees ? [1] : [1, 10]) : soak ? [180] : [9, 180])
        .flatMap(speed => (compareTrees ? ['attached', 'detached', 'attached', 'detached'] : ['current'])
          .flatMap(treeTraversal => passes.map(routePass => ({ speed, treeTraversal, routePass }))));
      for (const [captureIndex, { speed, treeTraversal, routePass }] of captures.entries()) {
        if (compareTrees) await page.evaluate(mode => {
          const d = window.__grassDemo;
          if (!d.trees.lodRenderer) throw new Error('Traversal comparison requires replacement tree instances');
          for (const object of [...d.trees.trees.map(tree => tree.high), ...d.trees.billboardGroups]) {
            if (mode === 'attached') d.world.scene.add(object);
            else object.removeFromParent();
          }
        }, treeTraversal);
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
        const trace = cpuTrace && !soak && quality === 'high' && scenario.id === (onlyScenario ?? (gameplay ? 'sprint' : 'forest'))
          && speed === (gameplay ? 1 : 9);
        if (trace) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
        const run = await page.evaluate(async ({ scenario, speed, soak, soakSeconds, gameplay, readiness, budgetMs }) => {
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
          let totalElapsed = 0;
          let traveled = 0;
          let measurementStarted = false;
          const trajectory = [];
          const streamState = () => (d.world.terrainDeferredGroups ?? []).map(group => ({
            name: group.name, loaded: Boolean(group.loaded), loading: Boolean(group.loading), failed: Boolean(group.failed),
          }));
          let measurementStart;
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
          const resetRoute = () => {
            elapsed = 0; traveled = 0;
            d.player.horizontalVelocity?.set(0, 0, 0);
            d.player.verticalVelocity = 0;
            d.player.cameraYaw = 0;
            d.player.playerYaw = Math.PI;
            pose();
          };
          resetRoute();
          const targetSpeed = d.player.modelHeight * d.config.cinematic.motion.runSpeedInHeights;
          if (gameplay && (d.player.keys.has('KeyW') === false || !d.player.physics)) {
            throw new Error('Gameplay capture requires keyboard movement and physics');
          }
          d.player.update = delta => {
            totalElapsed += delta;
            if (!measurementStarted && performance.now() >= d.profiler.warmupUntil) {
              // Warmup must not move measurement to a different route segment.
              resetRoute();
              measurementStarted = true;
              d.profiler.startTimed({ warmupSeconds: 0, measureSeconds: soak ? soakSeconds : gameplay ? 15 : speed === 9 ? 4 : 8 });
              d.__benchmarkPipelines = [];
              d.__benchmarkNodeBuilds = [];
              measurementStart = { position: d.player.root.position.toArray(), camera: d.world.camera.position.toArray(),
                jungleReady: Boolean(d.coastalJungle?.ready), streams: streamState() };
            }
            elapsed += delta;
            if (!gameplay) { pose(); return; }
            d.player.cameraYaw = elapsed * targetSpeed / scenario.radius;
            const { x, z } = d.player.root.position;
            d.__benchmarkPlayerUpdate(delta);
            traveled += Math.hypot(d.player.root.position.x - x, d.player.root.position.z - z);
            if (measurementStarted) trajectory.push({ sample: d.profiler.samples.length, seconds: elapsed,
              position: d.player.root.position.toArray(), camera: d.world.camera.position.toArray() });
          };
          const memory = () => {
            const arrays = new Set();
            for (const tile of d.grass.tiles) for (const geometry of tile.cache.values()) {
              for (const attribute of Object.values(geometry.attributes)) arrays.add(attribute.array);
            }
            return { seconds: totalElapsed, grassBytes: [...arrays].reduce((sum, array) => sum + array.byteLength, 0),
              heapBytes: performance.memory?.usedJSHeapSize ?? null,
              geometries: d.world.renderer.info.memory.geometries,
              cachedGrassGeometries: d.grass.tiles.reduce((sum, tile) => sum + tile.cache.size, 0),
              tileCount: d.grass.tiles.length };
          };
          const memorySamples = [memory()];
          d.__benchmarkPipelines = [];
          d.__benchmarkNodeBuilds = [];
          let nextMemorySample = 5;
          // Cold measures from the first frame, with the region's initialization
          // and its first-use pipelines still ahead of it. Warm runs unrecorded
          // frames over the route, then resets the measured start position.
          // Duration alone does not establish readiness: retained misses and
          // trajectory samples show whether preparation was sufficient.
          const gameplayWarmup = readiness === 'warm' ? 45 : 0;
          d.profiler.startTimed({ warmupSeconds: soak ? 5 : gameplay ? gameplayWarmup : speed === 9 ? 0 : 1,
            measureSeconds: soak ? soakSeconds : gameplay ? 15 : speed === 9 ? 4 : 8 });
          await new Promise((resolve, reject) => {
            const deadline = performance.now() + (soak ? (soakSeconds + 60) * 1000 : (gameplayWarmup + 75) * 1000);
            const check = () => {
              if (totalElapsed >= nextMemorySample) {
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
            // Share of frames whose CPU work or GPU time alone misses 144 Hz.
            budget: {
              ms: budgetMs,
              cpuOver: d.profiler.samples.filter(s => s.processingMs > budgetMs).length / Math.max(1, d.profiler.samples.length),
              gpuOver: d.profiler.samples.filter(s => s.gpuTimestamp > budgetMs).length
                / Math.max(1, d.profiler.samples.filter(s => s.gpuTimestamp > 0).length),
            },
            memory: memory(), memorySamples,
            newPipelines: d.__benchmarkPipelines,
            newNodeBuilds: d.__benchmarkNodeBuilds,
            vegetationJobs: { ...d.vegetationJobs.stats },
            drawPreparation: d.pipeline.prepareStats ?? null,
            measurementStart, trajectory,
            // Averages hide the tail this plan is about, so keep every frame.
            frameSamples: d.profiler.samples.map((sample, index) => ({
              i: index,
              marks: sample.marks,
              intervalMs: sample.intervalMs, processingMs: sample.processingMs,
              compactionMs: sample.compactionMs ?? 0, biomeBookkeepingMs: sample.biomeBookkeepingMs ?? 0,
              colliders: sample.colliders ?? 0, drawCalls: sample.drawCalls,
              gpuPrograms: sample.gpuPrograms ?? 0, gpuPipelines: sample.gpuPipelines ?? 0,
            })),
            readiness: { ...(window.__benchmarkReadiness ?? {}),
              jungleReadyAtCapture: Boolean(d.coastalJungle?.ready),
              streams: streamState() },
            renderError: Boolean(d.renderErrorLogged) };
        }, { scenario, speed, soak, soakSeconds, gameplay, readiness, budgetMs: FRAME_BUDGET_MS });
        if (gameplay) {
          await page.keyboard.up('w');
          await page.keyboard.up('Shift');
          if (run.traveled < 10) throw new Error('The player did not move far enough to validate gameplay');
        }
        if (trace) {
          const { profile } = await cdp.send('Profiler.stop');
          const suffix = `-${quality}-${speed}-${routePass}-${captureIndex}-${treeTraversal}`;
          await writeFile(new URL(`${label}-${scenario.id}${suffix}.cpuprofile`, out), JSON.stringify(profile));
        }
        run.quality = quality;
        run.routePass = routePass;
        run.treeTraversal = treeTraversal;
        report.runs.push(run);
        await save();
        if (run.renderError || !run.frames) throw new Error('Movement capture failed to render valid frames');
        if (assertWarmedTrees && run.newPipelines.some(pipeline => /^tree\d+:/.test(pipeline.name))) {
          throw new Error('A prepared tree LOD compiled a new pipeline during character movement');
        }
        console.log(label, quality, scenario.id, speed, treeTraversal, JSON.stringify({ frames: run.frames,
          cpu: run.processing, interval: run.interval, gpu: run.gpuTimestamp, budget: run.budget, compaction: run.compactionMs,
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
