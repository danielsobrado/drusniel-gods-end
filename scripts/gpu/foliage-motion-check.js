import * as THREE from 'three/webgpu';
import { prepareCoastalJungleMaterial } from '../../src/biome/CoastalJungleMaterial.js';
import { getSharedWindUniforms } from '../../src/weather/WindField.js';
import { VegetationLodRenderer } from '../../src/foliage/VegetationLodRenderer.js';

// Culling and LOD compaction change a surviving plant's instance index. With
// time frozen, moving it between slots must leave the rendered plant unchanged.
window.__foliageMotionCheck = (async () => {
  const renderer = new THREE.WebGPURenderer({ forceWebGL: window.location.search.includes('webgl') });
  await renderer.init(); renderer._animation.stop();
  const shared = getSharedWindUniforms(), previousSpeed = shared.simulationSpeed.value;
  shared.simulationSpeed.value = 0;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 20);
  camera.position.set(0, 2, 5); camera.lookAt(0, 2, 0);
  const geometry = new THREE.PlaneGeometry(0.2, 0.5);
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  material.name = 'jungle_leaf_atlas';
  prepareCoastalJungleMaterial(material, { kind: 'shrub', instanced: true, settings: { haze: { enabled: false } } });
  // Exercise both Three's small uniform matrix array and large vertex-buffer
  // instancing path; both use explicit version updates in the LOD renderer.
  const meshes = [64, 2048].map(capacity => {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false; return mesh;
  });
  let mesh;
  const target = new THREE.RenderTarget(256, 256);
  const secondTarget = new THREE.RenderTarget(256, 256);
  let lod;
  const anchor = new THREE.Matrix4().makeTranslation(0, 2, 0);
  const hidden = new THREE.Matrix4().makeTranslation(100, 2, 0);
  const capture = async slot => {
    mesh.count = slot + 1;
    for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, i === slot ? anchor : hidden);
    mesh.instanceMatrix.needsUpdate = true;
    renderer._nodes.nodeFrame.frameId++;
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
    return new Uint8Array(pixels);
  };
  try {
    const differences = [];
    const silhouettes = [];
    for (mesh of meshes) {
      scene.add(mesh);
      const baseline = await capture(0);
      let visiblePixels = 0;
      for (let i = 0; i < baseline.length; i += 4) if (baseline[i] > 8) visiblePixels++;
      silhouettes.push(visiblePixels);
      for (const slot of [1, 7, 31, 0]) {
        const pixels = await capture(slot);
        let changed = 0;
        for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - baseline[i]) > 8) changed++;
        differences.push({ capacity: mesh.instanceMatrix.count, slot, changed });
      }
      mesh.removeFromParent();
    }
    lod = new VegetationLodRenderer({ scene, config: {},
      prepareMaterial: () => new THREE.MeshStandardNodeMaterial(),
      policy: () => ({ centers: [20], far: 100 }) });
    const position = new THREE.Vector3(0, 2, 0);
    lod.addVariant({ key: 'upload', full: [{ geometry, material }],
      records: [{ position, matrix: new Float32Array(anchor.elements), fraction: 0,
        sphere: new THREE.Sphere(position, 1) }] });
    lod.update(camera);
    const interval = lod.chunks[0].draws[0].interval;
    const renderPass = renderTarget => {
      renderer._nodes.nodeFrame.frameId++;
      renderer.setRenderTarget(renderTarget); renderer.render(scene, camera);
    };
    renderPass(target); renderPass(secondTarget);
    const originalUpdate = renderer.backend.updateAttribute;
    let uploads = 0;
    renderer.backend.updateAttribute = function (attribute, ...args) {
      if (attribute === interval) uploads++;
      return originalUpdate.call(this, attribute, ...args);
    };
    const uploadCounts = [];
    try {
      camera.position.x += 0.1; lod.update(camera);
      for (const renderTarget of [target, secondTarget, target]) {
        const before = uploads; renderPass(renderTarget); uploadCounts.push(uploads - before);
      }
    } finally { renderer.backend.updateAttribute = originalUpdate; }
    return { passed: silhouettes.every(count => count > 100) && differences.every(result => result.changed === 0)
        && uploadCounts[0] === 1 && uploadCounts.slice(1).every(count => count === 0), silhouettes, differences, uploadCounts,
      backend: renderer.backend.constructor.name };
  } finally {
    shared.simulationSpeed.value = previousSpeed;
    lod?.dispose(); meshes.forEach(mesh => mesh.dispose());
    geometry.dispose(); material.dispose(); target.dispose(); secondTarget.dispose(); await renderer.dispose();
  }
})().catch(error => ({ passed: false, error: error.stack }));
window.__foliageMotionCheck.then(result => { document.querySelector('#results').textContent = JSON.stringify(result, null, 2); });
