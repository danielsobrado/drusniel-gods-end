import * as THREE from 'three';

function positiveNumber(value, name) {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`${name} must be a positive finite number.`);
  return number;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function resolveRiverViews(value) {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('navigation.scenicTour.riverViews must contain at least two views.');
  }
  let previousFraction = -1;
  return value.map((view, index) => {
    const fraction = finiteNumber(view?.fraction, `navigation.scenicTour.riverViews[${index}].fraction`);
    const offset = finiteNumber(view?.offset, `navigation.scenicTour.riverViews[${index}].offset`);
    const lift = positiveNumber(view?.lift, `navigation.scenicTour.riverViews[${index}].lift`);
    if (fraction < 0 || fraction > 1 || fraction <= previousFraction) {
      throw new Error('navigation.scenicTour.riverViews fractions must be strictly increasing in [0, 1].');
    }
    previousFraction = fraction;
    return { fraction, offset, lift };
  });
}

function resolveTourConfig(config) {
  if (!config) throw new Error('navigation.scenicTour configuration is required.');
  const durationSeconds = positiveNumber(config.durationSeconds, 'navigation.scenicTour.durationSeconds');
  const returnDurationSeconds = positiveNumber(
    config.returnDurationSeconds,
    'navigation.scenicTour.returnDurationSeconds',
  );
  if (returnDurationSeconds >= durationSeconds) {
    throw new Error('navigation.scenicTour.returnDurationSeconds must be lower than durationSeconds.');
  }
  const seaLookBlendStart = finiteNumber(config.seaLookBlendStart, 'navigation.scenicTour.seaLookBlendStart');
  if (seaLookBlendStart < 0 || seaLookBlendStart >= 1) {
    throw new Error('navigation.scenicTour.seaLookBlendStart must be in [0, 1).');
  }
  if (!Array.isArray(config.seaFocusXZ) || config.seaFocusXZ.length !== 2
    || config.seaFocusXZ.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('navigation.scenicTour.seaFocusXZ must contain two finite numbers.');
  }
  return {
    durationSeconds,
    returnDurationSeconds,
    travelDurationSeconds: durationSeconds - returnDurationSeconds,
    lookAheadDistance: positiveNumber(config.lookAheadDistance, 'navigation.scenicTour.lookAheadDistance'),
    orientationSharpness: positiveNumber(
      config.orientationSharpness,
      'navigation.scenicTour.orientationSharpness',
    ),
    terrainClearance: Math.max(0, finiteNumber(config.terrainClearance, 'navigation.scenicTour.terrainClearance')),
    targetDrop: finiteNumber(config.targetDrop, 'navigation.scenicTour.targetDrop'),
    seaLookBlendStart,
    seaFocusXZ: config.seaFocusXZ.map(Number),
    seaFocusHeightOffset: finiteNumber(
      config.seaFocusHeightOffset,
      'navigation.scenicTour.seaFocusHeightOffset',
    ),
    riverViews: resolveRiverViews(config.riverViews),
  };
}

function smoothstep01(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export class ScenicTour {
  constructor(world, player, trees, water) {
    this.world = world;
    this.player = player;
    this.trees = trees;
    this.water = water;
    this.active = false;
    this.returning = false;
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.curveLength = 1;
    this.config = null;
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.finalTarget = new THREE.Vector3();
    this.returnFromPosition = new THREE.Vector3();
    this.desiredQuaternion = new THREE.Quaternion();
    this.returnFromQuaternion = new THREE.Quaternion();
    this.lookMatrix = new THREE.Matrix4();
  }

  configure(config) {
    if (this.active) throw new Error('Cannot reconfigure ScenicTour while it is active.');
    this.config = resolveTourConfig(config);
    return this;
  }

  start() {
    if (!this.config) throw new Error('ScenicTour must be configured before it starts.');
    if (this.active) { this.stop(); return false; }
    this.saved = {
      position: this.world.camera.position.clone(),
      quaternion: this.world.camera.quaternion.clone(),
    };
    const cameraStart = this.world.camera.position.clone();
    const start = this.player.getPosition().clone();
    const terrain = this.world.terrainSampler;
    let points;

    if (this.world.expansion?.river) {
      const river = this.world.expansion.river;
      const reach = fraction => river.samples[Math.round((river.samples.length - 1) * fraction)];
      const riverView = ({ fraction, offset, lift }) => {
        const p = reach(fraction);
        const x = p.x - p.dz * offset;
        const z = p.z + p.dx * offset;
        return new THREE.Vector3(x, Math.max(p.y, terrain.sampleHeight(x, z)) + lift, z);
      };
      points = [
        cameraStart,
        start.clone().setY(terrain.sampleHeight(start.x, start.z) + 12),
        new THREE.Vector3(-170, terrain.sampleHeight(-170, 35) + 30, 35),
        ...this.config.riverViews.map(riverView),
      ];
    } else {
      const grove = (this.trees.trees ?? []).filter(tree => {
        const distance = tree.position.distanceTo(start);
        return distance > 18 && distance < 85;
      }).sort((a, b) => a.position.distanceToSquared(start) - b.position.distanceToSquared(start))[0]?.position.clone()
        ?? start.clone().add(new THREE.Vector3(30, 0, -25));
      let shore = null;
      let score = Infinity;
      const bounds = this.water.bounds;
      for (let x = bounds.min.x; x <= bounds.max.x; x += 8) {
        for (let z = bounds.min.z; z <= bounds.max.z; z += 8) {
          if (!terrain.contains(x, z, 5)) continue;
          const y = terrain.sampleHeight(x, z);
          const height = y - this.water.mesh.position.y;
          if (height < 0.3 || height > 5) continue;
          const distance = Math.hypot(x - start.x, z - start.z);
          if (distance < score) { shore = new THREE.Vector3(x, y, z); score = distance; }
        }
      }
      shore ??= grove.clone().add(new THREE.Vector3(30, 0, 35));
      const elevatedStart = start.clone().setY(terrain.sampleHeight(start.x, start.z) + 7);
      points = [
        cameraStart,
        elevatedStart,
        elevatedStart.clone().lerp(grove, 0.5),
        grove,
        grove.clone().lerp(shore, 0.5),
        shore,
      ];
      for (let index = 2; index < points.length; index += 1) {
        const point = points[index];
        point.y = terrain.sampleHeight(point.x, point.z) + 7;
      }
    }

    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    this.curve.updateArcLengths();
    this.curveLength = Math.max(this.curve.getLength(), Number.EPSILON);
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.returning = false;
    this.active = true;
    this.player.setEnabled(false);
    this.player.root.visible = false;
    globalThis.document?.exitPointerLock?.();
    return true;
  }

  update(deltaSeconds) {
    if (!this.active || deltaSeconds <= 0) return;
    if (this.returning) {
      this.#updateReturn(deltaSeconds);
      return;
    }

    this.elapsed += deltaSeconds;
    const progress = Math.min(this.elapsed / this.config.travelDurationSeconds, 1);
    this.curve.getPointAt(progress, this.position);
    this.position.y = Math.max(
      this.position.y,
      this.world.terrainSampler.sampleHeight(this.position.x, this.position.z) + this.config.terrainClearance,
    );
    this.world.camera.position.copy(this.position);

    const lookAheadProgress = Math.min(
      progress + this.config.lookAheadDistance / this.curveLength,
      1,
    );
    this.curve.getPointAt(lookAheadProgress, this.target);
    this.target.y -= this.config.targetDrop;
    this.#blendFinalTarget(progress);
    this.#smoothOrientation(deltaSeconds);

    if (progress >= 1) this.#beginReturn();
  }

  stop() {
    if (!this.active) return;
    if (this.saved) {
      this.world.camera.position.copy(this.saved.position);
      this.world.camera.quaternion.copy(this.saved.quaternion);
    }
    this.#finish();
  }

  #blendFinalTarget(progress) {
    if (progress < this.config.seaLookBlendStart) return;
    if (this.water.params?.sea?.enabled) {
      this.finalTarget.set(
        this.config.seaFocusXZ[0],
        this.water.params.sea.level + this.config.seaFocusHeightOffset,
        this.config.seaFocusXZ[1],
      );
    } else {
      this.finalTarget.copy(this.water.mesh.position);
      this.finalTarget.y = this.water.mesh.position.y + this.config.seaFocusHeightOffset;
    }
    const blend = smoothstep01(
      (progress - this.config.seaLookBlendStart) / (1 - this.config.seaLookBlendStart),
    );
    this.target.lerp(this.finalTarget, blend);
  }

  #smoothOrientation(deltaSeconds) {
    this.lookMatrix.lookAt(this.world.camera.position, this.target, this.world.camera.up);
    this.desiredQuaternion.setFromRotationMatrix(this.lookMatrix);
    const alpha = 1 - Math.exp(-this.config.orientationSharpness * deltaSeconds);
    this.world.camera.quaternion.slerp(this.desiredQuaternion, alpha);
  }

  #beginReturn() {
    this.returning = true;
    this.returnElapsed = 0;
    this.returnFromPosition.copy(this.world.camera.position);
    this.returnFromQuaternion.copy(this.world.camera.quaternion);
  }

  #updateReturn(deltaSeconds) {
    this.returnElapsed += deltaSeconds;
    const progress = Math.min(this.returnElapsed / this.config.returnDurationSeconds, 1);
    const eased = smoothstep01(progress);
    this.world.camera.position.lerpVectors(this.returnFromPosition, this.saved.position, eased);
    this.world.camera.quaternion.copy(this.returnFromQuaternion).slerp(this.saved.quaternion, eased);
    if (progress >= 1) this.#finish();
  }

  #finish() {
    this.active = false;
    this.returning = false;
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.player.root.visible = true;
    this.player.setEnabled(true);
    this.saved = null;
  }
}
