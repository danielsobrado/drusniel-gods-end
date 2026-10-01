import * as THREE from 'three/webgpu';
import { CinematicPipeline } from '../../src/rendering/CinematicPipeline.js';

function hookCreations(renderer) {
  const records = [];
  const restores = [];
  const wrap = (target, name, objectOf) => {
    const original = target?.[name];
    if (typeof original !== 'function') return;
    target[name] = function (...args) {
      const object = objectOf(args);
      records.push({
        kind: name,
        object,
        name: object?.name ?? null,
      });
      return original.apply(this, args);
    };
    restores.push(() => { target[name] = original; });
  };
  wrap(renderer.backend, 'createRenderPipeline', (args) => args[0]?.object ?? null);
  wrap(renderer.backend, 'createProgram', () => null);

  const previousNodeBuilderHook = renderer.debug.onNodeBuilderCreated;
  const nodeBuilderHook = (builder, target) => {
    previousNodeBuilderHook?.(builder, target);
    const object = target?.object ?? null;
    records.push({ kind: 'nodeBuilder', object, name: object?.name ?? null });
  };
  renderer.debug.onNodeBuilderCreated = nodeBuilderHook;
  restores.push(() => {
    if (renderer.debug.onNodeBuilderCreated === nodeBuilderHook) {
      renderer.debug.onNodeBuilderCreated = previousNodeBuilderHook;
    }
  });

  return {
    records,
    forObject(object) { return records.filter((entry) => entry.object === object); },
    restore() { for (const restore of restores) restore(); },
  };
}

function cinematicConfig(enabled, temporal = false) {
  return {
    cinematic: {
      enabled,
      post: {
        samples: 1,
        aoStrength: 0,
        aoRadius: 0.5,
        bloomStrength: 0,
        bloomThreshold: 1,
        saturation: 1,
        contrast: 1,
        lift: [0, 0, 0],
        gain: [1, 1, 1],
        highlightDesaturation: 0,
        vignette: 0,
        grain: 0,
        sharpness: 0,
        effects: {
          taa: temporal, bloom: false, lightShafts: false, depthOfField: false,
          sharpen: false, grain: false, vignette: false, tonemapper: 'aces',
        },
      },
    },
    ui: { initialQuality: 'performance' },
  };
}

function summarize(records) {
  return records.map((entry) => `${entry.kind}:${entry.name ?? 'anon'}`).join(',') || 'none';
}

function advanceFrame(renderer) {
  renderer._nodes.nodeFrame.update();
}

async function checkMode(renderer, { cinematic, temporal = false }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 6, 4);
  sun.castShadow = true;
  scene.add(sun);

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x339955 });
  const mesh = new THREE.InstancedMesh(geometry, material, 8);
  mesh.name = 'prep-target';
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.visible = false;
  mesh.frustumCulled = false;
  scene.add(mesh);

  // A different node material so WebGL cannot reuse the prepared program cache
  // (WebGL's pipeline key is shader-stage identity, not the instanced UUID).
  const cold = new THREE.InstancedMesh(geometry, new THREE.MeshBasicNodeMaterial({ color: 0xaa3344 }), 8);
  cold.name = 'cold-control';
  cold.count = 1;
  cold.position.set(0.35, 0, 0);
  cold.castShadow = false;
  cold.visible = false;
  cold.frustumCulled = false;
  scene.add(cold);

  renderer.setSize(64, 64, false);
  renderer.shadowMap.enabled = true;
  const world = { scene, camera, renderer, sun };
  const pipeline = new CinematicPipeline(world, cinematicConfig(cinematic, temporal));
  // Prime the post graph itself before attributing first-use work to a draw.
  // In particular TRAA owns fullscreen history passes unrelated to this mesh.
  advanceFrame(renderer);
  pipeline.render({ occlusionEnabled: false });
  const probe = hookCreations(renderer);
  const nextFrame = async () => {
    // PassNode is NodeUpdateType.FRAME. The animation loop normally bumps
    // nodeFrame.frameId; this harness stops that loop, so the compile render
    // and the later first-use/control renders must advance it themselves.
    advanceFrame(renderer);
    await new Promise(requestAnimationFrame);
  };

  try {
    const prepared = await pipeline.prepareDraws([mesh], { waitForFrame: true, nextFrame });
    const during = probe.forObject(mesh);
    if (prepared.prepared !== 1) {
      throw new Error(`Preparation reported ${prepared.prepared} draws, expected 1`);
    }
    if (during.length === 0) {
      throw new Error(`Preparation created no node builds or pipelines for the target mesh (${summarize(probe.records)})`);
    }

    mesh.count = 1;
    mesh.visible = true;
    // Gameplay follows the scheduler in the SAME animation callback. Advancing
    // the node frame here would conceal an empty preparation pass cached as the
    // gameplay scene, causing the exact blink this contract must prevent.
    let visibleSubmissions = 0;
    mesh.onBeforeRender = () => { if (mesh.visible && mesh.count > 0) visibleSubmissions++; };
    const after = probe.records.length;
    pipeline.render({ occlusionEnabled: false });
    if (visibleSubmissions === 0) throw new Error('Gameplay reused the empty preparation pass in the same frame');
    const createdOnUse = probe.forObject(mesh).length - during.length;
    if (createdOnUse !== 0) {
      throw new Error(`Prepared mesh created ${createdOnUse} extra node builds or pipelines on first visible use`);
    }
    const afterUse = probe.records.length - after;

    cold.visible = true;
    await nextFrame();
    pipeline.render({ occlusionEnabled: false });
    const control = probe.forObject(cold);
    if (control.length === 0) {
      throw new Error(`Unprepared control mesh did not compile on first use (${summarize(probe.records)})`);
    }

    return {
      cinematic,
      temporal,
      prepared: during.length,
      afterUse,
      control: control.length,
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    };
  } finally {
    probe.restore();
    pipeline.dispose();
    geometry.dispose();
    material.dispose();
    mesh.dispose();
    cold.dispose();
    cold.material.dispose();
  }
}

async function check() {
  const forceWebGL = new URLSearchParams(window.location.search).get('renderer') === 'webgl';
  const renderer = new THREE.WebGPURenderer({ forceWebGL, antialias: false });
  await renderer.init();
  renderer._animation.stop();
  try {
    const cinematic = await checkMode(renderer, { cinematic: true });
    const direct = await checkMode(renderer, { cinematic: false });
    const temporal = await checkMode(renderer, { cinematic: true, temporal: true });
    return {
      passed: true,
      failures: [],
      cinematic,
      direct,
      temporal,
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    };
  } finally {
    await renderer.dispose();
  }
}

window.__drawPreparationCheck = check().then((result) => {
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  return result;
}).catch((error) => {
  const result = { passed: false, failures: [error.message], error: error.stack };
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  return result;
});
