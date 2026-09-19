import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Mesh } from 'three';
import { hideCollisionHelpers } from '../src/world/loadTerrain.js';

test('collision helpers stay hidden independently of physics registration in split and combined terrain', () => {
  for (const split of [false, true]) {
    const root = new Group(), helpers = new Group();
    helpers.name = split ? 'TerrainPart:colliders' : 'AuthoredLevel';
    const water = new Mesh(), house = new Mesh(), terrain = new Mesh();
    water.name = 'WaterCollider'; house.name = 'HouseCollider'; terrain.name = 'Ground';
    helpers.add(water, house); root.add(helpers, terrain);
    hideCollisionHelpers(root, { collisions: { trimeshObjects: ['HouseCollider'] } });
    assert.equal(water.visible, false); assert.equal(house.visible, false);
    assert.equal(terrain.visible, true);
    assert.equal(root.getObjectByName('WaterCollider'), water, 'bounds consumers can still resolve the helper');
  }
});
