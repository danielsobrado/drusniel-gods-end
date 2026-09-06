import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three/webgpu';
import { createMeadowGeometry } from '../src/foliage/MeadowGeometry.js';

test('understory meshes have finite, nondegenerate surfaces within their instancing budget', () => {
  const budgets = { fern: 950, flower: 550, seed: 500, reed: 300, litter: 110, stone: 80 };
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (const [type, budget] of Object.entries(budgets)) {
    const geometry = createMeadowGeometry(type);
    const positions = geometry.attributes.position;
    assert.ok(geometry.index.count / 3 <= budget, `${type}: triangle budget`);
    for (const attribute of Object.values(geometry.attributes)) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite), `${type}: finite attributes`);
    }
    for (let i = 0; i < geometry.index.count; i += 3) {
      a.fromBufferAttribute(positions, geometry.index.getX(i));
      b.fromBufferAttribute(positions, geometry.index.getX(i + 1));
      c.fromBufferAttribute(positions, geometry.index.getX(i + 2));
      assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 1e-15, `${type}: nondegenerate triangle ${i / 3}`);
    }
    assert.ok(geometry.boundingBox.max.y < 2.2, `${type}: bounded wind displacement`);
    assert.ok(geometry.boundingSphere.radius > 0, `${type}: usable culling bounds`);
    geometry.dispose();
  }
});
