import * as THREE from 'three';

/** Measure landing phases once, before playback, without changing the bind pose. */
export function measureFootstepContacts(model, clip) {
  if (!clip || clip.duration <= 0) return null;
  const feet = ['LeftFoot', 'RightFoot'].map(name => model.getObjectByName(name));
  if (feet.some(foot => !foot)) return null;

  const saved = [];
  model.traverse(object => {
    saved.push({
      object,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    });
  });

  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip).play();
  const samples = 120, heights = [[], []], position = new THREE.Vector3();
  try {
    for (let i = 0; i < samples; i++) {
      action.time = clip.duration * i / samples;
      mixer.update(0);
      feet.forEach((foot, index) => heights[index].push(foot.getWorldPosition(position).y));
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    for (const entry of saved) {
      entry.object.position.copy(entry.position);
      entry.object.quaternion.copy(entry.quaternion);
      entry.object.scale.copy(entry.scale);
    }
    model.updateMatrixWorld(true);
  }
  const contacts = [];
  for (const values of heights) {
    const low = Math.min(...values), high = Math.max(...values);
    if (high - low < 0.0001) continue;
    const threshold = low + (high - low) * 0.15;
    for (let i = 0; i < samples; i++) {
      if (values[(i + samples - 1) % samples] > threshold && values[i] <= threshold) contacts.push(i / samples);
    }
  }
  return contacts.length >= 2 ? contacts.sort((a, b) => a - b) : null;
}
