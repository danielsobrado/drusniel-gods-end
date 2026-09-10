import * as THREE from 'three/webgpu';
import { GrassMaterial } from '../../src/grass/GrassMaterial.js';

const RECOVERED_HEIGHT_HASH = '24634.6345';

function shaderHasHeightHash(text) {
  return text.includes(RECOVERED_HEIGHT_HASH) || text.includes('24634.63') || text.includes('24634');
}

export async function captureShaderPrograms(renderer, work) {
  const backend = renderer.backend;
  const hadOwn = Object.hasOwn(backend, 'createProgram');
  const original = backend.createProgram;
  const codes = [];
  backend.createProgram = function createProgram(program) {
    if (typeof program?.code === 'string' && program.code) codes.push(program.code);
    return original.call(this, program);
  };
  try {
    await work();
    return codes;
  } finally {
    if (hadOwn) backend.createProgram = original;
    else delete backend.createProgram;
  }
}

function createGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3));
  geometry.setAttribute('instanceRotation', new THREE.InstancedBufferAttribute(new Float32Array([0, 1]), 2));
  geometry.setAttribute('instanceData', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 0.5]), 4));
  geometry.setAttribute('bladeSide', new THREE.Float32BufferAttribute([1, 1, 1, 1], 1));
  return geometry;
}

async function compileShaders(renderer, material) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 2;
  const geometry = createGeometry();
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  scene.add(mesh);
  try {
    return await captureShaderPrograms(renderer, async () => {
      await renderer.compileAsync(scene, camera);
      renderer.render(scene, camera);
    });
  } finally {
    mesh.removeFromParent();
    geometry.dispose();
    mesh.dispose?.();
  }
}

export async function checkGrassShaders(renderer) {
  const texture = new THREE.Texture();
  const terrain = {
    getShaderData() {
      return {
        texture,
        normalTexture: texture,
        boundsMin: new THREE.Vector3(-10, 0, -10),
        boundsSize: new THREE.Vector3(20, 4, 20),
        minHeight: 0,
        maxHeight: 4,
      };
    },
  };
  const mask = { vegetationTexture: texture };
  const interaction = {
    getShaderData() {
      return { texture, center: new THREE.Vector2(), worldSize: 12 };
    },
  };
  const grass = {
    type: 'blade',
    blade: {
      bladeWidth: 0.12, bladeHeight: 1, bladeStiffness: 1.6, baseBend: 0.08,
      windIntensity: 1.1, windDirection: 35, windNoiseScale: 0.3, simulationSpeed: 1,
      sheen: 0.25, baseColor: '#3a5c32', tipColor: '#c8d48a',
    },
    billboard: {
      bladeWidth: 0.4, bladeHeight: 1, bladeStiffness: 3, baseBend: 0,
      windIntensity: 1.1, windDirection: 35, windNoiseScale: 0.3, simulationSpeed: 1,
      sheen: 0.25, baseColor: '#3a5c32', tipColor: '#c8d48a',
    },
    maxDistance: 80, tileSize: 25,
  };
  const cinematic = new GrassMaterial({
    painter: { enabled: false },
    grass,
    cinematic: { enabled: true, style: { enabled: true, bladeHeightScaleMin: 0.88, bladeHeightScaleMax: 1.22 } },
    wind: { model: 'cinematic' },
  }, terrain, mask, interaction, 'blade');
  const recovered = new GrassMaterial({
    painter: { enabled: false },
    grass,
    cinematic: { enabled: false },
    wind: { model: 'recovered' },
  }, terrain, mask, interaction, 'blade');

  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(cinematic.shaderFeatures.recoveredWind === false, 'cinematic construction still includes recovered wind');
  check(cinematic.shaderFeatures.recoveredHeightVariation === false, 'cinematic construction still includes recovered height hashes');
  check(cinematic.shaderFeatures.cinematicHeight === true, 'cinematic height variation missing');
  check(cinematic.shaderFeatures.sharedTerrainSample === true, 'shared terrain sample flag missing');
  check(cinematic.shaderFeatures.skipDeformWhenInvisible === true, 'invisible skip flag missing');
  check(recovered.shaderFeatures.recoveredWind === true, 'recovered wind model dropped recovered wind');

  const cinematicShaders = await compileShaders(renderer, cinematic.material);
  check(cinematicShaders.length > 0, 'failed to capture compiled cinematic shaders');
  check(!shaderHasHeightHash(cinematicShaders.join('\n')),
    'compiled cinematic shader still contains recovered height hash');

  const recoveredShaders = await compileShaders(renderer, recovered.material);
  check(recoveredShaders.length > 0, 'failed to capture compiled recovered shaders');
  check(shaderHasHeightHash(recoveredShaders.join('\n')),
    'compiled recovered shader lost the height hash constant');

  cinematic.dispose();
  recovered.dispose();
  return {
    passed: failures.length === 0,
    failures,
    shaderChunks: cinematicShaders.length + recoveredShaders.length,
    features: cinematic.shaderFeatures,
  };
}

if (globalThis.document?.querySelector?.('#results')) {
  window.__grassShaderCheck = (async () => {
    const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';
    const renderer = new THREE.WebGPURenderer({ forceWebGL });
    await renderer.init();
    renderer._animation?.stop?.();
    try {
      const result = await checkGrassShaders(renderer);
      result.backend = renderer.backend.constructor.name;
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { renderer.dispose(); }
  })();
}
