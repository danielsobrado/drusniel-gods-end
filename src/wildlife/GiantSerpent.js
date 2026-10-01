import * as THREE from 'three/webgpu';
import { coastalJungleProfileWeight } from '../world/CoastalJungleRegion.js';
import { lakeBoundsContain, lakeSignedDistance } from '../world/LakeShape.js';
import { forestWeight } from '../world/LandscapePaths.js';
import { coastX } from '../world/CoastField.js';
import { DRAW_ORDER, setOpaqueDrawOrder } from '../rendering/drawOrder.js';
import { createSeededRandom } from '../core/math.js';
import { serpentBellyDepth, smoothstep } from './serpentShape.js';
import { createSerpentGeometry, deformSerpentGeometry, serpentEyeRest } from './serpentBody.js';
import { createSerpentEyeMaterial, createSerpentSkinMaterial, createSerpentTongueMaterial } from './serpentMaterial.js';

// A giant serpent roaming its habitat: the coastal jungle, or an open meadow.
//
// Locomotion is serpentine: the head steers a sinuous course and every part
// of the body follows exactly the path the head took (a trail of points one
// step apart), which is how a snake's body moves through undergrowth. The head
// keeps to its habitat near its home, off steep ground, clear of the lake,
// the river and the sea, and off its own coils. It rests now and then,
// lifting its head to taste the air; a walker who comes close is watched,
// head raised (a cobra spreads its hood), and one who comes closer sends it off.

// Distances below are for a snake with a 0.5 m body (REFERENCE_RADIUS) and
// scale with its size; times stretch with the square root of its size, so a
// giant flicks its tongue, breathes and turns more slowly.
const REFERENCE_RADIUS = 0.5;
const TRAIL_STEP = 0.05;
const STEER_INTERVAL = 0.3;
const STEER_OFFSETS = [0, -0.2, 0.2, -0.45, 0.45, -0.8, 0.8, -1.2, 1.2];
const STEER_WIDE = [-1.8, 1.8, -2.5, 2.5, Math.PI];
const LOOK_AHEAD = [2.5, 5, 8];
const TRUNK_CLEARANCE = 1.3;
// A body thicker than this cannot thread the gaps between jungle trunks: it
// only prefers open ground, and the trees stand through it.
const THREADING_RADIUS = 1.5;
// Meadow snakes stay out of the forest and this far inland of the coast
// (the beach and the dunes behind it), in metres.
const MEADOW_FOREST_LIMIT = 0.3;
const MEADOW_COAST_CLEARANCE = 200;
// Beyond these the body is re-posed every second and every third frame; it
// moves a few centimetres a frame, which does not show from there.
const CLOSE_UPDATE_DISTANCE = 25;
const NEAR_UPDATE_DISTANCE = 60;
const UP = new THREE.Vector3(0, 1, 0);

function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** The head's path: points TRAIL_STEP apart, newest last, plus the head itself. */
export class SerpentTrail {
  constructor(length, step = TRAIL_STEP) {
    this.step = step;
    this.capacity = Math.ceil(length / step) + 4;
    this.x = new Float32Array(this.capacity);
    this.z = new Float32Array(this.capacity);
    this.reset(0, 0);
  }

  reset(x, z) {
    this.count = 1;
    this.x[0] = x;
    this.z[0] = z;
    this.headX = x;
    this.headZ = z;
    // Distance from the newest point to the head.
    this.travel = 0;
  }

  #push(x, z) {
    const index = this.count % this.capacity;
    this.x[index] = x;
    this.z[index] = z;
    this.count += 1;
  }

  advance(x, z) {
    let fromX = this.headX, fromZ = this.headZ;
    let distance = Math.hypot(x - fromX, z - fromZ);
    while (distance > 0 && this.travel + distance >= this.step) {
      const t = (this.step - this.travel) / distance;
      fromX += (x - fromX) * t;
      fromZ += (z - fromZ) * t;
      this.#push(fromX, fromZ);
      distance = Math.hypot(x - fromX, z - fromZ);
      this.travel = 0;
    }
    this.travel += distance;
    this.headX = x;
    this.headZ = z;
  }

  /** Point `s` metres back along the path from the head. */
  sample(s, out) {
    const newest = (this.count - 1) % this.capacity;
    if (s <= this.travel) {
      const t = this.travel > 0 ? s / this.travel : 0;
      out.x = this.headX + (this.x[newest] - this.headX) * t;
      out.z = this.headZ + (this.z[newest] - this.headZ) * t;
      return out;
    }
    const back = (s - this.travel) / this.step;
    const oldestBack = Math.min(this.count, this.capacity) - 1;
    const whole = Math.min(Math.floor(back), oldestBack);
    const fraction = whole === oldestBack ? 0 : back - whole;
    const a = (this.count - 1 - whole) % this.capacity;
    const b = whole === oldestBack ? a : (this.count - 2 - whole) % this.capacity;
    out.x = this.x[a] + (this.x[b] - this.x[a]) * fraction;
    out.z = this.z[a] + (this.z[b] - this.z[a]) * fraction;
    return out;
  }
}

// Flat forked tongue along +z, unit length, lying in the x-z plane.
function createTongueGeometry(width) {
  const w = width * 0.5;
  const fork = 0.62;
  const spread = width * 1.2;
  const positions = [
    -w, 0, 0, w, 0, 0, -w * 0.8, 0, fork, w * 0.8, 0, fork,
    // Left and right prongs.
    -w * 0.8, 0, fork, 0, 0, fork, -spread, 0, 1,
    0, 0, fork, w * 0.8, 0, fork, spread, 0, 1,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3, 4, 6, 5, 7, 9, 8]);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * One giant serpent. `settings` come from resolveSerpentSettings(); the skin
 * textures are owned by the caller (SerpentSystem), which fills them in when
 * its worker has drawn them.
 */
export class GiantSerpent {
  constructor({
    scene, terrain, config, settings, tileTexture, patternTexture, jungle = null, lake = null, expansion = null,
  }) {
    this.settings = settings;
    this.enabled = Boolean(settings?.enabled && terrain);
    this.state = 'roam';
    if (!this.enabled) return;
    this.scene = scene;
    this.terrain = terrain;
    this.config = config;
    this.habitat = settings.habitat;
    // Only a jungle snake waits for the jungle (its trunks, its visibility).
    this.jungle = this.habitat === 'jungle' ? jungle : null;
    this.lake = lake;
    this.river = expansion?.river ?? null;
    this.sea = config?.water?.sea?.enabled ? config.water.sea : null;
    this.tileTexture = tileTexture;
    this.patternTexture = patternTexture;
    this.shape = this.settings.shape;
    this.size = this.shape.radius / REFERENCE_RADIUS;
    this.tempo = 1 / Math.sqrt(this.size);
    this.trunkClearance = TRUNK_CLEARANCE * this.size;
    this.trunkCell = Math.max(8, this.trunkClearance);
    this.random = createSeededRandom(this.settings.seed);
    this.colliderSettings = config.biomes?.coastalJungle?.collider ?? {};
    this.trunks = null;

    this.body = createSerpentGeometry(this.shape);
    this.skinMaterial = createSerpentSkinMaterial({
      tileTexture: this.tileTexture,
      patternTexture: this.patternTexture,
      shape: this.shape,
      totalRows: this.body.totalRows,
      // The jungle's haze belongs to jungle snakes; the meadow has only the world fog.
      haze: this.habitat === 'jungle' ? config.biomes?.coastalJungle?.material?.haze ?? null : null,
      ...settings.skin,
    });
    const name = `Giant serpent (${settings.label})`;
    this.mesh = new THREE.Mesh(this.body.geometry, this.skinMaterial);
    this.mesh.name = name;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    setOpaqueDrawOrder(this.mesh, DRAW_ORDER.props);
    this.#createHead();
    this.root = new THREE.Group();
    this.root.name = name;
    this.root.add(this.mesh, this.head);
    this.root.visible = false;
    scene.add(this.root);

    const { rings } = this.body;
    this.frames = new Float32Array(rings * 12);
    this.girth = new Float32Array(rings).fill(1);
    this.flare = settings.hood ? new Float32Array(rings).fill(1) : null;
    this.spine = new Float32Array(rings * 3);
    this.ground = new Float32Array(rings);
    this.trail = new SerpentTrail(this.shape.length + 6 * this.size, TRAIL_STEP * this.size);
    this.point = { x: 0, z: 0 };
    this.frustum = new THREE.Frustum();
    this.projection = new THREE.Matrix4();
    this.sphere = new THREE.Sphere();
    this.vectors = Array.from({ length: 4 }, () => new THREE.Vector3());
    this.pivot = { x: 0, z: 0 };
    this.#buildRingTables();

    this.time = 0;
    this.frame = 0;
    this.lift = 0;
    this.look = 0;
    this.hood = 0;
    this.tongue = { timer: 2, age: -1 };
    this.#spawn();
  }

  #createHead() {
    this.head = new THREE.Group();
    this.head.name = 'Jungle serpent head';
    this.head.matrixAutoUpdate = false;
    this.eyeMaterial = createSerpentEyeMaterial(this.settings.eye);
    this.tongueMaterial = createSerpentTongueMaterial();
    const eyeRest = serpentEyeRest(this.shape);
    this.eyeGeometry = new THREE.SphereGeometry(eyeRest.radius, 24, 16);
    const x = new THREE.Vector3(), y = new THREE.Vector3();
    for (const side of [1, -1]) {
      const { centre, axis } = serpentEyeRest(this.shape, side);
      const eye = new THREE.Mesh(this.eyeGeometry, this.eyeMaterial);
      eye.name = 'Jungle serpent eye';
      // Sphere +z out of the head, +y up, so the slit pupil stands upright.
      x.crossVectors(UP, axis).normalize();
      y.crossVectors(axis, x);
      eye.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, axis));
      eye.position.copy(centre);
      this.head.add(eye);
    }
    this.tongueGeometry = createTongueGeometry(this.shape.headWidth * 0.1);
    this.tongueMesh = new THREE.Mesh(this.tongueGeometry, this.tongueMaterial);
    this.tongueMesh.name = 'Jungle serpent tongue';
    this.tongueMesh.position.set(0, -this.shape.headHeight * 0.3, -this.shape.headLength * 0.04);
    this.tongueMesh.visible = false;
    this.tongueLength = this.shape.headLength * 0.45;
    this.head.add(this.tongueMesh);
  }

  // ---------------------------------------------------------------- terrain

  #slope(x, z) {
    const h = this.terrain;
    const d = 1.5 * this.size;
    const dx = (h.sampleHeight(x + d, z) - h.sampleHeight(x - d, z)) / (2 * d);
    const dz = (h.sampleHeight(x, z + d) - h.sampleHeight(x, z - d)) / (2 * d);
    return Math.hypot(dx, dz);
  }

  #loadTrunks() {
    const records = this.jungle?.colliderRecords;
    if (!this.jungle?.ready || !records?.length) return false;
    const cells = new Map();
    for (const record of records) {
      const settings = this.colliderSettings[record.kind];
      if (!settings || !record.position) continue;
      const scale = record.scale ? Math.max(Math.abs(record.scale.x), Math.abs(record.scale.z)) : 1;
      const radius = Number(settings.radius) * scale;
      const key = `${Math.floor(record.position.x / this.trunkCell)},${Math.floor(record.position.z / this.trunkCell)}`;
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = []);
      cell.push(record.position.x, record.position.z, radius);
    }
    this.trunks = cells;
    return true;
  }

  #trunkClearance(x, z) {
    if (!this.trunks) return Infinity;
    const cx = Math.floor(x / this.trunkCell), cz = Math.floor(z / this.trunkCell);
    let best = Infinity;
    for (let i = cx - 1; i <= cx + 1; i += 1) {
      for (let j = cz - 1; j <= cz + 1; j += 1) {
        const cell = this.trunks.get(`${i},${j}`);
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 3) {
          best = Math.min(best, Math.hypot(x - cell[k], z - cell[k + 1]) - cell[k + 2]);
        }
      }
    }
    return best;
  }

  /** How bad a spot is for the head to go: 0 is fine, bigger is worse. */
  hazard(x, z, { self = true } = {}) {
    let cost = 0;
    const size = this.size;
    const jungle = coastalJungleProfileWeight(x, z, this.config);
    if (this.habitat === 'jungle') {
      if (jungle < 0.98) cost += (1 - jungle) * 8;
    } else {
      // Meadow: out of the jungle and the forest, inland of the beach, and
      // clear of any avoided zone (the village).
      cost += jungle * 8;
      const forest = forestWeight(x, z);
      if (forest > MEADOW_FOREST_LIMIT) cost += (forest - MEADOW_FOREST_LIMIT) * 12;
      if (this.sea) {
        const inland = coastX(z, this.sea) - x;
        if (inland < MEADOW_COAST_CLEARANCE) cost += (MEADOW_COAST_CLEARANCE - inland) / size * 0.6;
      }
      for (const zone of this.settings.avoid) {
        const inside = zone.radius - Math.hypot(x - zone.center[0], z - zone.center[1]);
        if (inside > 0) cost += inside / size * 0.6;
      }
    }
    const [homeX, homeZ] = this.settings.home;
    const fromHome = Math.hypot(x - homeX, z - homeZ) - this.settings.roamRadius;
    if (fromHome > 0) cost += fromHome * 0.25;
    const shoreClearance = 5 * size;
    if (this.lake && lakeBoundsContain(x, z, this.lake, shoreClearance + 3)) {
      const shore = lakeSignedDistance(x, z, this.lake);
      if (shore < shoreClearance) cost += ((shoreClearance - shore) / size) * 1.5;
    }
    const edge = this.river?.sample?.(x, z)?.edge;
    if (Number.isFinite(edge) && edge < shoreClearance) cost += ((shoreClearance - edge) / size) * 1.5;
    const slope = this.#slope(x, z);
    if (!Number.isFinite(slope)) return 100;
    if (slope > this.settings.maxSlope) cost += (slope - this.settings.maxSlope) * 10;
    const trunk = this.#trunkClearance(x, z);
    const clearance = this.trunkClearance;
    if (trunk < clearance) {
      cost += (clearance - trunk) / clearance * (this.shape.radius > THREADING_RADIUS ? 0.4 : 6.5);
    }
    if (self) {
      // Its own body, from well behind the head.
      const gapLimit = 2.2 * size;
      for (let s = 5 * size; s < this.shape.length; s += 1.5 * size) {
        this.trail.sample(s, this.point);
        const gap = Math.hypot(x - this.point.x, z - this.point.z);
        if (gap < gapLimit) cost += ((gapLimit - gap) / size) * 2;
      }
    }
    return cost;
  }

  // -------------------------------------------------------------- behaviour

  #spawn() {
    const [homeX, homeZ] = this.settings.home;
    let x = homeX, z = homeZ;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const angle = this.random() * Math.PI * 2;
      const distance = Math.sqrt(this.random()) * this.settings.roamRadius * 0.6;
      const cx = homeX + Math.cos(angle) * distance, cz = homeZ + Math.sin(angle) * distance;
      if (this.hazard(cx, cz, { self: false }) < 0.05) {
        x = cx;
        z = cz;
        break;
      }
    }
    this.trail.reset(x, z);
    this.heading = this.random() * Math.PI * 2;
    this.wander = this.heading;
    this.phase = 0;
    this.speed = this.settings.speed;
    this.state = 'roam';
    this.stateTime = 20 + this.random() * 30;
    // Crawl out a full body length so the body lies along a real path.
    const step = 0.05;
    this.steerTimer = 0;
    for (let travelled = 0; travelled < this.shape.length + 4 * this.size; travelled += this.settings.speed * step) {
      this.#steer(step);
      this.#move(step, this.settings.speed);
    }
    this.#pose();
  }

  #steer(deltaSeconds, force = false) {
    this.steerTimer = (this.steerTimer ?? 0) - deltaSeconds;
    this.wanderTimer = (this.wanderTimer ?? 0) - deltaSeconds;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 4 + this.random() * 6;
      this.wander = this.heading + (this.random() * 2 - 1) * 1.1;
    }
    if (!force && this.steerTimer > 0) return;
    this.steerTimer = STEER_INTERVAL;
    const { headX, headZ } = this.trail;
    const evaluate = (offset) => {
      const angle = this.heading + offset;
      const dirX = Math.sin(angle), dirZ = Math.cos(angle);
      let cost = Math.abs(angleDelta(this.wander, angle)) * 0.35;
      for (const ahead of LOOK_AHEAD) {
        const distance = ahead * this.size;
        cost += this.hazard(headX + dirX * distance, headZ + dirZ * distance);
      }
      return cost;
    };
    let best = 0, bestCost = Infinity;
    for (const offset of STEER_OFFSETS) {
      const cost = evaluate(offset);
      if (cost < bestCost) {
        bestCost = cost;
        best = offset;
      }
    }
    if (bestCost > 2.5) {
      for (const offset of STEER_WIDE) {
        const cost = evaluate(offset);
        if (cost < bestCost) {
          bestCost = cost;
          best = offset;
        }
      }
      // Hemmed in: head for home.
      const [homeX, homeZ] = this.settings.home;
      if (bestCost > 6) this.wander = Math.atan2(homeX - headX, homeZ - headZ);
    }
    this.steerTarget = this.heading + best;
  }

  #move(deltaSeconds, speed) {
    const turn = angleDelta(this.heading, this.steerTarget ?? this.heading);
    const maxTurn = this.settings.turnRate * deltaSeconds * Math.max(0.35, speed / this.settings.speed);
    this.heading += Math.max(-maxTurn, Math.min(maxTurn, turn));
    const distance = speed * deltaSeconds;
    if (distance <= 0) return;
    this.phase += (distance / this.settings.wavelength) * Math.PI * 2;
    const course = this.heading + Math.sin(this.phase) * this.settings.amplitude;
    this.trail.advance(this.trail.headX + Math.sin(course) * distance, this.trail.headZ + Math.cos(course) * distance);
  }

  #setState(state, duration) {
    this.state = state;
    this.stateTime = duration;
  }

  #think(deltaSeconds, player) {
    const { headX, headZ } = this.trail;
    const settings = this.settings;
    const playerDistance = player ? Math.hypot(player.x - headX, player.z - headZ) : Infinity;
    const near = playerDistance < settings.alertDistance
      && Math.abs(player.y - this.terrain.sampleHeight(headX, headZ)) < 8 * this.size;
    this.stateTime -= deltaSeconds;
    if (this.state === 'retreat') {
      if (this.stateTime <= 0) this.#setState('roam', 15 + this.random() * 25);
    } else if (near && this.state !== 'alert') {
      this.#setState('alert', 4 + this.random() * 3);
    } else if (this.state === 'alert') {
      if (!near && playerDistance > settings.alertDistance * 1.25) this.#setState('roam', 15 + this.random() * 25);
      else if (this.stateTime <= 0 && playerDistance < settings.retreatDistance) this.#setState('retreat', 10 + this.random() * 5);
      else if (this.stateTime <= 0) this.stateTime = 1;
    } else if (this.stateTime <= 0) {
      if (this.state === 'roam') this.#setState('rest', 6 + this.random() * 8);
      else this.#setState('roam', 20 + this.random() * 40);
    }

    let targetSpeed = 0, targetLift = 0, targetLook = 0;
    if (this.state === 'roam') {
      targetSpeed = settings.speed;
      targetLift = 0.08 * this.size;
    } else if (this.state === 'rest') {
      targetLift = settings.headLift * 0.3;
      targetLook = Math.sin(this.time * 0.45 * this.tempo) * 0.55;
    } else if (this.state === 'alert') {
      targetLift = settings.headLift;
      targetLook = this.#lookToward(player);
    } else if (this.state === 'retreat') {
      targetSpeed = settings.fleeSpeed;
      targetLift = settings.headLift * 0.15;
      if (player) this.wander = Math.atan2(headX - player.x, headZ - player.z);
    }
    const ease = (current, target, rate) => current + (target - current) * (1 - Math.exp(-rate * this.tempo * deltaSeconds));
    this.speed = ease(this.speed, targetSpeed, targetSpeed > this.speed ? 1.2 : 2.2);
    this.lift = ease(this.lift, targetLift, 1.4);
    this.look = ease(this.look, targetLook, 1.8);
    // A cobra spreads its hood only while it stands up to watch.
    if (this.flare) this.hood = ease(this.hood, this.state === 'alert' ? 1 : 0, this.state === 'alert' ? 0.9 : 1.6);
    return playerDistance;
  }

  #lookToward(player) {
    if (!player) return 0;
    const pivot = this.trail.sample(this.settings.neckLength, { x: 0, z: 0 });
    const neckHeading = Math.atan2(this.trail.headX - pivot.x, this.trail.headZ - pivot.z);
    const toPlayer = Math.atan2(player.x - pivot.x, player.z - pivot.z);
    return Math.max(-1.3, Math.min(1.3, angleDelta(neckHeading, toPlayer)));
  }

  #updateTongue(deltaSeconds) {
    const tongue = this.tongue;
    if (tongue.age < 0) {
      tongue.timer -= deltaSeconds;
      if (tongue.timer <= 0) {
        tongue.age = 0;
        tongue.duration = (0.55 + this.random() * 0.4) / this.tempo;
      }
    }
    if (tongue.age >= 0) {
      tongue.age += deltaSeconds;
      const { age, duration } = tongue;
      const flick = 0.1 / this.tempo;
      const extension = smoothstep(0, flick * 0.9, age) * (1 - smoothstep(duration - flick, duration, age));
      this.tongueMesh.visible = extension > 0.02;
      this.tongueMesh.scale.set(1, 1, Math.max(0.01, extension) * this.tongueLength);
      this.tongueMesh.rotation.x = Math.sin(age * Math.PI * 2 * 8 * this.tempo) * 0.35 * extension - 0.08;
      if (age >= duration) {
        tongue.age = -1;
        this.tongueMesh.visible = false;
        const [min, max] = this.state === 'alert' ? [0.5, 1.4] : this.state === 'rest' ? [1.5, 3.5] : [3, 7];
        tongue.timer = (min + this.random() * (max - min)) / this.tempo;
      }
    }
  }

  // ------------------------------------------------------------------- pose

  // Per-ring constants of the pose: resting height of the spine above the
  // ground, and how much of the neck turn, head lift, breathing and tail sway
  // each ring takes.
  #buildRingTables() {
    const { stations, rings } = this.body;
    const shape = this.shape;
    const settings = this.settings;
    const headDepth = serpentBellyDepth(shape.headLength * 0.7, shape);
    const liftLength = settings.neckLength * 1.15;
    const hood = settings.hood;
    const hoodStart = shape.headLength * 1.02;
    const hoodLength = hood ? hood.length * shape.length : 1;
    const tables = {
      depth: new Float32Array(rings),
      contact: new Float32Array(rings),
      turn: new Float32Array(rings),
      lift: new Float32Array(rings),
      chest: new Float32Array(rings),
      tail: new Float32Array(rings),
      hood: new Float32Array(rings),
    };
    const sink = shape.radius * 0.06;
    for (let i = 0; i < rings; i += 1) {
      const s = stations[i];
      const depth = serpentBellyDepth(s, shape);
      tables.depth[i] = Math.max(s < shape.headLength ? headDepth : depth, shape.radius * 0.05) - sink;
      tables.contact[i] = depth * 0.8 - sink;
      tables.turn[i] = s < settings.neckLength ? 1 - smoothstep(0, settings.neckLength, s) : 0;
      tables.lift[i] = s < liftLength ? 1 - smoothstep(0, liftLength, s) : 0;
      tables.chest[i] = smoothstep(shape.neck, shape.neck + 2, s)
        * (1 - smoothstep(shape.length * 0.45, shape.length * 0.7, s));
      tables.tail[i] = smoothstep(shape.length - 2.5 * this.size, shape.length, s);
      if (hood) {
        // Opens just behind the head, widest a third of the way down it.
        const t = (s - hoodStart) / hoodLength;
        tables.hood[i] = smoothstep(0, 0.3, t) * (1 - smoothstep(0.4, 1, t));
      }
    }
    let anchor = 0;
    while (anchor < rings - 1 && stations[anchor] < shape.headLength) anchor += 1;
    tables.anchor = anchor;
    // Rings from the jaw hinge back to here blend from the rigid head into the neck.
    let blend = anchor;
    while (blend < rings - 1 && stations[blend] < shape.headLength + 0.6 * this.size) blend += 1;
    tables.blend = blend;
    this.rings = tables;
  }

  #poseSpine() {
    const { stations, rings } = this.body;
    const { depth, contact, turn, lift } = this.rings;
    const spine = this.spine;
    const pivot = this.trail.sample(this.settings.neckLength, this.pivot);
    const look = this.look;
    const reach = this.shape.radius > 1 ? this.shape.radius * 0.6 : 0;
    for (let i = 0; i < rings; i += 1) {
      this.trail.sample(stations[i], this.point);
      let { x, z } = this.point;
      // Neck turn: the front of the body swings about the pivot.
      if (turn[i] > 0 && look !== 0) {
        const angle = -look * turn[i];
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const dx = x - pivot.x, dz = z - pivot.z;
        x = pivot.x + dx * cos - dz * sin;
        z = pivot.z + dx * sin + dz * cos;
      }
      let ground = this.terrain.sampleHeight(x, z);
      // A wide body rests on the highest ground under it, not just under
      // its spine, or it sinks into every slope it lies across.
      if (reach > 0) {
        const h = this.terrain;
        const high = Math.max(h.sampleHeight(x + reach, z), h.sampleHeight(x - reach, z),
          h.sampleHeight(x, z + reach), h.sampleHeight(x, z - reach));
        ground = Math.max(ground, high - reach * 0.4);
      }
      this.ground[i] = ground;
      spine[i * 3] = x;
      spine[i * 3 + 1] = ground + depth[i];
      spine[i * 3 + 2] = z;
    }
    // Drape over small bumps instead of tracing each one.
    for (let pass = 0; pass < 2; pass += 1) {
      let previous = spine[1];
      for (let i = 1; i < rings - 1; i += 1) {
        const current = spine[i * 3 + 1];
        const smoothed = (previous + current * 2 + spine[(i + 1) * 3 + 1]) * 0.25;
        previous = current;
        // Never below its own ground contact.
        spine[i * 3 + 1] = Math.max(smoothed, this.ground[i] + contact[i]);
      }
    }
    for (let i = 0; i < rings && lift[i] > 0; i += 1) spine[i * 3 + 1] += this.lift * lift[i];
  }

  // Scalar on purpose: this runs over every ring on each posed frame.
  #buildFrames() {
    const { stations, rings } = this.body;
    const { spine, frames } = this;
    const { anchor, blend } = this.rings;
    const ax = spine[anchor * 3], ay = spine[anchor * 3 + 1], az = spine[anchor * 3 + 2];
    const anchorS = stations[anchor];
    // The rigid head points from its hinge to the snout, kept nearly level.
    let hx = spine[0] - ax, hy = (spine[1] - ay) * 0.35, hz = spine[2] - az;
    let length = Math.hypot(hx, hy, hz) || 1;
    hx /= length; hy /= length; hz /= length;
    const blendStart = anchorS;
    const blendEnd = stations[blend];
    for (let i = 0; i < rings; i += 1) {
      const s = stations[i];
      const a = (i > 0 ? i - 1 : 0) * 3, b = (i < rings - 1 ? i + 1 : i) * 3;
      let fx = spine[a] - spine[b], fy = spine[a + 1] - spine[b + 1], fz = spine[a + 2] - spine[b + 2];
      length = Math.hypot(fx, fy, fz) || 1;
      fx /= length; fy /= length; fz /= length;
      let px = spine[i * 3], py = spine[i * 3 + 1], pz = spine[i * 3 + 2];
      if (i <= anchor) {
        const back = anchorS - s;
        px = ax + hx * back; py = ay + hy * back; pz = az + hz * back;
        fx = hx; fy = hy; fz = hz;
      } else if (i < blend) {
        const t = smoothstep(blendStart, blendEnd, s);
        const back = s - anchorS;
        px += (ax - hx * back - px) * (1 - t);
        py += (ay - hy * back - py) * (1 - t);
        pz += (az - hz * back - pz) * (1 - t);
        fx = hx + (fx - hx) * t; fy = hy + (fy - hy) * t; fz = hz + (fz - hz) * t;
        length = Math.hypot(fx, fy, fz) || 1;
        fx /= length; fy /= length; fz /= length;
      }
      // Up is world up made square to forward; side = up x forward.
      let ux = -fx * fy, uy = 1 - fy * fy, uz = -fz * fy;
      length = Math.hypot(ux, uy, uz) || 1;
      ux /= length; uy /= length; uz /= length;
      const f = i * 12;
      frames[f] = px; frames[f + 1] = py; frames[f + 2] = pz;
      frames[f + 3] = uy * fz - uz * fy;
      frames[f + 4] = uz * fx - ux * fz;
      frames[f + 5] = ux * fy - uy * fx;
      frames[f + 6] = ux; frames[f + 7] = uy; frames[f + 8] = uz;
      frames[f + 9] = fx; frames[f + 10] = fy; frames[f + 11] = fz;
    }
    // Snout origin and head frame for the eyes and tongue.
    const [side, up, forward, position] = this.vectors;
    this.head.matrix.makeBasis(side.fromArray(frames, 3), up.fromArray(frames, 6), forward.fromArray(frames, 9))
      .setPosition(position.fromArray(frames, 0));
    this.head.matrixWorldNeedsUpdate = true;
  }

  #pose() {
    this.#poseSpine();
    this.#buildFrames();
    const { stations, rings } = this.body;
    const { chest, tail } = this.rings;
    const moving = Math.min(1, this.speed / this.settings.speed);
    // Breathing in the chest, a faint ripple of muscle while it crawls.
    const breath = 0.022 * Math.sin(this.time * 1.3 * this.tempo);
    const ripple = moving * 0.012;
    const rippleWave = 4.5 / this.size, rippleSpeed = 6 * this.tempo;
    for (let i = 0; i < rings; i += 1) {
      this.girth[i] = 1 + chest[i] * breath
        + (ripple > 0.0005 ? ripple * Math.sin(stations[i] * rippleWave - this.time * rippleSpeed) : 0);
    }
    // A lazy flick of the tail tip while it lies still.
    const sway = Math.sin(this.time * 1.7 * this.tempo) * 0.12 * this.size * (1 - moving);
    if (Math.abs(sway) > 0.001) {
      for (let i = rings - 1; i >= 0 && tail[i] > 0; i -= 1) {
        const f = i * 12;
        this.frames[f] += this.frames[f + 3] * tail[i] * sway;
        this.frames[f + 2] += this.frames[f + 5] * tail[i] * sway;
      }
    }
    if (this.flare) {
      const spread = (this.settings.hood.spread - 1) * this.hood;
      const { hood } = this.rings;
      for (let i = 0; i < rings; i += 1) this.flare[i] = 1 + hood[i] * spread;
    }
    deformSerpentGeometry(this.body, this.frames, this.girth, this.flare);
    this.#updateBounds();
  }

  #updateBounds() {
    const { frames } = this;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let f = 0; f < frames.length; f += 12) {
      minX = Math.min(minX, frames[f]); maxX = Math.max(maxX, frames[f]);
      minY = Math.min(minY, frames[f + 1]); maxY = Math.max(maxY, frames[f + 1]);
      minZ = Math.min(minZ, frames[f + 2]); maxZ = Math.max(maxZ, frames[f + 2]);
    }
    const sphere = this.body.geometry.boundingSphere;
    sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + this.shape.radius * 1.2;
  }

  // While it is not posed, keep a rough sphere on the moving body so the
  // distance and frustum tests still find it.
  #trackBounds() {
    const sphere = this.body.geometry.boundingSphere;
    const half = this.shape.length * 0.5;
    this.trail.sample(half, this.point);
    sphere.center.set(this.point.x, this.terrain.sampleHeight(this.point.x, this.point.z), this.point.z);
    sphere.radius = half + this.settings.headLift + this.shape.radius * 2;
  }

  #inView(camera) {
    const sphere = this.body.geometry.boundingSphere;
    const distance = camera.position.distanceTo(sphere.center) - sphere.radius;
    if (distance > this.settings.maxDistance) return { visible: false, distance };
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    // Padded so a body just off screen still casts its shadow into view.
    this.sphere.copy(sphere);
    this.sphere.radius += 8 * this.size;
    return { visible: this.frustum.intersectsSphere(this.sphere), distance };
  }

  update(deltaSeconds, camera, playerPosition = null) {
    if (!this.enabled || this.disposed) return;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.time += dt;
    this.frame += 1;
    if (!this.trunks && this.#loadTrunks()) {
      // The trunks arrive with the jungle; re-lay the body clear of them
      // unless someone is already watching it.
      const sphere = this.body.geometry.boundingSphere;
      if (!camera || camera.position.distanceTo(sphere.center) > sphere.radius + 40 * this.size) this.#spawn();
    }
    this.#think(dt, playerPosition);
    this.#steer(dt);
    this.#move(dt, this.speed);
    this.#updateTongue(dt);
    const ready = !this.jungle || this.jungle.ready;
    const view = camera ? this.#inView(camera) : { visible: true, distance: 0 };
    const show = ready && view.distance <= this.settings.maxDistance;
    this.root.visible = show;
    if (!show || !view.visible) {
      this.stale = true;
      this.#trackBounds();
      return;
    }
    const every = view.distance > NEAR_UPDATE_DISTANCE * this.size ? 3
      : view.distance > CLOSE_UPDATE_DISTANCE * this.size ? 2 : 1;
    if (!this.stale && this.frame % every !== 0) return;
    this.stale = false;
    this.#pose();
  }

  /** Its body as [x, z] points from the snout to the tail tip, for the map. */
  minimapPath(count = 32) {
    if (!this.enabled) return null;
    const path = [];
    for (let index = 0; index < count; index += 1) {
      this.trail.sample((index / (count - 1)) * this.shape.length, this.point);
      path.push([this.point.x, this.point.z]);
    }
    return path;
  }

  /** Where the head is, for teleports and debugging. */
  get headPosition() {
    if (!this.enabled) return null;
    return new THREE.Vector3().fromArray(this.frames, 0);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.enabled) return;
    // The skin textures belong to the SerpentSystem.
    this.root.removeFromParent();
    this.body.geometry.dispose();
    this.eyeGeometry.dispose();
    this.tongueGeometry.dispose();
    this.skinMaterial.dispose();
    this.eyeMaterial.dispose();
    this.tongueMaterial.dispose();
  }
}
