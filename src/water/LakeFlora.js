import * as THREE from 'three/webgpu';
import { attribute, cos, float, positionLocal, sin, vec2, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../core/math.js';
import { lakeSignedDistance, resolveLakeShape } from '../world/LakeShape.js';
import { InstancedLodSet } from '../world/InstancedLodSet.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';

// Lake plants, all procedural and instanced, two levels of detail each:
// - three rooted underwater species in clusters on the carved bed: eelgrass
//   ribbons, whorled waterweed stalks and broad-leaved pondweed, each kept
//   below the surface and swaying slowly;
// - floating lily pads, some flowering, in sheltered clusters on the shallow
//   shelf, riding the lake surface's own broad waves so they never clip it.
const SEED = 58213;
const LEVELS = Object.freeze({ underwaterNear: 32, underwaterFar: 80, padNear: 45, padFar: 140 });
const UNDERWATER_CLUSTERS = 90;
const PAD_CLUSTERS = 48;

// Per-vertex colour for merged pieces, so one material serves every part.
export function colored(geometry, color) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
  const colors = new Float32Array(g.attributes.position.count * 3);
  const top = new THREE.Color(color.top ?? color);
  const base = new THREE.Color(color.base ?? color);
  const scratch = new THREE.Color();
  for (let i = 0; i < g.attributes.position.count; i += 1) {
    scratch.copy(base).lerp(top, THREE.MathUtils.clamp(g.attributes.position.getY(i), 0, 1));
    colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// A bent ribbon one unit tall: `segments` quads, narrowing to the tip.
export function ribbon(width, segments, lean, twist) {
  const positions = [];
  const point = (t, side) => {
    const bend = lean * t * t;
    const w = width * (1 - t * 0.7) * side;
    const angle = twist * t;
    return [Math.cos(angle) * w + bend, t, Math.sin(angle) * w];
  };
  for (let s = 0; s < segments; s += 1) {
    const a = s / segments, b = (s + 1) / segments;
    const [p0, p1, p2, p3] = [point(a, -1), point(a, 1), point(b, -1), point(b, 1)];
    positions.push(...p0, ...p1, ...p2, ...p2, ...p1, ...p3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function eelgrass(blades, segments, random) {
  const parts = [];
  for (let i = 0; i < blades; i += 1) {
    const blade = ribbon(0.035, segments, (random() - 0.5) * 0.5, (random() - 0.5) * 1.2);
    blade.scale(1, 0.75 + random() * 0.25, 1);
    blade.rotateY((i / blades) * Math.PI * 2 + random() * 0.6);
    blade.translate((random() - 0.5) * 0.12, 0, (random() - 0.5) * 0.12);
    parts.push(colored(blade, { base: '#2f4a1c', top: '#7f9a3a' }));
  }
  return mergeGeometries(parts);
}

// A thin stalk with whorls of needle leaves (hornwort, milfoil).
function waterweed(whorls, leaves) {
  const parts = [];
  const stalk = new THREE.CylinderGeometry(0.012, 0.018, 1, 4, 1, true);
  stalk.translate(0, 0.5, 0);
  parts.push(colored(stalk, { base: '#35491f', top: '#56702c' }));
  for (let w = 0; w < whorls; w += 1) {
    const y = 0.12 + (w / whorls) * 0.85;
    const length = 0.26 * (1 - (w / whorls) * 0.45);
    for (let l = 0; l < leaves; l += 1) {
      const angle = (l / leaves) * Math.PI * 2 + w * 0.5;
      const leaf = new THREE.BufferGeometry();
      const tip = [Math.cos(angle) * length, y + 0.07, Math.sin(angle) * length];
      const side = [Math.cos(angle + 1.57) * 0.02, 0, Math.sin(angle + 1.57) * 0.02];
      leaf.setAttribute('position', new THREE.Float32BufferAttribute([
        side[0], y, side[2], -side[0], y, -side[2], ...tip], 3));
      leaf.computeVertexNormals();
      parts.push(colored(leaf, { base: '#3d5a22', top: '#6f8f35' }));
    }
  }
  return mergeGeometries(parts);
}

// A stem with a few broad oval leaves held at angles (pondweed).
function pondweed(leafCount, leafSegments, random) {
  const parts = [];
  const stem = new THREE.CylinderGeometry(0.01, 0.015, 1, 4, 1, true);
  stem.translate(0, 0.5, 0);
  parts.push(colored(stem, { base: '#3b4a1d', top: '#5b6b28' }));
  for (let i = 0; i < leafCount; i += 1) {
    const y = 0.35 + (i / leafCount) * 0.6;
    const leaf = new THREE.CircleGeometry(0.17, leafSegments);
    leaf.scale(1, 0.42, 1);
    leaf.rotateX(-Math.PI / 2 + 0.5 + random() * 0.4);
    leaf.translate(0, 0, 0.1);
    leaf.rotateY((i / leafCount) * Math.PI * 2 + random() * 0.8);
    leaf.translate(0, y, 0);
    parts.push(colored(leaf, { base: '#4a6326', top: '#5f7a2c' }));
  }
  return mergeGeometries(parts);
}

// A notched pad lying flat at y = 0, radius 1.
function lilyPad(segments) {
  const shape = new THREE.Shape();
  const notch = 0.35;
  shape.moveTo(0, 0);
  for (let i = 0; i <= segments; i += 1) {
    const angle = notch / 2 + (i / segments) * (Math.PI * 2 - notch);
    shape.lineTo(Math.cos(angle), Math.sin(angle));
  }
  shape.lineTo(0, 0);
  const pad = new THREE.ShapeGeometry(shape, 1);
  pad.rotateX(-Math.PI / 2);
  return colored(pad, { base: '#2e5a1e', top: '#2e5a1e' });
}

function flower(petals) {
  const parts = [];
  for (let ring = 0; ring < 2; ring += 1) {
    for (let p = 0; p < petals; p += 1) {
      const angle = (p / petals) * Math.PI * 2 + ring * (Math.PI / petals);
      const length = ring ? 0.3 : 0.42;
      const petal = new THREE.BufferGeometry();
      const lift = ring ? 0.26 : 0.13;
      petal.setAttribute('position', new THREE.Float32BufferAttribute([
        Math.cos(angle + 0.25) * 0.05, 0.04, Math.sin(angle + 0.25) * 0.05,
        Math.cos(angle - 0.25) * 0.05, 0.04, Math.sin(angle - 0.25) * 0.05,
        Math.cos(angle) * length, 0.04 + lift, Math.sin(angle) * length], 3));
      petal.computeVertexNormals();
      parts.push(colored(petal, ring ? '#f7e9ef' : '#f2c9d8'));
    }
  }
  const heart = new THREE.ConeGeometry(0.05, 0.08, 5);
  heart.translate(0, 0.08, 0);
  parts.push(colored(heart, '#e8c33a'));
  return mergeGeometries(parts);
}

export function plantMaterial(timeNode, swayAmount) {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 });
  // Slow sway, stronger toward the tip; each plant has its own phase.
  const phase = attribute('floraPhase', 'float');
  const height = positionLocal.y.max(0);
  const wave = timeNode.mul(0.9).add(phase.mul(6.283)).add(height.mul(1.4));
  const reach = height.mul(height).mul(swayAmount);
  material.positionNode = positionLocal.add(vec3(sin(wave).mul(reach), 0, cos(wave.mul(0.8)).mul(reach.mul(0.7))));
  return material;
}

// The lake surface's broad waves (WaterMaterial), so pads ride the water.
function padMaterial(timeNode, waterOrigin) {
  // Drawn after the water (see LakeFlora): transparent-list draws at full
  // opacity that still write depth.
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, transparent: true, depthWrite: true,
  });
  const origin = attribute('floraOrigin', 'vec2').sub(vec2(waterOrigin[0], waterOrigin[2]));
  const t = timeNode;
  const rise = sin(origin.x.mul(0.27).add(origin.y.mul(0.11)).sub(t.mul(0.72))).mul(0.065)
    .add(sin(origin.x.mul(-0.14).add(origin.y.mul(0.31)).sub(t.mul(0.49))).mul(0.035));
  material.positionNode = positionLocal.add(vec3(0, rise.div(attribute('floraScale', 'float').max(float(0.01))), 0));
  return material;
}

export function matrixFor(position, yaw, scale, tilt = 0, tiltAxis = 0) {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    Math.cos(tiltAxis) * tilt, yaw, Math.sin(tiltAxis) * tilt, 'YXZ'));
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(...scale));
}

function placeUnderwater(lake, terrain, random) {
  const records = [[], [], []];
  const { minX, minZ, maxX, maxZ } = lake.bounds;
  let clusters = 0;
  for (let attempt = 0; attempt < UNDERWATER_CLUSTERS * 20 && clusters < UNDERWATER_CLUSTERS; attempt += 1) {
    const cx = THREE.MathUtils.lerp(minX, maxX, random());
    const cz = THREE.MathUtils.lerp(minZ, maxZ, random());
    if (lakeSignedDistance(cx, cz, lake) > -2) continue;
    const bed = terrain.sampleHeight(cx, cz);
    const depth = lake.level - bed;
    if (!(depth > 0.7 && depth < 7)) continue;
    clusters += 1;
    // Eelgrass on the shallow shelf, waterweed in deeper water, pondweed between.
    const species = depth < 2.2 ? (random() < 0.7 ? 0 : 2) : depth < 4.5 ? (random() < 0.5 ? 2 : 1) : 1;
    const radius = 1.5 + random() * 4.5;
    const members = 6 + Math.floor(random() * 18);
    for (let m = 0; m < members; m += 1) {
      const angle = random() * Math.PI * 2;
      const r = radius * Math.sqrt(random());
      const x = cx + Math.cos(angle) * r, z = cz + Math.sin(angle) * r;
      if (lakeSignedDistance(x, z, lake) > -1) continue;
      const y = terrain.sampleHeight(x, z);
      const water = lake.level - y;
      if (!(water > 0.5)) continue;
      const kind = random() < 0.8 ? species : Math.floor(random() * 3);
      // Taller toward the cluster's middle; tips stay under the surface.
      const centre = 1 - r / radius;
      const height = Math.min(water - 0.25, (kind === 0 ? 1.1 : kind === 1 ? 1.6 : 0.9) * (0.55 + centre * 0.6 + random() * 0.35));
      if (height < 0.3) continue;
      const width = kind === 0 ? 1.2 + random() * 0.6 : 0.9 + random() * 0.4;
      const position = new THREE.Vector3(x, y - 0.05, z);
      records[kind].push({ position, phase: random(), matrix: matrixFor(position, random() * Math.PI * 2, [width, height, width], random() * 0.15, random() * 6.28) });
    }
  }
  return records;
}

function placePads(lake, terrain, random) {
  const records = [[], []];
  const { minX, minZ, maxX, maxZ } = lake.bounds;
  let clusters = 0;
  for (let attempt = 0; attempt < PAD_CLUSTERS * 40 && clusters < PAD_CLUSTERS; attempt += 1) {
    const cx = THREE.MathUtils.lerp(minX, maxX, random());
    const cz = THREE.MathUtils.lerp(minZ, maxZ, random());
    const shore = lakeSignedDistance(cx, cz, lake);
    // Sheltered shallows along the shore, not the open middle.
    if (!(shore < -2 && shore > -16)) continue;
    if (!(lake.level - terrain.sampleHeight(cx, cz) > 0.4)) continue;
    clusters += 1;
    const radius = 1.5 + random() * 3;
    const members = 5 + Math.floor(random() * 12);
    const placed = [];
    for (let m = 0; m < members * 3 && placed.length < members; m += 1) {
      const angle = random() * Math.PI * 2;
      const r = radius * Math.sqrt(random());
      const x = cx + Math.cos(angle) * r, z = cz + Math.sin(angle) * r;
      const size = 0.28 + random() * 0.4;
      if (placed.some(p => Math.hypot(p.x - x, p.z - z) < (p.size + size) * 0.85)) continue;
      if (lakeSignedDistance(x, z, lake) > -1 || !(lake.level - terrain.sampleHeight(x, z) > 0.3)) continue;
      placed.push({ x, z, size });
      const position = new THREE.Vector3(x, lake.level + 0.025, z);
      const flowering = random() < 0.18 ? 1 : 0;
      records[flowering].push({ position, size, matrix: matrixFor(position, random() * Math.PI * 2, [size, size, size]) });
    }
  }
  return records;
}

export class LakeFlora {
  constructor({ scene, terrain, config, timeNode }) {
    this.sets = [];
    const lake = resolveLakeShape(config);
    if (!lake || !terrain || !timeNode) return;
    const random = createSeededRandom(SEED);
    const underwater = placeUnderwater(lake, terrain, random);
    const shapes = [
      [eelgrass(7, 5, random), eelgrass(3, 2, random), 0.16],
      [waterweed(9, 8), waterweed(5, 5), 0.1],
      [pondweed(5, 8, random), pondweed(3, 5, random), 0.08],
    ];
    const names = ['Lake eelgrass', 'Lake waterweed', 'Lake pondweed'];
    shapes.forEach(([near, far, sway], kind) => {
      if (!underwater[kind].length) return;
      this.sets.push(new InstancedLodSet({
        scene, name: names[kind], records: underwater[kind], material: plantMaterial(timeNode, sway),
        levels: [{ geometry: near, maxDistance: LEVELS.underwaterNear }, { geometry: far, maxDistance: LEVELS.underwaterFar }],
        attributes: { floraPhase: { itemSize: 1, read: (record, out) => { out[0] = record.phase; } } },
        renderOrder: DRAW_ORDER.foliage,
      }));
    });
    const pads = placePads(lake, terrain, random);
    const waterOrigin = config.water.position;
    const padAttributes = {
      floraOrigin: { itemSize: 2, read: (record, out) => { out[0] = record.position.x; out[1] = record.position.z; } },
      floraScale: { itemSize: 1, read: (record, out) => { out[0] = record.size; } },
    };
    // Pads draw after the water, which writes no depth, so the surface's
    // ripples and foam can never cover them; terrain in front still does.
    // Transparent draws sort by their group's renderOrder first, and the
    // water tiles sit in a group with renderOrder 1.
    this.padGroup = new THREE.Group();
    this.padGroup.name = 'Floating lake plants';
    this.padGroup.renderOrder = 3;
    scene.add(this.padGroup);
    const padNear = lilyPad(18), padFar = lilyPad(7);
    const flowerNear = mergeGeometries([padNear, flower(8)]);
    const flowerFar = mergeGeometries([padFar, flower(4)]);
    [[pads[0], padNear, padFar, 'Lily pads'], [pads[1], flowerNear, flowerFar, 'Flowering lily pads']]
      .forEach(([records, near, far, name]) => {
        if (!records.length) return;
        this.sets.push(new InstancedLodSet({
          scene, parent: this.padGroup, name, records, material: padMaterial(timeNode, waterOrigin), attributes: padAttributes,
          levels: [{ geometry: near, maxDistance: LEVELS.padNear }, { geometry: far, maxDistance: LEVELS.padFar }],
          renderOrder: DRAW_ORDER.foliage,
        }));
      });
    this.counts = { underwater: underwater.map(list => list.length), pads: pads.map(list => list.length) };
  }

  update(camera) {
    for (const set of this.sets) set.update(camera);
  }

  dispose() {
    for (const set of this.sets) {
      set.meshes[0]?.material.dispose();
      set.dispose();
    }
    this.sets.length = 0;
    this.padGroup?.removeFromParent();
  }
}
