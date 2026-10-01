import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pinBrowserToCores, resolvePinMask } from './pinPerformanceCores.mjs';

// Startup timing: each sample is a first visit in a fresh browser context
// followed by a repeat navigation in that same context (HTTP cache warm, app
// state rebuilt). Serve a VITE_BENCHMARK=1 production build, e.g.
//   VITE_BENCHMARK=1 npx vite build --outDir dist-bench
//   npx vite preview --outDir dist-bench --host 127.0.0.1 --port 4173 --strictPort
//   node scripts/browser/measure-loading.mjs baseline --url=http://127.0.0.1:4173/ --pairs=3
// Every span comes from the app's LoadingProfiler (?profile=1). Spans overlap,
// so they are reported individually; "ready" is scene readiness (warmup done)
// and "interactive" is after the entry presentation.
//
// A plain context is incognito: its HTTP cache lives in memory and drops large
// files, and there is no on-disk GPU shader cache, so its repeat visit is not
// what a returning player sees. --persistent gives each pair a fresh on-disk
// profile instead (first visit cold, repeat visit with disk caches).
const label = process.argv[2] ?? 'current';
const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const url = arg('url', 'http://127.0.0.1:4173/');
const pairs = Number(arg('pairs', 3));
const renderer = arg('renderer', 'webgpu');
const quality = arg('quality', null);
const network = arg('network', 'local');
const cacheDisabled = process.argv.includes('--cache-disabled');
const persistent = process.argv.includes('--persistent');
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Use a simple alphanumeric report label');
if (!['webgpu', 'webgl'].includes(renderer)) throw new Error('renderer must be webgpu or webgl');
const NETWORKS = {
  local: null,
  // 50 Mbps down, 10 Mbps up, 40 ms latency (the plan's constrained profile).
  constrained: { latency: 40, downloadThroughput: 50e6 / 8, uploadThroughput: 10e6 / 8 },
  stress: { latency: 150, downloadThroughput: 10e6 / 8, uploadThroughput: 5e6 / 8 },
};
if (!(network in NETWORKS)) throw new Error(`network must be one of ${Object.keys(NETWORKS).join(', ')}`);

const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return null; }
};
const out = new URL('../../.cache/loading/', import.meta.url);
await mkdir(out, { recursive: true });

const launchArgs = [
  '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
const contextOptions = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
const browser = persistent ? null : await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });

const query = new URLSearchParams({ profile: '1', character: 'drusniel', renderer });
if (quality) query.set('quality', quality);
const target = `${url}${url.includes('?') ? '&' : '?'}${query}`;

async function visit(page) {
  const errors = [], failed = [];
  const onError = (error) => errors.push(error.message);
  const onConsole = (message) => { if (message.type() === 'error') errors.push(message.text()); };
  const onFailed = (request) => failed.push({ url: request.url(), error: request.failure()?.errorText });
  const onResponse = (response) => { if (response.status() >= 400) failed.push({ url: response.url(), status: response.status() }); };
  page.on('pageerror', onError); page.on('console', onConsole);
  page.on('requestfailed', onFailed); page.on('response', onResponse);
  const started = Date.now();
  await page.goto(target, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__grassDemo?.started === true, null, { timeout: 300000, polling: 100 });
  const wallMs = Date.now() - started;
  const result = await page.evaluate(() => {
    const demo = window.__grassDemo;
    const profile = demo.getProfileResults();
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name.replace(window.location.origin, ''), start: entry.startTime, duration: entry.duration,
      transfer: entry.transferSize, encoded: entry.encodedBodySize, decoded: entry.decodedBodySize,
    }));
    return {
      backend: profile.backend, quality: profile.quality,
      loading: profile.loading, warmup: profile.warmup,
      longTasks: window.__longTasks ?? [],
      resources,
      navigation: performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null,
      memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize } : null,
    };
  });
  page.off('pageerror', onError); page.off('console', onConsole);
  page.off('requestfailed', onFailed); page.off('response', onResponse);
  return { wallMs, errors, failed, ...result };
}

function summarize(run) {
  const marks = Object.fromEntries((run.loading?.marks ?? []).map((mark) => [mark.name, mark.time]));
  const spans = {};
  for (const span of run.loading?.spans ?? []) {
    const key = span.detail ? `${span.name}:${span.detail.split('/').pop()}` : span.name;
    spans[key] = Math.round(span.ms ?? -1);
  }
  const byName = new Map();
  for (const resource of run.resources) byName.set(resource.name, (byName.get(resource.name) ?? 0) + 1);
  const duplicates = [...byName].filter(([, count]) => count > 1).map(([name, count]) => ({ name, count }));
  const transfer = run.resources.reduce((sum, r) => sum + (r.transfer || 0), 0);
  const longTaskMs = run.longTasks.reduce((sum, task) => sum + task.duration, 0);
  return {
    backend: run.backend, quality: run.quality, wallMs: run.wallMs,
    readyMs: Math.round(marks.ready ?? NaN), interactiveMs: Math.round(marks.interactive ?? NaN),
    requests: run.resources.length, transferMB: +(transfer / 1048576).toFixed(2),
    longTasks: run.longTasks.length, longTaskMs: Math.round(longTaskMs),
    duplicates, spans, errors: run.errors.length, failed: run.failed.length,
  };
}

const report = { label, url, renderer, quality, network, cacheDisabled, persistent, pairs, date: new Date().toISOString(),
  source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '').split('\n').filter(Boolean).length },
  samples: [] };
try {
  for (let pair = 0; pair < pairs; pair += 1) {
    const profileDir = persistent ? await mkdtemp(path.join(tmpdir(), 'grass-loading-')) : null;
    const context = persistent
      ? await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: true, args: launchArgs, ...contextOptions })
      : await browser.newContext(contextOptions);
    await context.addInitScript(() => {
      window.__longTasks = [];
      try {
        new window.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: 'longtask', buffered: true });
      } catch { /* longtask unsupported */ }
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    if (cacheDisabled) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (NETWORKS[network]) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETWORKS[network] });
    // Each context brings new renderer processes, so pin every pair. A
    // persistent context exposes no Browser to list them, so it runs unpinned.
    const pinTarget = context.browser() ?? browser;
    report.pinned = pinTarget ? await pinBrowserToCores(pinTarget, resolvePinMask()) : null;
    const sample = { pair };
    for (const kind of ['first', 'repeat']) {
      const run = await visit(page);
      sample[kind] = { summary: summarize(run), raw: run };
      const s = sample[kind].summary;
      console.log(`[${label}] pair ${pair} ${kind}: ready ${s.readyMs} ms, interactive ${s.interactiveMs} ms, `
        + `${s.requests} requests, ${s.transferMB} MB, long tasks ${s.longTaskMs} ms, errors ${s.errors}, failed ${s.failed}`);
    }
    report.samples.push(sample);
    await context.close();
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
} finally {
  await browser?.close();
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
report.medians = {};
for (const kind of ['first', 'repeat']) {
  const summaries = report.samples.map((sample) => sample[kind].summary);
  const spanNames = [...new Set(summaries.flatMap((s) => Object.keys(s.spans)))];
  report.medians[kind] = {
    readyMs: median(summaries.map((s) => s.readyMs)),
    interactiveMs: median(summaries.map((s) => s.interactiveMs)),
    transferMB: median(summaries.map((s) => s.transferMB)),
    requests: median(summaries.map((s) => s.requests)),
    longTaskMs: median(summaries.map((s) => s.longTaskMs)),
    spans: Object.fromEntries(spanNames.map((name) => [name, median(summaries.map((s) => s.spans[name]))])),
  };
}
await writeFile(new URL(`${label}.json`, out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.medians, null, 2));
