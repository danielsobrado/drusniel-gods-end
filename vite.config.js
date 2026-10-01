import { rm } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';

// public/ also holds build inputs and references that the running app never
// loads; they stay in the repo (the asset scripts and tools/house-viewer read
// them through the dev server) but are dropped from the deployed build.
const DEV_ONLY_PUBLIC_PATHS = [
  // Scratch space for the vegetation LOD bakes, and local look references.
  'tmp',
  // Billboard sources baked into the fantasy tree GLBs (scripts/stylized-tree-textures.mjs).
  'Assets/terrain/fantasy-textures',
  // Look-review renders for the coastal jungle.
  'Assets/terrain/coastal-jungle/reference',
  // The original baked village houses, replaced by generated ones
  // (src/world/village); kept for tools/house-viewer and ?village=glb in dev.
  'Assets/terrain/structures/medieval',
  // Split-terrain outputs nothing places (scripts/split-terrain-glb.mjs).
  'Assets/terrain/structures/sketchfab-world.glb',
  'Assets/terrain/props/stone.glb',
];

function pruneDevOnlyPublicFiles() {
  let outDir = 'dist';
  return {
    name: 'prune-dev-only-public-files',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    async closeBundle() {
      await Promise.all(DEV_ONLY_PUBLIC_PATHS.map((entry) => rm(path.join(outDir, entry), { recursive: true, force: true })));
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    host: true,
  },
  build: {
    // Keep generated JS separate from public/Assets on case-insensitive filesystems.
    assetsDir: 'app-assets',
    target: 'es2022',
  },
  plugins: [pruneDevOnlyPublicFiles()],
});
