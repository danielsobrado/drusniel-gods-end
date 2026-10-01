import * as THREE from 'three/webgpu';
import { attribute, positionLocal, vec4 } from 'three/tsl';
import { MeadowDetails } from '../../src/foliage/MeadowDetails.js';

// Read the production vertex deformation back as floating-point pixels. Only
// projection and shading are replaced; Three's instancing and positionNode run
// normally, so changes to their ordering are covered by this regression check.
export async function checkMeadowRendering(renderer) {
  const previous = renderer.getRenderTarget();
  const scene = new THREE.Scene();
  const radius = 80;
  const meadow = new MeadowDetails(scene, {
    cinematic: { vegetation: { radius, count: 1, backlight: 0 } },
    ui: { initialQuality: 'high' },
  }, {}, {}, {});
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  const target = new THREE.RenderTarget(64, 1, { type: THREE.FloatType, depthBuffer: false });
  const dummy = new THREE.Object3D();
  const tests = [];
  const failures = [];
  const check = (condition, message) => { (condition ? tests : failures).push(message); };
  const close = (a, b) => a.distanceTo(b) < 0.0002;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('probeClip', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute('detailOrigin', new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
  const probe = new THREE.InstancedMesh(geometry, undefined, 1);
  probe.material.dispose();
  probe.frustumCulled = false;
  scene.add(probe);
  for (const mesh of meadow.meshes.values()) mesh.visible = false;

  const read = async (point, origin, { wind = 1, time = 0.7, distance = 5 } = {}) => {
    for (let i = 0; i < 3; i++) geometry.attributes.position.setXYZ(i, ...point);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.detailOrigin.setXYZ(0, origin.x, origin.y + 0.015, origin.z);
    geometry.attributes.detailOrigin.needsUpdate = true;
    dummy.position.copy(origin);
    dummy.updateMatrix();
    probe.setMatrixAt(0, dummy.matrix);
    probe.instanceMatrix.needsUpdate = true;
    camera.position.copy(origin).add(new THREE.Vector3(0, 2, distance));
    meadow.clock.value = time;
    meadow.wind.value = wind;
    renderer._nodes.nodeFrame.frameId++;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 1);
    return new THREE.Vector3().fromArray(pixels);
  };

  try {
    for (const [type, mesh] of meadow.meshes) {
      const material = mesh.material;
      material.vertexNode = vec4(attribute('probeClip', 'vec3'), 1);
      material.fragmentNode = vec4(positionLocal, 1);
      material.depthTest = false;
      material.depthWrite = false;
      material.toneMapped = false;
      probe.material = material;
      dummy.rotation.set(0, 0.8, 0);
      dummy.scale.set(1.4, 0.8, 1.1);
      const staticDetail = type === 'litter' || String(type).startsWith('stone');
      const point = [0.13, mesh.geometry.boundingBox.max.y, 0.07];
      let baselineMotion;
      for (const elevation of [0, 20, 80]) {
        const origin = new THREE.Vector3(23, elevation, -17);
        for (const time of [0, 0.7, 1.9]) {
          const root = await read([0, 0, 0], origin, { time });
          check(close(root, origin), `${type}: root stays anchored at elevation ${elevation}, time ${time}`);
        }
        const still = await read(point, origin, { wind: 0 });
        const animated = await read(point, origin);
        const motion = animated.clone().sub(still);
        if (!baselineMotion) baselineMotion = motion;
        check(close(motion, baselineMotion), `${type}: sway is independent of terrain elevation ${elevation}`);
        check(staticDetail ? motion.length() < 0.0002 : motion.length() > 0.0001 && motion.length() < 0.6,
          `${type}: ${staticDetail ? 'ground detail remains still' : 'tip sways gently'} at elevation ${elevation}`);
        check(close(await read(point, origin, { wind: -1 }), still), `${type}: negative wind stays calm at elevation ${elevation}`);
        check(close(await read(point, origin, { wind: 8 }), await read(point, origin, { wind: 3 })),
          `${type}: maximum wind remains capped at elevation ${elevation}`);

        // The middle of the smoothstep ring has exactly half scale. Both the
        // complete animated shape and static details must shrink around the root.
        const halfway = await read(point, origin, { distance: radius - 9 });
        check(close(halfway, origin.clone().lerp(animated, 0.5)), `${type}: distance fade preserves the planted origin at elevation ${elevation}`);
        check(close(await read(point, origin, { distance: radius }), origin), `${type}: outer ring collapses to the root at elevation ${elevation}`);
      }
    }
    return { passed: failures.length === 0, checks: tests.length + failures.length, failures };
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    geometry.dispose();
    probe.dispose();
    meadow.dispose();
  }
}

if (document.querySelector('#results')) {
  window.__meadowCheck = (async () => {
    const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';
    const renderer = new THREE.WebGPURenderer({ forceWebGL });
    await renderer.init();
    renderer._animation.stop();
    try {
      const result = await checkMeadowRendering(renderer);
      result.backend = renderer.backend.constructor.name;
      document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
      return result;
    } finally { await renderer.dispose(); }
  })();
}
