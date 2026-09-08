import * as THREE from 'three/webgpu';
import { BoundaryBarrier } from '../../src/world/BoundaryBarrier.js';

export async function checkBarrierRendering(renderer) {
  const previous = renderer.getRenderTarget();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#18202b');
  const terrainRoot = new THREE.Group();
  scene.add(terrainRoot);
  const barrier = new BoundaryBarrier({
    scene, terrainRoot, terrainSampler: { ready: true, sampleHeight: () => 0 },
    config: {
      boundaryBarrier: { enabled: true },
      collisions: { worldBounds: [
        { position: [-20, 0, 0], size: [1, 100, 40] },
        { position: [20, 0, 0], size: [1, 100, 40] },
        { position: [0, 0, -20], size: [40, 100, 1] },
        { position: [0, 0, 20], size: [40, 100, 1] },
      ] },
    },
  }).init();
  const camera = new THREE.OrthographicCamera(-9, 9, 12, -1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -20);
  const target = new THREE.RenderTarget(64, 64);
  const blocker = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1), new THREE.MeshBasicMaterial({ color: '#ff0000' }));
  blocker.position.set(0, 5.5, -10);
  const read = async () => {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64);
  };
  const mean = (pixels, from = 0, to = pixels.length) => {
    let sum = 0;
    for (let i = from; i < to; i += 4) sum += pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    return sum / ((to - from) / 4);
  };
  try {
    barrier.setEnabled(false);
    const background = await read();
    barrier.setEnabled(true);
    barrier.update(0, new THREE.Vector3(1000, 0, 1000));
    const far = await read();
    barrier.update(0, new THREE.Vector3(0, 3, -19));
    const near = await read();
    barrier.update(5, new THREE.Vector3(0, 3, -19));
    const animated = await read();
    let changedPixels = 0;
    for (let i = 0; i < near.length; i += 4) {
      if (Math.abs(near[i + 1] - animated[i + 1]) > 2) changedPixels++;
    }
    scene.add(blocker);
    const occluded = await read();
    const center = (32 * 64 + 32) * 4;
    const result = {
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
      background: mean(background), far: mean(far), near: mean(near), changedPixels,
      // GPU readback rows start at the top in WebGPU and the bottom in WebGL.
      topGlow: (renderer.backend.isWebGPUBackend ? mean(near, 0, 4 * 64 * 4)
        : mean(near, 60 * 64 * 4)) - mean(background),
      middleGlow: mean(near, 28 * 64 * 4, 36 * 64 * 4) - mean(background),
      blockerPixel: Array.from(occluded.slice(center, center + 3)),
    };
    result.passed = result.far > result.background && result.near > result.far * 1.15
      && changedPixels > 100 && result.topGlow < result.middleGlow * 0.25
      && result.blockerPixel[0] > 240 && result.blockerPixel[1] < 5 && result.blockerPixel[2] < 5;
    return result;
  } finally {
    renderer.setRenderTarget(previous);
    barrier.dispose();
    target.dispose(); blocker.geometry.dispose(); blocker.material.dispose();
  }
}

if (document.querySelector('#results')) {
  window.__barrierCheck = (async () => {
    const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';
    const renderer = new THREE.WebGPURenderer({ forceWebGL });
    await renderer.init();
    renderer._animation.stop();
    try {
      const result = await checkBarrierRendering(renderer);
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { renderer.dispose(); }
  })();
}
