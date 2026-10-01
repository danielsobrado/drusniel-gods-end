import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A regenerated GLB re-embeds the textures it shares with others; the check
// mode of scripts/share-glb-textures.mjs fails until they are shared again.
test('no texture image is embedded in more than one GLB', () => {
  assert.doesNotThrow(
    () => execFileSync(process.execPath, [path.join(ROOT, 'scripts/share-glb-textures.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' }),
    'run npm run assets:share-textures',
  );
});
