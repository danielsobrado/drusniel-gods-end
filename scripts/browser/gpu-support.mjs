const INFRASTRUCTURE_FAILURE_PATTERNS = Object.freeze([
  /A valid external Instance reference no longer exists/i,
  /Failed to create (?:a )?WebGPU device/i,
  /Failed to create Vulkan/i,
]);

export function isWebGPUInfrastructureFailure(error) {
  const message = typeof error === 'string'
    ? error
    : error?.message ?? String(error ?? '');
  return INFRASTRUCTURE_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

// WebGPU is restricted to secure contexts. about:blank is not the application's
// localhost origin, so capability checks run from the same secure origin.
export async function probeWebGPU(page, baseUrl, timeoutMs) {
  await page.goto(new URL('/scripts/gpu/support-check.html', baseUrl).href, {
    waitUntil: 'domcontentloaded', timeout: timeoutMs,
  });
  return page.evaluate(async (timeout) => {
    if (!navigator.gpu) {
      return { api: false, adapter: false, device: false, reason: 'navigator.gpu is unavailable' };
    }

    const withTimeout = async (promise, label) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    const adapter = await withTimeout(navigator.gpu.requestAdapter(), 'WebGPU adapter probe');
    if (!adapter) {
      return { api: true, adapter: false, device: false, reason: 'no WebGPU adapter is available' };
    }

    let device;
    try {
      device = await withTimeout(adapter.requestDevice(), 'WebGPU device probe');
      const lost = device.lost.then((info) => ({
        usable: false,
        reason: info?.message || `WebGPU device lost: ${info?.reason ?? 'unknown'}`,
      }));

      const encoder = device.createCommandEncoder();
      device.queue.submit([encoder.finish()]);
      const ready = device.queue.onSubmittedWorkDone().then(() => ({ usable: true }));
      const outcome = await withTimeout(Promise.race([ready, lost]), 'WebGPU queue probe');
      if (!outcome.usable) {
        return { api: true, adapter: true, device: false, reason: outcome.reason };
      }
      return { api: true, adapter: true, device: true };
    } catch (error) {
      return {
        api: true,
        adapter: true,
        device: false,
        reason: error?.message ?? String(error),
      };
    } finally {
      device?.destroy?.();
    }
  }, timeoutMs);
}
