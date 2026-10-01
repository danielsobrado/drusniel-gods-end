import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeaTileGeometries, seaTileStats } from '../src/water/seaGeometry.js';

const sea = {
  enabled: true,
  level: -24,
  shoreX: 1000,
  depth: 95,
};

test('performance sea geometry is substantially cheaper than high and ultra', () => {
  const performance = createSeaTileGeometries(sea, 'performance');
  const high = createSeaTileGeometries(sea, 'high');
  const ultra = createSeaTileGeometries(sea, 'ultra');
  try {
    const performanceStats = seaTileStats(performance);
    const highStats = seaTileStats(high);
    const ultraStats = seaTileStats(ultra);
    assert.equal(performanceStats.tiles, 48);
    assert.ok(performanceStats.triangles < highStats.triangles * 0.35);
    assert.ok(performanceStats.triangles < ultraStats.triangles * 0.25);
  } finally {
    for (const descriptor of [...performance, ...high, ...ultra]) descriptor.geometry.dispose();
  }
});
