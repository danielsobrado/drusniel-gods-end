// WebGPU is restricted to secure contexts. about:blank is not the application's
// localhost origin, so probing a newly opened page can incorrectly skip checks.
export async function probeWebGPU(page, baseUrl, timeoutMs) {
  await page.goto(new URL('/scripts/gpu/support-check.html', baseUrl).href, {
    waitUntil: 'domcontentloaded', timeout: timeoutMs,
  });
  return page.evaluate(async (timeout) => {
    if (!navigator.gpu) return { api: false, adapter: false };
    let timer;
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('WebGPU adapter probe timed out')), timeout);
        }),
      ]);
      return { api: true, adapter: Boolean(adapter) };
    } finally {
      clearTimeout(timer);
    }
  }, timeoutMs);
}
