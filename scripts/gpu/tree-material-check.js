import * as THREE from 'three/webgpu';
import { loadConfig } from '../../src/config/loadConfig.js';
import { TreeLeafMaterialFactory } from '../../src/world/TreeLeafMaterial.js';
import { foliageLight } from '../../src/rendering/CinematicLighting.js';

window.__treeMaterialCheck = (async () => {
  const config = await loadConfig();
  config.cinematic.style.enabled = false;
  const renderer = new THREE.WebGPURenderer({ forceWebGL: window.location.search.includes('webgl') });
  await renderer.init();
  renderer._animation.stop();
  const factory = new TreeLeafMaterialFactory(config);
  factory.setWindStrength(0);
  foliageLight.strength.value = 0;
  const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  map.needsUpdate = true;
  const material = factory.createShared({ map });
  const geometry = new THREE.PlaneGeometry(0.8, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 10);
  camera.position.z = 2;
  const trees = [new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material)];
  trees.forEach((mesh, i) => {
    mesh.position.x = i ? 0.5 : -0.5;
    mesh.userData.treeAppearance = { tint: new THREE.Color(i ? 0x0000ff : 0xff0000), opacity: 1 };
    scene.add(mesh);
  });
  const target = new THREE.RenderTarget(128, 64, { samples: 4 });
  const read = async () => {
    renderer._nodes.nodeFrame.frameId++;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 64);
    return [32, 96].map(x => Array.from(pixels.slice((32 * 128 + x) * 4, (32 * 128 + x) * 4 + 3)));
  };
  try {
    const colors = await read();
    trees[0].userData.treeAppearance.opacity = 0;
    const faded = await read();
    trees[0].userData.treeAppearance.opacity = 1;
    trees[1].userData.treeAppearance.tint.set(0x00ff00);
    const changed = await read();
    return {
      passed: colors[0][0] > 200 && colors[0][2] < 10 && colors[1][2] > 200 && colors[1][0] < 10
        && faded[0].every(value => value === 0) && faded[1][2] > 200 && changed[0][0] > 200 && changed[1][1] > 200,
      colors, faded, changed,
    };
  } finally {
    factory.dispose(); geometry.dispose(); map.dispose(); target.dispose(); renderer.dispose();
  }
})().catch(error => ({ passed: false, error: error.stack }));
window.__treeMaterialCheck.then(result => {
  document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
});
