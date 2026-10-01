import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installMatrixUpdateCache, getSceneGraphVersion } from '../src/core/matrixUpdateCache.js';
import { collectReflectionMask, withReflectionMask } from '../src/water/reflectionMask.js';

installMatrixUpdateCache();

function excludedMesh(name) {
  const mesh = new THREE.Mesh();
  mesh.name = name;
  mesh.userData.excludeFromReflection = true;
  return mesh;
}

test('hides excluded objects and pauses shadows only during the callback', () => {
  const scene = new THREE.Scene();
  const grass = excludedMesh('grass');
  const rock = new THREE.Mesh();
  const sun = new THREE.DirectionalLight();
  sun.shadow.autoUpdate = true;
  scene.add(grass, rock, sun);

  const seen = withReflectionMask(scene, () => ({
    grass: grass.visible, rock: rock.visible, shadow: sun.shadow.autoUpdate,
  }));
  assert.deepEqual(seen, { grass: false, rock: true, shadow: false });
  assert.equal(grass.visible, true);
  assert.equal(sun.shadow.autoUpdate, true);
});

test('caches the traverse until the scene graph changes', () => {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  group.add(excludedMesh('a'));
  const first = collectReflectionMask(scene);
  assert.equal(first.excluded.length, 1);
  assert.equal(collectReflectionMask(scene), first);
  assert.equal(first.version, getSceneGraphVersion());

  const late = excludedMesh('b');
  group.add(late);
  const second = collectReflectionMask(scene);
  assert.equal(second.excluded.length, 2);
  assert.ok(second.excluded.includes(late));

  late.removeFromParent();
  assert.equal(collectReflectionMask(scene).excluded.length, 1);

  group.clear();
  assert.equal(collectReflectionMask(scene).excluded.length, 0);
});

test('already hidden excluded objects stay hidden afterwards', () => {
  const scene = new THREE.Scene();
  const hidden = excludedMesh('hidden');
  hidden.visible = false;
  scene.add(hidden);
  withReflectionMask(scene, () => {});
  assert.equal(hidden.visible, false);
});

test('restores state when the callback throws', () => {
  const scene = new THREE.Scene();
  const grass = excludedMesh('grass');
  scene.add(grass);
  assert.throws(() => withReflectionMask(scene, () => { throw new Error('capture failed'); }));
  assert.equal(grass.visible, true);
  withReflectionMask(scene, () => assert.equal(grass.visible, false));
});
