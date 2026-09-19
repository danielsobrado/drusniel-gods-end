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

// Fractions of the character's height: the most the pelvis sinks to let the
// downhill foot reach the ground, and the swing lift over which a foot's
// correction fades out.
const MAX_PELVIS_DROP = 0.2;
const SWING_FADE = [0.04, 0.12];
// Radians: the most a planted foot tilts to follow the slope under it.
const MAX_FOOT_TILT = 0.45;
// Per-second rates at which the pelvis drop and each foot's weight settle.
const PELVIS_RATE = 12;
const FOOT_RATE = 16;
const NORMAL_STEP = 0.35;
const UP = new THREE.Vector3(0, 1, 0);

// Height of the ankle above the soles in the bind pose, as a fraction of the
// mesh's bind height: the bind pose, not whatever pose the rig was left in.
function ankleHeightFraction(model, foot) {
  let fraction = 0.065;
  model.traverse(object => {
    if (!object.isSkinnedMesh) return;
    const index = object.skeleton.bones.indexOf(foot);
    if (index < 0) return;
    const position = object.geometry.getAttribute('position');
    const point = new THREE.Vector3();
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < position.count; i += 7) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.bindMatrix);
      low = Math.min(low, point.y);
      high = Math.max(high, point.y);
    }
    const ankle = new THREE.Vector3().setFromMatrixPosition(object.skeleton.boneInverses[index].clone().invert());
    if (high > low) fraction = THREE.MathUtils.clamp((ankle.y - low) / (high - low), 0.01, 0.2);
  });
  return fraction;
}

/**
 * Plants the feet on the terrain under each of them. The capsule rests on a
 * slope at its uphill contact, which leaves the downhill foot hanging, so the
 * pelvis sinks until the lower foot can reach its ground; then each leg is
 * solved as a two-bone chain to put its ankle at its own ground height, the
 * knee bending to take up the difference, and a planted foot tilts to the
 * slope. A foot lifted in a stride keeps its lift above its own ground.
 */
export class FootPlacement {
  constructor(model, terrain, height) {
    this.model = model;
    this.terrain = terrain;
    this.height = height;
    this.baseY = model.position.y;
    this.drop = 0;
    this.chains = ['Left', 'Right'].map(side => ({
      foot: model.getObjectByName(`${side}Foot`),
      knee: model.getObjectByName(`${side}Leg`),
      hip: model.getObjectByName(`${side}UpLeg`),
      weight: 0,
      ankle: new THREE.Vector3(),
      ground: 0,
      lift: 0,
    })).filter(chain => chain.foot?.isBone && chain.knee?.isBone && chain.hip?.isBone);
    this.ankleHeight = this.chains.length ? ankleHeightFraction(model, this.chains[0].foot) * height : 0;
    this.hipPosition = new THREE.Vector3();
    this.kneePosition = new THREE.Vector3();
    this.anklePosition = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.toHip = new THREE.Vector3();
    this.toAnkle = new THREE.Vector3();
    this.axis = new THREE.Vector3();
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.parentRotation = new THREE.Quaternion();
    this.inverseParent = new THREE.Quaternion();
  }

  // Rotates a bone by a world-space rotation, keeping its parent.
  #rotateWorld(bone, rotation) {
    bone.parent.getWorldQuaternion(this.parentRotation);
    this.inverseParent.copy(this.parentRotation).invert();
    this.rotation.copy(rotation).premultiply(this.inverseParent).multiply(this.parentRotation);
    bone.quaternion.premultiply(this.rotation);
    bone.updateWorldMatrix(false, true);
  }

  update(grounded, solesY, deltaSeconds = 1 / 60) {
    const settle = rate => 1 - Math.exp(-rate * Math.min(deltaSeconds, 0.1));
    // Measure the animated feet with the pelvis where the animation put it.
    this.model.position.y = this.baseY;
    this.model.updateMatrixWorld(true);
    let lowest = 0;
    for (const chain of this.chains) {
      chain.foot.getWorldPosition(chain.ankle);
      chain.ground = this.terrain.sampleHeight(chain.ankle.x, chain.ankle.z);
      chain.lift = Math.max(0, chain.ankle.y - solesY - this.ankleHeight);
      const planted = 1 - THREE.MathUtils.smoothstep(chain.lift, SWING_FADE[0] * this.height, SWING_FADE[1] * this.height);
      const target = grounded && Number.isFinite(chain.ground) ? planted : 0;
      chain.weight += (target - chain.weight) * settle(FOOT_RATE);
      if (chain.weight > 0.001) lowest = Math.min(lowest, (chain.ground - solesY) * chain.weight);
    }
    const drop = grounded ? Math.max(lowest, -MAX_PELVIS_DROP * this.height) : 0;
    this.drop += (drop - this.drop) * settle(PELVIS_RATE);
    this.model.position.y = this.baseY + this.drop;
    this.model.updateMatrixWorld(true);

    for (const chain of this.chains) {
      if (chain.weight <= 0.001) continue;
      chain.hip.getWorldPosition(this.hipPosition);
      chain.knee.getWorldPosition(this.kneePosition);
      chain.foot.getWorldPosition(this.anklePosition);
      // The ankle's own ground plus its bind height and any stride lift.
      const goal = chain.ground + this.ankleHeight + chain.lift;
      this.target.copy(this.anklePosition);
      this.target.y += (goal - this.anklePosition.y) * chain.weight;

      // Knee: bend so the hip-to-ankle distance matches the hip-to-target one.
      const upper = this.hipPosition.distanceTo(this.kneePosition);
      const lower = this.kneePosition.distanceTo(this.anklePosition);
      const reach = THREE.MathUtils.clamp(this.hipPosition.distanceTo(this.target), Math.abs(upper - lower) + 1e-3, upper + lower - 1e-3);
      this.toHip.copy(this.hipPosition).sub(this.kneePosition).normalize();
      this.toAnkle.copy(this.anklePosition).sub(this.kneePosition).normalize();
      const current = Math.acos(THREE.MathUtils.clamp(this.toHip.dot(this.toAnkle), -1, 1));
      const wanted = Math.acos(THREE.MathUtils.clamp((upper * upper + lower * lower - reach * reach) / (2 * upper * lower), -1, 1));
      this.axis.crossVectors(this.toHip, this.toAnkle);
      if (this.axis.lengthSq() < 1e-8) {
        // A straight leg has no bend plane; bend it forward, like a knee.
        chain.hip.getWorldQuaternion(this.parentRotation);
        this.axis.set(1, 0, 0).applyQuaternion(this.parentRotation);
      }
      this.axis.normalize();
      this.#rotateWorld(chain.knee, this.rotation.setFromAxisAngle(this.axis, wanted - current));

      // Hip: swing the leg so the ankle lands on the target.
      chain.foot.getWorldPosition(this.anklePosition);
      this.from.copy(this.anklePosition).sub(this.hipPosition).normalize();
      this.to.copy(this.target).sub(this.hipPosition).normalize();
      this.#rotateWorld(chain.hip, this.rotation.setFromUnitVectors(this.from, this.to));

      // Foot: tilt to the slope beneath it.
      const s = NORMAL_STEP * this.height * 0.1;
      const x = this.target.x, z = this.target.z;
      this.normal.set(
        this.terrain.sampleHeight(x - s, z) - this.terrain.sampleHeight(x + s, z),
        s * 2,
        this.terrain.sampleHeight(x, z - s) - this.terrain.sampleHeight(x, z + s),
      ).normalize();
      if (!Number.isFinite(this.normal.x)) continue;
      const tilt = Math.min(MAX_FOOT_TILT, UP.angleTo(this.normal)) * chain.weight;
      this.axis.crossVectors(UP, this.normal);
      if (tilt > 1e-3 && this.axis.lengthSq() > 1e-8) {
        this.#rotateWorld(chain.foot, this.rotation.setFromAxisAngle(this.axis.normalize(), tilt));
      }
    }
  }
}
