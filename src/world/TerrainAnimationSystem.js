import * as THREE from 'three';

export class TerrainAnimationSystem {
  constructor(root, clips = []) {
    this.root = root;
    this.clips = clips;
    this.mixer = root && clips.length > 0 ? new THREE.AnimationMixer(root) : null;
    this.actions = [];
  }

  init() {
    if (!this.mixer) return this;
    for (const clip of this.clips) {
      const action = this.mixer.clipAction(clip);
      action.reset();
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      this.actions.push(action);
    }
    return this;
  }

  update(deltaSeconds) {
    this.mixer?.update(deltaSeconds);
  }

  dispose() {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.length = 0;
    this.mixer = null;
  }
}
