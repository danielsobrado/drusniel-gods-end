#!/usr/bin/env node
// Verifies that values asserted in docs/ match the effective merged configuration.
//
// A one-time manual correction of this drift has already been tried and already
// failed (docs/camera-system.md records a fix that never propagated to the three
// other files asserting the same value), so the check is mechanical.
//
// Assertions are OPT-IN. Many fenced blocks in docs/ are legitimately not
// effective config -- recovered-original values, deliberate pre-merge values,
// code constants, illustrative snippets -- and auto-checking every yaml block
// produces noise. A noisy check gets switched off.
//
// Two forms:
//
//   <!-- effective-config: player -->
//   ```yaml
//   modelOffsetY: -2.2
//   ```
//
//   <!-- effective: terrain.targetMeshName = Landscape002 -->
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadMergedConfig, resolvePath } from './mergedConfig.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

// The path is optional. Omit it when the yaml block is already rooted at the
// config root (i.e. it starts with `camera:` / `player:`); supply it when the
// block lists bare leaf keys (`walkSpeed:`) that need a prefix.
const BLOCK_ANNOTATION = /^<!--\s*effective-config(?::\s*([A-Za-z0-9_.[\]]+))?\s*-->$/;
const SCALAR_ANNOTATION = /^<!--\s*effective:\s*([A-Za-z0-9_.[\]]+)\s*=\s*(.+?)\s*-->$/;
const FENCE = /^```/;

async function markdownFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(entryPath));
    else if (entry.name.endsWith('.md')) found.push(entryPath);
  }
  return found.sort();
}

// Compares a documented leaf against the effective value. Numbers are compared
// numerically so 45 and 45.0 agree; everything else compares as a trimmed string
// so YAML quoting differences do not produce false failures.
function valuesAgree(documented, effective) {
  if (typeof documented === 'number' || typeof effective === 'number') {
    return Number(documented) === Number(effective);
  }
  if (Array.isArray(documented) && Array.isArray(effective)) {
    return documented.length === effective.length
      && documented.every((item, index) => valuesAgree(item, effective[index]));
  }
  if (documented === null || effective === null) return documented === effective;
  if (typeof documented === 'object' || typeof effective === 'object') {
    return JSON.stringify(documented) === JSON.stringify(effective);
  }
  return String(documented).trim() === String(effective).trim();
}

function format(value) {
  if (value === undefined) return '(absent from merged config)';
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) return JSON.stringify(value);
  return String(value);
}

// Walks a documented object, yielding one leaf assertion per scalar/array found,
// so a block asserting five keys reports five independent failures rather than one.
function* leaves(documented, prefix) {
  if (documented === null || typeof documented !== 'object' || Array.isArray(documented)) {
    yield [prefix, documented];
    return;
  }
  for (const [key, value] of Object.entries(documented)) {
    yield* leaves(value, prefix ? `${prefix}.${key}` : key);
  }
}

function collectAssertions(source) {
  const lines = source.split(/\r?\n/);
  const assertions = [];

  let insideFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    // Annotations shown as examples inside a fenced block are documentation of
    // the syntax, not live assertions.
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const scalar = SCALAR_ANNOTATION.exec(line);
    if (scalar) {
      assertions.push({ line: index + 1, dottedPath: scalar[1], raw: scalar[2] });
      continue;
    }

    const block = BLOCK_ANNOTATION.exec(line);
    if (!block) continue;

    // Find the fenced block that follows, allowing blank lines between.
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    if (cursor >= lines.length || !FENCE.test(lines[cursor].trim())) {
      assertions.push({ line: index + 1, error: 'annotation is not followed by a fenced block' });
      continue;
    }

    const start = cursor + 1;
    let end = start;
    while (end < lines.length && !FENCE.test(lines[end].trim())) end += 1;

    let parsed;
    try {
      parsed = yaml.load(lines.slice(start, end).join('\n'));
    } catch (error) {
      assertions.push({ line: cursor + 1, error: `block is not valid YAML: ${error.message}` });
      index = end;
      continue;
    }

    if (parsed === null || typeof parsed !== 'object') {
      assertions.push({ line: cursor + 1, error: 'block does not parse to an object' });
      index = end;
      continue;
    }

    for (const [leafPath, value] of leaves(parsed, '')) {
      assertions.push({
        line: start + 1,
        dottedPath: block[1] ? `${block[1]}.${leafPath}` : leafPath,
        value,
      });
    }
    index = end;
  }

  return assertions;
}

const config = await loadMergedConfig();
const failures = [];
let checked = 0;
let annotatedFiles = 0;

for (const file of await markdownFiles(DOCS)) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  const assertions = collectAssertions(await readFile(file, 'utf8'));
  if (assertions.length > 0) annotatedFiles += 1;

  for (const assertion of assertions) {
    if (assertion.error) {
      failures.push(`${relative}:${assertion.line}  ${assertion.error}`);
      continue;
    }

    checked += 1;
    const resolved = resolvePath(config, assertion.dottedPath);
    const documented = 'raw' in assertion ? assertion.raw : assertion.value;

    if (!resolved.found) {
      failures.push(
        `${relative}:${assertion.line}  ${assertion.dottedPath}: `
        + `doc says ${format(documented)}, but the key is absent from the merged config`,
      );
      continue;
    }

    if (!valuesAgree(documented, resolved.value)) {
      failures.push(
        `${relative}:${assertion.line}  ${assertion.dottedPath}: `
        + `doc says ${format(documented)}, effective is ${format(resolved.value)}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\nDocumentation disagrees with the effective merged configuration:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`\n${failures.length} mismatch(es) across ${checked} checked assertion(s).`);
  console.error(`Run \`npm run config:dump\` to see the effective values.\n`);
  process.exit(1);
}

console.log(`check:docs  ${checked} assertion(s) across ${annotatedFiles} file(s) match the merged config.`);
