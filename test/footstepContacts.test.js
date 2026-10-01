import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { measureFootstepContacts } from '../src/player/FootstepContacts.js';

test('contact phases follow animated foot landings and restore the original pose', () => {
  const model = new THREE.Group(), tracks = [];
  for (const [name, heights] of [['LeftFoot', [0, 1, 0, 0, 0]], ['RightFoot', [0, 0, 0, 1, 0]]]) {
    const foot = new THREE.Bone(); foot.name = name; model.add(foot);
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, [0, 0.25, 0.5, 0.75, 1], heights.flatMap(y => [0, y, 0])));
  }
  const contacts = measureFootstepContacts(model, new THREE.AnimationClip('walk', 1, tracks));
  assert.equal(contacts.length, 2);
  assert.ok(Math.abs(contacts[0] - 0.4625) < 0.01);
  assert.ok(Math.abs(contacts[1] - 0.9625) < 0.01);
  assert.equal(model.getObjectByName('LeftFoot').position.y, 0);
});
