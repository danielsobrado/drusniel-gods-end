import * as THREE from 'three/webgpu';
import { UnderstorySystem } from '../../src/foliage/UnderstorySystem.js';

export async function checkUnderstoryBillboards(renderer) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#18202a');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667755, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(5, 12, 8); scene.add(light);
  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 500);
  camera.position.set(0, 12, 40); camera.lookAt(0, 0, 0);
  const config = { ui: { initialPreset: 'green', initialQuality: 'high' }, cinematic: { enabled: false },
    assets: { foliage: { understory: new URL('../../Assets/terrain/understories/low_poly_stylized_plants_pack_free.glb', import.meta.url).href } },
    foliage: { understory: { count: 100, radius: 62, candidatesPerCell: 16 } },
    presets: { green: {}, off: { foliage: { understory: { enabled: false } } } },
    water: { position: [0, -10, 0] },
  };
  const understory = new UnderstorySystem({ scene, renderer, camera, config,
    terrain: { contains: () => true, sampleHeight: () => 0 },
    grass: { sampleVegetation: () => ({ density: 1, growth: 1, moisture: 1, path: 0, understory: 1 }) },
  });
  const checks = [], failures = [];
  const check = (condition, name) => { checks.push(name); if (!condition) failures.push(name); };
  await understory.init();
  check(understory.ready && understory.variants.length === 10, 'all ten production plant variants load and bake');
  const origin = new THREE.Vector3();
  const env = { grass: { blade: { windIntensity: 0 } } };
  try {
    for (const [index, variant] of understory.variants.entries()) {
      const atlas = variant.atlas;
      if (!atlas) { check(false, `variant ${index} has an atlas`); continue; }
      for (let view = 0; view < atlas.views; view++) {
        const pixels = await renderer.readRenderTargetPixelsAsync(atlas.target,
          view * atlas.tileSize, 0, atlas.tileSize, atlas.tileSize);
        let opaque = 0, transparent = 0;
        for (let p = 3; p < pixels.length; p += 4) { if (pixels[p] > 128) opaque++; else transparent++; }
        check(opaque > 20 && transparent > 20, `variant ${index} view ${view} contains a cutout silhouette`);
      }
    }
    understory.update(0.016, origin, env);
    const populated = { ...understory.stats };
    check(populated.plants > 0 && populated.near > 0 && populated.billboards > 0, 'real placement partitions into models and billboards');
    check(populated.triangles < populated.fullMeshTriangles, 'billboards reduce submitted triangles');
    renderer._nodes.nodeFrame.update(); await renderer.renderAsync(scene, camera);
    camera.position.set(100, 12, 100); camera.lookAt(0, 0, 0);
    understory.update(0.016, origin, env);
    check(understory.stats.near === 0 && understory.stats.billboards === populated.plants,
      'camera relocation replaces every distant model without changing placement');
    check(understory.stats.triangles === populated.plants * 2, 'distant plants cost two triangles each');
    camera.position.set(0, 12, 40); camera.lookAt(0, 0, 0);
    understory.update(0.016, origin, env);
    check(understory.stats.near === populated.near, 'moving back restores the nearby models');
    understory.setPreset('off'); understory.update(0.016, origin, env);
    check(understory.meshes.every(mesh => mesh.count === 0)
      && understory.variants.every(variant => variant.billboard.count === 0), 'disabled preset clears both representations');
    understory.setPreset('green'); understory.update(0.016, origin, env);
    check(understory.stats.plants === populated.plants, 're-enabling preserves deterministic placement');
    renderer._nodes.nodeFrame.update(); await renderer.renderAsync(scene, camera);
    // Leave the rendered field available for visual inspection until disposal.
    return { passed: failures.length === 0, failures, checks, stats: populated,
      backend: renderer.backend.constructor.name, dispose: () => understory.dispose(), scene, camera, understory };
  } catch (error) { understory.dispose(); throw error; }
}

if (globalThis.document?.querySelector?.('#results')) {
  window.__understoryBillboardCheck = (async () => {
    const renderer = new THREE.WebGPURenderer({ forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl' });
    await renderer.init(); renderer.setSize(900, 600); renderer._animation?.stop?.();
    document.body.appendChild(renderer.domElement);
    const result = await checkUnderstoryBillboards(renderer);
    window.__billboardReview = { ...result, renderer };
    const { passed, failures, checks, stats, backend } = result;
    const summary = { passed, failures, checkCount: checks.length, stats, backend };
    document.querySelector('#results').textContent = JSON.stringify(summary, null, 2);
    return summary;
  })();
}
