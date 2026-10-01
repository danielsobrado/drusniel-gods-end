import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runWatchedTask } from '../scripts/run-watched-task.mjs';

async function workspace(t) {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(join(base, 'grass task watcher '));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${base}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return { cwd: directory, outputRoot: directory };
}

test('completion waits for stdout/stderr flush and preserves literal arguments', async t => {
  const options = await workspace(t);
  const literal = 'spaces & $(unchanged) `literal`';
  const result = await runWatchedTask({ ...options, label: 'success', args: ['-e',
    'process.stdout.write(process.argv[1]); process.stderr.write("x".repeat(200000));', literal] });
  assert.equal(result.status, 'passed');
  assert.equal(await readFile(result.stdoutPath, 'utf8'), literal);
  assert.equal((await readFile(result.stderrPath, 'utf8')).length, 200000);
  assert.deepEqual(JSON.parse(await readFile(result.resultPath, 'utf8')), result);
});

test('a failing task retains its actual exit code and failure output', async t => {
  const options = await workspace(t);
  const result = await runWatchedTask({ ...options, label: 'failure', args: ['-e',
    'console.error("expected failure"); process.exitCode = 7;'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.match(await readFile(result.stderrPath, 'utf8'), /expected failure/);
});

test('spawn failure still completes with a persisted failure result', async t => {
  const options = await workspace(t);
  const result = await runWatchedTask({ ...options, cwd: join(options.cwd, 'missing'),
    label: 'spawn-failure', args: ['--version'] });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /ENOENT/);
  assert.equal(JSON.parse(await readFile(result.resultPath, 'utf8')).status, 'failed');
});

test('a hung direct child times out instead of being reported as successful', async t => {
  const options = await workspace(t);
  const result = await runWatchedTask({ ...options, label: 'timeout', timeoutMs: 250,
    args: ['-e', 'setTimeout(() => {}, 60000);'] });
  assert.equal(result.status, 'timed-out');
  assert.notEqual(result.exitCode, 0);
});

test('abort completes an active task once and distinguishes cancellation', async t => {
  const options = await workspace(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  try {
    const result = await runWatchedTask({ ...options, label: 'cancel', signal: controller.signal,
      args: ['-e', 'setTimeout(() => {}, 60000);'] });
    assert.equal(result.status, 'cancelled');
    assert.equal(JSON.parse(await readFile(result.resultPath, 'utf8')).status, 'cancelled');
  } finally { clearTimeout(timeout); }
});
