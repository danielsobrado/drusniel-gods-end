import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createGrassGeometry } from '../../src/grass/GrassGeometry.js';

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
window.bakeVegetation = async (key, tree) => {
  const draco = new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
  const { scene: root } = await new GLTFLoader().setDRACOLoader(draco).loadAsync(`/tmp/lod-bake/${key}.glb`);
  draco.dispose();
  const scene = new THREE.Scene(); scene.add(root); root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root), center = bounds.getCenter(new THREE.Vector3());
  const width = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 1.06;
  const height = (bounds.max.y - bounds.min.y) * 1.06;
  const size = tree ? 256 : 128, views = 8;
  const materials = [], originals = new Set(), textures = new Set();
  root.traverse(object => {
    if (!object.isMesh) return;
    const convert = source => {
      originals.add(source); for (const value of Object.values(source)) if (value?.isTexture) textures.add(value);
      const material = new THREE.MeshBasicMaterial({ map: source.map, color: source.color,
        vertexColors: source.vertexColors, side: THREE.DoubleSide, alphaTest: source.alphaTest || 0.1, toneMapped: false });
      materials.push(material); return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  renderer.setSize(size * views, size); renderer.setScissorTest(false); renderer.clear(); renderer.autoClear = false;
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.01, 2000);
  renderer.setScissorTest(true);
  for (let view = 0; view < views; view++) {
    const angle = view / views * Math.PI * 2;
    camera.position.copy(center).add(new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(Math.max(width, height) * 2 + 1));
    camera.lookAt(center);
    renderer.setViewport(view * size, 0, size, size); renderer.setScissor(view * size, 0, size, size);
    renderer.clearDepth(); renderer.render(scene, camera);
  }
  const png = renderer.domElement.toDataURL('image/png').split(',')[1];
  root.traverse(o => o.geometry?.dispose()); materials.forEach(m => m.dispose());
  originals.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
  return { png, width, height, center: center.toArray(), views, tileSize: size };
};

window.bakeGrassClumps = (shape) => {
  const size = 256, scene = new THREE.Scene();
  const source = createGrassGeometry({ type: 'blade', shape, density: 1, detail: 5, tileSize: 1, stable: true });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', source.attributes.position.clone()); geometry.setIndex(source.index.clone());
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
  const clump = new THREE.InstancedMesh(geometry, material, 180); scene.add(clump);
  const camera = new THREE.OrthographicCamera(-2.2, 2.2, 1.4, 0, 0.1, 10); camera.position.set(0, 0, 5);
  const object = new THREE.Object3D();
  renderer.setSize(size * 2, size * 2); renderer.setScissorTest(false); renderer.clear(); renderer.setScissorTest(true);
  for (let variant = 0; variant < 4; variant++) {
    let state = 2371 + variant * 107;
    const random = () => { state = Math.imul(state ^ (state >>> 15), 1 | state); state ^= state + Math.imul(state ^ (state >>> 7), 61 | state); return ((state ^ (state >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < 180; i++) {
      object.position.set((random() - 0.5) * 4, random() * 0.025, (random() - 0.5) * 0.25);
      object.scale.set(0.04 + random() * 0.09, 0.4 + random() * 0.95, 1);
      object.rotation.set(0, (random() - 0.5) * 1.2, (random() - 0.5) * 0.45);
      object.updateMatrix(); clump.setMatrixAt(i, object.matrix);
    }
    clump.instanceMatrix.needsUpdate = true;
    renderer.setViewport(variant % 2 * size, Math.floor(variant / 2) * size, size, size);
    renderer.setScissor(variant % 2 * size, Math.floor(variant / 2) * size, size, size);
    renderer.clearDepth(); renderer.render(scene, camera);
  }
  const png = renderer.domElement.toDataURL('image/png').split(',')[1];
  source.dispose(); geometry.dispose(); material.dispose(); clump.dispose(); return png;
};
