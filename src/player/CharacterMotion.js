import * as THREE from 'three';

const UPPER_BODY = /^Spine|^neck$|^Neck$|^Head$|Shoulder$|Arm$|Hand$/;

// The rig's bind pose holds the arms out in an A. Averaged over a whole walk
// cycle the arm swing cancels, leaving the arms hanging and the spine carried
// as the character actually walks, which is how it should stand. The legs keep
// the bind pose: a walk's mean knee bend would lift the soles off the ground.
function meanUpperBodyPose(model, bones, clip, samples = 24) {
  if (!clip) return new Map();
  const saved = new Map([...bones].map(([name, bone]) => [name, [bone.position.clone(), bone.quaternion.clone(), bone.scale.clone()]]));
  const sums = new Map();
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  for (let i = 0; i < samples; i++) {
    mixer.setTime(i / samples * clip.duration);
    for (const [name, bone] of bones) {
      if (!UPPER_BODY.test(name)) continue;
      const q = bone.quaternion;
      const sum = sums.get(name);
      if (!sum) {
        sums.set(name, new THREE.Vector4(q.x, q.y, q.z, q.w));
        continue;
      }
      // Keep every sample in the first sample's hemisphere before summing.
      const sign = sum.x * q.x + sum.y * q.y + sum.z * q.z + sum.w * q.w < 0 ? -1 : 1;
      sum.x += q.x * sign; sum.y += q.y * sign; sum.z += q.z * sign; sum.w += q.w * sign;
    }
  }
  action.stop();
  mixer.uncacheRoot(model);
  for (const [name, [position, quaternion, scale]] of saved) {
    const bone = bones.get(name);
    bone.position.copy(position);
    bone.quaternion.copy(quaternion);
    bone.scale.copy(scale);
  }
  return new Map([...sums].map(([name, sum]) => [name, new THREE.Quaternion(sum.x, sum.y, sum.z, sum.w).normalize()]));
}

// A rig-local fallback for assets delivered with only a run. Authored idle/walk
// clips take precedence in PlayerController when present. `walkClip`, when
// given, supplies the standing upper-body pose.
export function createLocomotionClips(model, walkClip = null) {
  const bones = new Map();
  model.traverse(object => { if (object.isBone) bones.set(object.name, object); });
  if (!bones.has('LeftUpLeg') || !bones.has('RightUpLeg')) return [];
  const stance = meanUpperBodyPose(model, bones, walkClip);
  const clips = [];
  for (const kind of ['idle', 'walk']) {
    const duration = kind === 'idle' ? 4 : 1.1;
    const tracks = [];
    for (const [name, bone] of bones) {
      const standing = kind === 'idle' && stance.get(name);
      if (!standing && !/UpLeg|^LeftLeg$|^RightLeg$|^LeftArm$|^RightArm$|ForeArm|^Spine/.test(name)) continue;
      const times = [];
      const values = [];
      const base = (standing || bone.quaternion).clone();
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
