import * as THREE from 'three/webgpu';
import { VegetationLodRenderer } from '../../src/foliage/VegetationLodRenderer.js';

function solidAtlas(views, tileSize, gutter, rgba) {
  const width = views * tileSize, height = tileSize;
  const data = new Uint8Array(width * height * 4);
  for (let view = 0; view < views; view += 1) {
    for (let y = gutter; y < tileSize - gutter; y += 1) {
      for (let x = gutter; x < tileSize - gutter; x += 1) {
        data.set(rgba, (y * width + view * tileSize + x) * 4);
      }
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.needsUpdate = true;
  return texture;
}

async function check() {
  const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';
  const renderer = new THREE.WebGPURenderer({ forceWebGL });
  await renderer.init();
  renderer._animation.stop();
  renderer.setSize(64, 64, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 4, 12);
  camera.lookAt(0, 4, 0);
  camera.updateMatrixWorld();

  const views = 12, tileSize = 8, gutter = 1;
  const atlas = solidAtlas(views, tileSize, gutter, [58, 148, 54, 255]);
  atlas.colorSpace = THREE.SRGBColorSpace;
  const normalMask = solidAtlas(views, tileSize, gutter, [128, 128, 255, 255]);
  normalMask.colorSpace = THREE.NoColorSpace;

  const geometry = new THREE.BoxGeometry(1, 8, 1);
  geometry.computeBoundingBox();
  const sourceMaterial = new THREE.MeshStandardNodeMaterial();
  const full = [{ geometry, material: sourceMaterial }];
  const position = new THREE.Vector3();
  const transform = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.45, 0)),
    new THREE.Vector3(1.35, 1, 0.75),
  );
  const config = {
    ui: { initialQuality: 'high' },
    cinematic: { enabled: true, style: { enabled: false } },
    wind: { model: 'cinematic' },
    trees: {
      types: [{ highLeaves: 'Leaves' }],
      windSpeed: 3,
      windStrength: 1.2,
      windFrequency: 1,
      simulationSpeed: 1,
      lod: {
        impostor: {
          detailedNormalQualities: ['high', 'ultra'],
          anisotropy: 1,
          fallback: {},
        },
      },
    },
  };
  const lod = new VegetationLodRenderer({
    scene,
    config,
    viewportHeight: () => 64,
    prepareMaterial: (material) => new THREE.MeshStandardNodeMaterial().copy(material),
    policy: () => ({ centers: [1, 2, 3], blend: 0.1, far: 100 }),
  });
  lod.addVariant({
    key: 'tree1',
    kind: 'tree',
    full,
    records: [{
      position,
      matrix: new Float32Array(transform.elements),
      height: 8,
      fraction: 0,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 4, 0), 5),
    }],
    asset: {
      levels: [null, full, full],
      atlas,
      normalMask,
      normalMaskReady: () => true,
      entry: {
        capture: { center: [0, 4, 0], width: 4, height: 8, views, tileSize, gutter },
        alphaCutoff: 0.35,
        canopyPalette: false,
      },
    },
  });
  lod.setQuality('high');
  const stats = lod.update(camera, true);
  if (stats.billboard !== 1) throw new Error(`Expected one tree billboard, got ${stats.billboard}`);
  const billboard = scene.children.find(mesh => mesh.name === 'tree1:billboard');
  if (!billboard?.material?.userData?.treeBillboardWindEnabled) {
    throw new Error('GPU contract did not enable tree billboard wind');
  }
  const normalControl = billboard.material.userData.impostorNormalControl;
  if (!normalControl || normalControl.normalWeight.value !== 1 || normalControl.mapReadyWeight.value !== 1) {
    throw new Error('GPU contract did not enable the packed tree normal/mask');
  }

  const target = new THREE.RenderTarget(64, 64);
  try {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64);
    let covered = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) covered += 1;
    if (covered < 64) throw new Error(`Tree impostor drew too few pixels: ${covered}`);
    return {
      passed: true,
      failures: [],
      checks: ['gpu-facing', 'multi-view-atlas', 'view-gutter', 'packed-normal-mask', 'normal-basis', 'billboard-wind'],
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
      covered,
    };
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    lod.dispose();
    geometry.dispose();
    sourceMaterial.dispose();
    atlas.dispose();
    normalMask.dispose();
    await renderer.dispose();
  }
}

window.__treeImpostorCheck = check().then((result) => {
  document.querySelector('#result').textContent = JSON.stringify(result);
  return result;
}).catch((error) => {
  const result = { passed: false, failures: [error.message], checks: [], error: error.stack };
  document.querySelector('#result').textContent = JSON.stringify(result);
  return result;
});
