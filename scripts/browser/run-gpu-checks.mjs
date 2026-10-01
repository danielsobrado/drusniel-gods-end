import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { isWebGPUInfrastructureFailure, probeWebGPU } from './gpu-support.mjs';

const WINDOWS = process.platform === 'win32';
const DEFAULT_PORT = 4173;
const DEFAULT_TIMEOUT_MS = 120_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK_RESULT_GLOBALS = Object.freeze({
  'sea-check': '__seaCheck',
  'snow-effects-check': '__snowEffectsCheck',
  'tree-impostor-check': '__treeImpostorCheck',
  'draw-preparation-check': '__drawPreparationCheck',
});

function parseArgs(argv) {
  const options = {
    renderer: 'webgl',
    allowUnsupported: false,
    baseUrl: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    checks: [],
  };
  for (const arg of argv) {
    if (arg.startsWith('--renderer=')) options.renderer = arg.slice('--renderer='.length);
    else if (arg === '--allow-unsupported') options.allowUnsupported = true;
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else options.checks.push(arg);
  }
  if (!['webgl', 'webgpu'].includes(options.renderer)) throw new Error(`Unsupported renderer: ${options.renderer}`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeout must be a positive number');
  if (options.checks.length === 0) options.checks.push('sea-check');
  for (const check of options.checks) {
    if (!CHECK_RESULT_GLOBALS[check]) throw new Error(`Unknown GPU check: ${check}`);
  }
  return options;
}

function chromiumArgs(renderer) {
  if (renderer === 'webgl') {
    return [
      '--use-gl=angle',
      '--use-angle=swiftshader-webgl',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ];
  }
  return [
    '--enable-unsafe-webgpu',
    // Vulkan is how the Linux CI image reaches an adapter; the bundled Chromium
    // on Windows has no Vulkan path and it only makes requestAdapter resolve
    // empty. Windows gets WebGPU from the installed Chrome instead (launch()).
    ...(WINDOWS ? [] : ['--enable-features=Vulkan']),
    '--ignore-gpu-blocklist',
  ];
}

async function waitForServer(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not become ready at ${baseUrl}: ${lastError?.message ?? 'timeout'}`);
}

// On Windows the bundled Chromium has no working WebGPU device -- with ANGLE it
// hands out an adapter and then falls back to WebGL2 anyway -- while the
// installed Chrome runs WebGPU properly. Linux CI has no chrome channel, and a
// Windows box without Chrome still reports support honestly through the bundle.
async function launchBrowser(renderer) {
  const args = chromiumArgs(renderer);
  if (WINDOWS && renderer === 'webgpu') {
    try {
      return await chromium.launch({ headless: true, args, channel: 'chrome' });
    } catch {
      // No Chrome installed; fall through to the bundled browser.
    }
  }
  return chromium.launch({ headless: true, args });
}

function startServer(port) {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

function harnessUrl(baseUrl, check, renderer) {
  const url = new URL(`/scripts/gpu/${check}.html`, baseUrl);
  if (renderer === 'webgl') url.searchParams.set('renderer', 'webgl');
  return url.toString();
}

async function runCheck(browser, baseUrl, check, options) {
  const page = await browser.newPage();
  // These harness pages declare no icon, so Chrome asks for /favicon.ico and the
  // 404 lands in the console-error guard below as a spurious check failure.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  try {
    await page.goto(harnessUrl(baseUrl, check, options.renderer), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    const globalName = CHECK_RESULT_GLOBALS[check];
    const result = await page.evaluate(async ({ name, timeoutMs }) => {
      const resultPromise = window[name];
      if (!resultPromise) throw new Error(`Harness result global ${name} is missing`);
      return Promise.race([
        resultPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Harness result timed out')), timeoutMs)),
      ]);
    }, { name: globalName, timeoutMs: options.timeoutMs });

    const failure = errors.length
      ? errors.join('\n')
      : result?.passed
        ? null
        : result?.error ?? result?.failures?.join('\n') ?? 'GPU check failed';
    if (failure) {
      if (options.renderer === 'webgpu'
        && options.allowUnsupported
        && isWebGPUInfrastructureFailure(failure)) {
        return { check, status: 'unsupported', reason: failure };
      }
      throw new Error(failure);
    }

    const expectedBackend = options.renderer === 'webgl' ? 'webgl2' : 'webgpu';
    if (result.backend !== expectedBackend) {
      throw new Error(`Expected ${expectedBackend}, got ${result.backend ?? 'unknown backend'}`);
    }
    return { check, status: 'passed', result };
  } finally {
    await page.close();
  }
}

async function webGPUSupport(browser, baseUrl, options) {
  const page = await browser.newPage();
  try {
    return await probeWebGPU(page, baseUrl, options.timeoutMs);
  } finally {
    await page.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = DEFAULT_PORT;
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${port}`;
  const server = options.baseUrl ? null : startServer(port);
  if (server) {
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }

  let browser;
  try {
    if (server) await waitForServer(baseUrl, options.timeoutMs);
    const results = [];

    if (options.renderer === 'webgpu') {
      // Three r186 performs real asynchronous WebGPU device teardown. Isolate each
      // contract in its own Chromium process so disposing one device cannot poison
      // Dawn's external instance for the following independent fixture.
      for (const check of options.checks) {
        browser = await launchBrowser(options.renderer);
        try {
          const support = await webGPUSupport(browser, baseUrl, options);
          if (!support.api || !support.adapter || !support.device) {
            if (!options.allowUnsupported) {
              throw new Error(support.reason ?? 'WebGPU device is unavailable in this browser');
            }
            results.push({
              check,
              status: 'unsupported',
              reason: support.reason ?? 'WebGPU device is unavailable in this browser',
            });
            continue;
          }
          results.push(await runCheck(browser, baseUrl, check, options));
        } finally {
          await browser.close();
          browser = null;
        }
      }
    } else {
      browser = await launchBrowser(options.renderer);
      for (const check of options.checks) {
        results.push(await runCheck(browser, baseUrl, check, options));
      }
    }

    console.log(JSON.stringify({ renderer: options.renderer, results }, null, 2));
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
