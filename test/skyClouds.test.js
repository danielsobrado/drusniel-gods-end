import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { CloudSystem } from '../src/environment/CloudSystem.js';
import { SkySystem } from '../src/environment/SkySystem.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

const config = await loadMergedConfig();

test('sky matches its geometry and follows the render camera', () => {
  const scene = new THREE.Scene();
  const sky = new SkySystem(scene, config);

  try {
    assert.equal(sky.mesh.name, 'Sky');
    assert.equal(sky.mesh.renderOrder, -1000);
    assert.equal(sky.mesh.frustumCulled, false);
    assert.equal(sky.mesh.geometry.parameters.radius, 5000);
    assert.equal(sky.mesh.geometry.parameters.widthSegments, 64);
    assert.equal(sky.mesh.geometry.parameters.heightSegments, 32);
    assert.equal(sky.mesh.material.side, THREE.BackSide);
    assert.equal(sky.mesh.material.depthWrite, false);
    assert.equal(sky.mesh.material.depthTest, false);
    assert.equal(sky.mesh.material.fog, false);

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(12, 34, 56);
    sky.mesh.onBeforeRender(null, scene, camera);
    assert.deepEqual(sky.mesh.position.toArray(), [12, 34, 56]);
    assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(sky.mesh.matrixWorld).toArray(), [12, 34, 56]);
    const parent = new THREE.Group();
    parent.position.set(100, 0, -200);
    parent.add(camera);
    sky.mesh.onBeforeRender(null, scene, camera);
    assert.deepEqual(sky.mesh.position.toArray(), [112, 34, -144], 'reflection camera uses its world position');
  } finally {
    sky.dispose();
  }
});

test('clouds match plane geometry, wind and explicit time update', () => {
  const scene = new THREE.Scene();
  const clouds = new CloudSystem(scene, config);

  try {
    assert.equal(clouds.mesh.geometry.type, 'PlaneGeometry');
    assert.equal(clouds.mesh.geometry.parameters.width, 5000);
    assert.equal(clouds.mesh.geometry.parameters.height, 5000);
    assert.equal(clouds.mesh.geometry.parameters.widthSegments, 1);
    assert.equal(clouds.mesh.geometry.parameters.heightSegments, 1);
    assert.equal(clouds.mesh.renderOrder, -100);
    assert.equal(clouds.mesh.frustumCulled, false);
    assert.equal(clouds.mesh.rotation.x, -Math.PI * 0.5);
    assert.equal(clouds.mesh.position.y, 120);
    assert.equal(clouds.material.side, THREE.BackSide);
    assert.equal(clouds.material.depthWrite, false);
    assert.equal(clouds.material.depthTest, true);
    assert.equal(clouds.material.fog, true);
    assert.deepEqual(clouds.uniforms.wind.value.toArray(), [1, 0.2]);

    const before = clouds.uniforms.time.value;
    clouds.update(0.25);
    assert.equal(clouds.uniforms.time.value, before + 0.25);
  } finally {
    clouds.dispose();
  }
});
