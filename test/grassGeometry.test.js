import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrassGeometry } from '../src/grass/GrassGeometry.js';
import { GrassGeometryFactory } from '../src/grass/GrassGeometryFactory.js';
import { grassShapeProfile } from '../src/grass/grassShapes.js';

function attributeKey(geometry, index) {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const normal = geometry.getAttribute('normal');
  const side = geometry.getAttribute('bladeSide');
  return [
    position.getX(index), position.getY(index), position.getZ(index),
    uv.getX(index), uv.getY(index),
    normal.getX(index), normal.getY(index), normal.getZ(index),
    side.getX(index),
  ].map((value) => value.toFixed(5)).join(',');
}

function uniqueKeys(geometry) {
  const keys = new Set();
  for (let index = 0; index < geometry.getAttribute('position').count; index += 1) {
    keys.add(attributeKey(geometry, index));
  }
  return keys;
}

function almostEqualTriangles(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let triangle = 0; triangle < actual.length; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(
          Math.abs(actual[triangle][corner][axis] - expected[triangle][corner][axis]) < 1e-6,
          `triangle ${triangle} corner ${corner} axis ${axis}`,
        );
      }
    }
  }
}

function trianglePositions(geometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const triangles = [];
  for (let offset = 0; offset < index.count; offset += 3) {
    triangles.push([0, 1, 2].map((corner) => {
      const vertex = index.getX(offset + corner);
      return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
    }));
  }
  return triangles;
}

// The pre-sharing generator duplicated each segment boundary. Keep it here so
// the welded strip must still emit the same triangles and silhouette.
function duplicatedBladeTriangles(detail, shape = 'slender') {
  const segments = Math.max(1, Math.round(detail));
  const profile = grassShapeProfile(shape);
  const scale = profile.widthScale * 0.5;
  const positions = [];
  const indices = [];
  let vertex = 0;
  for (let segment = 0; segment < segments; segment += 1) {
    const ratio = segment / segments;
    const nextRatio = (segment + 1) / segments;
    const halfWidth = profile.width(ratio) * scale;
    const nextHalfWidth = profile.width(nextRatio) * scale;
    positions.push(
      -halfWidth, ratio, 0,
      halfWidth, ratio, 0,
      -nextHalfWidth, nextRatio, 0,
    );
    if (segment < segments - 1) {
      positions.push(nextHalfWidth, nextRatio, 0);
      indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
      vertex += 4;
    } else {
      indices.push(vertex, vertex + 1, vertex + 2);
      vertex += 3;
    }
  }
  const triangles = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    triangles.push([0, 1, 2].map((corner) => {
      const index = indices[offset + corner] * 3;
      return [positions[index], positions[index + 1], positions[index + 2]];
    }));
  }
  return { vertexCount: vertex, triangles };
}

test('blade templates share segment-boundary vertices without dropping triangles', () => {
  for (const detail of [1, 2, 3, 4, 5]) {
    const geometry = createGrassGeometry({
      type: 'blade',
      detail,
      density: 1,
      tileSize: 4,
      bladeHeight: 1.5,
      stable: true,
    });
    const segments = detail;
    const position = geometry.getAttribute('position');
    try {
      assert.equal(position.count, 2 * segments + 1, `detail ${detail} stored vertices`);
      assert.equal(geometry.index.count / 3, 2 * segments - 1, `detail ${detail} triangles`);
      assert.equal(uniqueKeys(geometry).size, position.count, `detail ${detail} has no leftover duplicates`);
      const duplicated = 4 * segments - 1;
      if (segments > 1) assert.ok(position.count < duplicated);
    } finally {
      geometry.dispose();
    }
  }
});

test('shared high-detail blades keep nine triangles and the duplicated silhouette', () => {
  for (const shape of ['slender', 'reed', 'broadleaf']) {
    const geometry = createGrassGeometry({
      type: 'blade',
      shape,
      detail: 5,
      density: 1,
      tileSize: 4,
      bladeHeight: 1.5,
      stable: true,
    });
    const expected = duplicatedBladeTriangles(5, shape);
    try {
      assert.equal(geometry.getAttribute('position').count, 11);
      assert.equal(expected.vertexCount, 19);
      almostEqualTriangles(trianglePositions(geometry), expected.triangles);
    } finally {
      geometry.dispose();
    }
  }
});

test('unshared templates keep the 4S-1 vertex count', () => {
  const geometry = createGrassGeometry({
    type: 'blade',
    detail: 5,
    density: 1,
    tileSize: 4,
    bladeHeight: 1.5,
    stable: true,
    shareVertices: false,
  });
  try {
    assert.equal(geometry.getAttribute('position').count, 19);
    assert.equal(geometry.index.count / 3, 9);
    assert.equal(geometry.userData.lod.shareVertices, false);
  } finally {
    geometry.dispose();
  }
});

test('billboard cards keep their unshared quad and derived bladeSide', () => {
  const geometry = createGrassGeometry({
    type: 'billboard',
    detail: 1,
    density: 1,
    tileSize: 4,
    bladeHeight: 1.5,
    stable: true,
  });
  try {
    assert.equal(geometry.getAttribute('position').count, 4);
    assert.equal(geometry.index.count / 3, 2);
    assert.deepEqual(Array.from(geometry.getAttribute('bladeSide').array), [-1, 1, -1, 1]);
  } finally {
    geometry.dispose();
  }
});

test('geometry factory forwards shareVertices into the blade template', () => {
  const factory = new GrassGeometryFactory({
    grass: { tileSize: 4, blade: { bladeHeight: 1.5 } },
    cinematic: { enabled: true },
  });
  const shared = factory.create({ type: 'blade', shape: 'slender', detail: 5, density: 1 });
  const duplicated = factory.create({
    type: 'blade', shape: 'slender', detail: 5, density: 1, shareVertices: false,
  });
  try {
    assert.equal(shared.getAttribute('position').count, 11);
    assert.equal(duplicated.getAttribute('position').count, 19);
    assert.equal(shared.userData.lod.shareVertices, true);
    assert.equal(duplicated.userData.lod.shareVertices, false);
  } finally {
    shared.dispose();
    duplicated.dispose();
  }
});
