import * as THREE from 'three/webgpu';
import { createCinematicWaterMaterial } from '../../src/water/WaterMaterial.js';
import { createWaterGeometry } from '../../src/water/waterGeometry.js';

// Render the production shader against a tiny, constant river field. This
// checks ownership and shading independently of the landscape's art assets.
export async function checkWaterMouth(renderer, createMaterial = createCinematicWaterMaterial) {
  const params = { position: [0, 0, 0], size: 4, segments: 2 };
  const field = new THREE.DataTexture(new Float32Array([0, -0.1, 20, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  const ground = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  field.needsUpdate = ground.needsUpdate = true;
  const face = document.createElement('canvas'); face.width = face.height = 1;
  const context = face.getContext('2d'); context.fillStyle = '#789eaf'; context.fillRect(0, 0, 1, 1);
  const reflection = new THREE.CubeTexture(Array(6).fill(face)); reflection.needsUpdate = true;
  const shader = createMaterial({ params, reflection,
    river: { texture: field, bounds: { min: { x: -100, z: -100 } }, size: { x: 200, z: 200 } },
    terrain: { texture: ground, boundsMin: new THREE.Vector3(-100, -2, -100),
      boundsSize: new THREE.Vector3(200, 1, 200), minHeight: -2, maxHeight: -1 },
  });
  const geometry = createWaterGeometry(params);
  const mesh = new THREE.Mesh(geometry, shader.material);
  const scene = new THREE.Scene(); scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  const target = new THREE.RenderTarget(16, 16);
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousAlpha = renderer.getClearAlpha();
  const originalColor = shader.material.colorNode;
  const failures = [], checks = [];
  const check = (condition, name) => { checks.push(name); if (!condition) failures.push(name); };
  const render = async (kind, level = 0, x = 0) => {
    const a = geometry.attributes;
    for (let i = 0; i < a.position.count; i++) {
      a.waterKind.setX(i, kind); a.waterLevel.setX(i, level);
      a.waterFlow.setXYZW(i, 1, 0, 1, 20);
      a.riverSurface.setXYZW(i, a.position.getX(i), a.position.getZ(i) + 20, 0, 0);
    }
    for (const name of ['waterKind', 'waterLevel', 'waterFlow', 'riverSurface']) a[name].needsUpdate = true;
    field.image.data[0] = level; field.needsUpdate = true;
    mesh.position.set(x, level, 0);
    camera.position.set(x, level + 5, 0.001); camera.lookAt(x, level, 0);
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    return renderer.readRenderTargetPixelsAsync(target, 4, 4, 8, 8);
  };
  const maxDifference = (a, b) => a.reduce((max, v, i) => Math.max(max, Math.abs(v - b[i])), 0);
  try {
    renderer.setClearColor(0x000000, 0);
    // Keep the production discard conditions and render a white silhouette.
    shader.material.colorNode = originalColor.mul(0).add(1);
    shader.material.needsUpdate = true;
    const visible = pixels => pixels[0] > 20;
    check(visible(await render(0)), 'lake covers the flat river mouth');
    check(!visible(await render(1)), 'flat mouth ribbon is discarded to prevent overlapping waves');
    check(!visible(await render(0, 2)), 'lake stays masked beneath a raised river');
    check(visible(await render(1, 2)), 'raised river remains visible');
    check(visible(await render(1, 0, 10)), 'flat river outside the lake footprint remains visible');

    // At lake level the ripple normals AND edge opacity must match, regardless
    // of which geometry supplied the attributes. Use the actual exported nodes.
    shader.material.colorNode = shader.normalNode.mul(0.5).add(0.5);
    shader.material.needsUpdate = true;
    for (const rain of [0, 1]) for (const time of [0, 4.2]) {
      shader.uniforms.rain.value = rain; shader.uniforms.clock.value = time;
      const lake = await render(0), river = await render(1);
      check(maxDifference(lake, river) <= 1, `mouth normal and opacity continuity (rain=${rain}, time=${time})`);
    }
    return { passed: failures.length === 0, failures, checks, backend: renderer.backend.constructor.name };
  } finally {
    renderer.setRenderTarget(previousTarget); renderer.setClearColor(previousColor, previousAlpha);
    shader.dispose(); geometry.dispose(); field.dispose(); ground.dispose(); reflection.dispose(); target.dispose();
  }
}

if (globalThis.document?.querySelector?.('#results')) {
  window.__waterMouthCheck = (async () => {
    const renderer = new THREE.WebGPURenderer({ forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl' });
    await renderer.init();
    renderer.setSize(16, 16); renderer._animation?.stop?.();
    try {
      const result = await checkWaterMouth(renderer);
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { renderer.dispose(); }
  })();
}
