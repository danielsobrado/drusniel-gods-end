import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectShaderCompileDiagnostics,
  formatShaderCompileCategories,
  formatShaderMaterialTypes,
} from '../src/rendering/ShaderCompileDiagnostics.js';

function material(uuid, type, name = '') {
  return { uuid, type, name };
}

function mesh(name, materialValue) {
  return { isMesh: true, name, type: 'Mesh', material: materialValue };
}

test('shader diagnostics count unique materials and classify visible renderables', () => {
  const grassMaterial = material('grass', 'MeshStandardNodeMaterial', 'Grass blades');
  const waterMaterial = material('water', 'MeshStandardNodeMaterial', 'Sea surface');
  const characterMaterial = material('character', 'MeshStandardMaterial', 'Player armor');
  const objects = [
    mesh('GrassField', grassMaterial),
    mesh('WildGrass', grassMaterial),
    mesh('Ocean Water', waterMaterial),
    mesh('Player Character', characterMaterial),
  ];
  const scene = { traverseVisible(callback) { objects.forEach(callback); } };

  const result = collectShaderCompileDiagnostics(scene);

  assert.equal(result.renderables, 4);
  assert.equal(result.materials, 3);
  assert.equal(result.categories.find((entry) => entry.id === 'vegetation').materials, 1);
  assert.equal(result.categories.find((entry) => entry.id === 'water').materials, 1);
  assert.equal(result.categories.find((entry) => entry.id === 'character').materials, 1);
  assert.match(formatShaderCompileCategories(result), /Vegetation 1/);
  assert.match(formatShaderMaterialTypes(result), /MeshStandardNodeMaterial ×2/);
});

test('shader diagnostics include every material in multi-material meshes once', () => {
  const stone = material('stone', 'MeshStandardMaterial', 'Stone');
  const moss = material('moss', 'MeshStandardMaterial', 'Moss');
  const scene = {
    traverseVisible(callback) {
      callback(mesh('Rock Prop', [stone, moss]));
      callback(mesh('Rock Prop Copy', [stone, moss]));
    },
  };

  const result = collectShaderCompileDiagnostics(scene);
  assert.equal(result.renderables, 2);
  assert.equal(result.materials, 2);
  assert.equal(result.categories.find((entry) => entry.id === 'props').materials, 2);
});
