import { chromium } from 'playwright';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const output = '.cache/environment-parity';
await mkdir(output, { recursive: true });
const results = [];
const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
try {
  for (const backend of ['webgl', 'webgpu']) for (const sheen of [0, 1]) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.on('pageerror', e => errors.push(e.stack));
    page.on('console', m => {
      if (m.type() === 'error' || /GL_INVALID_|Shader Error|VALIDATION_ERROR/.test(m.text())) errors.push(m.text());
    });
    const base = process.env.VEGETATION_BASE_URL ?? 'http://127.0.0.1:5173';
    await page.goto(`${base}/scripts/browser/fixtures/environment-parity.html?backend=${backend}&sheen=${sheen}`);
    await page.waitForFunction(() => window.parityReady, null, { timeout: 60000 });
    const state = await page.evaluate(() => ({
      backend: window.parity.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl',
      cascades: window.parity.lighting.csm?.lights.length,
    }));
    assert.equal(state.backend, backend, 'the requested backend actually renders');
    assert.equal(state.cascades, 2, 'both backends initialize cascaded shadows');
    const png = await page.locator('canvas').screenshot();
    await writeFile(`${output}/${backend}-sheen-${sheen}.png`, png);
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let lit = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] + data[i + 1] + data[i + 2] > 20) lit++;
    const result = { backend, sheen, lit, brightness: data.reduce((sum, value) => sum + value, 0) };
    assert.ok(lit > 5000, 'grass remains visible');
    results.push(result);
    console.log(result);
    await page.close();
  }
  assert.deepEqual(errors, [], 'no browser or shader errors');
  for (const backend of ['webgl', 'webgpu']) {
    const [off, on] = results.filter(result => result.backend === backend);
    assert.ok(on.brightness > off.brightness * 1.1, `${backend}: gust sheen changes rendered pixels`);
    assert.ok(Math.abs(on.lit - off.lit) / off.lit < 0.02, `${backend}: sheen preserves grass coverage`);
  }
  for (const sheen of [0, 1]) {
    const [gl, gpu] = results.filter(result => result.sheen === sheen);
    // Rasterization and antialiasing differ; compare coverage and total light, not exact pixels.
    assert.ok(Math.abs(gl.lit - gpu.lit) / gpu.lit < 0.1, 'backend grass coverage is equivalent');
    assert.ok(Math.abs(gl.brightness - gpu.brightness) / gpu.brightness < 0.1, 'backend grass lighting is equivalent');
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
