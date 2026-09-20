import * as THREE from 'three/webgpu';
import { atan, attribute, cameraPosition, floor, fract, interleavedGradientNoise,
  mix, positionGeometry, screenCoordinate, smoothstep, texture, transformNormalToView,
  uv, vec2, vec3, vec4 } from 'three/tsl';
import { createSimpleFoliageSway } from './foliageWind.js';

const VIEWS = 8;
const TILE_SIZE = 128;

/** Bake albedo silhouettes once; the live scene still lights the distant cards. */
export async function bakeUnderstoryBillboard(renderer, plant) {
  const scene = new THREE.Scene();
  const bounds = new THREE.Box3();
  const materials = [];
  for (const primitive of plant.primitives) {
    const source = primitive.sourceMaterial;
    const material = new THREE.MeshBasicNodeMaterial({ map: source?.map ?? null,
      color: source?.color ?? 0xffffff, side: THREE.DoubleSide, alphaTest: 0.1 });
    materials.push(material);
    scene.add(new THREE.Mesh(primitive.geometry, material));
    bounds.union(primitive.geometry.boundingBox);
  }
  const width = 2 * Math.hypot(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
    Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z))) * 1.06;
  const height = plant.height * 1.06;
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.01, 1000);
  const center = new THREE.Vector3(0, height / 2, 0);
  const target = new THREE.RenderTarget(TILE_SIZE * VIEWS, TILE_SIZE, {
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
  });
  target.texture.name = `Understory views ${plant.name}`;
  target.texture.anisotropy = 4;
  target.scissorTest = true;
  const previousTarget = renderer.getRenderTarget(), previousMRT = renderer.getMRT();
  const previousColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousAlpha = renderer.getClearAlpha(), previousAutoClear = renderer.autoClear;
  try {
    renderer.setMRT(null); renderer.setClearColor(0x000000, 0); renderer.autoClear = false;
    // WebGPU attachment clears cover the whole atlas, regardless of scissor.
    // Clear its color once, then retain completed views while clearing depth.
    renderer.setRenderTarget(target); renderer.clear();
    for (let view = 0; view < VIEWS; view++) {
      const angle = view * Math.PI * 2 / VIEWS, distance = Math.max(width, height) * 2 + 1;
      camera.position.set(Math.sin(angle) * distance, center.y, Math.cos(angle) * distance);
      camera.lookAt(center);
      target.viewport.set(view * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
      target.scissor.copy(target.viewport);
      renderer.setRenderTarget(target);
      renderer.clear(false, true, false);
      await renderer.renderAsync(scene, camera);
    }
    return { target, width, height, views: VIEWS, tileSize: TILE_SIZE };
  } catch (error) {
    target.dispose(); throw error;
  } finally {
    renderer.setRenderTarget(previousTarget); renderer.setMRT(previousMRT);
    renderer.setClearColor(previousColor, previousAlpha); renderer.autoClear = previousAutoClear;
    for (const material of materials) material.dispose();
  }
}

export function understoryCoverage(lodStart, lodEnd) {
  const origin = attribute('clumpOrigin', 'vec3');
  const distance = origin.xz.sub(cameraPosition.xz).length();
  const blend = smoothstep(lodStart, lodEnd, distance);
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  return { near: noise.greaterThanEqual(blend), far: noise.lessThan(blend) };
}

export function createUnderstoryBillboard({ atlas, capacity, radius, fadeWidth,
  lodStart, lodEnd, windIntensity, windBend, windFlutter, cinematic }) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  geometry.setAttribute('clumpOrigin', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  // width, height, original plant yaw
  geometry.setAttribute('billboardShape', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.86 });
  material.alphaTest = 0.1;
  material.alphaToCoverage = cinematic;
  const origin = attribute('clumpOrigin', 'vec3'), shape = attribute('billboardShape', 'vec3');
  const toCamera = cameraPosition.xz.sub(origin.xz);
  const toward = toCamera.div(toCamera.length().max(0.001));
  const right = vec3(toward.y, 0, toward.x.negate());
  const distance = toCamera.length();
  const fade = smoothstep(radius.sub(fadeWidth), radius, distance).oneMinus();
  const sway = createSimpleFoliageSway({ origin, heightWeight: positionGeometry.y,
    windIntensity, windBend, windFlutter });
  material.positionNode = origin.add(right.mul(positionGeometry.x.mul(shape.x))
    .add(vec3(0, positionGeometry.y.mul(shape.y), 0)).add(sway).mul(fade));
  // Blend neighbouring views so circling a plant never snaps between images.
  const angle = atan(toCamera.x, toCamera.y).sub(shape.z).div(Math.PI * 2);
  const view = fract(angle.add(1)).mul(atlas.views);
  const first = floor(view), second = first.add(1).mod(atlas.views);
  const inset = 0.5 / atlas.tileSize;
  const tileUv = uv().clamp(inset, 1 - inset);
  // Render-target UVs use the opposite vertical orientation from mesh UVs;
  // TextureNode handles the remaining backend-specific texture orientation.
  const staticAtlas = Boolean(atlas.texture);
  const atlasTexture = atlas.texture ?? atlas.target?.texture;
  const atlasY = staticAtlas ? tileUv.y : tileUv.y.oneMinus();
  const sample = index => texture(atlasTexture, vec2(tileUv.x.add(index).div(atlas.views), atlasY));
  const a = sample(first), b = sample(second), blend = fract(view);
  const alpha = mix(a.a, b.a, blend);
  // Captures have black transparent borders. Unpremultiply after the blend.
  const rgb = mix(a.rgb, b.rgb, blend).div(alpha.max(0.001));
  material.colorNode = vec4(rgb, alpha);
  material.normalNode = transformNormalToView(vec3(0, 1, 0));
  material.maskNode = understoryCoverage(lodStart, lodEnd).far;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'Understory billboard';
  mesh.count = 0;
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.userData.excludeFromReflection = true;
  mesh.userData.occlusionCull = false;
  return mesh;
}
