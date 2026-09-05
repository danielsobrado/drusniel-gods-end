#!/usr/bin/env node
// Prints the effective merged configuration.
//
// Configuration is deep-merged from the runtime YAML file list. Use this
// command instead of reproducing the merge order in documentation or tooling.
//
//   npm run config:dump                 whole merged config as YAML
//   npm run config:dump -- --json       whole merged config as JSON
//   npm run config:dump -- player       one subtree, by dotted path
import yaml from 'js-yaml';
import { loadMergedConfig, resolvePath } from './mergedConfig.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dottedPath = args.find((argument) => !argument.startsWith('--'));

const config = await loadMergedConfig();

let value = config;
if (dottedPath) {
  const resolved = resolvePath(config, dottedPath);
  if (!resolved.found) {
    console.error(`No such config path: ${dottedPath}`);
    process.exit(1);
  }
  value = resolved.value;
}

process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : yaml.dump(value, { lineWidth: 100 }));
