import * as THREE from 'three';

// A rig-local fallback for assets delivered with only a run. Authored idle/walk
// clips take precedence in PlayerController when present.
export function createLocomotionClips(model) {
  const bones = new Map();
  model.traverse(object => { if (object.isBone) bones.set(object.name, object); });
  if (!bones.has('LeftUpLeg') || !bones.has('RightUpLeg')) return [];
  const clips = [];
  for (const kind of ['idle', 'walk']) {
    const duration = kind === 'idle' ? 4 : 1.1;
    const tracks = [];
    for (const [name, bone] of bones) {
      if (!/UpLeg|^LeftLeg$|^RightLeg$|^LeftArm$|^RightArm$|ForeArm|^Spine/.test(name)) continue;
      const times = [];
      const values = [];
      const base = bone.quaternion.clone();
      for (let frame = 0; frame <= 32; frame++) {
        const phase = frame / 32 * Math.PI * 2;
        const side = name.startsWith('Left') ? 1 : -1;
        const swing = Math.sin(phase) * side;
        const euler = new THREE.Euler();
        if (name.includes('UpLeg')) euler.x = kind === 'walk' ? swing * 0.36 : 0;
        else if (/^LeftLeg$|^RightLeg$/.test(name)) euler.x = kind === 'walk' ? Math.max(0, -swing) * 0.65 : 0.04;
        else if (/^LeftArm$|^RightArm$/.test(name)) {
          euler.z = side * 0.03;
          euler.x = kind === 'walk' ? -swing * 0.25 : Math.sin(phase) * 0.018;
        } else if (name.includes('ForeArm')) euler.x = -0.02;
        else if (name.startsWith('Spine')) euler.x = Math.sin(phase) * 0.009;
        const rotation = base.clone().multiply(new THREE.Quaternion().setFromEuler(euler));
        times.push(frame / 32 * duration);
        rotation.toArray(values, values.length);
      }
      // Key by bone name like the authored clips: the mixer keeps one
      // accumulator per binding path, so a uuid path and a name path on the
      // same bone write it independently and fades between authored and
      // generated clips leave the legs frozen at whichever wrote last.
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    }
    clips.push(new THREE.AnimationClip(`Cinematic_${kind}`, duration, tracks));
  }
  return clips;
}

export class FootPlacement {
  constructor(model, terrain, height) {
    this.model = model;
    this.terrain = terrain;
    this.height = height;
    this.chains = ['Left', 'Right'].map(side => ({
      foot: model.getObjectByName(`${side}Foot`),
      knee: model.getObjectByName(`${side}Leg`),
      hip: model.getObjectByName(`${side}UpLeg`),
    })).filter(chain => chain.foot?.isBone && chain.knee?.isBone && chain.hip?.isBone);
    this.foot = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.parentRotation = new THREE.Quaternion();
    this.inverseParent = new THREE.Quaternion();
  }

  update(grounded, solesY) {
    if (!grounded) return;
    // getWorldPosition / getWorldQuaternion refresh the ancestor chain of the
    // bones they read, so a full-rig world-matrix pass here was redundant.
    for (const chain of this.chains) {
      chain.foot.getWorldPosition(this.foot);
      // Leave the raised foot of a stride untouched.
      if (this.foot.y - solesY > this.height * 0.12) continue;
      const ground = this.terrain.sampleHeight(this.foot.x, this.foot.z);
      if (!Number.isFinite(ground)) continue;
      const correction = THREE.MathUtils.clamp(ground + this.height * 0.015 - this.foot.y, -this.height * 0.07, this.height * 0.07);
      this.target.copy(this.foot);
      this.target.y += correction;
      for (let iteration = 0; iteration < 2; iteration++) {
        for (const bone of [chain.knee, chain.hip]) {
          bone.getWorldPosition(this.pivot);
          chain.foot.getWorldPosition(this.foot);
          this.from.copy(this.foot).sub(this.pivot).normalize();
          this.to.copy(this.target).sub(this.pivot).normalize();
          this.rotation.setFromUnitVectors(this.from, this.to);
          bone.parent.getWorldQuaternion(this.parentRotation);
          this.inverseParent.copy(this.parentRotation).invert();
          this.rotation.premultiply(this.inverseParent).multiply(this.parentRotation);
          bone.quaternion.premultiply(this.rotation);
          bone.updateWorldMatrix(false, true);
        }
      }
    }
  }
}
