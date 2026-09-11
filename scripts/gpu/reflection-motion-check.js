import * as THREE from 'three/webgpu';
import { reflector } from 'three/tsl';
import { ReflectionBudget } from '../../src/water/ReflectionBudget.js';
import { createCinematicWaterMaterial } from '../../src/water/WaterMaterial.js';
import { createWaterGeometry } from '../../src/water/waterGeometry.js';

// Compare the production water shader during deterministic camera motion with
// an unthrottled reference. Freeze waves and scene objects to isolate captures.
export async function checkReflectionMotion(renderer) {
  const size = 128;
  const params = { position: [0, 0, 0], size: 100, segments: 8 };
  const ground = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  ground.needsUpdate = true;
  const face = document.createElement('canvas'); face.width = face.height = 1;
  const context = face.getContext('2d'); context.fillStyle = '#789eaf'; context.fillRect(0, 0, 1, 1);
  const reflection = new THREE.CubeTexture(Array(6).fill(face)); reflection.needsUpdate = true;
  const placeholder = new THREE.Texture();
  const planar = reflector({ bounces: false, defaultTexture: placeholder });
  planar.target.rotation.x = -Math.PI / 2;
  const shader = createCinematicWaterMaterial({ params, reflection, planar,
    terrain: { texture: ground, boundsMin: new THREE.Vector3(-100, -20, -100),
      boundsSize: new THREE.Vector3(200, 1, 200), minHeight: -20, maxHeight: -19 },
  });
  const geometry = createWaterGeometry(params), mesh = new THREE.Mesh(geometry, shader.material);
  mesh.add(planar.target);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#172635'); scene.add(mesh);
  const markerGeometry = new THREE.BoxGeometry(2, 8, 2);
  const markerMaterial = new THREE.MeshBasicNodeMaterial({ color: '#ffffff' });
  for (const x of [-6, 0, 6]) {
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    marker.position.set(x, 4, -5); scene.add(marker);
  }
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  const target = new THREE.RenderTarget(size, size);
  const previousTarget = renderer.getRenderTarget();
  const update = planar.reflector.updateBefore.bind(planar.reflector);
  let budget, unthrottled, now, captures, quality;
  planar.reflector.updateBefore = frame => {
    if (frame.camera !== camera) return;
    if (unthrottled || budget.shouldRender(camera, quality, now)) { update(frame); captures++; }
  };
  const motion = {
    translation: frame => { camera.position.x += frame * 0.25; },
    rotation: frame => { camera.rotateY(frame * 0.012); },
    slowTranslation: frame => { camera.position.x += frame * 0.01; },
    slowRotation: frame => { camera.rotateY(frame * 0.001); },
    projection: frame => { camera.fov += frame * 0.3; camera.updateProjectionMatrix(); },
  };
  const run = async (pose, fresh, qualityName) => {
    budget = new ReflectionBudget(); unthrottled = fresh; captures = 0;
    quality = qualityName;
    shader.uniforms.rich.value = quality === 'ultra' ? 1 : 0;
    const frames = [];
    for (let frame = 0; frame < 8; frame++) {
      now = frame * 1000 / 60;
      camera.fov = 55; camera.updateProjectionMatrix();
      camera.position.set(0, 5, 20); camera.lookAt(0, 0, -5); pose(frame);
      // The test owns the frame clock because the renderer animation is stopped.
      renderer._nodes.nodeFrame.update();
      renderer.setRenderTarget(target);
      await renderer.renderAsync(scene, camera);
      frames.push(await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size));
    }
    return { frames, captures };
  };
  const checks = [];
  try {
    for (const quality of ['ultra', 'high', 'balanced', 'performance']) for (const [name, pose] of Object.entries(motion)) {
      const actual = await run(pose, false, quality), reference = await run(pose, true, quality);
      let differingPixels = 0, maxDifference = 0;
      for (let frame = 0; frame < actual.frames.length; frame++) {
        const a = actual.frames[frame], b = reference.frames[frame];
        for (let i = 0; i < a.length; i += 4) {
          const difference = Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c])));
          maxDifference = Math.max(maxDifference, difference);
          if (difference > 1) differingPixels++;
        }
      }
      const expectedCaptures = quality === 'ultra' ? 8 : 0;
      checks.push({ name: `${quality} ${name}`, passed: differingPixels === 0
        && actual.captures === expectedCaptures && reference.captures === 8,
        differingPixels, maxDifference, captures: actual.captures, referenceCaptures: reference.captures });
    }
    return { passed: checks.every(check => check.passed), checks, backend: renderer.backend.constructor.name };
  } finally {
    renderer.setRenderTarget(previousTarget);
    shader.dispose(); geometry.dispose(); ground.dispose(); reflection.dispose();
    planar.dispose(); placeholder.dispose(); markerGeometry.dispose(); markerMaterial.dispose(); target.dispose();
  }
}

if (globalThis.document?.querySelector?.('#results')) {
  window.__reflectionMotionCheck = (async () => {
    const renderer = new THREE.WebGPURenderer({ forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl' });
    await renderer.init(); renderer.setSize(128, 128); renderer._animation?.stop?.();
    try {
      const result = await checkReflectionMotion(renderer);
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { renderer.dispose(); }
  })();
}
