import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { findRiverFalls, measureRiverSurface } from '../src/water/RiverCourse.js';
import { createMistParticles, WaterfallMist } from '../src/water/WaterfallMist.js';

// A river running north with a 60 m fall and, far downstream, a 10 m one.
function createRiver() {
  const level = i => i < 40 ? 100 : i < 100 ? 100 - (i - 40) : i < 400 ? 40 : i < 410 ? 40 - (i - 400) : 30;
  const samples = Array.from({ length: 500 }, (_, i) => ({
    x: 0, z: i * 1.5, y: level(i), s: i * 1.5, width: 10, dx: 0, dz: 1, outletProgress: 0, bankBlend: 7,
  }));
  measureRiverSurface(samples);
  return { samples, falls: findRiverFalls(samples) };
}

test('mist rises at every plunge, scaled to its fall, and any leading share samples them all', () => {
  const { samples, falls } = createRiver();
  assert.equal(falls.length, 2);
  const a = createMistParticles(samples, falls), b = createMistParticles(samples, falls);
  assert.deepEqual(a.spawn, b.spawn);
  assert.equal(a.sites.length, 2);

  const nearest = z => Math.abs(z - samples[falls[0].foot].z) < Math.abs(z - samples[falls[1].foot].z) ? 0 : 1;
  const perFall = [[], []];
  for (let i = 0; i < a.count; i += 1) {
    const [x, y, z, water] = a.spawn.subarray(i * 4, i * 4 + 4);
    const fall = nearest(z);
    perFall[fall].push(i);
    // Within the channel, above the water where it rose, and inside the fall's site.
    assert.ok(Math.abs(x) <= 5, `across ${x}`);
    assert.ok(y > water, 'born above the water');
    assert.ok(a.sites[fall].containsPoint(new THREE.Vector3(x, y, z)), 'inside its site');
    const [start, end, lifetime, opacity] = a.shape.subarray(i * 4, i * 4 + 4);
    assert.ok(end > start && lifetime > 2 && opacity > 0 && opacity < 0.5);
  }
  // The big fall throws more puffs, each thinner.
  assert.ok(perFall[0].length > perFall[1].length * 1.5);
  const meanOpacity = ids => ids.reduce((sum, i) => sum + a.shape[i * 4 + 3], 0) / ids.length;
  assert.ok(meanOpacity(perFall[0]) < meanOpacity(perFall[1]));
  // The lowest quality draws the leading 35%: every fall keeps its share.
  const lead = Math.round(a.count * 0.35);
  for (const ids of perFall) {
    const share = ids.filter(i => i < lead).length / ids.length;
    assert.ok(Math.abs(share - 0.35) < 0.15, `share ${share}`);
  }
  assert.equal(createMistParticles(samples, []).count, 0);
});

test('mist draws after the water, only near a visible fall, and dims with the light', () => {
  const { samples, falls } = createRiver();
  const scene = new THREE.Scene();
  const terrain = {
    texture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
    boundsMin: new THREE.Vector3(-100, 0, -100), boundsSize: new THREE.Vector3(200, 200, 1000), minHeight: 0, maxHeight: 200,
  };
  const mist = new WaterfallMist(scene, { samples, falls }, terrain, { quality: 'performance' });
  try {
    assert.equal(mist.root.parent, scene);
    assert.ok(mist.root.renderOrder > 1, 'a later transparent group than the water tiles');
    assert.equal(mist.mesh.count, Math.round(mist.total * 0.35));
    mist.setQuality('ultra');
    assert.equal(mist.mesh.count, mist.total);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    const foot = samples[falls[0].foot];
    const day = {
      position: new THREE.Vector3(10, 30, 5), color: new THREE.Color('#fff5e7'), directionalIntensity: 2.7,
      hemisphereSkyColor: new THREE.Color('#a8d0ed'), hemisphereGroundColor: new THREE.Color('#807258'),
      hemisphereIntensity: 0.65, ambientColor: new THREE.Color('#d6e5ed'), ambientIntensity: 0.24,
    };
    camera.position.set(foot.x + 40, foot.y + 5, foot.z);
    camera.lookAt(foot.x, foot.y, foot.z);
    mist.update(camera, day);
    assert.equal(mist.mesh.visible, true);
    const daySun = mist.light.sun.value.r, daySky = mist.light.sky.value.b;
    assert.ok(Math.abs(mist.light.direction.value.length() - 1) < 1e-6);

    const night = { ...day, color: new THREE.Color('#8eafff'), directionalIntensity: 1.6,
      hemisphereSkyColor: new THREE.Color('#405f8e'), hemisphereGroundColor: new THREE.Color('#151c1b'),
      hemisphereIntensity: 0.2, ambientColor: new THREE.Color('#7895c4'), ambientIntensity: 0.55 };
    mist.update(camera, night);
    assert.ok(mist.light.sun.value.r < daySun * 0.4 && mist.light.sky.value.b < daySky, 'night is darker');

    camera.position.set(foot.x + 120, foot.y + 5, foot.z);
    camera.lookAt(foot.x + 300, foot.y, foot.z);
    mist.update(camera, day);
    assert.equal(mist.mesh.visible, false, 'looking away');
    camera.position.set(foot.x + 2000, foot.y, foot.z);
    camera.lookAt(foot.x, foot.y, foot.z);
    mist.update(camera, day);
    assert.equal(mist.mesh.visible, false, 'too far to see');
  } finally {
    mist.dispose();
    terrain.texture.dispose();
  }
  assert.equal(mist.root.parent, null);
});
