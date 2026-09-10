import * as THREE from 'three/webgpu';
import { positionWorld, texture, uv, vec2, vec3, vec4, float } from 'three/tsl';

const DEFAULT_RESOLUTION = 1024;
const CAMERA_HEIGHT_PADDING = 5;
const CAMERA_NEAR = 0.01;
const CAMERA_FAR_PADDING = 10;
const MIN_HEIGHT_RANGE = 0.0001;

async function createGpuTerrainNormalTexture(renderer, heightTexture, resolution, size, minHeight, maxHeight) {
  const target = new THREE.RenderTarget(resolution, resolution, {
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.flipY = false;
  target.texture.generateMipmaps = false;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;

  const uvNode = uv();
  const step = float(0.8);
  const range = float(Math.max(MIN_HEIGHT_RANGE, maxHeight - minHeight));
  const dx = vec2(step, 0).div(vec2(size.x, size.z));
  const dz = vec2(0, step).div(vec2(size.x, size.z));
  const sample = (offset) => texture(heightTexture, uvNode.add(offset).clamp(0, 1)).level(0).r.mul(range);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = vec4(
    vec3(sample(dx.negate()).sub(sample(dx)), step.mul(2), sample(dz.negate()).sub(sample(dz))).normalize().mul(0.5).add(0.5),
    1,
  );
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  camera.position.z = 1;
  const scene = new THREE.Scene();
  scene.add(quad);
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.clear();
    await renderer.renderAsync(scene, camera);
  } catch (error) {
    target.dispose();
    throw error;
  } finally {
    renderer.setRenderTarget(previous);
    scene.remove(quad);
    quad.geometry.dispose();
    material.dispose();
  }
  target.texture.userData.normalTarget = target;
  return target.texture;
}

export async function createGrassTerrainData(renderer, terrain, resolution = DEFAULT_RESOLUTION) {
  if (!terrain?.geometry) throw new Error('Grass terrain target must be a mesh.');

  terrain.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(terrain);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const minHeight = bounds.min.y;
  const maxHeight = bounds.max.y;
  const heightRange = Math.max(MIN_HEIGHT_RANGE, maxHeight - minHeight);
  const renderTarget = new THREE.RenderTarget(resolution, resolution, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  renderTarget.texture.colorSpace = THREE.NoColorSpace;
  renderTarget.texture.minFilter = THREE.LinearFilter;
  renderTarget.texture.magFilter = THREE.LinearFilter;
  renderTarget.texture.generateMipmaps = false;

  const camera = new THREE.OrthographicCamera(
    -size.x * 0.5,
    size.x * 0.5,
    size.z * 0.5,
    -size.z * 0.5,
    CAMERA_NEAR,
    size.y + CAMERA_FAR_PADDING,
  );
  camera.position.set(center.x, bounds.max.y + CAMERA_HEIGHT_PADDING, center.z);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const material = new THREE.MeshBasicNodeMaterial();
  const normalizedHeight = positionWorld.y.sub(minHeight).div(heightRange);
  material.colorNode = vec3(normalizedHeight);

  const mesh = new THREE.Mesh(terrain.geometry, material);
  mesh.position.copy(terrain.position);
  mesh.quaternion.copy(terrain.quaternion);
  mesh.scale.copy(terrain.scale);
  mesh.updateMatrixWorld(true);

  const scene = new THREE.Scene();
  scene.add(mesh);
  const previousTarget = renderer.getRenderTarget();
  let normalTexture = null;

  try {
    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    try {
      normalTexture = await createGpuTerrainNormalTexture(
        renderer, renderTarget.texture, resolution, size, minHeight, maxHeight,
      );
    } catch {
      normalTexture = null;
    }
  } catch (error) {
    renderTarget.dispose();
    normalTexture?.userData.normalTarget?.dispose();
    throw error;
  } finally {
    renderer.setRenderTarget(previousTarget);
    scene.remove(mesh);
    material.dispose();
  }

  return {
    texture: renderTarget.texture,
    normalTexture,
    bounds,
    boundsMin: bounds.min,
    boundsSize: size,
    minHeight,
    maxHeight,
    getShaderData() {
      return {
        texture: renderTarget.texture,
        normalTexture,
        boundsMin: bounds.min,
        boundsSize: size,
        minHeight,
        maxHeight,
      };
    },
    dispose() {
      normalTexture?.userData.normalTarget?.dispose();
      renderTarget.dispose();
    },
  };
}
