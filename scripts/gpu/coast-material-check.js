import * as THREE from 'three/webgpu';
import { createCinematicWaterMaterial } from '../../src/water/WaterMaterial.js';
import { createGroundMaterial } from '../../src/world/GroundMaterial.js';
import { coastalHeight } from '../../src/world/CoastField.js';
import { disposePresetAppearance } from '../../src/rendering/PresetAppearance.js';

// Exercise production fragment graphs: diagnostic normal outputs alone bypass
// refraction, specular, foam, opacity, and the PBR ground shader entirely.
export async function checkCoastMaterials(renderer) {
  const previousTarget = renderer.getRenderTarget();
  const target = new THREE.RenderTarget(32, 32, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#dceeff', '#807050', 2));
  const light = new THREE.DirectionalLight('#ffffff', 2);
  light.position.set(3, 8, 4);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const context = canvas.getContext('2d');
  context.fillStyle = '#b0b0b0';
  context.fillRect(0, 0, 2, 2);
  const image = canvas.toDataURL();
  const reflection = new THREE.CubeTexture(Array(6).fill(canvas));
  reflection.needsUpdate = true;
  const terrainTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  terrainTexture.needsUpdate = true;
  const riverTexture = new THREE.DataTexture(new Float32Array([0, -10, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  riverTexture.needsUpdate = true;
  const sea = { enabled: true, shoreX: 0, level: 0, depth: 95,
    coast: { curve: { longAmplitude: 0, shortAmplitude: 0 } } };
  const config = {
    assets: { grassTexture: image, groundBlend: image,
      ground: { color: image, normal: image, roughness: image } },
    ground: {}, cinematic: { enabled: true, style: { enabled: false } },
    terrain: { expansion: { enabled: true } },
    water: { size: 640, position: [0, 0, 0], sea },
  };
  const shaderOptions = {
    params: config.water,
    terrain: { texture: terrainTexture, boundsMin: { x: -100, z: -100 },
      boundsSize: { x: 1000, z: 1000 }, minHeight: -95, maxHeight: 0 },
    river: { texture: riverTexture, bounds: { min: { x: -100, z: -100 } }, size: { x: 1000, z: 1000 } },
    reflection,
  };
  const shader = createCinematicWaterMaterial(shaderOptions);
  const waterGeometry = new THREE.PlaneGeometry(24, 24, 24, 24);
  waterGeometry.rotateX(-Math.PI / 2);
  const count = waterGeometry.attributes.position.count;
  for (const name of ['waterKind', 'waterLevel']) {
    waterGeometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  }
  for (const name of ['waterFlow', 'riverSurface']) {
    waterGeometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  }
  const water = new THREE.Mesh(waterGeometry, shader.material);
  water.frustumCulled = false;
  scene.add(water);
  let ground, groundGeometry;
  let frames = 0;
  const render = async (label) => {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0, 0);
    await renderer.renderAsync(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32);
    let covered = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const pixel = [0, 1, 2, 3].map((channel) => THREE.DataUtils.fromHalfFloat(pixels[i + channel]));
      if (!pixel.every(Number.isFinite)) throw new Error(`${label}: non-finite material output`);
      if (pixel[3] > 0.05 && Math.max(...pixel.slice(0, 3)) > 0.001) covered += 1;
    }
    if (covered < 100) throw new Error(`${label}: material did not draw enough colored pixels (${covered})`);
    frames += 1;
    return pixels;
  };
  try {
    let previousX = 0;
    for (const kind of [0, 1, 2]) {
      const x = kind === 0 ? 0 : 500;
      // Production tiles store coordinates relative to the shared water root.
      // Do not add a per-tile transform that the vertex wave function cannot see.
      waterGeometry.translate(x - previousX, 0, 0);
      previousX = x;
      waterGeometry.attributes.waterKind.array.fill(kind);
      waterGeometry.attributes.waterKind.needsUpdate = true;
      camera.position.set(x, 20, 10);
      camera.lookAt(x, 0, 0);
      for (const rain of [0, 1]) for (const detail of [0, 0.4, 0.7, 1]) {
        shader.uniforms.rain.value = rain;
        shader.uniforms.clock.value = rain ? 730 : 5;
        shader.uniforms.seaDetail.value = detail;
        await render(`water kind ${kind}, rain ${rain}, detail ${detail}`);
      }
    }
    // Ocean specular controls must not alter lake highlights. Compare real
    // fragment output with those controls disabled, not only the normal graph.
    waterGeometry.translate(-previousX, 0, 0);
    waterGeometry.attributes.waterKind.array.fill(0);
    waterGeometry.attributes.waterKind.needsUpdate = true;
    camera.position.set(0, 20, 10);
    camera.lookAt(0, 0, 0);
    shader.uniforms.rain.value = 0;
    shader.uniforms.clock.value = 5;
    const baseline = await render('lake specular baseline');
    const alternate = createCinematicWaterMaterial({
      ...shaderOptions,
      params: { ...config.water, sea: { ...sea,
        detail: { specularSharpStrength: 0, specularBroadStrength: 0 } } },
    });
    try {
      alternate.uniforms.clock.value = 5;
      water.material = alternate.material;
      const pixels = await render('lake with offshore specular disabled');
      for (let i = 0; i < pixels.length; i += 1) {
        if (Math.abs(THREE.DataUtils.fromHalfFloat(pixels[i])
          - THREE.DataUtils.fromHalfFloat(baseline[i])) > 0.001) {
          throw new Error('Offshore specular controls changed lake rendering');
        }
      }
    } finally {
      water.material = shader.material;
      alternate.dispose();
    }
    water.visible = false;
    ground = await createGroundMaterial(config);
    groundGeometry = new THREE.PlaneGeometry(32, 32, 32, 32);
    groundGeometry.rotateX(-Math.PI / 2);
    const positions = groundGeometry.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      positions.setY(i, coastalHeight(positions.getX(i), positions.getZ(i), 20, sea));
    }
    positions.needsUpdate = true;
    groundGeometry.computeVertexNormals();
    scene.add(new THREE.Mesh(groundGeometry, ground));
    camera.position.set(-4, 25, 12);
    camera.lookAt(-4, 0, 0);
    for (const rain of [0, 1]) for (const clock of [0, 1, 3, 730]) {
      ground.userData.setRainIntensity(rain);
      ground.userData.updateCoast(1, clock);
      await render(`ground rain ${rain}, clock ${clock}`);
    }
    return frames;
  } finally {
    renderer.setRenderTarget(previousTarget);
    shader.dispose();
    waterGeometry.dispose();
    groundGeometry?.dispose();
    for (const texture of ground?.userData.textures ?? []) texture.dispose();
    ground?.dispose();
    disposePresetAppearance(config);
    reflection.dispose();
    terrainTexture.dispose();
    riverTexture.dispose();
    target.dispose();
  }
}
