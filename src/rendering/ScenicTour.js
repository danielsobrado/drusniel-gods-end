import * as THREE from 'three';

/* The route used to be a Catmull-Rom through a handful of ground-level waypoints with
 * a single per-frame clamp to `terrainClearance` above the heightfield. That keeps the
 * camera out of the landscape mesh and nothing else: one of the waypoints is literally
 * the position of the nearest tree, so the flight went through a trunk and its canopy,
 * and rocks, fences and buildings were not consulted at all.
 *
 * The route is now flown over an obstacle ceiling. At start we measure the bounding box
 * of every tree and every structure/prop mesh near the corridor, resample the curve, and
 * lift each station above whatever it passes over. A slope limit and a smoothing pass
 * turn that jagged ceiling into something a camera can actually fly, and the per-frame
 * clamp stays as a backstop for anything the resampling missed. */
const CLEARANCE_STATIONS = 96;
const CLEARANCE_PASSES = 2;
/* Metres of climb or dive allowed per metre of route flown. Measured against arc length
 * rather than ground distance on purpose: the route's first leg rises from the live
 * camera to its cruising height with almost no horizontal travel, and a gradient
 * expressed per horizontal metre puts no limit at all on that stretch -- which is
 * exactly where the whole climb used to collect into one vertical lurch. */
const MAX_PATH_SLOPE = 0.35;
/* Ceiling on the take-off ramp below. A route that has to clear a tall canopy soon
 * after leaving the camera needs more than MAX_PATH_SLOPE or it steps rather than
 * climbs; past this it would be a launch, so the floor is simply obeyed instead. */
const MAX_TAKEOFF_SLOPE = 1.6;
const SMOOTHING_PASSES = 3;
/* Only structures and props are solid. `landscape` is the sampler's job, `zones` are
 * trigger volumes, `colliders` are invisible proxies that duplicate the structures, and
 * `trees/*` are the hidden prototypes TreeSystem clones from. */
const SOLID_PART_PREFIXES = ['structures/', 'props/'];
const OBSTACLE_PREFILTER_MARGIN = 40;
const DEFAULT_CANOPY_CLEARANCE = 9;
const DEFAULT_OBSTACLE_STANDOFF = 14;

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
  if (value === undefined) return [];
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
    // Optional so an existing tour config keeps loading unchanged; public/player-controls.yaml
    // sets both explicitly.
    canopyClearance: Math.max(0, finiteNumber(
      config.canopyClearance ?? DEFAULT_CANOPY_CLEARANCE,
      'navigation.scenicTour.canopyClearance',
    )),
    obstacleStandoff: Math.max(0, finiteNumber(
      config.obstacleStandoff ?? DEFAULT_OBSTACLE_STANDOFF,
      'navigation.scenicTour.obstacleStandoff',
    )),
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
    this.obstacles = [];
  }

  configure(config) {
    if (this.active) throw new Error('Cannot reconfigure ScenicTour while it is active.');
    this.config = resolveTourConfig(config);
    return this;
  }

  start() {
    if (!this.config) throw new Error('ScenicTour must be configured before it starts.');
    if (this.active) { this.stop(); return false; }
    if (this.world.expansion?.river && this.config.riverViews.length < 2) {
      throw new Error('navigation.scenicTour.riverViews must contain at least two views when the river is enabled.');
    }
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

    this.obstacles = this.#collectObstacles(points);
    this.curve = this.#buildClearedCurve(points);
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
    // Backstop. The curve is already lifted, but Catmull-Rom overshoots between
    // stations and the resampling only guarantees the stations themselves.
    this.position.y = Math.max(this.position.y, this.#requiredHeight(this.position.x, this.position.z));
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

  /**
   * Bounding discs for everything solid the flight might pass over: every tree, and
   * every mesh under a structures/ or props/ terrain part. Measured once per tour so
   * the per-frame clamp is a handful of squared distances.
   *
   * Trees are taken whatever their current LOD -- a tree swapped to its billboard is
   * still in the way -- so this reads the record, not the visible object.
   */
  #collectObstacles(points) {
    const obstacles = [];
    const corridor = new THREE.Box3().setFromPoints(points)
      .expandByScalar(this.config.obstacleStandoff + OBSTACLE_PREFILTER_MARGIN);
    const near = (x, z) => x >= corridor.min.x && x <= corridor.max.x
      && z >= corridor.min.z && z <= corridor.max.z;
    const box = new THREE.Box3();

    const add = (object) => {
      box.setFromObject(object);
      if (box.isEmpty()) return;
      const x = (box.min.x + box.max.x) * 0.5;
      const z = (box.min.z + box.max.z) * 0.5;
      if (!near(x, z)) return;
      obstacles.push({
        x,
        z,
        radius: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5,
        top: box.max.y,
      });
    };

    for (const tree of this.trees?.trees ?? []) {
      // Cheap reject on the trunk position before paying for a bounding box.
      if (!tree.high || !near(tree.position.x, tree.position.z)) continue;
      add(tree.high);
    }

    for (const [name, part] of this.world.terrainParts ?? []) {
      if (!SOLID_PART_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      part.traverse((child) => { if (child.isMesh && child.visible) add(child); });
    }

    return obstacles;
  }

  /** Lowest height the camera may fly at this column: terrain, or an obstacle's crown. */
  #requiredHeight(x, z) {
    let height = this.world.terrainSampler.sampleHeight(x, z) + this.config.terrainClearance;
    for (const obstacle of this.obstacles) {
      const dx = x - obstacle.x;
      const dz = z - obstacle.z;
      const reach = obstacle.radius + this.config.obstacleStandoff;
      if (dx * dx + dz * dz > reach * reach) continue;
      const crown = obstacle.top + this.config.canopyClearance;
      if (crown > height) height = crown;
    }
    return height;
  }

  /**
   * Resamples the route at even arc length and raises every station to its required
   * height, then makes the result flyable: a slope limit so the climb onto a tall
   * canopy starts early instead of as a jerk at its base, and a smoothing pass that
   * is re-clamped so smoothing can never push the path back into anything.
   *
   * Station 0 is pinned to the live camera position throughout -- lifting it would
   * teleport the view on the first frame of the tour.
   */
  #buildClearedCurve(points) {
    let curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    if (this.obstacles.length === 0 && points.length < CLEARANCE_STATIONS) {
      // Nothing to climb over; the terrain clamp in update() is enough on its own.
      return curve;
    }

    const start = points[0].clone();
    let stations = points;

    for (let pass = 0; pass < CLEARANCE_PASSES; pass += 1) {
      curve.updateArcLengths();
      const sample = new THREE.Vector3();
      stations = [];
      for (let index = 0; index < CLEARANCE_STATIONS; index += 1) {
        curve.getPointAt(index / (CLEARANCE_STATIONS - 1), sample);
        stations.push(sample.clone());
      }
      stations[0].copy(start);

      const floor = stations.map((station, index) => (
        index === 0 ? start.y : this.#requiredHeight(station.x, station.z)
      ));
      const heights = stations.map((station, index) => Math.max(station.y, floor[index]));
      // getPointAt spaces the stations evenly along the curve, so one spacing value
      // describes every gap.
      this.#shapeProfile(heights, floor, curve.getLength() / (CLEARANCE_STATIONS - 1));
      stations.forEach((station, index) => { station.y = heights[index]; });

      curve = new THREE.CatmullRomCurve3(stations, false, 'centripetal');
    }

    return curve;
  }

  /**
   * Turns a per-station ceiling into a flight profile, in place. `spacing` is the arc
   * length between stations, so the slope limit is spent evenly along the route.
   *
   * The smoothing is re-clamped to `floor` after every pass so a rounded corner never
   * dips back below the thing it was rounding over.
   */
  #shapeProfile(heights, floor, spacing) {
    const last = heights.length - 1;
    /* The first station is pinned to the live camera, so the slope budget has to be
     * big enough to walk the highest crown on the route back down to it. Spend the
     * default and no more when that is already enough; without this the backward pass
     * runs out of budget partway and leaves a step at the very first frame. */
    let slope = MAX_PATH_SLOPE;
    for (let index = 1; index <= last; index += 1) {
      slope = Math.max(slope, (floor[index] - heights[0]) / (index * spacing));
    }
    const rise = Math.min(slope, MAX_TAKEOFF_SLOPE) * spacing;

    // Both directions, because a peak has to be eased into as well as out of. Each pass
    // only ever raises a station, so neither can undo the other's guarantee.
    for (let index = 1; index <= last; index += 1) {
      heights[index] = Math.max(heights[index], heights[index - 1] - rise);
    }
    for (let index = last - 1; index >= 1; index -= 1) {
      heights[index] = Math.max(heights[index], heights[index + 1] - rise);
    }

    for (let pass = 0; pass < SMOOTHING_PASSES; pass += 1) {
      const previous = [...heights];
      for (let index = 1; index < last; index += 1) {
        heights[index] = Math.max(
          (previous[index - 1] + 2 * previous[index] + previous[index + 1]) * 0.25,
          floor[index],
        );
      }
    }
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
    this.obstacles = [];
    this.active = false;
    this.returning = false;
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.player.root.visible = true;
    this.player.setEnabled(true);
    this.saved = null;
  }
}
