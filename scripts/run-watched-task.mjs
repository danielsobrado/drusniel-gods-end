// Run Node tools without a shell or a status-polling loop. Completion is emitted
// once the child has closed and both logs have been flushed to disk.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

export async function runWatchedTask({ label, args, cwd = process.cwd(), outputRoot,
  timeoutMs = 600_000, signal } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(label ?? '')) throw new Error('Use an alphanumeric task label.');
  if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) {
    throw new Error('Supply Node arguments after --.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.');
  signal?.throwIfAborted();
  const root = resolve(outputRoot ?? join(cwd, '.cache', 'task-runs'));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, `${label}-`));
  const stdoutPath = join(directory, 'stdout.log');
  const stderrPath = join(directory, 'stderr.log');
  const resultPath = join(directory, 'result.json');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let failure;
  let timedOut = false;
  let cancelled = false;
  // Subscribe immediately: spawn failures also produce a close event.
  const closed = new Promise(resolveClosed => {
    child.once('error', error => { failure = error.message; });
    child.once('close', (exitCode, exitSignal) => resolveClosed({ exitCode, exitSignal }));
  });
  const logs = Promise.allSettled([
    pipeline(child.stdout, createWriteStream(stdoutPath)),
    pipeline(child.stderr, createWriteStream(stderrPath)),
  ]);
  const cancel = () => { cancelled = true; child.kill('SIGKILL'); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  let status;
  try {
    status = await closed;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
  for (const result of await logs) {
    if (result.status === 'rejected') failure ??= result.reason.message;
  }
  const result = { event: 'task-completed', label,
    status: timedOut ? 'timed-out' : cancelled ? 'cancelled'
      : !failure && status.exitCode === 0 ? 'passed' : 'failed',
    ...status, error: failure ?? null, startedAt, completedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    command: [process.execPath, ...args], cwd, stdoutPath, stderrPath, resultPath };
  const temporaryPath = join(directory, 'result.pending.json');
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporaryPath, resultPath);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [label, ...options] = process.argv.slice(2);
  const separator = options.indexOf('--');
  const timeoutOption = options.slice(0, separator).find(arg => arg.startsWith('--timeout-ms='));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (separator < 0 || options.slice(0, separator).some(arg => arg !== timeoutOption)) {
      throw new Error('Usage: node scripts/run-watched-task.mjs LABEL [--timeout-ms=600000] -- NODE_ARGS');
    }
    const result = await runWatchedTask({ label, args: options.slice(separator + 1),
      timeoutMs: timeoutOption ? Number(timeoutOption.split('=')[1]) : undefined,
      signal: controller.signal });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'passed' ? 0 : result.exitCode || 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
