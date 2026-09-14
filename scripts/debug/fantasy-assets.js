import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { resolveTreeShape } from '../../src/world/TreeSystem.js';

window.__fantasyPreview = (async () => {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: window.location.search.includes('webgl') });
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#283530');
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xdde9ef, 0x474332, 2));
  const sun = new THREE.DirectionalLight(0xffe4bd, 3);
  sun.position.set(15, 30, 18); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 150 });
  sun.shadow.bias = -0.0002;
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardNodeMaterial({ color: '#777666', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true;
  scene.add(ground);
  const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const [lantern, tree] = await Promise.all(['lantern', 'tree1'].map(name => loader.loadAsync(`/Assets/terrain/fantasy/${name}.glb`)));
  const subject = new THREE.Group(); scene.add(subject);
  const treeSource = tree.scene.getObjectByName('Tree1_High');
  async function show(view) {
    subject.clear();
    ground.material.color.set(view === 'snow' ? '#dde8ed' : '#777666');
    if (view === 'snow') {
      const snowTrees = await Promise.all([10, 11].map(type => loader.loadAsync(`/Assets/terrain/fantasy/tree${type}.glb`)));
      for (let i = 0; i < 4; i++) {
        const type = i < 2 ? 10 : 11;
        const instance = snowTrees[type - 10].scene.getObjectByName(`Tree${type}_High`).clone();
        instance.position.x = (i - 1.5) * 10;
        instance.rotation.y = i * 1.9;
        instance.scale.copy(resolveTreeShape(i * 19, instance.position, { enabled: true, width: 0.22, depth: 0.18, height: 0.08 }));
        subject.add(instance);
      }
      camera.position.set(27, 18, 55); controls.target.set(0, 6, 0);
    } else if (view === 'lantern') {
      const lineup = lantern.scene.clone();
      lineup.children.forEach((object, index) => object.position.x = (index - 1) * 3.4);
      subject.add(lineup);
      camera.position.set(8, 5.8, 17); controls.target.set(0.5, 2.4, 0);
    } else {
      for (let i = 0; i < (view === 'trees' ? 3 : 1); i++) {
        const instance = treeSource.clone();
        instance.position.set(view === 'trees' ? (i - 1) * 26 : 0, 0, 0);
        instance.rotation.set(0, i * 1.9, 0);
        instance.scale.copy(resolveTreeShape(i * 19, instance.position, { enabled: true, width: 0.22, depth: 0.18, height: 0.08 }));
        subject.add(instance);
      }
      camera.position.set(...(view === 'trees' ? [60, 36, 100] : [7, 3.8, 10]));
      controls.target.set(0, view === 'trees' ? 16 : 1.4, 0);
    }
    subject.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    controls.update();
    document.querySelector('#caption').textContent = view === 'snow' ? 'Snow spruce · windswept mountain pine · individual shape variations' : view === 'lantern' ? 'Timber crossbeam · twisted woodland · braced roadside'
      : view === 'roots' ? 'Flared trunk · seven tapered, bark-textured roots' : 'Shared tree geometry · stable individual proportions';
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
  }
  for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => show(button.dataset.view);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  await show('lantern');
  return { show };
})();
