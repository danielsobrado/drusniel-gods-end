import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../core/math.js';
import { coastX, resolveCoastConfig } from '../world/CoastField.js';
import { InstancedLodSet } from '../world/InstancedLodSet.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';
import { colored, matrixFor, plantMaterial, ribbon } from './LakeFlora.js';

// Algae in the shallows off the beach: clusters on the sandy floor, from just
// past the swash out to a few metres of water, each kept below the surface
// and swaying with the water's clock. Three kinds: a bright seagrass meadow,
// taller olive-brown kelp ribbons, and short bushy red-brown tufts.
const SEED = 77103;
const CLUSTERS = 320;
const NEAR = 30;
const FAR = 75;

function seagrass(blades, segments, random) {
  const parts = [];
  for (let i = 0; i < blades; i += 1) {
    const blade = ribbon(0.03, segments, (random() - 0.5) * 0.6, (random() - 0.5) * 0.8);
    blade.scale(1, 0.7 + random() * 0.3, 1);
    blade.rotateY((i / blades) * Math.PI * 2 + random() * 0.5);
    blade.translate((random() - 0.5) * 0.15, 0, (random() - 0.5) * 0.15);
    parts.push(colored(blade, { base: '#2d5a1f', top: '#86ad3c' }));
  }
  return mergeGeometries(parts);
}

function kelp(fronds, segments, random) {
  const parts = [];
  for (let i = 0; i < fronds; i += 1) {
    const frond = ribbon(0.085, segments, (random() - 0.5) * 0.9, (random() - 0.5) * 2.2);
    frond.scale(1, 0.8 + random() * 0.2, 1);
    frond.rotateY((i / fronds) * Math.PI * 2 + random() * 0.8);
    parts.push(colored(frond, { base: '#3f3a18', top: '#8f7c30' }));
  }
  return mergeGeometries(parts);
}

// Short branching tuft: a few ribbons fanning out from the base.
function tuft(branches, segments, random) {
  const parts = [];
  for (let i = 0; i < branches; i += 1) {
    const branch = ribbon(0.045, segments, 0.12 + random() * 0.25, (random() - 0.5) * 1.5);
    branch.scale(1, 0.7 + random() * 0.3, 1);
    branch.rotateZ((random() - 0.5) * 0.5);
    branch.rotateY((i / branches) * Math.PI * 2 + random() * 0.6);
    parts.push(colored(branch, { base: '#5a241d', top: '#b0583a' }));
  }
  return mergeGeometries(parts);
}

function place(terrain, sea, random) {
  const records = [[], [], []];
  let clusters = 0;
  for (let attempt = 0; attempt < CLUSTERS * 25 && clusters < CLUSTERS; attempt += 1) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 10, terrain.bounds.max.z - 10, random());
    // Seaward of the shoreline: the sea lies at x greater than coastX.
    const x = coastX(z, sea) + 4 + random() * 70;
    if (x > terrain.bounds.max.x - 2) continue;
    const depth = sea.level - terrain.sampleHeight(x, z);
    if (!(depth > 0.8 && depth < 6)) continue;
    clusters += 1;
    // Seagrass in the shallowest water, kelp deeper, tufts scattered through.
    const kind = depth < 2 ? (random() < 0.75 ? 0 : 2) : (random() < 0.65 ? 1 : 2);
    const radius = 1.5 + random() * 4;
    const members = 6 + Math.floor(random() * 16);
    for (let m = 0; m < members; m += 1) {
      const angle = random() * Math.PI * 2;
      const r = radius * Math.sqrt(random());
      const px = x + Math.cos(angle) * r, pz = z + Math.sin(angle) * r;
      const y = terrain.sampleHeight(px, pz);
      const water = sea.level - y;
      if (!(water > 0.6)) continue;
      const species = random() < 0.85 ? kind : Math.floor(random() * 3);
      const tall = species === 1 ? 1.8 : species === 0 ? 0.8 : 0.45;
      // Breaking waves near the beach are under a metre, so tips stay 0.45 m down.
      const height = Math.min(water - 0.45, tall * (0.6 + random() * 0.6));
      if (height < 0.25) continue;
      const width = species === 1 ? 1 + random() * 0.5 : 1.1 + random() * 0.6;
      const position = new THREE.Vector3(px, y - 0.04, pz);
      records[species].push({ position, phase: random(), matrix: matrixFor(position, random() * Math.PI * 2, [width, height, width], random() * 0.12, random() * 6.28) });
    }
  }
  return records;
}

export class SeaAlgae {
  constructor({ scene, terrain, config, timeNode }) {
    this.sets = [];
    if (!config.water?.sea?.enabled || !terrain?.bounds || !timeNode) return;
    const sea = resolveCoastConfig(config.water.sea);
    const random = createSeededRandom(SEED);
    const records = place(terrain, sea, random);
    const kinds = [
      ['Sea grass', seagrass(8, 5, random), seagrass(4, 2, random), 0.18],
      ['Kelp', kelp(5, 7, random), kelp(3, 3, random), 0.3],
      ['Red algae', tuft(11, 4, random), tuft(5, 2, random), 0.1],
    ];
    kinds.forEach(([name, near, far, sway], index) => {
      if (!records[index].length) return;
      this.sets.push(new InstancedLodSet({
        scene, name, records: records[index], material: plantMaterial(timeNode, sway),
        levels: [{ geometry: near, maxDistance: NEAR }, { geometry: far, maxDistance: FAR }],
        attributes: { floraPhase: { itemSize: 1, read: (record, out) => { out[0] = record.phase; } } },
        renderOrder: DRAW_ORDER.foliage,
      }));
    });
    this.counts = records.map(list => list.length);
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
  }
}
