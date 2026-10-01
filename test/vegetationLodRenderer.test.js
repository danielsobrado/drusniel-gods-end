import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { VegetationLodRenderer } from '../src/foliage/VegetationLodRenderer.js';
import { SHADOW_LAYER } from '../src/world/TerrainShadowChunks.js';
import { createVegetationJobScheduler } from '../src/foliage/vegetationRebuild.js';
import { validateVegetationLodConfig } from '../src/config/validateVegetationLodConfig.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('quality cancellation requeues a staged draw and preserves it until publication', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.z = 5; camera.lookAt(0, 0, 0);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const jobs = createVegetationJobScheduler({ now: () => 0 });
  let release;
  const renderer = new VegetationLodRenderer({ scene, config: {},
    prepareMaterial: () => material.clone(), policy: () => ({ centers: [20], far: 100 }) });
  renderer.setScheduler(jobs, { prepare: () => new Promise(resolve => { release = resolve; }) });
  renderer.addVariant({ key: 'cancel-test', full: [{ geometry, material }], records: [{
    position: new THREE.Vector3(), matrix: new Float32Array(new THREE.Matrix4().elements),
    fraction: 0, sphere: new THREE.Sphere(new THREE.Vector3(), 2),
  }] });
  // A draw's meshes may be prepared across frames; let a whole task pass.
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    renderer.update(camera, true); jobs.tick();
    assert.equal(scene.children.length, 0, 'unprepared meshes stay outside scene traversal');
    renderer.setQuality('ultra');
    release(); await settle();
    renderer.update(camera, true); jobs.tick();
    assert.equal(jobs.stats.prepares, 2, 'the cancelled draw is prepared again');
    for (let slice = 0; slice < 4; slice += 1) { release(); await settle(); }
    jobs.tick(); renderer.update(camera, true);
    assert.equal(scene.children.filter(mesh => mesh.visible).length, 1);
  } finally { renderer.dispose(); jobs.dispose(); geometry.dispose(); material.dispose(); }
});

test('preparing a streamed tree region batches chunks and prevents draw allocation while travelling', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const renderer = new VegetationLodRenderer({ scene, config: {}, chunkSize: 20,
    prepareMaterial: () => material.clone(), policy: () => ({ centers: [20, 40], far: 100 }) });
  const full = [{ geometry, material }];
  renderer.addVariant({ key: 'region', full, asset: { levels: [null, full], entry: {} },
    records: [0, 100, 200].map(x => ({ position: new THREE.Vector3(x, 0, 0),
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(x, 0, 0).elements),
      fraction: 0, sphere: new THREE.Sphere(new THREE.Vector3(x, 0, 0), 2) })) });
  renderer.prepareAll();
  const prepared = [...scene.children];
  assert.equal(prepared.length, 2, 'tree chunks share one instance batch per available LOD');
  assert.deepEqual(prepared.map(mesh => mesh.name).sort(), ['region:full', 'region:medium']);
  assert.ok(prepared.every(mesh => !mesh.visible && mesh.count === 0));
  for (const x of [0, 100, 200, 0]) for (const z of [10, 30, 60]) {
    camera.position.set(x, 0, z); camera.lookAt(x, 0, 0);
    renderer.update(camera);
    // Expanding a compact draw replaces its mesh once (three keeps a mesh's
    // buffers), but travelling never adds draws.
    assert.deepEqual(scene.children.map(mesh => mesh.name).sort(), prepared.map(mesh => mesh.name).sort());
  }
  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('LOD submissions handle reversals, teleports, missing levels and preserve transformed billboard centers', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(3, 12, 3), material = new THREE.MeshStandardNodeMaterial();
  const full = [{ geometry, material }], atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const capture = { center: [0, 6, 0], width: 4, height: 12, views: 8, tileSize: 128 };
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(17, 4, -23),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0.7, -0.1)), new THREE.Vector3(1.3, 2, 0.7));
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  const renderer = new VegetationLodRenderer({ scene, config: {}, prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [80, 160, 300], far: 900 }) });
  renderer.addVariant({ key: 'test', full, asset: { levels: [null, full, full], atlas, entry: { capture } },
    records: [{ matrix: new Float32Array(matrix.elements), position, height: 24, fraction: 0,
      sphere: new THREE.Sphere(position, 30) }] });
  const visit = distance => {
    camera.position.copy(position).add(new THREE.Vector3(0, 0, distance)); camera.lookAt(position); camera.updateMatrixWorld();
    return { ...renderer.update(camera) };
  };
  assert.equal(visit(20).full, 1);
  renderer.prepareNearby(camera, 60);
  const preparedCount = scene.children.length;
  assert.equal(renderer.stats.medium, 0, 'preparation must not change the submitted population');
  assert.equal(scene.children.find(mesh => mesh.name === 'test:medium').visible, false);
  assert.equal(visit(80).medium, 1);
  assert.equal(scene.children.length, preparedCount, 'crossing a prepared transition allocates no new draw');
  assert.equal(visit(120).medium, 1); assert.equal(visit(220).low, 1);
  assert.equal(visit(500).billboard, 1);
  const card = scene.children.find(o => o.name === 'test:billboard');
  const expectedCenter = new THREE.Vector3(...capture.center).applyMatrix4(matrix);
  const center = card.geometry.getAttribute('lodCenter');
  assert.ok(new THREE.Vector3(center.getX(0), center.getY(0), center.getZ(0)).distanceTo(expectedCenter) < 1e-4);
  assert.equal(card.geometry.getAttribute('lodView'), undefined, 'tree view selection is GPU-derived');
  assert.equal(card.geometry.isInstancedBufferGeometry, true, 'GPU-facing tree billboards use instanced geometry');
  assert.equal(card.instanceMatrix, undefined, 'GPU-facing billboards do not carry redundant identity matrices');
  assert.ok(card.geometry.getAttribute('lodInverseX').count >= card.geometry.instanceCount);
  assert.equal(renderer.chunks[0].records[0].inverse, undefined, 'tree records do not retain inverse matrices');
  assert.equal(card.castShadow, false); assert.equal(card.userData.excludeFromReflection, true);
  assert.equal(visit(80).full, 1); assert.equal(renderer.stats.medium, 1);
  const intervals = ['test:full', 'test:medium'].map(name => {
    const draw = scene.children.find(candidate => candidate.name === name);
    return [...draw.geometry.getAttribute('lodInterval').array.slice(0, 2)];
  });
  assert.deepEqual(intervals, [[0, 0.5], [0.5, 1]], 'shared tree batches retain independent transition intervals');
  assert.equal(visit(20).full, 1); assert.equal(renderer.stats.billboard, 0);
  assert.equal(visit(1000).visibleInstances, 0);
  assert.equal(visit(220).low, 1);
  renderer.chunks[0].templates[2] = null;
  renderer.setQuality('balanced'); assert.equal(visit(220).medium, 1);
  const mesh = scene.children.find(o => o.name === 'test:full');
  assert.equal(mesh.geometry.attributes.position, geometry.attributes.position);
  renderer.dispose(); renderer.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose(); atlas.dispose();
});

test('atlas appearance hooks receive the tinted billboard color and keep final overrides', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 1, 0], width: 2, height: 2, views: 8, tileSize: 128 };
  let received = null;
  const renderer = new VegetationLodRenderer({
    scene,
    config: { cinematic: { enabled: true } },
    prepareMaterial: () => material.clone(),
    prepareAtlasMaterial: (atlasMaterial, context) => {
      received = context;
      atlasMaterial.alphaToCoverage = false;
    },
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  const position = new THREE.Vector3();
  renderer.addVariant({
    key: 'tinted',
    kind: 'tree',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().elements),
      tint: new THREE.Color(0.5, 0.8, 0.6),
      height: 2,
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    }],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  renderer.prepareAll();
  const card = scene.children.find(mesh => mesh.name === 'tinted:billboard');
  assert.ok(received?.sourceRgb);
  assert.ok(received?.baseRgb);
  assert.notEqual(received.baseRgb, received.sourceRgb);
  assert.equal(received.kind, 'tree');
  assert.equal(card.material.alphaToCoverage, false);
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('tree billboard wind keeps the source transform basis in GPU-facing mode', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  const transform = new THREE.Matrix4().compose(
    new THREE.Vector3(),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),
    new THREE.Vector3(1.5, 1, 0.75),
  );
  const position = new THREE.Vector3();
  const renderer = new VegetationLodRenderer({
    scene,
    config: { wind: { model: 'cinematic' } },
    windUniforms: {
      speed: uniform(3),
      strength: uniform(1.2),
      frequency: uniform(1),
      simulationSpeed: uniform(1),
    },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  renderer.addVariant({
    key: 'tree1',
    kind: 'tree',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(transform.elements),
      height: 10,
      fraction: 0,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 5, 0), 6),
    }],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  const billboard = renderer.chunks[0].billboardData;
  assert.ok(Math.abs(billboard[5]) > 1, 'source rotation and scale remain available to the wind graph');
  assert.ok(Math.abs(billboard[9]) > 0.5, 'source forward basis remains available to the wind graph');
  assert.equal(renderer.chunks[0].records[0].billboard, undefined, 'billboard records stay in one packed slab');
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('snow tree impostors stay rigid when their detailed trees have no leaf wind', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  const position = new THREE.Vector3();
  const renderer = new VegetationLodRenderer({
    scene,
    config: {
      wind: { model: 'cinematic' },
      trees: {
        types: [{ highLeaves: 'Leaves' }, { zone: 'snow' }],
        lod: {},
      },
    },
    windUniforms: {
      speed: uniform(3),
      strength: uniform(1.2),
      frequency: uniform(1),
      simulationSpeed: uniform(1),
    },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  renderer.addVariant({
    key: 'tree2',
    kind: 'tree',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().elements),
      height: 10,
      fraction: 0,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 5, 0), 6),
    }],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  renderer.prepareAll();
  const card = scene.children.find(mesh => mesh.name === 'tree2:billboard');
  assert.ok(card?.material.positionNode, 'GPU facing still supplies the billboard position node');
  assert.equal(card.material.userData.treeBillboardWindEnabled, false);
  assert.equal(card.material.emissiveNode, null, 'rigid snow impostors keep neutral PBR lighting');
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('tree impostors use the shared tree wind uniforms while plant atlases stay static', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  const windUniforms = {
    speed: uniform(3),
    strength: uniform(1.2),
    frequency: uniform(1),
    simulationSpeed: uniform(1),
  };
  const renderer = new VegetationLodRenderer({
    scene,
    config: { trees: { types: [{ highLeaves: 'Leaves' }] } },
    windUniforms,
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  const record = {
    position: new THREE.Vector3(0, 0, 0),
    matrix: new Float32Array(new THREE.Matrix4().elements),
    fraction: 0,
    sphere: new THREE.Sphere(new THREE.Vector3(), 10),
  };
  renderer.addVariant({
    key: 'tree1',
    kind: 'tree',
    full: [{ geometry, material }],
    records: [record],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  renderer.prepareAll();
  const treeCard = scene.children.find(mesh => mesh.name === 'tree1:billboard');
  assert.ok(treeCard?.material.positionNode, 'tree billboard must have GPU wind deformation');
  assert.equal(treeCard.material.userData.treeBillboardWindEnabled, true);
  assert.ok(treeCard.geometry.getAttribute('lodCenter'), 'tree billboard facing data is on the GPU');
  assert.equal(treeCard.geometry.getAttribute('lodView'), undefined);
  renderer.dispose();
  geometry.dispose();
  material.dispose();
  atlas.dispose();
});

test('tree impostor normals load lazily when quality upgrades after performance startup', async () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const normalMask = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  let ready = false, loads = 0;
  const renderer = new VegetationLodRenderer({
    scene,
    config: { ui: { initialQuality: 'performance' } },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  const position = new THREE.Vector3();
  renderer.addVariant({
    key: 'tree1',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().elements),
      height: 10,
      fraction: 0,
      sphere: new THREE.Sphere(position, 6),
    }],
    asset: {
      levels: [null, [{ geometry, material }], [{ geometry, material }]],
      atlas,
      normalMask,
      normalMaskReady: () => ready,
      ensureNormalMask: async () => { loads += 1; ready = true; return normalMask; },
      entry: { capture, canopyPalette: true },
    },
  });

  renderer.prepareAll();
  const card = scene.children.find(mesh => mesh.name === 'tree1:billboard');
  const control = card.material.userData.impostorNormalControl;
  assert.equal(control.normalWeight.value, 0);
  assert.equal(control.mapReadyWeight.value, 0);

  renderer.setQuality('high');
  await Promise.resolve();
  assert.equal(loads, 0, 'quality selection alone must not fetch every tree normal atlas');

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  camera.position.set(0, 0, 50);
  camera.lookAt(position);
  camera.updateMatrixWorld();
  renderer.prepareNearby(camera, 0);
  await Promise.resolve();
  assert.equal(loads, 1, 'reachable billboard normals start loading during shader warmup');
  renderer.update(camera, true);
  await Promise.resolve();
  assert.equal(loads, 1, 'the first visible frame reuses the warmup normal request');
  assert.equal(control.mapReadyWeight.value, 1);
  assert.equal(control.normalWeight.value, 1);

  renderer.setQuality('performance');
  assert.equal(control.mapReadyWeight.value, 1, 'loaded foliage mask remains exact');
  assert.equal(control.normalWeight.value, 0, 'performance disables detailed normals');

  renderer.dispose();
  geometry.dispose();
  material.dispose();
  atlas.dispose();
  normalMask.dispose();
});

test('vegetation LOD skips sub-threshold camera movement and updates after accumulated travel', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const config = { vegetationLod: { update: { cameraMoveThreshold: 0.2, cameraRotationThreshold: 0.0038, cameraTurnMarginDegrees: 12 } } };
  const renderer = new VegetationLodRenderer({
    scene,
    config,
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20], far: 100 }),
  });
  const position = new THREE.Vector3(0, 0, -10);
  renderer.addVariant({
    key: 'threshold',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    }],
  });

  camera.lookAt(position);
  renderer.update(camera, true);
  camera.position.x = 0.1;
  camera.lookAt(position);
  renderer.update(camera);
  assert.equal(renderer.lastPosition.x, 0);

  camera.position.x = 0.21;
  camera.lookAt(position);
  renderer.update(camera);
  assert.equal(renderer.lastPosition.x, 0.21);

  camera.position.x = 0;
  camera.lookAt(position);
  renderer.update(camera, true);
  camera.rotation.y = THREE.MathUtils.degToRad(5);
  camera.updateMatrixWorld();
  renderer.update(camera);
  assert.ok(renderer.lastQuaternion.angleTo(camera.quaternion) > 0.05, 'small turns reuse the prepared envelope');
  camera.rotation.y = THREE.MathUtils.degToRad(11);
  camera.updateMatrixWorld();
  renderer.update(camera);
  assert.ok(renderer.lastQuaternion.angleTo(camera.quaternion) < 1e-6, 'accumulated turns repack after the threshold');

  renderer.dispose();
  geometry.dispose();
  material.dispose();
});

test('vegetation turn envelope includes records just outside the current view', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const renderer = new VegetationLodRenderer({
    scene,
    config: { vegetationLod: { update: { cameraMoveThreshold: 0.5, cameraRotationThreshold: 0.0038, cameraTurnMarginDegrees: 12 } } },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20], far: 100 }),
  });
  const angle = THREE.MathUtils.degToRad(38);
  const position = new THREE.Vector3(Math.sin(angle) * 40, 0, -Math.cos(angle) * 40);
  renderer.addVariant({
    key: 'turn-envelope',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    }],
  });

  camera.updateMatrixWorld();
  const stats = renderer.update(camera, true);
  assert.equal(stats.visibleInstances, 1);

  renderer.dispose();
  geometry.dispose();
  material.dispose();
});

test('plant cards keep coastal-style wind on the GPU', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 1, 0], width: 2, height: 2, views: 8, tileSize: 128 };
  let calls = 0;
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    preparePlantBillboardWind: ({ origin, right, forward, kind }) => {
      calls += 1;
      assert.equal(kind, 'fern');
      assert.equal(origin.isNode, true);
      assert.equal(right.isNode, true);
      assert.equal(forward.isNode, true);
      return origin.mul(0);
    },
    policy: () => ({ plant: true, centers: [20], blend: 0.15, far: 100 }),
  });
  const position = new THREE.Vector3(0, 0, -40);
  renderer.addVariant({
    key: 'wind-fern',
    kind: 'fern',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    }],
    asset: { levels: [], atlas, entry: { capture } },
  });
  assert.equal(calls, 1);
  const card = scene.children.find(mesh => mesh.name === 'wind-fern:billboard');
  assert.ok(card?.material.positionNode);
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('nearby warmup prepares the billboard stage before the first tree transition', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20, 40, 60], blend: 0.15, far: 200 }),
  });
  const position = new THREE.Vector3(0, 0, -70);
  renderer.addVariant({
    key: 'warm-billboard',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      height: 10,
      fraction: 0,
      sphere: new THREE.Sphere(position, 6),
    }],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  camera.lookAt(position); camera.updateMatrixWorld();
  renderer.prepareNearby(camera, 20);
  const billboard = scene.children.find(mesh => mesh.name === 'warm-billboard:billboard');
  assert.ok(billboard, 'reachable billboard draw is allocated during warmup');
  assert.equal(billboard.visible, false, 'warmup allocation does not publish the billboard');
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('nearby warmup covers a first-turn tree behind the opening camera', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  const position = new THREE.Vector3(0, 0, 70);
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20, 40, 60], blend: 0.15, far: 200 }),
  });
  renderer.addVariant({
    key: 'turn-tree',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      height: 10,
      fraction: 0,
      sphere: new THREE.Sphere(position, 6),
    }],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  camera.lookAt(0, 0, -10); camera.updateMatrixWorld();
  renderer.prepareNearby(camera, 25);
  assert.ok(scene.children.some(mesh => mesh.name === 'turn-tree:billboard'));
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('screen-space first-turn warmup uses the turned camera depth', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 6, 0], width: 4, height: 12, views: 8, tileSize: 128 };
  const position = new THREE.Vector3(0, 0, 120);
  const renderer = new VegetationLodRenderer({
    scene,
    config: { trees: { lod: { screenSpace: { fallbackViewportHeight: 1080 } } } },
    viewportHeight: () => 1080,
    prepareMaterial: () => material.clone(),
    policy: () => ({
      centers: [35, 75, 120],
      screenHeights: [260, 125, 80],
      blend: 0.15,
      far: 1000,
    }),
  });
  renderer.addVariant({
    key: 'turn-screen-tree',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      height: 12,
      fraction: 0,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 6, 120), 8),
    }],
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  camera.lookAt(0, 0, -10); camera.updateMatrixWorld();
  renderer.prepareNearby(camera, 25);
  assert.ok(scene.children.some(mesh => mesh.name === 'turn-screen-tree:low'),
    'a turn candidate must warm the LOD selected after the camera faces it');
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('nearby warmup enables only plant cards inside the expanded opening view', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 1, 0], width: 2, height: 2, views: 8, tileSize: 128 };
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    chunkSize: 20,
    prepareMaterial: () => material.clone(),
    policy: () => ({ plant: true, centers: [20], blend: 0.15, far: 200 }),
  });
  const records = [0, 100].map(x => {
    const position = new THREE.Vector3(x, 0, -30);
    return {
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    };
  });
  renderer.addVariant({
    key: 'warm-plants',
    kind: 'grass',
    full: [{ geometry, material }],
    records,
    asset: { levels: [], atlas, entry: { capture } },
  });
  camera.lookAt(0, 0, -30); camera.updateMatrixWorld();
  renderer.prepareNearby(camera, 8);
  const cards = scene.children.filter(mesh => mesh.name === 'warm-plants:billboard');
  assert.equal(cards.length, 2);
  assert.equal(cards.filter(mesh => mesh.userData.skipWarmup === false).length, 1);
  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('tree screen-space LOD reacts to FOV and viewport height at a fixed distance', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(3, 12, 3), material = new THREE.MeshStandardNodeMaterial();
  const full = [{ geometry, material }], atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const capture = { center: [0, 6, 0], width: 4, height: 12, views: 8, tileSize: 128 };
  let viewportHeight = 1080;
  const renderer = new VegetationLodRenderer({
    scene,
    config: { trees: { lod: { screenSpace: { fallbackViewportHeight: 1080 } } } },
    viewportHeight: () => viewportHeight,
    prepareMaterial: () => material.clone(),
    policy: () => ({
      centers: [35, 75, 120],
      screenHeights: [260, 125, 80],
      blend: 0.05,
      far: 1000,
    }),
  });
  const position = new THREE.Vector3(0, 0, -100);
  renderer.addVariant({
    key: 'screen-tree',
    full,
    asset: { levels: [null, full, full], atlas, entry: { capture } },
    records: [{
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      position,
      height: 12,
      fraction: 0,
      sphere: new THREE.Sphere(position, 8),
    }],
  });

  camera.lookAt(position); camera.updateMatrixWorld();
  assert.equal(renderer.update(camera, true).low, 1);

  camera.fov = 35; camera.updateProjectionMatrix();
  renderer.prepareNearby(camera, 0);
  assert.ok(scene.children.some(mesh => mesh.name === 'screen-tree:medium'),
    'screen-space warmup prepares the zoom-selected mesh stage');
  assert.equal(renderer.update(camera).medium, 1, 'zoom keeps the same tree at a higher-detail mesh');

  camera.fov = 70; camera.updateProjectionMatrix();
  viewportHeight = 540;
  assert.equal(renderer.update(camera).billboard, 1, 'shorter viewport hands the same tree to the impostor');

  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('screen-space LOD keeps near-plane intersecting trees detailed', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(3, 12, 3), material = new THREE.MeshStandardNodeMaterial();
  const full = [{ geometry, material }], atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const capture = { center: [0, 6, 0], width: 4, height: 12, views: 8, tileSize: 128 };
  const renderer = new VegetationLodRenderer({
    scene,
    config: { trees: { lod: { screenSpace: { fallbackViewportHeight: 1080 } } } },
    viewportHeight: () => 1080,
    prepareMaterial: () => material.clone(),
    policy: () => ({
      centers: [35, 75, 120],
      screenHeights: [260, 125, 80],
      blend: 0.05,
      far: 1000,
    }),
  });
  const position = new THREE.Vector3(0, 0, 1);
  renderer.addVariant({
    key: 'near-plane-tree',
    full,
    asset: { levels: [null, full, full], atlas, entry: { capture } },
    records: [{
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      position,
      height: 12,
      fraction: 0,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 6, 1), 8),
    }],
  });
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();

  const stats = renderer.update(camera, true);
  assert.equal(stats.full, 1, 'a tree intersecting the camera plane must not collapse to its impostor');

  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('variant staging is transactional and packs billboard metadata contiguously', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  const records = [0, 1].map((x) => {
    const position = new THREE.Vector3(x, 0, -20);
    return {
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      height: 10,
      fraction: 0,
      sphere: new THREE.Sphere(position, 6),
    };
  });
  const stage = renderer.createVariantStage({
    key: 'staged-tree',
    full: [{ geometry, material }],
    records,
    asset: { levels: [null, [{ geometry, material }], [{ geometry, material }]], atlas, entry: { capture } },
  });
  stage.iterator.next();
  assert.equal(renderer.chunks.length, 0, 'a partially built variant must not mutate live renderer state');
  for (let step = stage.iterator.next(); !step.done; step = stage.iterator.next()) continue;
  assert.equal(stage.ready, true);
  assert.equal(renderer.chunks.length, 0, 'a ready stage remains private until publication');
  renderer.commitVariantStage(stage);
  assert.ok(renderer.chunks.length > 0);
  assert.equal(renderer.chunks[0].billboardData.length, records.length * 18);
  assert.ok(records.every(record => record.billboard === undefined));

  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose();
});

test('small remote draws warm up at full size and keep their compiled mesh', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const renderer = new VegetationLodRenderer({ scene, config: {}, prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20, 40], far: 100 }) });
  const position = new THREE.Vector3(0, 0, -20);
  renderer.addVariant({ key: 'full-warmup', full: [{ geometry, material }],
    asset: { levels: [null, [{ geometry, material }]], entry: {} },
    records: [{ position, matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0, sphere: new THREE.Sphere(position, 2) }] });
  renderer.prepareAll();
  const full = scene.children.find(mesh => mesh.name === 'full-warmup:full');
  // Expanding would replace the mesh, and three compiles a new InstancedMesh
  // again: the warmup compile would be wasted and paid for mid-flight.
  assert.ok(full.instanceMatrix.count >= 64, 'a draw under the size limit is built at production size');
  assert.equal(renderer.unpreparedMeshes().length, 0, 'nothing is left to prepare during play');
  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('remote loading warmup keeps large instance buffers compact until scheduled expansion', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  camera.position.set(0, 0, -15); camera.lookAt(0, 0, -20);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20, 40], far: 100 }),
    // Every draw counts as large here.
    fullWarmupMaxBytes: 0,
  });
  const position = new THREE.Vector3(0, 0, -20);
  renderer.addVariant({
    key: 'compact-warmup',
    full: [{ geometry, material }],
    asset: { levels: [null, [{ geometry, material }]], entry: {} },
    records: [{ position, matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0, sphere: new THREE.Sphere(position, 2) }],
  });
  renderer.prepareAll();
  const full = scene.children.find(mesh => mesh.name === 'compact-warmup:full');
  assert.equal(full.instanceMatrix.count, 1, 'remote warmup does not allocate production-sized instance buffers');
  assert.equal(full.geometry.getAttribute('lodView'), undefined, 'mesh LODs do not allocate billboard view data');

  const scheduler = createVegetationJobScheduler({ budgetMs: 100, now: () => 0 });
  renderer.setScheduler(scheduler, { prepare: async () => {} });
  renderer.update(camera, true);
  for (let step = 0; step < 6; step += 1) { scheduler.tick(); await Promise.resolve(); }
  renderer.update(camera, true);
  const expanded = scene.children.find(mesh => mesh.name === 'compact-warmup:full');
  assert.ok(expanded.instanceMatrix.count >= 64, 'scheduled preparation expands the warmup draw');
  assert.notEqual(expanded, full, 'the expanded draw is a new mesh, so three builds it with the new buffers');
  assert.equal(full.parent, null);
  assert.ok(expanded.visible && expanded.count > 0);

  renderer.dispose(); scheduler.dispose(); geometry.dispose(); material.dispose();
});

test('tree impostor normal loading retries a transient failure within its configured budget', async () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const normalMask = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1);
  const capture = { center: [0, 5, 0], width: 4, height: 10, views: 8, tileSize: 128 };
  let ready = false, loads = 0;
  const renderer = new VegetationLodRenderer({
    scene,
    config: {
      ui: { initialQuality: 'high' },
      vegetationLod: { impostorNormalRetry: { maxAttempts: 2, delayMs: 0 } },
      trees: { lod: { impostor: { detailedNormalQualities: ['high'] } } },
    },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [10, 20, 30], far: 100 }),
  });
  const position = new THREE.Vector3(0, 0, -50);
  renderer.addVariant({
    key: 'retry-tree',
    full: [{ geometry, material }],
    records: [{ position, matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      height: 10, fraction: 0, sphere: new THREE.Sphere(position, 6) }],
    asset: {
      levels: [null, [{ geometry, material }], [{ geometry, material }]],
      atlas,
      normalMask,
      normalMaskReady: () => ready,
      ensureNormalMask: async () => {
        loads += 1;
        if (loads === 1) throw new Error('transient');
        ready = true;
        return normalMask;
      },
      entry: { capture, canopyPalette: true },
    },
  });
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  camera.lookAt(position); camera.updateMatrixWorld();
  renderer.prepareNearby(camera, 0);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(loads, 1);
  await new Promise(resolve => setTimeout(resolve, 0));
  renderer.prepareNearby(camera, 0);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(loads, 2, 'a transient failure is retried instead of poisoning the renderer lifetime');
  const card = scene.children.find(mesh => mesh.name === 'retry-tree:billboard');
  assert.equal(card.material.userData.impostorNormalControl.normalWeight.value, 1);

  renderer.dispose(); geometry.dispose(); material.dispose(); atlas.dispose(); normalMask.dispose();
});

test('vegetation configuration rejects reversed transitions and cutoffs before handoff', async () => {
  const config = await loadMergedConfig(); const problems = [];
  validateVegetationLodConfig(config, problems); assert.deepEqual(problems, []);
  config.trees.lod.distances = [80, 60, 300];
  config.trees.lod.screenSpace.heights = [260, 300, 80];
  config.trees.lod.impostor.gutter = config.trees.lod.impostor.tileSize;
  config.grass.far.distances.high = 40;
  config.vegetationLod.update.cameraMoveThreshold = -1;
  config.vegetationLod.update.cameraTurnMarginDegrees = 61;
  validateVegetationLodConfig(config, problems);
  assert.ok(problems.some(p => p.includes('increasing')));
  assert.ok(problems.some(p => p.includes('screenSpace.heights')));
  assert.ok(problems.some(p => p.includes('impostor.gutter')));
  assert.ok(problems.some(p => p.includes('near grass range')));
  assert.ok(problems.some(p => p.includes('cameraMoveThreshold')));
  assert.ok(problems.some(p => p.includes('cameraTurnMarginDegrees')));

  const turnProblems = [];
  config.vegetationLod.update.cameraMoveThreshold = 0.5;
  config.vegetationLod.update.cameraRotationThreshold = 0.0038;
  config.vegetationLod.update.cameraTurnMarginDegrees = 1;
  validateVegetationLodConfig(config, turnProblems);
  assert.ok(turnProblems.some(p => p.includes('must cover cameraRotationThreshold')));
});

test('stable compacted records only upload dynamic LOD intervals', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20, 40], far: 100 }),
  });
  const position = new THREE.Vector3(0, 0, -10);
  renderer.addVariant({
    key: 'static-upload',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    }],
  });

  camera.lookAt(position);
  renderer.update(camera, true);
  const mesh = scene.children.find(child => child.name === 'static-upload:full');
  const matrixVersion = mesh.instanceMatrix.version;
  const tint = mesh.geometry.getAttribute('lodTint');
  const interval = mesh.geometry.getAttribute('lodInterval');
  const tintVersion = tint.version;
  const intervalVersion = interval.version;

  renderer.update(camera, true);
  assert.equal(mesh.instanceMatrix.version, matrixVersion, 'stable transforms are not uploaded again');
  assert.equal(tint.version, tintVersion, 'stable per-instance appearance is not uploaded again');
  assert.equal(interval.version, intervalVersion, 'an unchanged LOD interval is not uploaded again');

  // Inside the far fade (90-100 m) the tree's coverage shrinks.
  camera.position.set(0, 0, 85);
  camera.lookAt(position);
  camera.updateMatrixWorld();
  renderer.update(camera, true);
  assert.equal(mesh.instanceMatrix.version, matrixVersion, 'a coverage change leaves transforms alone');
  assert.equal(tint.version, tintVersion, 'a coverage change leaves appearance alone');
  assert.ok(interval.version > intervalVersion, 'LOD coverage remains dynamic');
  assert.ok(interval.getY(0) < 1, 'the tree is fading out near the far limit');

  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('chunk update reuses cached availability and prefetch policy state', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  let policyCalls = 0;
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    chunkSize: 100,
    prepareMaterial: () => material.clone(),
    policy: () => {
      policyCalls += 1;
      return { centers: [20, 40], far: 200 };
    },
  });
  const position = new THREE.Vector3(0, 0, -50);
  renderer.addVariant({
    key: 'cached-chunk-state',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 2),
    }],
  });
  const scheduler = createVegetationJobScheduler({ budgetMs: 100, now: () => 0 });
  renderer.setScheduler(scheduler, { prepare: async () => {} });
  const cachedAvailable = renderer.chunks[0].available;

  camera.lookAt(position);
  policyCalls = 0;
  renderer.update(camera, true);
  assert.ok(policyCalls <= 3, `chunk policy should be reused across prefetch and visibility: ${policyCalls}`);
  assert.strictEqual(renderer.chunks[0].available, cachedAvailable, 'availability is cached with the immutable templates');

  renderer.dispose(); scheduler.dispose(); geometry.dispose(); material.dispose();
});

test('distant plant movement reuses static buffers without per-record policy or matrix work', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  let visits = 0;
  const renderer = new VegetationLodRenderer({ scene, config: {}, chunkSize: 20, prepareMaterial: () => material.clone(),
    policy: () => { visits++; return { plant: true, centers: [24], blend: 10 / 24, far: 500 }; } });
  const records = Array.from({ length: 2000 }, (_, i) => {
    const position = new THREE.Vector3(i % 10, 0, -100 - Math.floor(i / 10) * 0.01);
    return { position, matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0, sphere: new THREE.Sphere(position, 2) };
  });
  renderer.addVariant({ key: 'grass', kind: 'grass', full: [{ geometry, material }], records,
    asset: { levels: [], atlas, entry: { capture: { center: [0, 1, 0], width: 2, height: 2, views: 8, tileSize: 128 } } } });
  camera.lookAt(0, 0, -100); renderer.update(camera);
  const cards = scene.children.filter(mesh => mesh.name === 'grass:billboard');
  renderer.prepareAll();
  assert.ok(cards.every(mesh => mesh.userData.skipWarmup === false), 'remote cards participate in loading-screen preparation');
  assert.equal(renderer.stats.full, 0, 'preparation must not publish hidden near geometry');
  const versions = cards.map(mesh => mesh.geometry.attributes.cardCenter.data.version);
  visits = 0;
  for (let i = 0; i < 20; i++) { camera.position.x += 0.1; renderer.update(camera); }
  assert.ok(visits < 100, `policy visits must scale with chunks, not 2000 stems: ${visits}`);
  assert.deepEqual(cards.map(mesh => mesh.geometry.attributes.cardCenter.data.version), versions);
  assert.ok(cards.every(mesh => mesh.geometry.attributes.cardOrigin.data === mesh.geometry.attributes.cardCenter.data));
  assert.equal(records.some(record => record.inverse), false);
  assert.equal(renderer.stats.full, 0);
  assert.equal(renderer.stats.billboard, 2000);
  renderer.setQuality('performance'); renderer.update(camera);
  assert.ok(cards.every(mesh => mesh.visible));
  renderer.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose(); atlas.dispose();
});

test('a chunk wholly inside the frustum skips per-record tests without admitting off-screen plants', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  // One chunk wide enough to hold every record, so its bounds straddle the
  // frustum in the narrow view below and sit wholly inside it in the wide one.
  const renderer = new VegetationLodRenderer({ scene, config: {}, chunkSize: 400,
    prepareMaterial: () => material.clone(), policy: () => ({ centers: [1000, 2000], far: 5000 }) });
  const full = [{ geometry, material }];
  renderer.addVariant({ key: 'spread', full, asset: undefined,
    records: [-60, 0, 60].map(x => ({ position: new THREE.Vector3(x, 0, 0),
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(x, 0, 0).elements),
      fraction: 0, sphere: new THREE.Sphere(new THREE.Vector3(x, 0, 0), 2) })) });

  const look = (z, fov) => {
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.position.set(0, 0, z); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    return { ...renderer.update(camera, true) };
  };

  // Narrow view: the chunk is only partly visible, so the flanking plants must
  // still be culled. This is what a wrong containment test would break.
  assert.equal(look(80, 15).full, 1, 'off-screen plants stay culled when the chunk straddles the frustum');
  // Wide, distant view: the chunk is wholly inside, so every plant is drawn.
  assert.equal(look(400, 70).full, 3, 'a contained chunk submits all of its plants');
  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('distant vegetation LODs stop casting shadows and expose occlusion bounds', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(3, 12, 3), material = new THREE.MeshStandardNodeMaterial();
  const position = new THREE.Vector3(0, 0, -20);
  const renderer = new VegetationLodRenderer({
    scene,
    config: {
      vegetationLod: {
        update: { cameraMoveThreshold: 0.5, cameraRotationThreshold: 0.0038, cameraTurnMarginDegrees: 12, shadowCastDistance: 50 },
      },
    },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [1000, 2000], far: 5000 }),
  });
  renderer.addVariant({
    key: 'shadow-gate',
    // Shared tree draws opt out of occlusion; a local stage is the candidate.
    kind: 'rock',
    full: [{ geometry, material }],
    records: [{
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 4),
    }],
  });

  camera.position.set(0, 0, 0); camera.lookAt(position); camera.updateMatrixWorld();
  renderer.update(camera, true);
  const full = scene.children.find(mesh => mesh.name === 'shadow-gate:full');
  assert.equal(full.castShadow, true, 'a nearby tree still casts a shadow');
  assert.notEqual(full.userData.occlusionCull, false, 'mesh stages may be occlusion candidates');
  assert.ok(full.userData.occlusionBounds instanceof THREE.Box3, 'occlusion bounds are published');
  assert.equal(full.userData.occlusionBounds.isEmpty(), false);

  camera.position.set(0, 0, -120); camera.lookAt(position); camera.updateMatrixWorld();
  renderer.update(camera, true);
  assert.equal(full.castShadow, false, 'a distant tree stops casting shadows');

  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('full and medium trees cast one solid shadow each from a shadow-layer low-stage caster', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const shadowCamera = new THREE.OrthographicCamera();
  const fullGeometry = new THREE.BoxGeometry(3, 12, 3, 4, 4, 4), lowGeometry = new THREE.BoxGeometry(3, 12, 3);
  const material = new THREE.MeshStandardNodeMaterial();
  const positions = [new THREE.Vector3(0, 0, -20), new THREE.Vector3(6, 0, -20)];
  // Centres place the pair across the full->medium blend at ~20 units.
  let centers = [20, 2000];
  const renderer = new VegetationLodRenderer({
    scene,
    shadowCamera,
    config: {
      vegetationLod: {
        update: {
          cameraMoveThreshold: 0.5, cameraRotationThreshold: 0.0038, cameraTurnMarginDegrees: 12,
          shadowCastDistance: 50, shadowLodLevel: 2,
        },
      },
    },
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers, blend: 0.3, far: 5000 }),
  });
  const full = [{ geometry: fullGeometry, material }];
  renderer.addVariant({
    key: 'caster-tree',
    kind: 'tree',
    full,
    asset: { levels: [null, full, [{ geometry: lowGeometry, material }]], entry: {} },
    records: positions.map((position) => ({
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 4),
    })),
  });
  assert.equal(shadowCamera.layers.isEnabled(SHADOW_LAYER), true, 'the sun sees the caster layer');

  camera.position.set(3, 0, 0); camera.lookAt(3, 0, -20); camera.updateMatrixWorld();
  renderer.update(camera, true);
  const stage = (name) => scene.children.find(mesh => mesh.name === `caster-tree:${name}`);
  const caster = stage('shadow');
  assert.equal(stage('full').visible, true);
  assert.equal(stage('medium').visible, true, 'the pair is cross-fading between full and medium');
  assert.equal(stage('full').castShadow, false, 'detailed stages leave the shadow pass');
  assert.equal(stage('medium').castShadow, false);
  assert.equal(caster.visible, true);
  assert.equal(caster.castShadow, true);
  assert.equal(caster.count, 2, 'one caster instance per tree, not one per stage');
  const interval = caster.geometry.attributes.lodInterval;
  assert.deepEqual([interval.getX(0), interval.getY(0), interval.getX(1), interval.getY(1)], [0, 1, 0, 1],
    'each shadow is solid, never dithered by the cross-fade');
  assert.equal(caster.geometry.index.count, lowGeometry.index.count, 'the caster draws low-stage triangles');
  assert.notEqual(caster.instanceMatrix, stage('full').instanceMatrix, 'the caster packs its own instances');
  assert.equal(caster.layers.mask, 1 << SHADOW_LAYER, 'main and reflection cameras never draw it');

  camera.position.set(3, 0, -140); camera.lookAt(3, 0, -20); camera.updateMatrixWorld();
  renderer.update(camera, true);
  assert.equal(caster.visible, false, 'the distance gate applies to the caster');

  renderer.dispose();
  assert.equal(caster.parent, null);
  fullGeometry.dispose(); lowGeometry.dispose(); material.dispose();
});

test('shared tree batches stay out of whole-draw GPU occlusion', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  const geometry = new THREE.BoxGeometry(3, 12, 3), material = new THREE.MeshStandardNodeMaterial();
  const renderer = new VegetationLodRenderer({
    scene,
    config: {},
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [1000, 2000], far: 5000 }),
  });
  const records = [-40, 40].map((x) => {
    const position = new THREE.Vector3(x, 0, -100);
    return {
      position,
      matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0,
      sphere: new THREE.Sphere(position, 4),
    };
  });
  renderer.addVariant({ key: 'shared-tree', kind: 'tree', full: [{ geometry, material }], records });
  camera.lookAt(0, 0, -100); camera.updateMatrixWorld();
  renderer.update(camera, true);

  const full = scene.children.find(mesh => mesh.name === 'shared-tree:full');
  assert.equal(full.userData.occlusionCull, false,
    'one global indirect tree draw cannot be spatially occluded per chunk');

  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('a scheduler stages draws instead of constructing them during update', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardNodeMaterial();
  const scheduler = createVegetationJobScheduler({ budgetMs: 100, now: () => 0 });
  const prepared = [];
  const renderer = new VegetationLodRenderer({
    scene, config: {}, chunkSize: 20,
    prepareMaterial: () => material.clone(),
    policy: () => ({ centers: [20, 40], far: 100 }),
  });
  renderer.setScheduler(scheduler, {
    prepare: async (meshes) => { prepared.push(...meshes.map((mesh) => mesh.name)); },
  });
  renderer.addVariant({
    key: 'region', full: [{ geometry, material }], asset: { levels: [null, [{ geometry, material }]], entry: {} },
    records: [{ position: new THREE.Vector3(), matrix: new Float32Array(new THREE.Matrix4().elements),
      fraction: 0, sphere: new THREE.Sphere(new THREE.Vector3(), 2) }],
  });
  renderer.update(camera, true);
  assert.equal(scene.children.length, 0, 'update must not construct missing draws synchronously');
  for (let step = 0; step < 8; step += 1) {
    scheduler.tick();
    await Promise.resolve();
  }
  assert.equal(renderer.dirty, true, 'publication must invalidate LOD state without waiting for camera motion');
  renderer.update(camera);
  assert.ok(prepared.includes('region:full'));
  assert.ok(scene.children.length > 0, 'the scheduled job builds the identical gameplay mesh');
  assert.ok(scene.children.some((mesh) => mesh.visible && mesh.count > 0));
  renderer.dispose(); geometry.dispose(); material.dispose();
});

test('a scheduler defers plant-card construction instead of building it in addVariant', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardNodeMaterial();
  const atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const capture = { center: [0, 1, 0], width: 2, height: 2, views: 8, tileSize: 128 };
  const scheduler = createVegetationJobScheduler({ budgetMs: 100, now: () => 0 });
  const prepared = [];
  const renderer = new VegetationLodRenderer({
    scene, config: {}, chunkSize: 20,
    prepareMaterial: () => material.clone(),
    policy: () => ({ plant: true, centers: [20], blend: 0.15, far: 100 }),
  });
  renderer.setScheduler(scheduler, {
    prepare: async (meshes) => { prepared.push(...meshes.map((mesh) => mesh.name)); },
  });
  const position = new THREE.Vector3(0, 0, -10);
  renderer.addVariant({
    key: 'deferred-plants', kind: 'grass', full: [{ geometry, material }],
    records: [{ position, matrix: new Float32Array(new THREE.Matrix4().makeTranslation(position).elements),
      fraction: 0, sphere: new THREE.Sphere(position, 2) }],
    asset: { levels: [], atlas, entry: { capture } },
  });
  assert.equal(scene.children.length, 0, 'addVariant must not build plant cards while a scheduler is attached');
  renderer.update(camera, true);
  assert.equal(scene.children.length, 0, 'a pending card chunk must not fall back to mesh draws');
  for (let step = 0; step < 8; step += 1) { scheduler.tick(); await Promise.resolve(); }
  const cards = scene.children.filter((mesh) => mesh.name === 'deferred-plants:billboard');
  assert.equal(cards.length, 1, 'the scheduler builds the card instance stream');
  assert.ok(prepared.includes('deferred-plants:billboard'), 'the card draw is prepared through the gameplay passes');
  renderer.update(camera, true);
  assert.ok(cards[0].visible, 'published cards become visible without waiting for camera motion');
  renderer.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose(); atlas.dispose();
});
