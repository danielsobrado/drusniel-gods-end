import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMergedConfig } from '../scripts/mergedConfig.mjs';
import {
  lakeBoundsContain,
  lakeSignedDistance,
  resolveLakeShape,
  shapeLakeHeight,
} from '../src/world/LakeShape.js';
import { createShorelineGeometry, createWaterGeometry, LAKE_MASK_FAR } from '../src/water/waterGeometry.js';
import { LANDSCAPE_ROUTES } from '../src/world/LandscapePaths.js';
import { coastX } from '../src/world/CoastField.js';

const config = await loadMergedConfig();
const lake = resolveLakeShape(config);

const straight = resolveLakeShape({
  water: {
    position: [0, -10, 0],
    lake: { points: [[0, 0, 20], [200, 0, 20]], depth: 5, shelf: 10, bankWidth: 80, bankSlope: 0.4, waterMargin: 6 },
  },
});

test('the configured lake is a long bent lake, not the old round basin', () => {
  assert.ok(lake, 'water.lake is configured');
  const { minX, maxX, minZ, maxZ } = lake.bounds;
  // The old basin was about 300 x 340 m; the new outline runs well past both.
  let length = 0;
  for (let i = 1; i < lake.centreline.length; i += 1) {
    const [ax, az] = lake.centreline[i - 1], [bx, bz] = lake.centreline[i];
    length += Math.hypot(bx - ax, bz - az);
  }
  assert.ok(length > 550, `centreline is ${length.toFixed(0)} m`);
  assert.ok(maxX - minX < 1000 && maxZ - minZ < 1000);
});

test('lake bounds support a padded cheap rejection around shoreline work', () => {
  const z = (straight.bounds.minZ + straight.bounds.maxZ) * 0.5;
  assert.equal(lakeBoundsContain(straight.bounds.minX - 11, z, straight, 12), true);
  assert.equal(lakeBoundsContain(straight.bounds.minX - 13, z, straight, 12), false);
});

test('signed distance is negative in the water and positive on land', () => {
  assert.ok(lakeSignedDistance(100, 0, straight) < -15);
  assert.ok(lakeSignedDistance(100, 30, straight) > 5);
  assert.ok(Math.abs(lakeSignedDistance(100, 20, straight)) < 0.01);
});

test('terrain is carved below the water inside and rises above it within a few metres', () => {
  const ground = 5;
  for (let z = 0; z < 20; z += 2) {
    assert.ok(shapeLakeHeight(100, z, ground, straight) < straight.level, `z=${z} is under water`);
  }
  for (let z = 24; z < 100; z += 2) {
    assert.ok(shapeLakeHeight(100, z, ground, straight) > straight.level, `z=${z} is dry`);
  }
});

test('banks climb no steeper than the bank slope, so the jungle can grow on them', () => {
  // Ground 25 m above the water: the bank has to climb all of it.
  let worst = 0;
  for (let z = 20; z < 110; z += 0.5) {
    const rise = shapeLakeHeight(100, z + 0.5, 15, straight) - shapeLakeHeight(100, z, 15, straight);
    worst = Math.max(worst, rise / 0.5);
  }
  assert.ok(worst <= straight.bankSlope + 0.01, `steepest bank ${worst.toFixed(2)}`);
  assert.ok(worst < Number(config.biomes.coastalJungle.placement?.maxSlope ?? 0.75));
});

test('the old basin left outside the new outline is filled above the water', () => {
  const filled = resolveLakeShape({
    water: {
      position: [0, -10, 0],
      lake: { points: [[0, 0, 20], [200, 0, 20]], bankWidth: 80, fill: { bounds: [-100, 40, 300, 300], rise: 6, fade: 10 } },
    },
  });
  assert.ok(shapeLakeHeight(100, 150, -30, filled) > filled.level);
  // Ground already above the fill is never lowered.
  assert.equal(shapeLakeHeight(100, 150, 12, filled), 12);
});

test('the water surface follows the shoreline instead of a square', () => {
  const geometry = createShorelineGeometry(straight, null, 4);
  const position = geometry.attributes.position;
  assert.ok(geometry.index.count > 0);
  const reach = straight.margin + 4 * Math.SQRT2;
  for (let i = 0; i < position.count; i += 1) {
    assert.equal(position.getY(i), straight.level);
    assert.ok(lakeSignedDistance(position.getX(i), position.getZ(i), straight) <= reach);
  }
  // It still covers the water it is meant to.
  const xs = Array.from({ length: position.count }, (_, i) => position.getX(i));
  assert.ok(Math.min(...xs) <= -20 && Math.max(...xs) >= 220);
});

test('the lake surface stops where the river channel leaves the shore', () => {
  const river = { sample: (x, z) => ({ edge: x > 210 && Math.abs(z) < 8 ? -1 : 50 }) };
  const geometry = createShorelineGeometry(straight, river, 4);
  const position = geometry.attributes.position;
  for (let i = 0; i < geometry.index.count; i += 3) {
    const ids = [0, 1, 2].map(k => geometry.index.getX(i + k));
    const cx = ids.reduce((sum, id) => sum + position.getX(id), 0) / 3;
    const cz = ids.reduce((sum, id) => sum + position.getZ(id), 0) / 3;
    assert.ok(!(cx > 226 && Math.abs(cz) < 6), `cell at ${cx.toFixed(0)},${cz.toFixed(0)} covers the channel`);
  }
});

test('lake and ribbon carry the signed lake distance the water shader hands over on', () => {
  const params = { ...config.water, lake: undefined };
  // The channel runs along +x from inside the lake out through its shore.
  const channel = (x, z) => ({ edge: Math.abs(z) < 8 && x > 100 ? 0 : 50 });
  const river = {
    lakeLevel: straight.level,
    sample: channel,
    samples: [0, 1, 2].map(i => ({ x: 150 + i * 60, z: 0, y: straight.level, width: 10, s: i * 60, dx: 1, dz: 0 })),
  };
  const geometry = createWaterGeometry({ ...params, position: [0, straight.level, 0] }, river, straight);
  const kind = geometry.attributes.waterKind, mask = geometry.attributes.lakeMask;
  const position = geometry.attributes.position;
  const clamp = (d) => Math.max(-LAKE_MASK_FAR, Math.min(LAKE_MASK_FAR, d));
  let lakeVertices = 0, lakeOverChannel = 0, ribbonInside = 0, ribbonOutside = 0;
  for (let i = 0; i < kind.count; i += 1) {
    // Positions are relative to the water origin, which sits at x = z = 0 here.
    const x = position.getX(i), z = position.getZ(i);
    const distance = clamp(lakeSignedDistance(x, z, straight));
    if (kind.getX(i) === 0) {
      lakeVertices += 1;
      // The lake only gives way (positive distance) over the river channel.
      if (channel(x, z).edge < 2) { lakeOverChannel += 1; assert.ok(Math.abs(mask.getX(i) - distance) < 1e-3); }
      else assert.equal(mask.getX(i), -LAKE_MASK_FAR);
      continue;
    }
    assert.ok(Math.abs(mask.getX(i) - distance) < 1e-3, 'the ribbon carries the exact signed distance');
    if (distance < 0) ribbonInside += 1;
    else ribbonOutside += 1;
  }
  assert.ok(lakeVertices > 0 && lakeOverChannel > 0 && ribbonInside > 0 && ribbonOutside > 0);
});

test('the river crosses the lake and leaves it just before its outlet falls', () => {
  const { points, outletStartIndex } = config.water.river;
  const crossing = points.slice(13, outletStartIndex);
  assert.ok(crossing.length >= 3);
  for (const [x, z] of crossing) assert.ok(lakeSignedDistance(x, z, lake) < 0, `river point ${x},${z} in the lake`);
  const [ox, oz] = points[outletStartIndex];
  const outlet = lakeSignedDistance(ox, oz, lake);
  assert.ok(outlet > 0 && outlet < 25, `outlet starts ${outlet.toFixed(1)} m past the shore`);
});

test('the lakeside circuit stays on dry ground around the new outline', () => {
  const circuit = LANDSCAPE_ROUTES.find(route => route.name === 'Lakeside circuit');
  for (let i = 1; i < circuit.points.length; i += 1) {
    const [ax, az] = circuit.points[i - 1], [bx, bz] = circuit.points[i];
    for (let t = 0; t <= 1; t += 0.02) {
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      // Where the path crosses the river it is the river's crossing, not the lake's.
      if (Math.abs(z - 120) < 45 && x > 500) continue;
      assert.ok(lakeSignedDistance(x, z, lake) > circuit.width, `path at ${x.toFixed(0)},${z.toFixed(0)}`);
    }
  }
});

test('the jungle strip runs down to the lake shore', () => {
  const { region } = config.biomes.coastalJungle;
  const sea = config.water.sea;
  for (const z of [280, 320, 360]) {
    const westEdge = coastX(z, sea) - region.inlandEnd;
    let shore = null;
    for (let x = 700; x > 400; x -= 1) {
      if (lakeSignedDistance(x, z, lake) <= 0) {
        shore = x;
        break;
      }
    }
    assert.ok(shore !== null, `the south arm is beside the jungle at z=${z}`);
    assert.ok(westEdge <= shore + 12, `jungle edge ${westEdge.toFixed(0)} reaches shore ${shore} at z=${z}`);
  }
});
