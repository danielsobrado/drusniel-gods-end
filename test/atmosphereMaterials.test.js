import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Mesh, MeshStandardMaterial, MeshStandardNodeMaterial, Texture } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { prepareAtmosphereMaterials } from '../src/rendering/atmosphereMaterials.js';

test('atmosphere refresh preserves shared material identities, maps and controller updates', () => {
  const root = new Group(), map = new Texture();
  const material = new MeshStandardMaterial({ map });
  root.add(new Mesh(undefined, material), new Mesh(undefined, [material, material]));
  const restore = prepareAtmosphereMaterials(root);
  assert.equal(root.children[0].material, material);
  assert.equal(root.children[1].material[1], material);
  assert.equal(material.map, map);
  assert.ok(material.colorNode.isNode);
  material.opacity = 0.4;
  assert.equal(root.children[1].material[0].opacity, 0.4);
  restore();
  assert.equal(material.colorNode, undefined);
  assert.equal(material.map, map);
});

test('custom shading and deliberate fog exclusions survive atmosphere preparation', () => {
  const root = new Group();
  const custom = new MeshStandardNodeMaterial();custom.colorNode = vec3(0.2, 0.4, 0.1);
  const sky = new MeshStandardMaterial({ fog: false });
  root.add(new Mesh(undefined, custom), new Mesh(undefined, sky));
  const node = custom.colorNode, restore = prepareAtmosphereMaterials(root);
  assert.equal(custom.colorNode, node);
  assert.equal(sky.colorNode, undefined);
  restore();assert.equal(custom.colorNode, node);
});
