import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
try {
  for (const backend of ['webgpu', 'webgl']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${process.env.VEGETATION_BASE_URL ?? 'http://127.0.0.1:5173'}/scripts/gpu/foliage-motion-check.html?renderer=${backend}`);
    const result = await page.evaluate(() => window.__foliageMotionCheck);
    console.log(backend, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally { await browser.close(); }
