// Run from the Vite app after entering the scene with ?renderer=auto. Injecting
// the loss callback exercises bootstrap's actual disposal/restart path without
// relying on a driver crash. This deliberately consumes the page's retry budget.
export async function checkRendererRecovery({ loseDuringRestart = false } = {}) {
  const initial = window.__grassDemo;
  if (!initial?.started || initial.world.renderer.backend.isWebGPUBackend !== true) {
    throw new Error('Start the development scene on WebGPU before checking recovery.');
  }
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const edit = (selector, value, event) => {
    const input = initial.ui.element.querySelector(selector);
    if (event === 'change') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  edit('[data-grass-param="windIntensity"]', 2.1, 'input');
  edit('[data-grass-param="simulationSpeed"]', 0.7, 'input');
  edit('[data-pixel-ratio]', 0.75, 'input');
  edit('[data-interaction]', false, 'change');
  initial.player.cameraDistance = initial.player.targetCameraDistance = 14;
  const expectedGrass = JSON.stringify(initial.environment.current.grass);

  const restart = async (previous, backend) => {
    const previousBarrier = previous.boundaryBarrier;
    const hadBarrier = Boolean(previousBarrier?.mesh);
    previous.world.renderer.onDeviceLost({ api: 'WebGPU', message: 'Recovery regression check' });
    const deadline = performance.now() + 45000;
    while (performance.now() < deadline) {
      const next = window.__grassDemo;
      if (next !== previous && next.started) {
        check(next.world.rendererSession.diagnostics.actual === backend, `recovery selects ${backend}`);
        if (hadBarrier) {
          check(previousBarrier.disposed && !previousBarrier.mesh, 'old barrier resources are released');
          check(Boolean(next.boundaryBarrier?.mesh), 'the boundary barrier is rebuilt');
          check(next.boundaryBarrier?.fences.every(({ object }) => !object.visible),
            'the authored fence stays hidden after recovery');
        }
        check(JSON.stringify(next.environment.current.grass) === expectedGrass, 'both grass families preserve their settings');
        check(Number(next.ui.element.querySelector('[data-grass-param="windIntensity"]').value) === 2.1,
          'wind control matches the restored simulation');
        check(Number(next.ui.element.querySelector('[data-grass-param="simulationSpeed"]').value) === 0.7,
          'speed control matches the restored simulation');
        check(Number(next.ui.element.querySelector('[data-pixel-ratio]').value) === 0.75,
          'pixel ratio control matches the restored renderer');
        check(next.grass.interactionMap.enabled === false && !next.ui.element.querySelector('[data-interaction]').checked,
          'interaction control matches the restored setting');
        check(Math.abs(next.player.cameraDistance - 14) < 0.001, 'pixel ratio restoration preserves camera zoom');
        return next;
      }
      const fatal = document.querySelector('.fatal');
      if (fatal) throw new Error(fatal.textContent);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Renderer recovery did not finish within 45 seconds.');
  };
  if (loseDuringRestart) {
    const prototype = initial.constructor.prototype;
    const originalStart = prototype.start;
    let injected = false;
    prototype.start = function () {
      const ready = this.onRendererReady;
      this.onRendererReady = session => {
        ready(session);
        if (!injected) {
          injected = true;
          session.renderer.onDeviceLost({ api: 'WebGPU', message: 'Loss during recovery startup' });
        }
      };
      return originalStart.call(this);
    };
    try { await restart(initial, 'webgl2'); }
    finally { prototype.start = originalStart; }
  } else {
    const retried = await restart(initial, 'webgpu');
    await restart(retried, 'webgl2');
  }
  return { passed: failures.length === 0, failures };
}
