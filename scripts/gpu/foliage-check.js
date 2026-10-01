import * as THREE from 'three/webgpu';
import { fog, uniform, float } from 'three/tsl';
import { prepareAtmosphereMaterials } from '../../src/rendering/atmosphereMaterials.js';

export async function checkFoliageRendering(renderer) {
  const previous = renderer.getRenderTarget();
  const camera = new THREE.OrthographicCamera(-2, 2, 0.5, -0.5, 0.1, 10);
  camera.position.z = 2;
  const read = async (scene, camera, target) => {
    renderer._nodes.nodeFrame.frameId++;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height);
  };
  const fogCase = async prepared => {
    const scene = new THREE.Scene();
    const tint = uniform(new THREE.Color(0.02, 0.03, 0.04));
    scene.fogNode = fog(tint, float(1));
    const material = new THREE.MeshStandardMaterial();
    const geometry = new THREE.PlaneGeometry(0.6, 0.6);
    for (const x of [-1, 0, 1]) {
      const mesh = new THREE.Mesh(geometry, material); mesh.position.x = x; scene.add(mesh);
    }
    const restore = prepared ? prepareAtmosphereMaterials(scene) : null;
    const target = new THREE.RenderTarget(64, 16);
    for (const color of [0.05, 0.65, 0.1, 0.8]) {
      tint.value.setRGB(color, color, color);
      await read(scene, camera, target);
    }
    const pixels = await read(scene, camera, target);
    const values = [16, 32, 48].map(x => pixels[(8 * 64 + x) * 4]);
    target.dispose(); geometry.dispose();
    restore?.();
    material.dispose();
    return { values, spread: Math.max(...values) - Math.min(...values) };
  };
  const coverageCase = async samples => {
    const scene = new THREE.Scene();scene.background = new THREE.Color(0);
    const camera = new THREE.OrthographicCamera(-16, 16, 16, -16, 0.1, 10);camera.position.z = 2;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.11, -10, 0, 0.11, -10, 0, 0, 10, 0], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));scene.add(mesh);
    const target = new THREE.RenderTarget(32, 32, { samples });const areas = [];
    for (let step = 0; step < 24; step++) {
      mesh.position.x = step / 24;
      const pixels = await read(scene, camera, target);
      let area = 0;for (let i = 0; i < pixels.length; i += 4) area += pixels[i] / 255;
      areas.push(area);
    }
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    const variance = areas.reduce((sum, x) => sum + (x - mean) ** 2, 0) / areas.length;
    target.dispose();geometry.dispose();mesh.material.dispose();
    return { mean, variance };
  };
  try {
    const staleFog = await fogCase(false), updatedFog = await fogCase(true);
    const singleSample = await coverageCase(0), multisample = await coverageCase(4);
    return {
      staleFog, updatedFog, singleSample, multisample,
      passed: updatedFog.spread <= 1 && multisample.variance < singleSample.variance * 0.65,
    };
  } finally { renderer.setRenderTarget(previous); }
}

if (document.querySelector('#results')) {
  window.__foliageCheck = (async () => {
    const renderer = new THREE.WebGPURenderer();await renderer.init();renderer._animation.stop();
    try { const result = await checkFoliageRendering(renderer);document.querySelector('#results').textContent = JSON.stringify(result, null, 2);return result; }
    finally { await renderer.dispose(); }
  })();
}
