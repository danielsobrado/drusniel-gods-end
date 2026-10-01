import * as THREE from 'three/webgpu';
import { texture, vec4 } from 'three/tsl';
import { createDepthNormals } from '../../src/rendering/DepthNormals.js';

window.__depthNormalsCheck = (async () => {
  const renderer = new THREE.WebGPURenderer({ forceWebGL: window.location.search.includes('webgl') });
  await renderer.init();
  renderer.setSize(128, 64);
  renderer._animation.stop();
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 6000);
  camera.coordinateSystem = renderer.coordinateSystem;
  camera.updateProjectionMatrix();
  const data = new Float32Array(128 * 64).fill(0.98);
  const map = new THREE.DataTexture(data, 128, 64, THREE.RedFormat, THREE.FloatType);
  map.needsUpdate = true;
  const normals = createDepthNormals(texture(map), camera);
  const output = new THREE.RenderTarget(128, 64);
  const material = new THREE.MeshBasicNodeMaterial({ fragmentNode: vec4(normals.rgb.mul(0.5).add(0.5), 1) });
  const quad = new THREE.QuadMesh(material);
  const cases = [];
  try {
    for (const slope of [0, 0.01]) {
      for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
        data[y * 128 + x] = 0.98 + slope * ((y + 0.5) / 64 - 0.5);
      }
      map.needsUpdate = true;
      renderer._nodes.nodeFrame.frameId++;
      renderer.setRenderTarget(output);
      quad.render(renderer);
      const pixels = await renderer.readRenderTargetPixelsAsync(output, 0, 0, 128, 64);
      const min = [255, 255, 255], max = [0, 0, 0];
      for (let y = 4; y < 60; y++) for (let x = 4; x < 124; x++) for (let c = 0; c < 3; c++) {
        const value = pixels[(y * 128 + x) * 4 + c];
        min[c] = Math.min(min[c], value);
        max[c] = Math.max(max[c], value);
      }
      cases.push({ slope, min, max, range: max.map((value, i) => value - min[i]) });
    }
    return { passed: cases.every(c => c.range.every(value => value <= 2) && c.min[2] > 128), cases };
  } finally {
    normals.dispose(); map.dispose(); output.dispose(); material.dispose(); await renderer.dispose();
  }
})().catch(error => ({ passed: false, error: error.stack }));
window.__depthNormalsCheck.then(result => {
  document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
});
