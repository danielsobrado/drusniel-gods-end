import * as THREE from 'three/webgpu';
import { attribute, positionLocal, positionWorld, uniform, vec3, vec4 } from 'three/tsl';
import { createSeaNodes } from '../../src/water/seaNodes.js';
import { sampleSeaSurface } from '../../src/water/seaWaves.js';
import { coastX } from '../../src/world/coast.js';
import { createCinematicWaterMaterial } from '../../src/water/WaterMaterial.js';

async function checkFiniteWaterNormals(renderer) {
  renderer.setClearColor(0x000000, 0);
  const terrainTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  terrainTexture.needsUpdate = true;
  const reflection = new THREE.CubeTexture();
  const shader = createCinematicWaterMaterial({
    terrain: { texture: terrainTexture, boundsMin: { x: 0, z: 0 }, boundsSize: { x: 1000, z: 1000 }, minHeight: -95, maxHeight: 0 },
    river: null, reflection, params: { position: [0, 0, 0], sea: { enabled: true, shoreX: 0, level: 0, depth: 95 } },
  });
  const geometry = new THREE.PlaneGeometry(8, 8, 4, 4);
  geometry.rotateX(-Math.PI / 2); geometry.translate(500, 0, 0);
  const count = geometry.attributes.position.count;
  geometry.setAttribute('waterKind', new THREE.Float32BufferAttribute(new Float32Array(count).fill(2), 1));
  geometry.setAttribute('waterLevel', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  for (const name of ['waterFlow', 'riverSurface']) geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  shader.material.fragmentNode = vec4(shader.normalNode, 1);
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, shader.material));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(500, 8, 6); camera.lookAt(500, 0, 0);
  const target = new THREE.RenderTarget(32, 32, { type: THREE.HalfFloatType });
  let checked = 0;
  try {
    for (const kind of [0, 1, 2]) for (const time of [5, 730]) {
      geometry.attributes.waterKind.array.fill(kind); geometry.attributes.waterKind.needsUpdate = true;
      shader.uniforms.clock.value = time;
      renderer.setRenderTarget(target); await renderer.renderAsync(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32);
      for (let i = 0; i < pixels.length; i += 4) {
        if (THREE.DataUtils.fromHalfFloat(pixels[i + 3]) < 0.9) continue;
        const n = [0, 1, 2].map(channel => THREE.DataUtils.fromHalfFloat(pixels[i + channel]));
        if (!n.every(Number.isFinite) || Math.abs(Math.hypot(...n) - 1) > 0.01) {
          throw new Error(`Invalid water normal for kind ${kind} at ${time}s: ${n}`);
        }
        checked++;
      }
    }
    if (checked < 100) throw new Error('Water normal fixture did not draw enough covered pixels.');
    return checked;
  } finally { shader.dispose(); geometry.dispose(); target.dispose(); terrainTexture.dispose(); reflection.dispose(); }
}

async function check() {
  const sea = { enabled: true, shoreX: 1000, level: -24, depth: 95 };
  const points = [-500, 0, 125, 800].flatMap(z => [-5, 0, 8, 30, 80, 180, 500, 2500].map(d => [coastX(z) + d, z]));
  const renderer = new THREE.WebGPURenderer({ forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl' });
  await renderer.init();
  renderer._animation.stop();
  const target = new THREE.RenderTarget(points.length, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const geometry = new THREE.BufferGeometry(), positions = [], coordinates = [], indices = [];
  points.forEach((p, i) => {
    positions.push(i, 0, 0, i + 1, 0, 0, i, 1, 0, i + 1, 1, 0);
    for (let j = 0; j < 4; j++) coordinates.push(...p);
    const a = i * 4; indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('samplePoint', new THREE.Float32BufferAttribute(coordinates, 2));
  geometry.setIndex(indices);
  const clock = uniform(0), rain = uniform(0), ocean = createSeaNodes(sea, clock, rain);
  const p = attribute('samplePoint', 'vec2');
  // Z records the actual vertex displacement; RGBA16F preserves signed values.
  material.positionNode = vec3(positionLocal.xy, ocean.height(p));
  material.fragmentNode = vec4(positionWorld.z, ocean.normal(p).xz, 1);
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.OrthographicCamera(0, points.length, 1, 0, 0.1, 30);
  camera.position.z = 10;
  let comparisons = 0, maxError = 0;
  try {
    for (const wetness of [0, 1]) for (const time of [5, 730]) {
      rain.value = wetness; clock.value = time;
      renderer.setRenderTarget(target); await renderer.renderAsync(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, points.length, 1);
      for (let i = 0; i < points.length; i++) {
        const [x, z] = points[i], h = sampleSeaSurface(x, z, time, sea, wetness);
        const normal = new THREE.Vector3(-(sampleSeaSurface(x + 0.25, z, time, sea, wetness) - h) / 0.25,
          1, -(sampleSeaSurface(x, z + 0.25, time, sea, wetness) - h) / 0.25).normalize();
        for (const [channel, expected] of [h, normal.x, normal.z, 1].entries()) {
          const actual = THREE.DataUtils.fromHalfFloat(pixels[i * 4 + channel]);
          const error = Math.abs(actual - expected);
          if (!Number.isFinite(actual) || error > 0.004) throw new Error(`Sea sample ${i}, rain ${wetness}, time ${time}, channel ${channel}: ${actual} != ${expected}`);
          maxError = Math.max(maxError, error); comparisons++;
        }
      }
    }
    const finiteNormals = await checkFiniteWaterNormals(renderer);
    return { passed: true, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2', comparisons, maxError, finiteNormals };
  } finally { geometry.dispose(); material.dispose(); target.dispose(); renderer.dispose(); }
}

check().then(result => { document.querySelector('#result').textContent = JSON.stringify(result); })
  .catch(error => { document.querySelector('#result').textContent = JSON.stringify({ passed: false, error: error.stack }); });
