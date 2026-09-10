import * as THREE from 'three/webgpu';
import { createGrassGeometry } from '../../src/grass/GrassGeometry.js';
import { GrassMaterial } from '../../src/grass/GrassMaterial.js';

const SHAPES = ['slender', 'reed', 'broadleaf'];
const DETAILS = [1, 2, 3, 4, 5];
const TIMES = [0, 0.37, 1.1, 2.8];
const WIDTH = 256;
const HEIGHT = 256;

export function diffRgba(shared, duplicated) {
  const pixels = Math.min(shared.length, duplicated.length) / 4;
  let maxDelta = 0;
  let changed = 0;
  let sum = 0;
  for (let index = 0; index < pixels; index += 1) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(shared[index * 4 + channel] - duplicated[index * 4 + channel]);
      pixelDelta = Math.max(pixelDelta, delta);
    }
    maxDelta = Math.max(maxDelta, pixelDelta);
    sum += pixelDelta;
    if (pixelDelta > 0) changed += 1;
  }
  return {
    pixels,
    changed,
    changedShare: pixels ? changed / pixels : 0,
    maxDelta,
    meanDelta: pixels ? sum / pixels : 0,
  };
}

function grassParams() {
  return {
    bladeWidth: 0.12, bladeHeight: 1.2, bladeStiffness: 1.6, baseBend: 0.08,
    windIntensity: 1.1, windDirection: 35, windNoiseScale: 0.3, simulationSpeed: 1,
    sheen: 0.25, baseColor: '#3a5c32', tipColor: '#c8d48a',
  };
}

function solidTexture(r, g, b, a = 255) {
  const texture = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

function createMaterial(heightTexture, maskTexture, interactionTexture) {
  const terrain = {
    getShaderData() {
      return {
        texture: heightTexture,
        normalTexture: null,
        boundsMin: new THREE.Vector3(-20, 0, -20),
        boundsSize: new THREE.Vector3(40, 0, 40),
        minHeight: 0,
        maxHeight: 0,
      };
    },
  };
  return new GrassMaterial({
    painter: { enabled: false },
    grass: {
      type: 'blade',
      blade: grassParams(),
      billboard: grassParams(),
      maxDistance: 80,
      tileSize: 8,
    },
    cinematic: {
      enabled: true,
      style: { enabled: true, bladeHeightScaleMin: 0.88, bladeHeightScaleMax: 1.22 },
    },
    wind: { model: 'cinematic' },
  }, terrain, { vegetationTexture: maskTexture }, {
    getShaderData() {
      return { texture: interactionTexture, center: new THREE.Vector2(), worldSize: 12 };
    },
  }, 'blade');
}

async function readTarget(renderer, scene, camera, target) {
  renderer._nodes.nodeFrame.frameId++;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  return renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height);
}

async function gpuTimestamp(renderer) {
  if (!renderer.backend?.trackTimestamp || typeof renderer.resolveTimestampsAsync !== 'function') {
    return null;
  }
  try {
    const duration = await renderer.resolveTimestampsAsync('render');
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export async function compareBladeTopology(renderer) {
  const previous = renderer.getRenderTarget();
  const heightTexture = solidTexture(0, 0, 0);
  const maskTexture = solidTexture(0, 0, 0);
  const interactionTexture = solidTexture(0, 0, 0);
  const material = createMaterial(heightTexture, maskTexture, interactionTexture);
  const camera = new THREE.PerspectiveCamera(35, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 1.15, 4.2);
  camera.lookAt(0, 0.55, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const projectionView = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  material.setViewProjection(projectionView);
  material.setMaxDistance(80);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6b7c8a);
  const light = new THREE.DirectionalLight(0xfff4d8, 2.4);
  light.position.set(4, 8, 3);
  scene.add(light, new THREE.AmbientLight(0x88a0b8, 0.55));
  const mesh = new THREE.Mesh();
  scene.add(mesh);

  const target = new THREE.RenderTarget(WIDTH, HEIGHT);
  const comparisons = [];
  const timings = { shared: [], duplicated: [] };

  try {
    for (const shape of SHAPES) {
      for (const detail of DETAILS) {
        const shared = createGrassGeometry({
          type: 'blade', shape, detail, density: 4, tileSize: 8, bladeHeight: 1.2, stable: true,
        });
        const duplicated = createGrassGeometry({
          type: 'blade', shape, detail, density: 4, tileSize: 8, bladeHeight: 1.2, stable: true,
          shareVertices: false,
        });
        const vertexCounts = {
          shared: shared.getAttribute('position').count,
          duplicated: duplicated.getAttribute('position').count,
        };
        for (const time of TIMES) {
          material.setFrame(time, camera.position);
          mesh.material = material.material;
          mesh.geometry = shared;
          const sharedPixels = await readTarget(renderer, scene, camera, target);
          const sharedGpu = await gpuTimestamp(renderer);
          mesh.geometry = duplicated;
          const duplicatedPixels = await readTarget(renderer, scene, camera, target);
          const duplicatedGpu = await gpuTimestamp(renderer);
          const diff = diffRgba(sharedPixels, duplicatedPixels);
          comparisons.push({ shape, detail, time, ...diff, vertexCounts });
          if (sharedGpu != null) timings.shared.push(sharedGpu);
          if (duplicatedGpu != null) timings.duplicated.push(duplicatedGpu);
        }
        shared.dispose();
        duplicated.dispose();
      }
    }
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    material.dispose();
    heightTexture.dispose();
    maskTexture.dispose();
    interactionTexture.dispose();
  }

  const maxDelta = Math.max(0, ...comparisons.map((entry) => entry.maxDelta));
  const changedShare = Math.max(0, ...comparisons.map((entry) => entry.changedShare));
  const median = (values) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return {
    backend: renderer.backend?.constructor?.name ?? null,
    comparisons,
    maxDelta,
    changedShare,
    timings: {
      sharedMedianMs: median(timings.shared),
      duplicatedMedianMs: median(timings.duplicated),
      samples: timings.shared.length,
    },
    passed: maxDelta <= 1,
  };
}

if (globalThis.document?.querySelector?.('#results')) {
  window.__bladeTopologyCheck = (async () => {
    const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';
    const renderer = new THREE.WebGPURenderer({ forceWebGL, trackTimestamp: true });
    await renderer.init();
    renderer._animation?.stop?.();
    try {
      const result = await compareBladeTopology(renderer);
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { renderer.dispose(); }
  })();
}
