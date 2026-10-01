import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Confirms, in the browser, that the build-time scene preprocessing
// (scripts/bake-scene-preprocessing.mjs) is used and matches the runtime: every
// house and NPC stage the app holds must equal, index for index, what the
// runtime simplifier produces from the geometry the browser decoded, and the
// simplifier module must never have been fetched. Needs the Vite dev server:
//   npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
//   node scripts/browser/check-scene-preprocessing.mjs [--url=http://127.0.0.1:5173/]
const url = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}?character=drusniel`);
  await page.waitForFunction(() => window.__grassDemo?.started === true, null, { timeout: 300000, polling: 250 });
  const report = await page.evaluate(async () => {
    const demo = window.__grassDemo;
    const simplifierFetched = performance.getEntriesByType('resource')
      .some((entry) => /meshSimplify|meshoptimizer\/meshopt_simplifier/.test(entry.name));
    const { meshSimplifierReady, simplifiedStage } = await import('/src/rendering/meshSimplify.js');
    const { STRUCTURE_STAGES, NPC_LOD_RATIOS } = await import('/src/assets/scenePreprocessing.js');
    await meshSimplifierReady;
    const same = (a, b) => a === b || (a.index.count === b.index.count && a.index.array.every((value, i) => value === b.index.array[i]));
    const mismatches = [];
    let compared = 0;
    for (const [geometry, stages] of demo.structures.stages) {
      for (const [key, options] of Object.entries(STRUCTURE_STAGES)) {
        compared += 1;
        const runtime = simplifiedStage(geometry, options);
        if (!same(stages[key], runtime)) mismatches.push(`structure ${key} (${geometry.attributes.position.count} vertices)`);
      }
    }
    for (const [geometry, stages] of demo.npcs.lodGeometries) {
      NPC_LOD_RATIOS.forEach((ratio, level) => {
        if (ratio >= 1) return;
        compared += 1;
        const runtime = simplifiedStage(geometry, { ratio });
        if (!same(stages[level], runtime)) mismatches.push(`npc ratio ${ratio} (${geometry.attributes.position.count} vertices)`);
      });
    }
    return { simplifierFetched, compared, mismatches, houses: demo.structures.instances.length, npcs: demo.npcs.entries.length };
  });
  console.log(JSON.stringify(report));
  assert.deepEqual(errors, []);
  assert.equal(report.simplifierFetched, false, 'the runtime simplifier must not load when the bake is valid');
  assert.ok(report.compared >= 16, 'every house and NPC stage is compared');
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.houses, 6);
  assert.equal(report.npcs, 23);
  console.log('Scene preprocessing matches the runtime simplifier.');
} finally {
  await browser.close();
}
