import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import StandardNodeLibrary from 'three/src/renderers/webgpu/nodes/StandardNodeLibrary.js';
import { CinematicLighting } from '../src/rendering/CinematicLighting.js';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';

test('distant backdrop fade preserves its authored material and restores ownership on disposal', async () => {
  const config = await loadMergedConfig();
  config.cinematic.shadows.cascades = 1;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#aabbcc', 0.004);
  const original = new THREE.MeshStandardMaterial({ color: '#364523', roughness: 0.73 });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), original);
  backdrop.name = 'Landscape046';
  const terrainTarget = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshStandardMaterial());
  scene.add(backdrop, terrainTarget);
  const renderer = { library: new StandardNodeLibrary(), backend: { isWebGPUBackend: false } };
  const lighting = new CinematicLighting({ scene, terrain: scene, terrainTarget, sun: new THREE.DirectionalLight(), renderer }, config);
  const faded = backdrop.material;
  try {
    assert.equal(faded.color.getHex(), original.color.getHex());
    assert.equal(faded.roughness, original.roughness);
    assert.equal(faded.transparent, true);
    assert.equal(faded.depthWrite, false);
    assert.equal(terrainTarget.material.depthWrite, true);
    assert.equal(original.transparent, false);
  } finally {
    lighting.dispose();
    assert.equal(backdrop.material, original);
    backdrop.geometry.dispose(); original.dispose();
    terrainTarget.geometry.dispose(); terrainTarget.material.dispose();
  }
});
