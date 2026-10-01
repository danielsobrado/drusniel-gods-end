import * as THREE from 'three/webgpu';
import yaml from 'js-yaml';
import { SnowPowderSystem } from '../../src/world/SnowPowderSystem.js';
import { SnowSurfWake } from '../../src/world/SnowSurfWake.js';

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function check() {
  const config = yaml.load(await (await fetch('/snow.yaml')).text());
  const renderer = new THREE.WebGPURenderer({
    forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl',
  });
  await renderer.init();
  renderer._animation.stop();
  renderer.setClearColor(0x000000, 0);
  const target = new THREE.RenderTarget(96, 96, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 2));
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.set(0, 175, 10);
  camera.lookAt(0, 175, 0);
  camera.updateMatrixWorld();
  let height = -1000;
  const terrainSampler = { sampleHeight: () => height };
  const powder = new SnowPowderSystem({ scene, camera, terrainSampler, config });
  // Keep one billboard stationary to isolate shader alpha from its trajectory.
  Object.assign(powder.physics, { windX: 0, windZ: 0, gravity: 0, drag: 0 });
  const wake = new SnowSurfWake({ scene, camera, terrainSampler, config, powder });
  const alpha = async (view) => {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, view);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 96);
    let peak = 0, covered = 0, soft = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      const value = THREE.DataUtils.fromHalfFloat(pixels[i]);
      require(Number.isFinite(value), 'Snow shader produced non-finite alpha');
      peak = Math.max(peak, value);
      if (value > 0.001) covered++;
      if (value > 0.005 && value < 0.3) soft++;
    }
    return { peak, covered, soft };
  };
  try {
    powder.emit(0, 175, 0, 0, 0, 0, 1, 1);
    powder.update(0.01, null);
    const entering = await alpha(camera);
    powder.update(0.09, null);
    const fresh = await alpha(camera);
    for (let i = 0; i < 8; i++) powder.update(0.1, null);
    const fading = await alpha(camera);
    require(entering.peak > 0 && entering.peak < fresh.peak * 0.2, 'Powder must ease in through alpha');
    require(fading.peak > 0 && fading.peak < fresh.peak * 0.2, 'Powder must dissipate through alpha');
    require(fresh.soft > 20, 'Powder needs soft edges, not a hard cutout');
    for (let i = 0; i < 3; i++) powder.update(0.1, null);
    const expired = await alpha(camera);
    require(!powder.mesh.visible && expired.covered === 0, 'Expired powder must stop drawing');

    height = 175;
    const position = new THREE.Vector3();
    const player = { modelHeight: 5, speed: 18, running: true, playerYaw: 0,
      horizontalVelocity: new THREE.Vector3(), getPosition: () => position };
    for (let i = 0; i < 150; i++) {
      const angle = i / 60 * 0.32;
      position.set(Math.sin(angle) * 18 / 0.32, 175, Math.cos(angle) * 18 / 0.32);
      player.playerYaw = angle + Math.PI / 2;
      player.horizontalVelocity.set(Math.cos(angle) * 18, 0, -Math.sin(angle) * 18);
      wake.update(1 / 60, player, true);
      wake.restoreCamera();
      powder.update(1 / 60, null);
    }
    powder.mesh.visible = false;
    const view = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    view.position.copy(position).add(new THREE.Vector3(-15, 9, -23));
    view.lookAt(position.clone().add(new THREE.Vector3(-4, -1, 3)));
    const plume = await alpha(view);
    require(wake.mesh.visible && plume.covered > 20, 'Sprint fixture must actually draw the wake');
    require(plume.peak < 0.8 && plume.soft > 20, 'Wake must blend translucent edges');
    require(!wake.mesh.castShadow && !wake.material.depthWrite, 'Powder must not cast a solid slab shadow or block depth');

    height = 0;
    position.set(0, 0, 0);
    for (let i = 0; i < 300; i++) {
      wake.update(1 / 60, player, true);
      wake.restoreCamera();
      powder.update(1 / 60, null);
    }
    require(!wake.mesh.visible && !powder.mesh.visible, 'Snow effects must clear after leaving snow');
    return { passed: true, failures: [], checks: ['powder-alpha-envelope', 'wake-transparency', 'snow-exit'],
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2', entering, fresh, fading, plume };
  } finally {
    wake.dispose();
    powder.dispose();
    target.dispose();
    await renderer.dispose();
  }
}

window.__snowEffectsCheck = check().then(result => {
  document.querySelector('#result').textContent = JSON.stringify(result);
  return result;
}).catch(error => {
  const result = { passed: false, failures: [error.message], checks: [], error: error.stack };
  document.querySelector('#result').textContent = JSON.stringify(result);
  return result;
});
