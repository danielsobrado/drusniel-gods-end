import * as THREE from 'three/webgpu';
import { float, uniform, uv, vec4 } from 'three/tsl';
import { groundRoughness, groundTurf } from '../../src/rendering/GroundTurf.js';

export async function checkGroundRendering(renderer) {
  const previous = renderer.getRenderTarget();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  // RGBA8 rows are 256-byte aligned in the WebGPU readback buffer.
  const target = new THREE.RenderTarget(64, 32);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshBasicNodeMaterial();
  scene.add(new THREE.Mesh(geometry, material));
  const read = async () => {
    renderer._nodes.nodeFrame.frameId++;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 32);
  };
  try {
    const soil = uniform(0), wet = uniform(0);
    material.fragmentNode = vec4(groundRoughness(soil, float(0.3), wet, float(0)), 0, 0, 1);
    const roughness = {};
    for (const [name, soilValue, wetValue] of [
      ['dryTurf', 0, 0], ['wetTurf', 0, 1], ['shoreTurf', 0, 0.65],
      ['drySoil', 1, 0], ['wetSoil', 1, 1], ['wetFringe', 0.5, 1],
    ]) {
      soil.value = soilValue; wet.value = wetValue;
      roughness[name] = (await read())[0] / 255;
    }
    const scale = uniform(1);
    material.fragmentNode = vec4(groundTurf(uv().mul(scale)).mul(0.5).add(0.5), 1);
    material.needsUpdate = true;
    const range = pixels => {
      let min = 255, max = 0;
      for (let i = 0; i < pixels.length; i += 4) { min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]); }
      return max - min;
    };
    const nearDetailRange = range(await read());
    scale.value = 100;
    const farDetailRange = range(await read());
    return {
      roughness, nearDetailRange, farDetailRange,
      passed: roughness.wetTurf >= 0.8 && roughness.shoreTurf >= 0.85
        && roughness.dryTurf > roughness.wetTurf && roughness.wetSoil >= 0.47
        && roughness.wetSoil < roughness.wetFringe && roughness.wetFringe < roughness.wetTurf
        && nearDetailRange > 20 && farDetailRange <= 1,
    };
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose(); geometry.dispose(); material.dispose();
  }
}

if (document.querySelector('#results')) {
  window.__groundCheck = (async () => {
    const renderer = new THREE.WebGPURenderer(); await renderer.init(); renderer._animation.stop();
    try {
      const result = await checkGroundRendering(renderer);
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { renderer.dispose(); }
  })();
}
