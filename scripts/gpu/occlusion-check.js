import * as THREE from 'three/webgpu';
import { GpuOcclusion } from '../../src/rendering/GpuOcclusion.js';
import { CinematicPipeline } from '../../src/rendering/CinematicPipeline.js';

const check = (condition, message) => { if (!condition) throw new Error(message); };

async function run() {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(256, 256);
  await renderer.init();
  const errors = [];
  renderer.backend.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const culling = new GpuOcclusion({ renderer, scene, camera }, { minTriangles: 1, minOccluderArea: 0, minSavedTriangles: 0 });
  const output = new THREE.RenderTarget(256, 256);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1), new THREE.MeshBasicNodeMaterial({ color: 0x777777 }));
  wall.position.z = -5;
  const geometry = new THREE.SphereGeometry(0.5, 32, 16);
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xff0000 });
  const hidden = new THREE.Mesh(geometry, material);
  hidden.position.z = -10;
  const visible = new THREE.Mesh(geometry, material);
  visible.position.set(1, 0, -3);
  scene.add(wall, hidden, visible);
  const draw = () => {
    renderer.setRenderTarget(output);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  };
  const args = async (mesh) => {
    const record = culling.active.get(mesh)?.get(null);
    if (!record) return null;
    return new Uint32Array(await renderer.getArrayBufferAsync(record.indirect));
  };
  const tests = [];
  try {
    draw();
    const baseline = await renderer.readRenderTargetPixelsAsync(output, 0, 0, 256, 256);
    culling.prepare();
    culling.render(draw);
    check((await args(hidden))[1] === 0, 'object behind wall was not culled');
    const visibleArgs = await args(visible);
    check(visibleArgs[1] === 1, `foreground object was culled: ${visibleArgs}`);
    const culled = await renderer.readRenderTargetPixelsAsync(output, 0, 0, 256, 256);
    check(baseline.every((value, i) => value === culled[i]), 'occlusion changed visible pixels');
    tests.push('hidden geometry suppressed; foreground and every visible pixel preserved');

    // No old-frame result can survive a camera cut.
    camera.position.z = -15;
    camera.lookAt(0, 0, -10);
    culling.prepare();
    culling.render(draw);
    check((await args(hidden))[1] === 1, 'camera cut retained stale occlusion');
    tests.push('camera cut reveals objects in the same frame');

    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    wall.material.transparent = true;
    wall.material.opacity = 0.5;
    culling.prepare();
    culling.render(draw);
    check((await args(hidden))?.[1] !== 0, 'transparent wall hid an object');
    tests.push('transparent surfaces do not act as solid occluders');

    wall.material.transparent = false;
    wall.material.opacity = 1;
    wall.material.alphaTest = 0.5;
    culling.prepare();
    culling.render(draw);
    check((await args(hidden))?.[1] !== 0, 'cutout wall hid an object');
    wall.material.alphaTest = 0;
    tests.push('cutout materials cannot fill occluder depth');

    const batch = new THREE.InstancedMesh(geometry, material, 2);
    const matrix = new THREE.Matrix4();
    batch.setMatrixAt(0, matrix.makeTranslation(-0.6, 0, -10));
    batch.setMatrixAt(1, matrix.makeTranslation(-0.6, 0, -12));
    scene.add(batch);
    culling.prepare();
    culling.render(draw);
    check((await args(batch))[1] === 0, 'hidden instanced batch was not culled');
    batch.setMatrixAt(0, matrix.makeTranslation(-5, 0, -10));
    batch.instanceMatrix.needsUpdate = true;
    culling.prepare();
    culling.render(draw);
    check((await args(batch))[1] === 2, 'moving one instance did not restore the complete batch');
    scene.remove(batch);
    batch.dispose();
    tests.push('instance counts and changed batch bounds are preserved');

    hidden.userData.occlusionBounds = new THREE.Box3(new THREE.Vector3(-8, -1, -11), new THREE.Vector3(8, 1, -9));
    culling.prepare();
    culling.render(draw);
    check((await args(hidden))[1] === 1, 'padded animated bounds were ignored');
    tests.push('animated bounds extending past an occluder remain visible');

    delete hidden.userData.occlusionBounds;
    hidden.position.set(0, 0, -0.15);
    culling.prepare();
    check(!culling.active.has(hidden), 'near-plane intersection should bypass occlusion');
    hidden.position.set(0, 0, -10);
    renderer.setSize(301, 199);
    culling.prepare();
    culling.render(draw);
    check((await args(hidden))[1] === 0, 'non-power-of-two resize broke depth reduction');
    tests.push('near-plane bypass and non-power-of-two resize');
    const post = new CinematicPipeline({ renderer, scene, camera }, {
      cinematic: { enabled: true, occlusion: { enabled: false }, post: {
        aoRadius: 1.4, aoStrength: 0.38, bloomStrength: 0.12, bloomThreshold: 1.8, saturation: 0.94, vignette: 0.12,
      } }, ui: { initialQuality: 'ultra' },
    });
    try {
      post.render();
      await renderer.backend.device.queue.onSubmittedWorkDone();
    } finally { post.dispose(); }
    tests.push('GTAO compiles with an antialiased WebGPU renderer');
    culling.settings.minSavedTriangles = 1e9;
    culling.frame = 0;
    culling.prepare();
    culling.render(draw);
    while (culling.reading) await new Promise((resolve) => setTimeout(resolve, 0));
    check(culling.cooldown > 0, 'low-benefit view did not enter backoff');
    culling.prepare();
    check(culling.active.size === 0, 'backoff reused old indirect visibility');
    culling.render(draw);
    tests.push('GPU statistics trigger backoff with ordinary draws');
    await renderer.backend.device.queue.onSubmittedWorkDone();
    check(errors.length === 0, errors.join('\n'));
    return { passed: true, tests, stats: culling.stats, errors };
  } catch (error) {
    throw new Error(`${error.message}\nGPU validation: ${errors.join('\n')}`, { cause: error });
  } finally {
    culling.dispose();
    output.dispose(); geometry.dispose(); material.dispose(); wall.geometry.dispose(); wall.material.dispose();
    await renderer.dispose();
  }
}

window.__occlusionCheck = run().catch((error) => ({ passed: false, error: error.stack }));
window.__occlusionCheck.then((result) => { document.querySelector('#result').textContent = JSON.stringify(result, null, 2); });
