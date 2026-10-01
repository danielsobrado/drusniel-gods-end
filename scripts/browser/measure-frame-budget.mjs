// Frame-budget capture at fixed poses, at the resolution the game is played at.
// The 144 Hz target leaves 6.94 ms for the CPU and for the GPU, and GPU cost
// scales with pixels, so the default viewport is the user's 3440x1440 display.
//
//   node measure-frame-budget.mjs <label> [port] [--viewport=3440x1440]
//     [--pose=meadow,forest] [--seconds=3] [--turn] [--passes] [--categories]
//     [--no-pin | --pin=0xFFFF]
//
// Always compare two labels captured in the same session state: frame times
// vary up to 2x between runs, while draws, uploads and traversals do not.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { pinBrowserToCores, resolvePinMask } from './pinPerformanceCores.mjs';

const label = process.argv[2] ?? 'current';
const port = Number(process.argv[3] ?? 5173);
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
const [width, height] = (option('viewport') ?? '3440x1440').split('x').map(Number);
const seconds = Number(option('seconds') ?? 3);
const turn = process.argv.includes('--turn');
const passes = process.argv.includes('--passes');
const categories = process.argv.includes('--categories');
const pinMask = resolvePinMask();
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Use a simple alphanumeric report label');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
if (!(width > 0 && height > 0)) throw new Error('viewport must look like 3440x1440');
if (!(seconds > 0)) throw new Error('seconds must be positive');

const BUDGET_MS = 1000 / 144;
// Heading chosen per pose so the heavy content is in view: the meadow's forest
// edge, a canopy, the village square and the jungle coast.
const POSES = {
  meadow: { x: 2, z: -5, yaw: 2.2 },
  meadowOpen: { x: 2, z: -5, yaw: 5.2 },
  forest: { x: -320, z: 20, yaw: 0.6 },
  forestBack: { x: -320, z: 20, yaw: 3.8 },
  village: { x: -212, z: -305, yaw: 1 },
  jungle: { x: 840, z: 290, yaw: 1.6 },
};
const poseIds = option('pose')?.split(',') ?? Object.keys(POSES);
for (const id of poseIds) if (!POSES[id]) throw new Error(`Unknown pose: ${id}`);

const out = new URL('../../.cache/frame-budget/', import.meta.url);
await mkdir(out, { recursive: true });
const report = { label, port, viewport: { width, height }, seconds, turn, budgetMs: BUDGET_MS,
  startedAt: new Date().toISOString(), poses: [], errors: [] };
const save = () => writeFile(new URL(`${label}.json`, out), JSON.stringify(report, null, 2));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
  '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  // Keep the capture on one code revision if a save triggers HMR.
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      if (typeof message === 'string' && /"type":"(?:update|full-reload)"/.test(message)) return;
      socket.send(message);
    });
  });
  page.on('pageerror', error => { report.errors.push(error.message); console.log('PAGE ERROR', error.message); });
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push(message.text().slice(0, 300));
  });
  await page.goto(`http://127.0.0.1:${port}/?profile=1&renderer=webgpu&character=serpent`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  console.log(label, 'loading scene');
  await page.waitForFunction(() => window.__grassDemo?.started, null, { timeout: 240000 });
  await page.evaluate(() => {
    const d = window.__grassDemo;
    d.audio.start = async () => {};
    d.loading?.dispose?.();
    d.ui.actions.setPixelRatio(1);
    d.tour.stop();
    d.player.setEnabled(true);
  });
  await page.keyboard.press('h');
  report.pinned = await pinBrowserToCores(browser, pinMask);
  if (report.pinned) console.log(label, 'pinned', report.pinned.processes, 'browser processes to', pinMask);

  for (const id of poseIds) {
    const pose = POSES[id];
    const result = await page.evaluate(async ({ pose, seconds, turn, passes, categories, budget }) => {
      const d = window.__grassDemo;
      const scene = d.world.scene;
      const backend = d.world.renderer.backend;
      const queue = backend.device.queue;
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const place = () => {
        const ground = d.world.terrainSampler.sampleHeight(pose.x, pose.z);
        const { rootToFeet, groundOffset } = d.player.metrics;
        d.player.setPosition(pose.x, ground + rootToFeet + groundOffset, pose.z);
        d.player.cameraYaw = pose.yaw;
      };
      place();
      // Streamed terrain and the jungle load on approach; wait them out so the
      // capture measures the settled region, not its first-use work.
      const deadline = performance.now() + 90000;
      while (performance.now() < deadline) {
        const streaming = (d.world.terrainDeferredGroups ?? []).some(group => group.loading);
        const jungle = d.coastalJungle?.initTask && !d.coastalJungle.ready;
        if (!streaming && !jungle) break;
        await wait(250);
      }
      place();
      await wait(2500);
      const update = d.player.update;
      if (turn) d.player.update = function (delta) { d.player.cameraYaw += delta * 0.5; return update.call(this, delta); };
      try {
        // Structural counters: cheap to collect and reproducible run to run.
        let writes = 0, bytes = 0, traversals = 0, traversalMs = 0, counted = 0;
        const writeBuffer = queue.writeBuffer;
        queue.writeBuffer = function (...args) {
          writes += 1;
          bytes += args[4] ?? args[2]?.byteLength ?? 0;
          return writeBuffer.apply(this, args);
        };
        const updateMatrixWorld = scene.updateMatrixWorld;
        scene.updateMatrixWorld = function (force) {
          const started = performance.now();
          traversals += 1;
          try { return updateMatrixWorld.call(this, force); } finally { traversalMs += performance.now() - started; }
        };
        for (; counted < 60; counted += 1) await frame();
        queue.writeBuffer = writeBuffer;
        scene.updateMatrixWorld = updateMatrixWorld;

        d.profiler.startTimed({ warmupSeconds: 1, measureSeconds: seconds });
        while (!d.profiler.done) await frame();
        const summary = d.profiler.summarize();
        const samples = d.profiler.samples;
        const gpu = samples.map(sample => sample.gpuTimestamp).filter(value => value > 0);
        const round = value => Math.round(value * 100) / 100;
        const stats = values => {
          const sorted = [...values].sort((a, b) => a - b);
          const at = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
          return { median: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1) ?? 0),
            overBudget: round(sorted.filter(value => value > budget).length / Math.max(1, sorted.length)) };
        };
        const marks = Object.entries(summary.subsystems)
          .map(([name, value]) => ({ name, median: round(value.median), p99: round(value.p99), max: round(value.max) }))
          .filter(mark => mark.median >= 0.1 || mark.max >= 2)
          .sort((a, b) => b.median - a.median);
        const result = {
          frames: samples.length, cpu: stats(samples.map(sample => sample.processingMs)), gpu: stats(gpu),
          drawCalls: summary.drawCalls.median, triangles: summary.triangles.median,
          perFrame: { writeBuffer: round(writes / counted), uploadKiB: round(bytes / counted / 1024),
            matrixTraversals: round(traversals / counted), matrixTraversalMs: round(traversalMs / counted) },
          marks,
        };

        if (passes) {
          // Per render pass: CPU spent between its begin and finish (nested
          // passes excluded), GPU from the timestamp pool, and its draws.
          const buckets = new Map();
          const bucket = context => {
            let entry = buckets.get(context.id);
            if (!entry) {
              entry = { label: `${context.width}x${context.height} s${context.sampleCount ?? 1}${context.depth ? ' depth' : ''}`,
                cpu: 0, gpu: 0, draws: 0, names: new Map() };
              buckets.set(context.id, entry);
            }
            return entry;
          };
          const stack = [];
          const { beginRender, finishRender, draw } = backend;
          backend.beginRender = function (context) {
            const now = performance.now();
            if (stack.length) stack.at(-1).self += now - stack.at(-1).since;
            stack.push({ since: now, self: 0 });
            return beginRender.call(this, context);
          };
          backend.finishRender = function (context) {
            const value = finishRender.call(this, context);
            const now = performance.now();
            const entry = stack.pop();
            bucket(context).cpu += entry.self + now - entry.since;
            if (stack.length) stack.at(-1).since = now;
            return value;
          };
          backend.draw = function (renderObject, info) {
            const entry = bucket(renderObject.context);
            entry.draws += 1;
            const name = (renderObject.object?.name || renderObject.object?.type || '?').slice(0, 32);
            entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
            return draw.call(this, renderObject, info);
          };
          const pool = backend.timestampQueryPool?.render;
          let seen = null, frames = 0;
          const end = performance.now() + seconds * 1000;
          try {
            while (performance.now() < end) {
              await frame();
              frames += 1;
              // Each resolve holds every frame since the previous one, so the
              // GPU sum is divided by frames rendered, not by resolves.
              if (!pool || pool.frames === seen) continue;
              seen = pool.frames;
              for (const [uid, ms] of pool.timestamps) {
                const match = /^r:\d+:(\d+):f/.exec(uid);
                const entry = match && buckets.get(Number(match[1]));
                if (entry) entry.gpu += ms;
              }
            }
          } finally {
            Object.assign(backend, { beginRender, finishRender, draw });
          }
          const merged = new Map();
          for (const entry of buckets.values()) {
            const row = merged.get(entry.label) ?? { label: entry.label, contexts: 0, cpu: 0, gpu: 0, draws: 0, names: new Map() };
            row.contexts += 1; row.cpu += entry.cpu; row.gpu += entry.gpu; row.draws += entry.draws;
            for (const [name, count] of entry.names) row.names.set(name, (row.names.get(name) ?? 0) + count);
            merged.set(entry.label, row);
          }
          result.passes = [...merged.values()].map(row => ({ label: row.label, contexts: row.contexts,
            cpu: round(row.cpu / frames), gpu: round(row.gpu / frames), draws: round(row.draws / frames),
            top: [...row.names].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name}:${round(count / frames)}`) }))
            .sort((a, b) => b.gpu + b.cpu - a.gpu - a.cpu);
        }

        if (categories) {
          // GPU cost of each kind of main-pass draw, by skipping its draws.
          const { draw } = backend;
          const prefix = object => {
            const name = object?.name || object?.parent?.name || object?.type || '?';
            return name.split(/[ _:\-0-9]/)[0] || name;
          };
          let skip = null;
          const seen = new Map();
          backend.draw = function (renderObject, info) {
            if (renderObject.context?.sampleCount > 1) {
              const key = prefix(renderObject.object);
              seen.set(key, (seen.get(key) ?? 0) + 1);
              if (skip && (skip === '*' || skip === key)) return undefined;
            }
            return draw.call(this, renderObject, info);
          };
          const gpuMedian = async () => {
            d.profiler.startTimed({ warmupSeconds: 0.7, measureSeconds: Math.min(seconds, 2.5) });
            while (!d.profiler.done) await frame();
            return round(d.profiler.summarize().gpuTimestamp?.median ?? 0);
          };
          try {
            const base = await gpuMedian();
            const keys = [...seen].sort((a, b) => b[1] - a[1]).map(([key]) => key).slice(0, 12);
            result.categories = { base, skipped: {} };
            for (const key of [...keys, '*']) {
              skip = key;
              result.categories.skipped[key === '*' ? 'ALL' : key] = round(base - await gpuMedian());
            }
          } finally {
            backend.draw = draw;
          }
        }
        return result;
      } finally {
        d.player.update = update;
      }
    }, { pose, seconds, turn, passes, categories, budget: BUDGET_MS });
    report.poses.push({ id, pose, ...result });
    await save();
    const { cpu, gpu, perFrame } = result;
    console.log(`${id.padEnd(10)} cpu ${cpu.median}/${cpu.p99}/${cpu.max} (${Math.round(cpu.overBudget * 100)}% >6.94)`
      + `  gpu ${gpu.median}/${gpu.p99}/${gpu.max} (${Math.round(gpu.overBudget * 100)}% >6.94)`
      + `  draws ${result.drawCalls}  writes ${perFrame.writeBuffer} (${perFrame.uploadKiB} KiB)`
      + `  traversals ${perFrame.matrixTraversals} (${perFrame.matrixTraversalMs} ms)`);
    console.log(`           marks ${result.marks.slice(0, 8).map(mark => `${mark.name}:${mark.median}/${mark.max}`).join(' ')}`);
    for (const row of result.passes ?? []) {
      console.log(`           pass ${row.label.padEnd(22)} x${row.contexts} draws ${row.draws} cpu ${row.cpu} gpu ${row.gpu} | ${row.top.join(', ')}`);
    }
    if (result.categories) {
      console.log(`           gpu saved by skipping (base ${result.categories.base}): ${Object.entries(result.categories.skipped)
        .map(([key, value]) => `${key}:${value}`).join(' ')}`);
    }
  }
  if (report.errors.length) console.log(`Browser emitted ${report.errors.length} errors`);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await save();
  await browser.close();
}
