import * as THREE from 'three/webgpu';
import { attribute, positionLocal, positionWorld, uniform, vec3, vec4 } from 'three/tsl';
import { createSeaNodes } from '../../src/water/seaNodes.js';
import { sampleSeaSurface } from '../../src/water/seaWaves.js';
import { coastX } from '../../src/world/coast.js';
import { createCoastNodes, sampleCoastField } from '../../src/world/CoastField.js';
import { createCinematicWaterMaterial } from '../../src/water/WaterMaterial.js';

const TAU = Math.PI * 2;
const TOLERANCE = 0.004;

function wrap01(value) {
  return value - Math.floor(value);
}

async function checkFiniteWaterNormals(renderer) {
  renderer.setClearColor(0x000000, 0);
  const terrainTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  terrainTexture.needsUpdate = true;
  const reflection = new THREE.CubeTexture();
  const shader = createCinematicWaterMaterial({
    terrain: {
      texture: terrainTexture,
      boundsMin: { x: 0, z: 0 },
      boundsSize: { x: 1000, z: 1000 },
      minHeight: -95,
      maxHeight: 0,
    },
    river: null,
    reflection,
    params: {
      size: 640,
      position: [0, 0, 0],
      sea: { enabled: true, shoreX: 0, level: 0, depth: 95 },
    },
  });
  const geometry = new THREE.PlaneGeometry(8, 8, 4, 4);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(500, 0, 0);
  const count = geometry.attributes.position.count;
  geometry.setAttribute('waterKind', new THREE.Float32BufferAttribute(new Float32Array(count).fill(2), 1));
  geometry.setAttribute('waterLevel', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  for (const name of ['waterFlow', 'riverSurface']) {
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  }
  shader.material.fragmentNode = vec4(shader.normalNode, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, shader.material));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(500, 8, 6);
  camera.lookAt(500, 0, 0);
  const target = new THREE.RenderTarget(32, 32, { type: THREE.HalfFloatType });
  let checked = 0;
  try {
    for (const kind of [0, 1, 2]) for (const clock of [5, 730]) {
      geometry.attributes.waterKind.array.fill(kind);
      geometry.attributes.waterKind.needsUpdate = true;
      shader.uniforms.clock.value = clock;
      renderer.setRenderTarget(target);
      await renderer.renderAsync(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32);
      for (let i = 0; i < pixels.length; i += 4) {
        if (THREE.DataUtils.fromHalfFloat(pixels[i + 3]) < 0.9) continue;
        const normal = [0, 1, 2].map((channel) => THREE.DataUtils.fromHalfFloat(pixels[i + channel]));
        if (!normal.every(Number.isFinite) || Math.abs(Math.hypot(...normal) - 1) > 0.01) {
          throw new Error(`Invalid water normal for kind ${kind} at ${clock}s: ${normal}`);
        }
        checked += 1;
      }
    }
    if (checked < 100) throw new Error('Water normal fixture did not draw enough covered pixels.');
    return checked;
  } finally {
    shader.dispose();
    geometry.dispose();
    target.dispose();
    terrainTexture.dispose();
    reflection.dispose();
  }
}

async function check() {
  const sea = { enabled: true, shoreX: 1000, level: -24, depth: 95 };
  const points = [-1200, -500, 0, 500, 1200].flatMap((z) =>
    [-80, -20, -8, 0, 8, 30, 80, 180, 500, 2500].map((distance) => [coastX(z, sea) + distance, z]));
  const renderer = new THREE.WebGPURenderer({
    forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl',
  });
  await renderer.init();
  renderer._animation.stop();
  const target = new THREE.RenderTarget(points.length, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const geometry = new THREE.BufferGeometry();
  const positions = [], coordinates = [], indices = [];
  points.forEach((point, index) => {
    positions.push(index, 0, 0, index + 1, 0, 0, index, 1, 0, index + 1, 1, 0);
    for (let vertex = 0; vertex < 4; vertex += 1) coordinates.push(...point);
    const a = index * 4;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('samplePoint', new THREE.Float32BufferAttribute(coordinates, 2));
  geometry.setIndex(indices);
  const clock = uniform(0), rain = uniform(0), ocean = createSeaNodes(sea, clock, rain);
  const point = attribute('samplePoint', 'vec2');
  material.positionNode = vec3(positionLocal.xy, ocean.height(point));
  material.fragmentNode = vec4(positionWorld.z, ocean.normal(point).xz, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.OrthographicCamera(0, points.length, 1, 0, 0.1, 30);
  camera.position.z = 10;
  let comparisons = 0, coastComparisons = 0, maxError = 0;

  const render = async () => {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, points.length, 1);
  };
  const compare = (actual, expected, label) => {
    const error = Math.abs(actual - expected);
    if (!Number.isFinite(actual) || error > TOLERANCE) {
      throw new Error(`${label}: ${actual} != ${expected}`);
    }
    maxError = Math.max(maxError, error);
  };

  try {
    for (const wetness of [0, 1]) for (const time of [5, 730]) {
      rain.value = wetness;
      clock.value = time;
      const pixels = await render();
      for (let i = 0; i < points.length; i += 1) {
        const [x, z] = points[i], height = sampleSeaSurface(x, z, time, sea, wetness);
        const normal = new THREE.Vector3(
          -(sampleSeaSurface(x + 0.25, z, time, sea, wetness) - height) / 0.25,
          1,
          -(sampleSeaSurface(x, z + 0.25, time, sea, wetness) - height) / 0.25,
        ).normalize();
        for (const [channel, expected] of [height, normal.x, normal.z, 1].entries()) {
          const actual = THREE.DataUtils.fromHalfFloat(pixels[i * 4 + channel]);
          compare(actual, expected, `Sea sample ${i}, rain ${wetness}, time ${time}, channel ${channel}`);
          comparisons += 1;
        }
      }
    }

    const coast = createCoastNodes(sea, clock, rain);
    const coastPasses = [
      {
        node: vec4(
          coast.distance(point).div(3000),
          coast.depth(point).div(100),
          coast.beachPhase(point).div(TAU).fract(),
          coast.baseMoisture(point),
        ),
        expected: (field) => [
          field.signedCoastDistance / 3000,
          field.oceanDepth / 100,
          wrap01(field.beachPhase / TAU),
          field.baseMoisture,
        ],
      },
      {
        node: vec4(
          coast.waterCoverage(point),
          coast.foamFront(point),
          coast.washMemory(point),
          coast.waveWash(point),
        ),
        expected: (field) => [
          field.waterCoverage,
          field.foamFront,
          field.washMemory,
          field.waveWash,
        ],
      },
      {
        node: vec4(
          coast.shoreRunup(point).div(20),
          coast.vegetationSuitability(point),
          coast.groundcoverSuitability(point),
          coast.scatterSuitability(point),
        ),
        expected: (field) => [
          field.shoreRunup / 20,
          field.vegetationSuitability,
          field.groundcoverSuitability,
          field.scatterSuitability,
        ],
      },
    ];

    for (const pass of coastPasses) {
      material.fragmentNode = pass.node;
      material.needsUpdate = true;
      for (const wetness of [0, 1]) for (const time of [0, 1, 3, 730]) {
        rain.value = wetness;
        clock.value = time;
        const pixels = await render();
        for (let i = 0; i < points.length; i += 1) {
          const field = sampleCoastField(...points[i], time, sea, wetness);
          const expected = pass.expected(field);
          for (let channel = 0; channel < 4; channel += 1) {
            const actual = THREE.DataUtils.fromHalfFloat(pixels[i * 4 + channel]);
            compare(actual, expected[channel], `Coast sample ${i}, pass channel ${channel}`);
            coastComparisons += 1;
          }
        }
      }
    }
    const finiteNormals = await checkFiniteWaterNormals(renderer);
    return {
      passed: true,
      failures: [],
      checks: ['sea-wave-parity', 'coast-field-parity', 'finite-water-normals'],
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
      comparisons,
      coastComparisons,
      maxError,
      finiteNormals,
    };
  } finally {
    geometry.dispose();
    material.dispose();
    target.dispose();
    renderer.dispose();
  }
}

window.__seaCheck = check().then((result) => {
  document.querySelector('#result').textContent = JSON.stringify(result);
  return result;
}).catch((error) => {
  const result = { passed: false, failures: [error.message], checks: [], error: error.stack };
  document.querySelector('#result').textContent = JSON.stringify(result);
  return result;
});
