import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  calibrateLocomotionClip,
  resolveClipSpeedInHeights,
} from '../src/player/LocomotionCalibration.js';

test('locomotion calibration removes net horizontal root drift without mutating the source', () => {
  const source = new THREE.AnimationClip('Walking', 1, [
    new THREE.VectorKeyframeTrack(
      'Hips.position',
      [0, 0.5, 1],
      [
        0, 1.0, 0,
        0.7, 1.2, 0.8,
        1.0, 1.1, 2.0,
      ],
    ),
  ]);

  const calibrated = calibrateLocomotionClip(source, {
    rootMotion: {
      inPlace: true,
      nodes: ['Hips'],
      axes: ['x', 'z'],
    },
  });

  assert.notEqual(calibrated, source);
  const sourceEnd = Array.from(source.tracks[0].values.slice(-3));
  assert.ok(Math.abs(sourceEnd[0] - 1) < 1e-6);
  assert.ok(Math.abs(sourceEnd[1] - 1.1) < 1e-6);
  assert.ok(Math.abs(sourceEnd[2] - 2) < 1e-6);

  const values = Array.from(calibrated.tracks[0].values);
  assert.ok(Math.abs(values[6] - values[0]) < 1e-6);
  assert.ok(Math.abs(values[8] - values[2]) < 1e-6);
  assert.ok(Math.abs(values[4] - 1.2) < 1e-6);
  assert.ok(Math.abs(values[3] - 0.2) < 1e-6);
  assert.ok(Math.abs(values[5] + 0.2) < 1e-6);
});

test('locomotion calibration only changes configured root nodes and axes', () => {
  const source = new THREE.AnimationClip('Walking', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 2, 0, 1, 3, 2]),
    new THREE.VectorKeyframeTrack('LeftFoot.position', [0, 1], [0, 0, 0, 4, 5, 6]),
  ]);

  const calibrated = calibrateLocomotionClip(source, {
    rootMotion: {
      inPlace: true,
      nodes: ['Hips'],
      axes: ['x'],
    },
  });

  assert.deepEqual(Array.from(calibrated.tracks[0].values), [0, 2, 0, 0, 3, 2]);
  assert.deepEqual(Array.from(calibrated.tracks[1].values), [0, 0, 0, 4, 5, 6]);
});

test('clip speed calibration is explicit per locomotion state', () => {
  const calibration = { clipSpeedInHeights: { walk: 0.92, run: 2.6 } };
  assert.equal(resolveClipSpeedInHeights(calibration, 'walk'), 0.92);
  assert.equal(resolveClipSpeedInHeights(calibration, 'run'), 2.6);
  assert.equal(resolveClipSpeedInHeights(calibration, 'idle'), null);
  assert.equal(resolveClipSpeedInHeights({ clipSpeedInHeights: { walk: 0 } }, 'walk'), null);
});

test('locomotion calibration returns the source clip when no configured root track exists', () => {
  const source = new THREE.AnimationClip('Walking', 1, [
    new THREE.VectorKeyframeTrack('Spine.position', [0, 1], [0, 1, 0, 0, 1.1, 0]),
  ]);
  const calibrated = calibrateLocomotionClip(source, {
    rootMotion: { inPlace: true, nodes: ['Hips'], axes: ['x', 'z'] },
  });
  assert.equal(calibrated, source);
});

test('locomotion calibration supports glTF CUBICSPLINE root translation', () => {
  const track = new THREE.VectorKeyframeTrack(
    'Hips.position',
    [0, 1],
    [
      0.5, 0, 1.0,
      0, 2, 0,
      0.5, 0, 1.0,
      0.5, 0, 1.0,
      1, 2, 2,
      0.5, 0, 1.0,
    ],
  );
  track.createInterpolant = () => null;
  track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true;
  const source = new THREE.AnimationClip('Walking', 1, [track]);

  const calibrated = calibrateLocomotionClip(source, {
    rootMotion: { inPlace: true, nodes: ['Hips'], axes: ['x', 'z'] },
  });
  const values = calibrated.tracks[0].values;

  assert.ok(Math.abs(values[3] - values[12]) < 1e-6);
  assert.ok(Math.abs(values[5] - values[14]) < 1e-6);
  assert.ok(Math.abs(values[0] + 0.5) < 1e-6);
  assert.ok(Math.abs(values[2] + 1.0) < 1e-6);
  assert.ok(Math.abs(values[6] + 0.5) < 1e-6);
  assert.ok(Math.abs(values[8] + 1.0) < 1e-6);
});
