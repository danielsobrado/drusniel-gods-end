import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { probeWebGPU } from './gpu-support.mjs';

const DEFAULT_PORT = 4173;
const DEFAULT_TIMEOUT_MS = 120_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK_RESULT_GLOBALS = Object.freeze({
  'sea-check': '__seaCheck',
  'snow-effects-check': '__snowEffectsCheck',
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
    '--enable-features=Vulkan',
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

function startServer(port) {
  return spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
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
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  try {
    if (options.renderer === 'webgpu') {
      const support = await probeWebGPU(page, baseUrl, options.timeoutMs);
      if ((!support.api || !support.adapter) && options.allowUnsupported) {
        const reason = support.api ? 'no WebGPU adapter is available' : 'navigator.gpu is unavailable';
        return { check, status: 'unsupported', reason };
      }
      if (!support.api) throw new Error('WebGPU is unavailable in this browser');
      if (!support.adapter) throw new Error('No WebGPU adapter is available in this browser');
    }
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
    if (errors.length) throw new Error(errors.join('\n'));
    if (!result?.passed) throw new Error(result?.error ?? result?.failures?.join('\n') ?? 'GPU check failed');
    const expectedBackend = options.renderer === 'webgl' ? 'webgl2' : 'webgpu';
    if (result.backend !== expectedBackend) {
      throw new Error(`Expected ${expectedBackend}, got ${result.backend ?? 'unknown backend'}`);
    }
    return { check, status: 'passed', result };
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
    browser = await chromium.launch({ headless: true, args: chromiumArgs(options.renderer) });
    const results = [];
    for (const check of options.checks) {
      results.push(await runCheck(browser, baseUrl, check, options));
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
