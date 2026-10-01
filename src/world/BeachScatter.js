import * as THREE from 'three/webgpu';
import { color, float, hash, instanceIndex, mix, normalWorld, positionWorld } from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { getSurfaceDetail } from '../rendering/surfaceDetail.js';
import { noise2 } from './snowNoiseNodes.js';
import { createSeededRandom } from '../core/math.js';
import { coastX, resolveCoastConfig, sampleCoastField } from './CoastField.js';
import { DRAW_ORDER } from '../rendering/drawOrder.js';
import { adoptInstanceMatrices } from '../rendering/instanceMatrices.js';

const SHAPE_SCALE = Object.freeze({
  pebble: [1, 0.34, 0.72],
  shell: [1, 0.2, 0.88],
  cliffRockYMin: 0.45,
  cliffRockYMax: 0.72,
  cliffRockXZMin: 0.78,
  cliffRockXZMax: 1.28,
});

function sampleSurfaceNormal(terrain, x, z, target) {
  return target.set(
    terrain.sampleHeight(x - 0.2, z) - terrain.sampleHeight(x + 0.2, z),
    0.4,
    terrain.sampleHeight(x, z - 0.2) - terrain.sampleHeight(x, z + 0.2),
  ).normalize();
}

function createDriftwoodGeometry(params) {
  const bend = params.twigBend;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(-0.35, bend, 0.08),
    new THREE.Vector3(0.35, -bend * 0.35, -0.06),
    new THREE.Vector3(1, bend * 0.4, 0),
  ]);
  const geometry = new THREE.TubeGeometry(curve, 4, params.twigRadius, 5, false);
  geometry.translate(0, params.twigRadius * 0.35, 0);
  return geometry;
}

// Smooth-shaded: a subdivided, welded icosahedron reads as a sea-worn stone;
// the flat 20-face one read as a plastic gem.
function roundedStone(detail) {
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, detail).deleteAttribute('normal').deleteAttribute('uv'));
  geometry.computeVertexNormals();
  return geometry;
}

function createScatterGeometries(params, rounded) {
  const pebble = rounded ? roundedStone(1) : new THREE.IcosahedronGeometry(1, 0);
  pebble.translate(0, 0.72, 0);
  const shell = new THREE.SphereGeometry(1, 8, 4);
  shell.translate(0, 0.78, 0);
  const twig = createDriftwoodGeometry(params);
  const cliffRock = new THREE.DodecahedronGeometry(1, 0);
  cliffRock.translate(0, 0.62, 0);
  return [pebble, shell, twig, cliffRock];
}

function addShoreDebris(records, terrain, sea, params, random, normal) {
  for (let i = 0; i < Math.floor(params.attempts); i += 1) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 4, terrain.bounds.max.z - 4, random());
    const inland = THREE.MathUtils.lerp(params.inlandMin, params.inlandMax, random());
    const x = coastX(z, sea) - inland;
    if (x < terrain.bounds.min.x + 2 || x > terrain.bounds.max.x - 2) continue;
    const field = sampleCoastField(x, z, 0, sea);
    const patch = Math.sin(x * params.patchFrequencyX + Math.sin(z * params.patchWarpFrequency))
      * Math.sin(z * params.patchFrequencyZ) * 0.5 + 0.5;
    const clustered = Math.pow(THREE.MathUtils.clamp(patch, 0, 1), params.clusterPower);
    if (random() > field.scatterSuitability * clustered * params.density) continue;
    if (field.waterCoverage > 0.001) continue;
    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y <= sea.level + 0.2) continue;
    sampleSurfaceNormal(terrain, x, z, normal);
    if (normal.y < params.minNormalY) continue;

    const kind = Math.floor(random() * 3);
    const size = THREE.MathUtils.lerp(params.sizeMin, params.sizeMax, random());
    const scale = kind === 0
      ? [size * SHAPE_SCALE.pebble[0], size * SHAPE_SCALE.pebble[1], size * SHAPE_SCALE.pebble[2]]
      : kind === 1
        ? [size * SHAPE_SCALE.shell[0], size * SHAPE_SCALE.shell[1], size * SHAPE_SCALE.shell[2]]
        : [size * params.twigLength, size, size];
    records[kind].push({ x, y, z, normal: normal.clone(), scale, yaw: random() * Math.PI * 2 });
  }
}

function addCliffBaseRocks(records, terrain, sea, params, random, normal) {
  const baseInland = -sea.coast.terrain.beachTop;
  for (let i = 0; i < Math.floor(params.cliffRockAttempts); i += 1) {
    const z = THREE.MathUtils.lerp(terrain.bounds.min.z + 4, terrain.bounds.max.z - 4, random());
    const inland = baseInland + THREE.MathUtils.lerp(-params.cliffRockBand, params.cliffRockBand, random());
    const x = coastX(z, sea) - inland;
    if (x < terrain.bounds.min.x + 2 || x > terrain.bounds.max.x - 2) continue;
    if (random() > params.cliffRockDensity) continue;
    const y = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y) || y <= sea.level + 0.2) continue;
    sampleSurfaceNormal(terrain, x, z, normal);
    if (normal.y < params.cliffRockMinNormalY) continue;

    const size = THREE.MathUtils.lerp(params.cliffRockSizeMin, params.cliffRockSizeMax, random());
    const scaleX = size * THREE.MathUtils.lerp(SHAPE_SCALE.cliffRockXZMin, SHAPE_SCALE.cliffRockXZMax, random());
    const scaleY = size * THREE.MathUtils.lerp(SHAPE_SCALE.cliffRockYMin, SHAPE_SCALE.cliffRockYMax, random());
    const scaleZ = size * THREE.MathUtils.lerp(SHAPE_SCALE.cliffRockXZMin, SHAPE_SCALE.cliffRockXZMax, random());
    records[3].push({
      x, y, z, normal: normal.clone(), scale: [scaleX, scaleY, scaleZ], yaw: random() * Math.PI * 2,
    });
  }
}

// Beach debris shading: each piece its own tone, dusted with sand on its top
// faces, darker and glossier below the wet line the waves reach.
function createScatterMaterial(baseColor, roughness, { sea, detail, sandColor, glossy }) {
  const material = new THREE.MeshStandardNodeMaterial({ color: baseColor, roughness });
  if (!detail?.settings.beachScatter.enabled) return material;
  const settings = detail.settings.beachScatter;
  const tone = hash(instanceIndex.toFloat().add(3.7)).sub(0.5).mul(settings.tone * 2).add(1);
  const base = color(baseColor).mul(tone);
  const dust = normalWorld.y.smoothstep(0.45, 0.9)
    .mul(noise2(positionWorld.xz.mul(6)).smoothstep(-0.3, 0.4)).mul(settings.dust);
  const dusted = mix(base, color(sandColor), dust);
  const wet = positionWorld.y.smoothstep(sea.level + settings.wetHeight * 0.6, sea.level + settings.wetHeight).oneMinus();
  material.colorNode = dusted.mul(wet.mul(0.45).oneMinus());
  material.roughnessNode = mix(float(roughness), float(glossy), wet.mul(dust.oneMinus()));
  return material;
}

export function createBeachScatter(terrain, seaConfig, config = null) {
  const group = new THREE.Group();
  group.name = 'Beach debris';
  if (!seaConfig?.enabled) return group;

  const sea = resolveCoastConfig(seaConfig);
  const params = sea.coast.scatter;
  const random = createSeededRandom(params.seed);
  const records = [[], [], [], []];
  const normal = new THREE.Vector3();

  addShoreDebris(records, terrain, sea, params, random, normal);
  addCliffBaseRocks(records, terrain, sea, params, random, normal);

  const detail = config ? getSurfaceDetail(config) : null;
  const rounded = Boolean(detail?.settings.beachScatter.enabled);
  const geometries = createScatterGeometries(params, rounded);
  const colors = [params.pebbleColor, params.shellColor, params.twigColor, params.cliffRockColor];
  const names = ['Beach pebbles', 'Beach shells', 'Washed driftwood', 'Cliff-base rocks'];
  const object = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);

  records.forEach((items, kind) => {
    const material = rounded
      ? createScatterMaterial(colors[kind], params.roughness, {
        sea, detail, sandColor: sea.coast.sand.dryLight, glossy: kind === 2 ? 0.55 : 0.25,
      })
      : new THREE.MeshStandardMaterial({ color: colors[kind], roughness: params.roughness });
    const mesh = adoptInstanceMatrices(new THREE.InstancedMesh(geometries[kind], material, items.length));
    mesh.name = names[kind];
    mesh.renderOrder = DRAW_ORDER.props;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    items.forEach((item, index) => {
      object.position.set(item.x, item.y, item.z);
      object.quaternion.setFromUnitVectors(up, item.normal);
      object.rotateY(item.yaw);
      object.scale.fromArray(item.scale);
      object.updateMatrix();
      mesh.setMatrixAt(index, object.matrix);
    });
    mesh.computeBoundingSphere();
    group.add(mesh);
  });
  return group;
}

export function disposeBeachScatter(group) {
  group.removeFromParent();
  group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
}
