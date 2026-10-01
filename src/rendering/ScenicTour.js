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
const DEFAULT_MAX_LOOK_UP_DEGREES = 8;
const DEFAULT_MAX_LOOK_DOWN_DEGREES = 24;
const MAX_VIEW_ANGLE_DEGREES = 89;
const OBSTACLE_GRID_CELL_SIZE = 32;
const EMPTY_OBSTACLES = Object.freeze([]);
const DEFAULT_PRELOAD_DISTANCE = 320;
const DEFAULT_FINAL_HOLD_SECONDS = 0;
const DEFAULT_LAKE_DIVE_BED_CLEARANCE = 1.5;
/* A showcase point's `pace` (speed factor, 1 = cruise) eases back to cruise
 * over this many world units either side of it, measured along the route. */
const DEFAULT_PACE_RADIUS = 160;
// A `lookAt` holds the view within `lookRadius` of its point along the route
// (so a later leg passing nearby does not look back), fading out to twice that.
const DEFAULT_LOOK_RADIUS = 140;
// While a focus holds the view the camera may look down this steeply.
const FOCUS_MAX_LOOK_DOWN_DEGREES = 42;
// A `serpent` point is placed this far from the snake's middle, toward the route.
const DEFAULT_SERPENT_STANDOFF = 150;
const TIMING_SAMPLES = 512;
const FOCUS_MAX_LOOK_DOWN_SLOPE = Math.tan(THREE.MathUtils.degToRad(FOCUS_MAX_LOOK_DOWN_DEGREES));

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

function viewAngleDegrees(value, name, fallback) {
  const number = finiteNumber(value ?? fallback, name);
  if (number < 0 || number >= MAX_VIEW_ANGLE_DEGREES) {
    throw new Error(`${name} must be in [0, ${MAX_VIEW_ANGLE_DEGREES}).`);
  }
  return number;
}

function nonNegativeNumber(value, name, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!(number >= 0) || !Number.isFinite(number)) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return number;
}

/* A point is either a fixed `position` [x, z] or `serpent: N`, the live
 * position of wildlife.serpents[N] when the tour starts (skipped if that snake
 * is not there). Optional: `pace` slows the flight around it (0.5 = half
 * speed), `lookAt` [x, z] or [x, y, z] turns the view to a subject while
 * passing (`lookHeight` above the ground when y is omitted). */
function resolveShowcasePoints(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('navigation.scenicTour.showcasePoints must contain at least two points.');
  }
  return value.map((point, index) => {
    const name = `navigation.scenicTour.showcasePoints[${index}]`;
    const serpent = point?.serpent === undefined ? null : Number(point.serpent);
    if (serpent !== null && !(Number.isInteger(serpent) && serpent >= 0)) {
      throw new Error(`${name}.serpent must be a wildlife.serpents index.`);
    }
    if (serpent === null && (!Array.isArray(point?.position) || point.position.length !== 2
      || point.position.some((coordinate) => !Number.isFinite(Number(coordinate))))) {
      throw new Error(`${name}.position must contain finite X/Z values.`);
    }
    if (point.lookAt !== undefined && (!Array.isArray(point.lookAt) || ![2, 3].includes(point.lookAt.length)
      || point.lookAt.some((coordinate) => !Number.isFinite(Number(coordinate))))) {
      throw new Error(`${name}.lookAt must contain finite [x, z] or [x, y, z] values.`);
    }
    const minY = point.minY === undefined
      ? Number.NEGATIVE_INFINITY
      : finiteNumber(point.minY, `${name}.minY`);
    return {
      position: serpent === null ? point.position.map(Number) : null,
      serpent,
      standoff: positiveNumber(point.standoff ?? DEFAULT_SERPENT_STANDOFF, `${name}.standoff`),
      lift: positiveNumber(point.lift, `${name}.lift`),
      minY,
      pace: positiveNumber(point.pace ?? 1, `${name}.pace`),
      paceRadius: positiveNumber(point.paceRadius ?? DEFAULT_PACE_RADIUS, `${name}.paceRadius`),
      lookAt: point.lookAt?.map(Number) ?? null,
      lookHeight: finiteNumber(point.lookHeight ?? 6, `${name}.lookHeight`),
      lookRadius: positiveNumber(point.lookRadius ?? DEFAULT_LOOK_RADIUS, `${name}.lookRadius`),
    };
  });
}

function resolveLakeDive(value) {
  if (!value?.enabled) return null;
  if (!Array.isArray(value.centerXZ) || value.centerXZ.length !== 2
    || value.centerXZ.some((coordinate) => !Number.isFinite(Number(coordinate)))) {
    throw new Error('navigation.scenicTour.lakeDive.centerXZ must contain finite X/Z values.');
  }
  const radius = positiveNumber(value.radius, 'navigation.scenicTour.lakeDive.radius');
  const fullDepthRadius = nonNegativeNumber(
    value.fullDepthRadius,
    'navigation.scenicTour.lakeDive.fullDepthRadius',
  );
  if (fullDepthRadius >= radius) {
    throw new Error('navigation.scenicTour.lakeDive.fullDepthRadius must be lower than radius.');
  }
  return {
    centerXZ: value.centerXZ.map(Number),
    radius,
    fullDepthRadius,
    depth: positiveNumber(value.depth, 'navigation.scenicTour.lakeDive.depth'),
    bedClearance: nonNegativeNumber(
      value.bedClearance,
      'navigation.scenicTour.lakeDive.bedClearance',
      DEFAULT_LAKE_DIVE_BED_CLEARANCE,
    ),
  };
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
  const finalHoldSeconds = nonNegativeNumber(
    config.finalHoldSeconds,
    'navigation.scenicTour.finalHoldSeconds',
    DEFAULT_FINAL_HOLD_SECONDS,
  );
  if (returnDurationSeconds + finalHoldSeconds >= durationSeconds) {
    throw new Error('navigation.scenicTour return and hold durations must leave time for travel.');
  }
  const seaLookBlendStart = finiteNumber(config.seaLookBlendStart, 'navigation.scenicTour.seaLookBlendStart');
  const maxLookUpDegrees = viewAngleDegrees(
    config.maxLookUpDegrees,
    'navigation.scenicTour.maxLookUpDegrees',
    DEFAULT_MAX_LOOK_UP_DEGREES,
  );
  const maxLookDownDegrees = viewAngleDegrees(
    config.maxLookDownDegrees,
    'navigation.scenicTour.maxLookDownDegrees',
    DEFAULT_MAX_LOOK_DOWN_DEGREES,
  );
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
    finalHoldSeconds,
    travelDurationSeconds: durationSeconds - returnDurationSeconds - finalHoldSeconds,
    lookAheadDistance: positiveNumber(config.lookAheadDistance, 'navigation.scenicTour.lookAheadDistance'),
    preloadDistance: nonNegativeNumber(
      config.preloadDistance,
      'navigation.scenicTour.preloadDistance',
      DEFAULT_PRELOAD_DISTANCE,
    ),
    orientationSharpness: positiveNumber(
      config.orientationSharpness,
      'navigation.scenicTour.orientationSharpness',
    ),
    maxLookUpSlope: Math.tan(THREE.MathUtils.degToRad(maxLookUpDegrees)),
    maxLookDownSlope: Math.tan(THREE.MathUtils.degToRad(maxLookDownDegrees)),
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
    showcasePoints: resolveShowcasePoints(config.showcasePoints),
    lakeDive: resolveLakeDive(config.lakeDive),
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
    this.holding = false;
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.holdElapsed = 0;
    this.curveLength = 1;
    this.config = null;
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.finalTarget = new THREE.Vector3();
    this.preloadPosition = new THREE.Vector3();
    this.returnFromPosition = new THREE.Vector3();
    this.desiredQuaternion = new THREE.Quaternion();
    this.returnFromQuaternion = new THREE.Quaternion();
    this.lookMatrix = new THREE.Matrix4();
    this.obstacles = [];
    this.obstacleGrid = new Map();
    // Route marks from showcase points: { x, z, pace, paceRadius, focus, lookRadius }.
    this.marks = [];
    this.timing = null;
    this.focusTarget = new THREE.Vector3();
    this.focusWeight = 0;
    /** Wildlife.serpents[index] as XZ points head to tail, or null; set by the demo. */
    this.serpentPath = null;
  }

  configure(config) {
    if (this.active) throw new Error('Cannot reconfigure ScenicTour while it is active.');
    this.config = resolveTourConfig(config);
    return this;
  }

  start() {
    if (!this.config) throw new Error('ScenicTour must be configured before it starts.');
    if (this.active) { this.stop(); return false; }
    if (this.world.expansion?.river
      && this.config.showcasePoints.length === 0
      && this.config.riverViews.length < 2) {
      throw new Error('navigation.scenicTour.riverViews must contain at least two views when the river fallback is used.');
    }
    this.saved = {
      position: this.world.camera.position.clone(),
      quaternion: this.world.camera.quaternion.clone(),
    };
    const cameraStart = this.world.camera.position.clone();
    const start = this.player.getPosition().clone();
    const terrain = this.world.terrainSampler;
    let points;

    this.marks = [];
    if (this.config.showcasePoints.length > 0) {
      points = [cameraStart];
      for (const point of this.config.showcasePoints) {
        const placed = this.#placeShowcasePoint(point, points[points.length - 1]);
        if (!placed) continue;
        const [x, z] = placed.position;
        const terrainY = terrain.sampleHeight(x, z);
        points.push(new THREE.Vector3(
          x,
          Math.max(terrainY + point.lift, point.minY),
          z,
        ));
        this.marks.push({ x, z, pace: point.pace, paceRadius: point.paceRadius, focus: placed.focus, lookRadius: point.lookRadius });
      }
    } else if (this.world.expansion?.river) {
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
    this.#indexObstacles();
    this.curve = this.#buildClearedCurve(points);
    this.curve.updateArcLengths();
    this.curveLength = Math.max(this.curve.getLength(), Number.EPSILON);
    this.#locateMarks();
    this.timing = this.#buildTiming();
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.holdElapsed = 0;
    this.returning = false;
    this.holding = false;
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
    if (this.holding) {
      this.#updateHold(deltaSeconds);
      return;
    }

    this.elapsed += deltaSeconds;
    const progress = this.#routeProgress(Math.min(this.elapsed / this.config.travelDurationSeconds, 1));
    this.curve.getPointAt(progress, this.position);
    // Backstop. The curve is already lifted, but Catmull-Rom overshoots between
    // stations and the resampling only guarantees the stations themselves.
    this.position.y = Math.max(this.position.y, this.#requiredHeight(this.position.x, this.position.z));
    this.#applyLakeDive();
    this.world.camera.position.copy(this.position);

    const lookAheadProgress = Math.min(
      progress + this.config.lookAheadDistance / this.curveLength,
      1,
    );
    this.curve.getPointAt(lookAheadProgress, this.target);
    this.target.y -= this.config.targetDrop;
    if (this.lakeDiveAmount > 0) {
      const underwaterTarget = this.lakeDiveLevel - Math.max(0.5, this.config.lakeDive.depth * 0.45);
      this.target.y = THREE.MathUtils.lerp(this.target.y, underwaterTarget, this.lakeDiveAmount);
    }
    this.#blendFocus(progress);
    this.#blendFinalTarget(progress);
    this.#clampTargetPitch();
    this.#smoothOrientation(deltaSeconds);

    if (progress >= 1) this.#beginHoldOrReturn();
  }

  getPreloadPosition() {
    if (!this.active || !this.curve || this.returning || this.holding) {
      return this.world.camera.position;
    }
    const progress = this.#routeProgress(Math.min(this.elapsed / this.config.travelDurationSeconds, 1));
    const preloadProgress = Math.min(
      progress + this.config.preloadDistance / this.curveLength,
      1,
    );
    this.curve.getPointAt(preloadProgress, this.preloadPosition);
    return this.preloadPosition;
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
   * Where a showcase point sits and what it looks at. A serpent point flies
   * `standoff` from the snake's middle toward the previous route point and
   * looks at that middle; null when the snake is not available.
   */
  #placeShowcasePoint(point, previous) {
    const terrain = this.world.terrainSampler;
    const focusAt = (x, y, z) => new THREE.Vector3(x, y ?? Number(terrain.sampleHeight(x, z)) + point.lookHeight, z);
    if (point.serpent === null) {
      const focus = point.lookAt
        ? (point.lookAt.length === 3 ? focusAt(point.lookAt[0], point.lookAt[1], point.lookAt[2]) : focusAt(point.lookAt[0], null, point.lookAt[1]))
        : null;
      return { position: point.position, focus };
    }
    const path = this.serpentPath?.(point.serpent);
    if (!Array.isArray(path) || path.length === 0) return null;
    const [mx, mz] = path[Math.floor(path.length / 2)];
    let dx = previous.x - mx, dz = previous.z - mz;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length; dz /= length;
    return { position: [mx + dx * point.standoff, mz + dz * point.standoff], focus: focusAt(mx, null, mz) };
  }

  /**
   * Route fraction reached at each time fraction: the flight slows near marks
   * with a `pace` below 1. Tabulated once per tour as cumulative time over
   * evenly spaced route fractions; null when every pace is 1.
   */
  #buildTiming() {
    if (!this.marks.some((mark) => mark.pace !== 1)) return null;
    const curve = this.curve;
    const point = new THREE.Vector3();
    const times = new Float64Array(TIMING_SAMPLES + 1);
    const step = this.curveLength / TIMING_SAMPLES;
    for (let index = 1; index <= TIMING_SAMPLES; index += 1) {
      curve.getPointAt((index - 0.5) / TIMING_SAMPLES, point);
      let pace = 1;
      for (const mark of this.marks) {
        const distance = Math.hypot(point.x - mark.x, point.z - mark.z);
        const eased = THREE.MathUtils.lerp(mark.pace, 1, smoothstep01(distance / mark.paceRadius));
        pace = Math.min(pace, eased);
      }
      times[index] = times[index - 1] + step / pace;
    }
    const total = times[TIMING_SAMPLES];
    for (let index = 0; index <= TIMING_SAMPLES; index += 1) times[index] /= total;
    return times;
  }

  #routeProgress(timeFraction) {
    const times = this.timing;
    if (!times) return timeFraction;
    let low = 0, high = TIMING_SAMPLES;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (times[middle] <= timeFraction) low = middle; else high = middle;
    }
    const span = times[high] - times[low];
    const within = span > 0 ? (timeFraction - times[low]) / span : 0;
    return Math.min(1, (low + within) / TIMING_SAMPLES);
  }

  // Each mark's route fraction: where the cleared curve passes closest to it.
  #locateMarks() {
    const point = new THREE.Vector3();
    const samples = TIMING_SAMPLES;
    for (const mark of this.marks) {
      let best = Infinity;
      for (let index = 0; index <= samples; index += 1) {
        this.curve.getPointAt(index / samples, point);
        const distance = Math.hypot(point.x - mark.x, point.z - mark.z);
        if (distance < best) { best = distance; mark.fraction = index / samples; }
      }
    }
  }

  /**
   * Turns the view toward the subject of the nearest mark with a `lookAt`,
   * measured along the route, and lets go once the subject falls behind the
   * direction of travel rather than twisting round to follow it.
   */
  #blendFocus(progress) {
    this.focusWeight = 0;
    const camera = this.world.camera.position;
    const aheadX = this.target.x - camera.x, aheadZ = this.target.z - camera.z;
    const aheadLength = Math.hypot(aheadX, aheadZ) || 1;
    for (const mark of this.marks) {
      if (!mark.focus) continue;
      const along = Math.abs(progress - mark.fraction) * this.curveLength;
      let weight = 1 - smoothstep01((along - mark.lookRadius) / mark.lookRadius);
      if (weight <= 0) continue;
      const toX = mark.focus.x - camera.x, toZ = mark.focus.z - camera.z;
      const facing = (toX * aheadX + toZ * aheadZ) / ((Math.hypot(toX, toZ) || 1) * aheadLength);
      weight *= smoothstep01((facing + 0.35) / 0.55);
      if (weight > this.focusWeight) {
        this.focusWeight = weight;
        this.focusTarget.copy(mark.focus);
      }
    }
    if (this.focusWeight > 0) this.target.lerp(this.focusTarget, this.focusWeight);
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
      if (tree.obstacle) {
        if (!near(tree.obstacle.x, tree.obstacle.z)) continue;
        obstacles.push({ ...tree.obstacle });
        continue;
      }
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

  #obstacleGridKey(x, z) {
    return `${Math.floor(x / OBSTACLE_GRID_CELL_SIZE)},${Math.floor(z / OBSTACLE_GRID_CELL_SIZE)}`;
  }

  #indexObstacles() {
    this.obstacleGrid.clear();
    for (const obstacle of this.obstacles) {
      const reach = obstacle.radius + this.config.obstacleStandoff;
      const minX = Math.floor((obstacle.x - reach) / OBSTACLE_GRID_CELL_SIZE);
      const maxX = Math.floor((obstacle.x + reach) / OBSTACLE_GRID_CELL_SIZE);
      const minZ = Math.floor((obstacle.z - reach) / OBSTACLE_GRID_CELL_SIZE);
      const maxZ = Math.floor((obstacle.z + reach) / OBSTACLE_GRID_CELL_SIZE);
      for (let x = minX; x <= maxX; x += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const key = `${x},${z}`;
          const cell = this.obstacleGrid.get(key);
          if (cell) cell.push(obstacle);
          else this.obstacleGrid.set(key, [obstacle]);
        }
      }
    }
  }

  #terrainFloor(x, z) {
    const terrain = this.world.terrainSampler;
    if (typeof terrain.contains === 'function' && !terrain.contains(x, z, 0)) return -Infinity;
    const sampled = Number(terrain.sampleHeight(x, z));
    return Number.isFinite(sampled) ? sampled + this.config.terrainClearance : -Infinity;
  }

  /** Lowest height the camera may fly at this column: terrain, or an obstacle's crown. */
  #requiredHeight(x, z) {
    let height = this.#terrainFloor(x, z);
    const obstacles = this.obstacleGrid.get(this.#obstacleGridKey(x, z)) ?? EMPTY_OBSTACLES;
    for (const obstacle of obstacles) {
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

  #applyLakeDive() {
    this.lakeDiveAmount = 0;
    this.lakeDiveLevel = 0;
    const dive = this.config.lakeDive;
    if (!dive || typeof this.water.surfaceLevelAt !== 'function') return;

    const dx = this.position.x - dive.centerXZ[0];
    const dz = this.position.z - dive.centerXZ[1];
    const distance = Math.hypot(dx, dz);
    if (distance >= dive.radius) return;

    const level = this.water.surfaceLevelAt(this.position.x, this.position.z);
    if (!Number.isFinite(level)) return;

    const amount = distance <= dive.fullDepthRadius
      ? 1
      : 1 - smoothstep01((distance - dive.fullDepthRadius) / (dive.radius - dive.fullDepthRadius));
    if (amount <= 0) return;

    const terrainY = Number(this.world.terrainSampler.sampleHeight(this.position.x, this.position.z));
    const bedFloor = Number.isFinite(terrainY) ? terrainY + dive.bedClearance : Number.NEGATIVE_INFINITY;
    const diveY = level - dive.depth;
    this.position.y = Math.max(
      THREE.MathUtils.lerp(this.position.y, diveY, amount),
      bedFloor,
    );
    this.lakeDiveAmount = amount;
    this.lakeDiveLevel = level;
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

  #clampTargetPitch() {
    const cameraPosition = this.world.camera.position;
    const horizontalDistance = Math.hypot(
      this.target.x - cameraPosition.x,
      this.target.z - cameraPosition.z,
    );
    if (horizontalDistance <= Number.EPSILON) {
      this.target.y = cameraPosition.y;
      return;
    }
    // A focused subject may be looked down on more steeply than the path ahead.
    const lookDown = THREE.MathUtils.lerp(this.config.maxLookDownSlope, FOCUS_MAX_LOOK_DOWN_SLOPE, this.focusWeight ?? 0);
    this.target.y = THREE.MathUtils.clamp(
      this.target.y,
      cameraPosition.y - horizontalDistance * lookDown,
      cameraPosition.y + horizontalDistance * this.config.maxLookUpSlope,
    );
  }

  #smoothOrientation(deltaSeconds) {
    this.lookMatrix.lookAt(this.world.camera.position, this.target, this.world.camera.up);
    this.desiredQuaternion.setFromRotationMatrix(this.lookMatrix);
    const alpha = 1 - Math.exp(-this.config.orientationSharpness * deltaSeconds);
    this.world.camera.quaternion.slerp(this.desiredQuaternion, alpha);
  }

  #beginHoldOrReturn() {
    this.focusWeight = 0;
    if (this.config.finalHoldSeconds <= 0) {
      this.#beginReturn();
      return;
    }
    this.holding = true;
    this.holdElapsed = 0;
  }

  #updateHold(deltaSeconds) {
    this.holdElapsed += deltaSeconds;
    this.target.set(
      this.config.seaFocusXZ[0],
      this.water.params?.sea?.enabled
        ? this.water.params.sea.level + this.config.seaFocusHeightOffset
        : this.water.mesh.position.y + this.config.seaFocusHeightOffset,
      this.config.seaFocusXZ[1],
    );
    this.#clampTargetPitch();
    this.#smoothOrientation(deltaSeconds);
    if (this.holdElapsed >= this.config.finalHoldSeconds) this.#beginReturn();
  }

  #beginReturn() {
    this.holding = false;
    this.returning = true;
    this.returnElapsed = 0;
    this.returnFromPosition.copy(this.world.camera.position);
    this.returnFromQuaternion.copy(this.world.camera.quaternion);
  }

  #updateReturn(deltaSeconds) {
    this.returnElapsed += deltaSeconds;
    const progress = Math.min(this.returnElapsed / this.config.returnDurationSeconds, 1);
    if (progress >= 1) {
      this.world.camera.position.copy(this.saved.position);
      this.world.camera.quaternion.copy(this.saved.quaternion);
      this.#finish();
      return;
    }

    const eased = smoothstep01(progress);
    this.position.lerpVectors(this.returnFromPosition, this.saved.position, eased);
    this.position.y = Math.max(this.position.y, this.#requiredHeight(this.position.x, this.position.z));
    this.world.camera.position.copy(this.position);
    this.world.camera.quaternion.copy(this.returnFromQuaternion).slerp(this.saved.quaternion, eased);
  }

  #finish() {
    this.marks = [];
    this.timing = null;
    this.focusWeight = 0;
    this.obstacles = [];
    this.obstacleGrid.clear();
    this.active = false;
    this.returning = false;
    this.holding = false;
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.holdElapsed = 0;
    this.lakeDiveAmount = 0;
    this.player.root.visible = true;
    this.player.setEnabled(true);
    this.saved = null;
  }
}
