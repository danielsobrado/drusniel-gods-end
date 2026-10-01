import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createGrassGeometry } from '../../src/grass/GrassGeometry.js';

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0, 0);
document.body.append(renderer.domElement);

function colorMaterial(source, materials, originals, textures) {
  originals.add(source);
  for (const value of Object.values(source)) if (value?.isTexture) textures.add(value);
  const material = new THREE.MeshBasicMaterial({
    map: source.map,
    color: source.color,
    vertexColors: source.vertexColors,
    side: THREE.DoubleSide,
    alphaTest: source.alphaTest || 0.1,
    toneMapped: false,
  });
  materials.push(material);
  return material;
}

function normalMaskMaterial(source, geometry, materials) {
  const hasMap = Boolean(source.map && geometry.getAttribute('uv'));
  const foliage = source.alphaTest > 0 || source.transparent === true || source.alphaHash === true;
  const material = new THREE.ShaderMaterial({
    defines: hasMap ? { USE_COVERAGE_MAP: 1 } : {},
    uniforms: {
      coverageMap: { value: source.map ?? null },
      alphaCutoff: { value: source.alphaTest || (foliage ? 0.01 : 0) },
      foliageMask: { value: foliage ? 1 : 0 },
    },
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    toneMapped: false,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalView;
      void main() {
        vUv = uv;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D coverageMap;
      uniform float alphaCutoff;
      uniform float foliageMask;
      varying vec2 vUv;
      varying vec3 vNormalView;
      void main() {
        float coverage = 1.0;
        #ifdef USE_COVERAGE_MAP
          coverage = texture2D(coverageMap, vUv).a;
        #endif
        if (coverage <= alphaCutoff) discard;
        vec3 normalView = normalize(vNormalView);
        if (normalView.z < 0.0) normalView = -normalView;
        gl_FragColor = vec4(normalView.xy * 0.5 + 0.5, foliageMask, coverage);
      }
    `,
  });
  materials.push(material);
  return material;
}

function assignMaterials(root, factory) {
  root.traverse(object => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(source => factory(source, object.geometry))
      : factory(object.material, object.geometry);
  });
}

function renderViews(scene, camera, center, width, height, size, views, gutter = 0) {
  renderer.setSize(size * views, size);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  for (let view = 0; view < views; view += 1) {
    const angle = view / views * Math.PI * 2;
    camera.position.copy(center).add(
      new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
        .multiplyScalar(Math.max(width, height) * 2 + 1),
    );
    camera.lookAt(center);
    const innerSize = size - gutter * 2;
    renderer.setViewport(view * size + gutter, gutter, innerSize, innerSize);
    renderer.setScissor(view * size + gutter, gutter, innerSize, innerSize);
    renderer.clearDepth();
    renderer.render(scene, camera);
  }
}

window.bakeVegetation = async (key, tree, capture = null) => {
  const draco = new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
  const { scene: root } = await new GLTFLoader().setDRACOLoader(draco).loadAsync(`/tmp/lod-bake/${key}.glb`);
  draco.dispose();
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root), center = bounds.getCenter(new THREE.Vector3());
  const width = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 1.06;
  const height = (bounds.max.y - bounds.min.y) * 1.06;
  const size = tree ? Number(capture?.tileSize ?? 256) : 128;
  const views = tree ? Number(capture?.views ?? 8) : 8;
  const gutter = tree ? Number(capture?.gutter ?? 0) : 0;
  if (!Number.isInteger(gutter) || gutter < 0 || gutter * 2 >= size) {
    throw new Error(`Invalid tree impostor gutter: ${gutter}`);
  }
  const colorMaterials = [], normalMaterials = [], originals = new Set(), textures = new Set();
  const sourceMaterials = new Map();
  root.traverse(object => {
    if (!object.isMesh) return;
    sourceMaterials.set(object, object.material);
  });

  assignMaterials(root, source => colorMaterial(source, colorMaterials, originals, textures));
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.01, 2000);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderViews(scene, camera, center, width, height, size, views, gutter);
  const png = renderer.domElement.toDataURL('image/png').split(',')[1];

  let normalMaskPng = null;
  if (tree) {
    root.traverse(object => {
      if (!object.isMesh) return;
      object.material = sourceMaterials.get(object);
    });
    assignMaterials(root, (source, geometry) => normalMaskMaterial(source, geometry, normalMaterials));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(new THREE.Color(0.5, 0.5, 0), 0);
    renderViews(scene, camera, center, width, height, size, views, gutter);
    normalMaskPng = renderer.domElement.toDataURL('image/png').split(',')[1];
  }

  root.traverse(object => object.geometry?.dispose());
  colorMaterials.forEach(material => material.dispose());
  normalMaterials.forEach(material => material.dispose());
  originals.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
  return { png, normalMaskPng, width, height, center: center.toArray(), views, tileSize: size, gutter };
};

window.bakeGrassClumps = (shape) => {
  const size = 256, scene = new THREE.Scene();
  const source = createGrassGeometry({ type: 'blade', shape, density: 1, detail: 5, tileSize: 1, stable: true });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', source.attributes.position.clone());
  geometry.setIndex(source.index.clone());
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
  const clump = new THREE.InstancedMesh(geometry, material, 180);
  scene.add(clump);
  const camera = new THREE.OrthographicCamera(-2.2, 2.2, 1.4, 0, 0.1, 10);
  camera.position.set(0, 0, 5);
  const object = new THREE.Object3D();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(size * 2, size * 2);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  for (let variant = 0; variant < 4; variant += 1) {
    let state = 2371 + variant * 107;
    const random = () => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 180; i += 1) {
      object.position.set((random() - 0.5) * 4, random() * 0.025, (random() - 0.5) * 0.25);
      object.scale.set(0.04 + random() * 0.09, 0.4 + random() * 0.95, 1);
      object.rotation.set(0, (random() - 0.5) * 1.2, (random() - 0.5) * 0.45);
      object.updateMatrix();
      clump.setMatrixAt(i, object.matrix);
    }
    clump.instanceMatrix.needsUpdate = true;
    renderer.setViewport(variant % 2 * size, Math.floor(variant / 2) * size, size, size);
    renderer.setScissor(variant % 2 * size, Math.floor(variant / 2) * size, size, size);
    renderer.clearDepth();
    renderer.render(scene, camera);
  }
  const png = renderer.domElement.toDataURL('image/png').split(',')[1];
  source.dispose();
  geometry.dispose();
  material.dispose();
  clump.dispose();
  return png;
};
