import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, mix, normalWorld, positionWorld } from 'three/tsl';
import { createSeededRandom } from '../core/math.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';
import { coastX, resolveCoastConfig } from '../world/CoastField.js';
import { InstancedLodSet } from '../world/InstancedLodSet.js';
import { noise2 } from '../world/snowNoiseNodes.js';

// Boulders on the sandy floor of the shallows: rounded, sea-worn stones in
// loose clusters, their tops furred with green weed and their flanks bare
// grey-brown rock. They give the clear water something to look down on from
// the beach and a sense of depth to a dive over the reefs.
const SEED = 61241;
const CLUSTERS = 340;
const VARIANTS = 3;
const NEAR = 55;
const FAR = 170;
// Depth range (metres of water) the clusters stand in.
const MIN_DEPTH = 1.2;
const MAX_DEPTH = 11;
const COLLIDER_SIZE = 1.1;

// Smooth 3D value noise on a hashed lattice, for the stone shapes.
function valueNoise3(random) {
  const table = Array.from({ length: 256 }, () => random() * 2 - 1);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const at = (x, y, z) => table[perm[(perm[(perm[x & 255] + y) & 255] + z) & 255]];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
    const lerp = THREE.MathUtils.lerp;
    const plane = (k) => lerp(
      lerp(at(ix, iy, iz + k), at(ix + 1, iy, iz + k), fx),
      lerp(at(ix, iy + 1, iz + k), at(ix + 1, iy + 1, iz + k), fx),
      fy,
    );
    return lerp(plane(0), plane(1), fz);
  };
}

function boulder(detail, random) {
  const noise = valueNoise3(random);
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, detail).deleteAttribute('normal').deleteAttribute('uv'));
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  const squash = 0.5 + random() * 0.25;
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i);
    const radius = 1 + noise(v.x * 1.6 + 3, v.y * 1.6, v.z * 1.6) * 0.28
      + noise(v.x * 4.1, v.y * 4.1 + 7, v.z * 4.1) * 0.08;
    v.multiplyScalar(radius);
    v.y *= squash;
    // Settled into the sand: a flattened underside.
    v.y = Math.max(v.y, -0.18);
    position.setXYZ(i, v.x, v.y + 0.12, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function rockMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  material.name = 'Seabed boulders';
  const tint = attribute('rockTint', 'float');
  const mottle = noise2(positionWorld.xz.mul(1.3).add(positionWorld.y.mul(0.7))).mul(0.5).add(0.5);
  const rock = mix(color('#5d584e'), color('#7d7565'), mottle).mul(tint.mul(0.35).add(0.8));
  // Weed on the faces that look up to the light, patchy at its edge.
  const weed = normalWorld.y.add(mottle.sub(0.5).mul(0.6)).smoothstep(0.15, 0.55);
  const weedColor = mix(color('#3f5a24'), color('#6f8d3a'), mottle.mul(tint));
  material.colorNode = mix(rock, weedColor, weed);
  return material;
}

function place(terrain, sea, random) {
  const records = Array.from({ length: VARIANTS }, () => []);
  const minZ = terrain.bounds.min.z + 10, maxZ = terrain.bounds.max.z - 10;
  let clusters = 0;
  for (let attempt = 0; attempt < CLUSTERS * 30 && clusters < CLUSTERS; attempt += 1) {
    const z = THREE.MathUtils.lerp(minZ, maxZ, random());
    const x = coastX(z, sea) + 8 + random() ** 1.4 * 130;
    if (x > terrain.bounds.max.x - 4) continue;
    const depth = sea.level - terrain.sampleHeight(x, z);
    if (!(depth > MIN_DEPTH && depth < MAX_DEPTH)) continue;
    if ((terrain.river?.sample(x, z)?.edge ?? Infinity) < 6) continue;
    clusters += 1;
    const radius = 2 + random() * 7;
    const members = 2 + Math.floor(random() ** 1.5 * 12);
    for (let m = 0; m < members; m += 1) {
      const angle = random() * Math.PI * 2;
      const r = radius * Math.sqrt(random());
      const px = x + Math.cos(angle) * r, pz = z + Math.sin(angle) * r;
      const y = terrain.sampleHeight(px, pz);
      const water = sea.level - y;
      // Stones stay under the surface and clear of the swash.
      if (!(water > 0.9)) continue;
      const size = Math.min(water * 0.55, 0.25 + random() ** 2.2 * 2.1);
      if (size < 0.2) continue;
      const position = new THREE.Vector3(px, y - size * 0.08, pz);
      const scale = new THREE.Vector3(size * (0.8 + random() * 0.5), size, size * (0.8 + random() * 0.5));
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (random() - 0.5) * 0.3, random() * Math.PI * 2, (random() - 0.5) * 0.3, 'YXZ'));
      records[Math.floor(random() * VARIANTS)].push({
        position,
        size,
        tint: random(),
        matrix: new THREE.Matrix4().compose(position, quaternion, scale),
      });
    }
  }
  return records;
}

export class SeabedRocks {
  constructor({ scene, terrain, config, collisions = null }) {
    this.sets = [];
    this.material = null;
    if (!config.water?.sea?.enabled || !config.terrain?.expansion?.enabled || !terrain?.bounds) return;
    const sea = resolveCoastConfig(config.water.sea);
    const random = createSeededRandom(SEED);
    const records = place(terrain, sea, random);
    this.material = rockMaterial();
    records.forEach((list, variant) => {
      if (!list.length) return;
      const near = boulder(2, createSeededRandom(SEED + variant * 17));
      const far = boulder(1, createSeededRandom(SEED + variant * 17));
      this.sets.push(new InstancedLodSet({
        scene,
        name: `Seabed boulders ${variant + 1}`,
        records: list,
        material: this.material,
        levels: [{ geometry: near, maxDistance: NEAR }, { geometry: far, maxDistance: FAR }],
        attributes: { rockTint: { itemSize: 1, read: (record, out) => { out[0] = record.tint; } } },
        renderOrder: DRAW_ORDER.props,
        rebucketDistance: 8,
      }));
      near.dispose();
      far.dispose();
    });
    if (collisions) {
      for (const record of records.flat()) {
        if (record.size < COLLIDER_SIZE) continue;
        collisions.addBox(
          record.position.clone().setY(record.position.y + record.size * 0.35),
          new THREE.Vector3(record.size * 1.4, record.size * 0.7, record.size * 1.4),
          { cameraTransparent: true },
        );
      }
    }
    this.counts = records.map((list) => list.length);
  }

  update(camera) {
    for (const set of this.sets) set.update(camera);
  }

  dispose() {
    for (const set of this.sets) set.dispose();
    this.sets.length = 0;
    this.material?.dispose();
  }
}
