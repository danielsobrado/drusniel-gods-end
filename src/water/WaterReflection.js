import * as THREE from 'three/webgpu';
import CubeRenderTarget from 'three/src/renderers/common/CubeRenderTarget.js';

export function createReflectionRenderTarget(params) {
  return new CubeRenderTarget(params.reflectionResolution, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
  });
}

export function createReflectionCapture(mesh, params) {
  const renderTarget = createReflectionRenderTarget(params);
  const cubeCamera = new THREE.CubeCamera(
    params.reflectionNear,
    params.reflectionFar,
    renderTarget,
  );
  cubeCamera.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
  cubeCamera.position.y += 1;
  renderTarget.texture.mapping = THREE.CubeReflectionMapping;
  renderTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return { texture: renderTarget.texture, renderTarget, cubeCamera };
}
