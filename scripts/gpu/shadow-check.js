// Minimal WebGPU shadow bisect harness. Adds app features cumulatively per
// ?step=N so we can find which one suppresses the directional-light shadow.
// Read-only probe: it never touches the app's own scene.
import * as THREE from 'three/webgpu';
import { fog, pass, renderOutput, positionView, uniform } from 'three/tsl';

const params = new URLSearchParams(window.location.search);
const step = Number(params.get('step') ?? 1);
const log = [];
const results = document.getElementById('results');
const say = (line) => { log.push(line); results.textContent = log.join('\n'); };

say(`step=${step}  three=${THREE.REVISION}`);

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
await renderer.init();
say(`renderer=${renderer.constructor.name} backend=${renderer.backend.constructor.name} shadowMap=${renderer.shadowMap.enabled}/${renderer.shadowMap.type}`);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fc6e8');
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 26, 26);
camera.lookAt(2, 0, 2);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardNodeMaterial({ color: 0x8fbf6a, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const box = new THREE.Mesh(
  new THREE.BoxGeometry(4, 4, 4),
  new THREE.MeshStandardNodeMaterial({ color: 0xcc3333 }),
);
box.position.set(0, 3, 0);
box.castShadow = true;
scene.add(box);

const sun = new THREE.DirectionalLight(0xffe0ae, 2.8);
sun.position.set(-28, 65, -30);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(2048);
Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 0.5, far: 200 });
sun.shadow.camera.updateProjectionMatrix();
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);
say('1 baseline: plane + box + directional light');

// --- 2: tone mapping / output color space
if (step >= 2) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  say('2 + ACESFilmic tone mapping + sRGB output');
}

// --- 3: fill lights
let hemisphere = null;
let ambient = null;
if (step >= 3) {
  hemisphere = new THREE.HemisphereLight(0xbcd9ff, 0x54703a, 0.95);
  ambient = new THREE.AmbientLight(0xffffff, 0.32);
  scene.add(hemisphere, ambient);
  say('3 + HemisphereLight(0.95) + AmbientLight(0.32)');
}

// --- 4: TSL exponential fog node (shape of CinematicLighting.js:24-37)
if (step >= 4) {
  scene.fog = new THREE.FogExp2(0xcfe3f2, 0.0018);
  const fogColor = uniform(scene.fog.color.clone());
  const fogDensity = uniform(scene.fog.density);
  const distance = positionView.z.negate().max(0);
  const factor = distance.mul(fogDensity).pow(2).negate().exp().oneMinus().clamp(0, 1);
  scene.fogNode = fog(fogColor, factor);
  say('4 + scene.fogNode = fog(color, exp factor)');
}

// --- 5: app shadow tuning
if (step >= 5) {
  sun.shadow.intensity = 0.72;
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.03;
  say('5 + shadow intensity .72 radius 4 bias -1e-4 normalBias .03');
}

// --- 6: per-frame sun rig move (EnvironmentController.js:157-161)
const sunOffset = new THREE.Vector3(-28, 65, -30);
const follow = new THREE.Vector3(0, 0, 0);
function updateSunTarget(position) {
  sun.position.copy(position).add(sunOffset);
  sun.target.position.copy(position);
  sun.target.updateMatrixWorld();
}
if (step >= 6) say('6 + per-frame updateSunTarget()');

// --- 7: RenderPipeline with pass()
let post = null;
if (step >= 7) {
  post = new THREE.RenderPipeline(renderer);
  post.outputColorTransform = false;
  const scenePass = pass(scene, camera, { samples: 4 });
  post.outputNode = renderOutput(scenePass.getTextureNode('output'));
  say('7 + RenderPipeline(pass(scene, camera, {samples:4})) + renderOutput');
}

// --- 8: pixel ratio + scene.environment (app loads an equirect HDR)
if (step >= 8) {
  renderer.setPixelRatio(1);
  const size = 32;
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const up = 1 - y / size;
      data[i] = 0.5 + up * 0.5; data[i + 1] = 0.6 + up * 0.5; data[i + 2] = 0.8 + up * 0.4; data[i + 3] = 1;
    }
  }
  const env = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  env.mapping = THREE.EquirectangularReflectionMapping;
  env.needsUpdate = true;
  scene.environment = env;
  scene.environmentIntensity = 0.3;
  say('8 + setPixelRatio(1) + equirect scene.environment (intensity .3)');
}

// --- 9: the Object3D matrix cache patch
if (step >= 9) {
  const mod = await import('../../src/core/matrixUpdateCache.js');
  const installed = mod.installMatrixUpdateCache();
  say(`9 + installMatrixUpdateCache() -> installed=${installed}`);
}

// --- 10: the app's real ground material, if it builds standalone
if (step >= 10) {
  try {
    const mod = await import('../../src/world/GroundMaterial.js');
    const cfgMod = await import('../../src/config/loadConfig.js').catch(() => null);
    const config = cfgMod?.loadConfig ? await cfgMod.loadConfig() : null;
    if (!config) throw new Error('config loader unavailable');
    ground.material = await mod.createGroundMaterial(config, null, null);
    say('10 + app createGroundMaterial() on the ground plane');
  } catch (error) {
    say(`10 SKIPPED (needs app assets): ${error.message}`);
  }
}

// Probe points: the box shadow centre (light dir projected from 3 units up)
// and a lit reference far from the box.
const lightDir = new THREE.Vector3().copy(sun.target.position).sub(sun.position).normalize();
const shadowWorld = new THREE.Vector3(
  box.position.x + (lightDir.x / -lightDir.y) * box.position.y,
  0.02,
  box.position.z + (lightDir.z / -lightDir.y) * box.position.y,
);
const refWorld = new THREE.Vector3(-20, 0.02, 14);
function project(v) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const p = v.clone().project(camera);
  return [Math.round((p.x * 0.5 + 0.5) * window.innerWidth), Math.round((-p.y * 0.5 + 0.5) * window.innerHeight)];
}
window.__computeProbe = () => {
  window.__probe = { shadowWorld: shadowWorld.toArray(), refWorld: refWorld.toArray(), shadowPx: project(shadowWorld), refPx: project(refWorld), step };
  return window.__probe;
};
window.__computeProbe();
say(`probe shadowPx=${window.__probe.shadowPx} refPx=${window.__probe.refPx}`);

let frames = 0;
renderer.setAnimationLoop(async () => {
  if (step >= 6) updateSunTarget(follow);
  if (post) await post.renderAsync();
  else await renderer.renderAsync(scene, camera);
  frames += 1;
  window.__frames = frames;
});
window.__scene = { renderer, scene, camera, sun, ground, box, post };
window.__ready = true;
say('running');
