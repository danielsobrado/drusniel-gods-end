import * as THREE from 'three/webgpu';
import { positionWorld, vec3 } from 'three/tsl';

const DEFAULT_RESOLUTION = 1024;
const CAMERA_HEIGHT_PADDING = 5;
const CAMERA_NEAR = 0.01;
const CAMERA_FAR_PADDING = 10;
const MIN_HEIGHT_RANGE = 0.0001;

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

  try {
    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    await renderer.renderAsync(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    scene.remove(mesh);
    material.dispose();
  }

  return {
    texture: renderTarget.texture,
    bounds,
    boundsMin: bounds.min,
    boundsSize: size,
    minHeight,
    maxHeight,
    getShaderData() {
      return {
        texture: renderTarget.texture,
        boundsMin: bounds.min,
        boundsSize: size,
        minHeight,
        maxHeight,
      };
    },
    dispose() {
      renderTarget.dispose();
    },
  };
}
