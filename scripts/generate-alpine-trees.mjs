/** Offline conifers: shared bark/needles/snow, plus the existing two-card LOD. */
import { readFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../src/core/math.js';
import { applyBakedTreeBillboard, TEXTURE_DIRECTORY } from './stylized-tree-textures.mjs';

// Each species is a different age and exposure, not a rescaled copy: the
// proportions, crown profile, branch density and snow load all differ.
// `profile` gives the crown radius at relative crown height h (0 at the lowest
// whorl, 1 at the leader); `wind` is how far boughs lengthen downwind.
export const ALPINE_SPECIES = {
  10: { name: 'Snow spruce', height: 15, trunk: 0.48, crownBase: 1.7, radius: 3.9, whorls: 16, arms: [5, 7],
    profile: h => (1 - h) ** 0.95, droop: 0.34, missing: 0.08, sprays: 3, snow: 0.8, wind: 0,
    needles: [0.05, 0.15, 0.11], lean: y => Math.sin(y * 0.2) * 0.16 },
  // Pine needles grow in tufts at the ends of bare branches, not along them.
  11: { name: 'Windswept mountain pine', height: 12, trunk: 0.5, crownBase: 4.2, radius: 4.2, whorls: 9, arms: [4, 6],
    profile: h => 0.35 + 0.65 * Math.sin(Math.PI * (0.25 + 0.75 * (1 - h))) * (1 - h * 0.45), droop: 0.08, missing: 0.3,
    sprays: 4, snow: 0.55, wind: 0.5, tuft: 0.42, bough: 0.3, needles: [0.09, 0.17, 0.12], lean: y => (y / 12) ** 1.5 * 2 },
  12: { name: 'Young spruce', height: 7.5, trunk: 0.22, crownBase: 0.35, radius: 2.4, whorls: 10, arms: [5, 6],
    profile: h => (1 - h) ** 0.85, droop: 0.22, missing: 0.03, sprays: 2, snow: 1, wind: 0,
    needles: [0.06, 0.17, 0.12], lean: () => 0 },
  13: { name: 'Old storm fir', height: 13, trunk: 0.56, crownBase: 2.6, radius: 2.9, whorls: 9, arms: [3, 5],
    profile: h => 1 - h ** 2.6, droop: 0.42, missing: 0.38, sprays: 3, snow: 0.6, wind: 0.2, deadTop: 2.2,
    needles: [0.045, 0.12, 0.1], lean: y => Math.sin(y * 0.13 + 0.6) * 0.3 - 0.2 },
};
const TYPES = Object.keys(ALPINE_SPECIES).map(Number);
const UP = new THREE.Vector3(0, 1, 0);
const ACROSS = [-1, -0.45, 0, 0.45, 1];

// A bough as a drooping, arched ribbon: a raised spine, edges falling away like
// a spruce spray, the width swelling to a blunt point, and a saw-toothed edge
// so the silhouette breaks up instead of reading as one smooth cushion. `colorAt`
// gives the linear RGB for a point t along the bough and s across it.
function bough({ base, direction, length, width, rise, droop, arch, edgeDrop, jag, random, segments, colorAt, lift = 0, from = 0, to = 1 }) {
  const side = new THREE.Vector3(-direction.z, 0, direction.x);
  const positions = [], colors = [], uvs = [];
  for (let i = 0; i <= segments; i++) {
    const t = from + (to - from) * i / segments;
    const center = base.clone().addScaledVector(direction, length * t)
      .addScaledVector(UP, length * (rise * t - droop * t * t) + lift);
    const w = width * Math.max(0.06, Math.sin(Math.PI * Math.min(1, t ** 0.8)) ** 0.7);
    // Alternate long and short edge teeth; the spine row stays smooth.
    const tooth = i % 2 ? 1 + jag * (0.4 + random() * 0.6) : 1 - jag * 0.5 * random();
    for (const s of ACROSS) {
      const edge = Math.abs(s) === 1;
      const reach = w * s * (edge ? tooth : 1);
      const drop = arch * w * (1 - s * s) - edgeDrop * w * s * s * (edge ? 0.8 + random() * 0.4 : 1);
      const point = center.clone().addScaledVector(side, reach).addScaledVector(UP, drop);
      positions.push(point.x, point.y, point.z);
      colors.push(...colorAt(t, s));
      uvs.push((s + 1) / 2, t);
    }
  }
  const indices = [], columns = ACROSS.length;
  for (let i = 0; i < segments; i++) for (let j = 0; j < columns - 1; j++) {
    const a = i * columns + j, b = a + columns;
    // Winding faces the upper side toward the sky.
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');
  let up = 0;
  for (let i = 0; i < normal.count; i++) up += normal.getY(i);
  if (up < 0) {
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
  }
  return geometry;
}

function solidColor(geometry, rgb) {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: count }, () => rgb).flat(), 3));
  return geometry;
}

function buildConifer(type) {
  const species = ALPINE_SPECIES[type];
  const random = createSeededRandom(type * 837);
  const batches = [[], [], []];
  const add = (kind, geometry) => batches[kind].push(geometry.index ? geometry.toNonIndexed() : geometry);
  const { height, lean } = species;
  const barkColor = [1, 1, 1];
  const wood = (points, radius) => add(0, solidColor(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 6, radius, 5, false), barkColor));

  const trunk = new THREE.CylinderGeometry(species.deadTop ? 0.05 : 0.07, species.trunk, height, 9, 16).translate(0, height / 2, 0);
  const tp = trunk.getAttribute('position');
  for (let i = 0; i < tp.count; i++) tp.setX(i, tp.getX(i) + lean(tp.getY(i)));
  trunk.computeVertexNormals();
  add(0, solidColor(trunk, barkColor));
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + random() * 0.3;
    const reach = species.trunk * (2.2 + random() * 0.8);
    wood([new THREE.Vector3(0, species.trunk * 1.35, 0), new THREE.Vector3(Math.cos(a) * reach * 0.5, 0.12, Math.sin(a) * reach * 0.5),
      new THREE.Vector3(Math.cos(a) * reach, -0.12, Math.sin(a) * reach)], species.trunk * 0.27);
  }

  const needleColor = (shade, t, s) => {
    // Old growth near the trunk is dark; the fresh tips are lighter and
    // yellower, and the lowered edges sit in the bough's own shade.
    const [r, g, b] = species.needles;
    const light = shade * (0.6 + 0.55 * t ** 1.3) * (1 - 0.18 * s * s);
    return [r * light * (1 + 0.25 * t), g * light, b * light * (1 - 0.15 * t)];
  };
  const snowColor = (t, s) => {
    const edge = s * s;
    // Snow thins to a bluer rind at its edges and under its own lip.
    return [0.86 - edge * 0.12, 0.92 - edge * 0.07, 0.98 - edge * 0.02];
  };

  const addBough = ({ base, angle, length, width, rise, droop, shade, snowy, sprays }) => {
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const tuft = species.tuft ?? 0;
    const common = { base, direction, length, width, rise, droop, arch: 0.22, edgeDrop: 0.5, jag: 0.35, random };
    add(1, bough({ ...common, segments: 7, from: tuft, colorAt: (t, s) => needleColor(shade, t, s) }));
    // The branch itself shows from below.
    const along = t => base.clone().addScaledVector(direction, length * t).addScaledVector(UP, length * (rise * t - droop * t * t) - width * 0.08);
    wood([along(0), along(0.45), along(0.9)], Math.max(0.035, width * 0.045));
    if (snowy) {
      // A lumpy cap over part of the bough, lying on its spine: narrower than
      // the needles so dark edges and tips show beneath it.
      const from = Math.max(tuft + 0.05, 0.12 + random() * 0.18), to = 0.62 + random() * 0.3;
      add(2, bough({ ...common, width: width * (0.62 + random() * 0.2), arch: 0.5, edgeDrop: 0.35, jag: 0.5,
        lift: width * 0.1 + 0.04, segments: 6, from, to, colorAt: snowColor }));
    }
    for (let spray = 0; spray < sprays; spray++) {
      const t = Math.max(tuft, 0.3) + (spray + random() * 0.6) / sprays * (0.8 - Math.max(tuft, 0.3));
      const sideSign = spray % 2 ? 1 : -1;
      const sprayAngle = angle + sideSign * (0.55 + random() * 0.35);
      const sprayBase = along(t).addScaledVector(UP, width * 0.06);
      const sprayLength = length * (0.32 + random() * 0.18) * (1 - t * 0.4);
      const sprayDirection = new THREE.Vector3(Math.cos(sprayAngle), 0, Math.sin(sprayAngle));
      add(1, bough({ base: sprayBase, direction: sprayDirection, length: sprayLength, width: width * 0.5, rise: rise * 0.5,
        droop: droop * 1.2, arch: 0.2, edgeDrop: 0.5, jag: 0.4, random, segments: 4,
        colorAt: (tt, s) => needleColor(shade * 0.95, 0.35 + tt * 0.65, s) }));
    }
  };

  const top = height - (species.deadTop ?? 0);
  const crown = top - species.crownBase - 0.8;
  for (let whorl = 0; whorl < species.whorls; whorl++) {
    const h = whorl / (species.whorls - 1);
    const y = species.crownBase + crown * h ** 1.05 + (random() - 0.5) * 0.35;
    const radius = species.radius * species.profile(h) + 0.5;
    const [low, high] = species.arms;
    const arms = low + Math.floor(random() * (high - low + 1));
    const twist = whorl * 2.4 + random();
    for (let arm = 0; arm < arms; arm++) {
      if (whorl < species.whorls - 2 && random() < species.missing) continue;
      const angle = twist + arm / arms * Math.PI * 2 + (random() - 0.5) * 0.5;
      // Downwind boughs reach further on exposed trees; the wind comes from -x.
      const flag = 1 + species.wind * Math.cos(angle);
      const length = radius * (0.72 + random() * 0.42) * flag;
      addBough({
        base: new THREE.Vector3(lean(y), y, 0),
        angle,
        length,
        width: length * ((species.bough ?? 0.46) + random() * 0.12),
        rise: THREE.MathUtils.lerp(-0.05, 0.3, h),
        droop: species.droop * (1.3 - h),
        // Lower boughs are shaded by the crown above them.
        shade: (0.72 + 0.4 * h) * (0.88 + random() * 0.24),
        snowy: random() < species.snow * (0.55 + 0.45 * (1 - h)),
        sprays: h > 0.85 ? 1 : species.sprays,
      });
    }
    // A short filler bough between whorls keeps the crown from reading as rings.
    if (whorl < species.whorls - 1 && random() < 0.8) {
      const fy = y + crown / species.whorls * 0.5;
      const angle = twist + Math.PI / arms + random();
      const length = radius * 0.55;
      addBough({ base: new THREE.Vector3(lean(fy), fy, 0), angle, length, width: length * 0.45, rise: 0.1,
        droop: species.droop, shade: 0.8 + 0.3 * h, snowy: random() < species.snow * 0.5, sprays: 1 });
    }
  }
  // Leader: a spire of small upturned sprays, or a bare dead spike on the old fir.
  for (let tip = 0; tip < 5; tip++) {
    const y = top - 0.9 + tip * 0.22;
    for (let arm = 0; arm < 3; arm++) {
      const angle = tip * 1.3 + arm * Math.PI * 2 / 3;
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const length = 0.75 - tip * 0.12;
      add(1, bough({ base: new THREE.Vector3(lean(y), y, 0), direction, length, width: length * 0.5, rise: 0.8, droop: 0.2,
        arch: 0.2, edgeDrop: 0.4, jag: 0.3, random, segments: 3, colorAt: (t, s) => needleColor(1.05, 0.5 + t * 0.5, s) }));
    }
  }
  if (species.deadTop) {
    for (let stub = 0; stub < 4; stub++) {
      const y = top + 0.3 + stub * species.deadTop / 4.5;
      const a = stub * 2.1 + random();
      const reach = 0.9 - stub * 0.15;
      wood([new THREE.Vector3(lean(y), y, 0), new THREE.Vector3(lean(y) + Math.cos(a) * reach, y + 0.1, Math.sin(a) * reach)], 0.05);
    }
  }
  return batches.map(batch => mergeGeometries(batch));
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
});
const manifest = JSON.parse(await readFile(`${TEXTURE_DIRECTORY}/manifest.json`, 'utf8'));
const textures = new Map(await Promise.all(manifest.textures.map(async t => [t.name, await readFile(`${TEXTURE_DIRECTORY}/${t.file}`)])));
for (const type of TYPES) {
  const species = ALPINE_SPECIES[type];
  const doc = await io.read('public/Assets/terrain/trees/tree1.glb');
  const high = doc.getRoot().listNodes().find(n => n.getName() === 'Tree1_High');
  for (const child of high.listChildren()) high.removeChild(child);
  high.setName(`Tree${type}_High`).setTranslation([0, 0, 0]).setExtras({ species: species.name, roots: 6 });
  const low = doc.getRoot().listNodes().find(n => n.getName() === 'Tree1_Low');
  low.setName(`Tree${type}_Low`).setTranslation([0, 0, 0]);
  low.traverse(node => { for (const primitive of node.getMesh()?.listPrimitives() ?? []) primitive.getMaterial().setExtras({ snowPalette: true }); });
  const barkMap = doc.createTexture('Alpine bark').setImage(textures.get('bark-rugged')).setMimeType('image/jpeg');
  // Colour lives in the vertices: bark stays textured, needles and snow are
  // shaded per bough.
  const materials = [doc.createMaterial('Alpine bark').setBaseColorTexture(barkMap).setRoughnessFactor(0.95),
    doc.createMaterial('Evergreen needles').setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.9).setDoubleSided(true),
    doc.createMaterial('Settled snow').setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.85).setDoubleSided(true)];
  for (const material of materials) material.setMetallicFactor(0);
  const geometries = buildConifer(type);
  for (let kind = 0; kind < 3; kind++) {
    const geometry = geometries[kind], buffer = doc.getRoot().listBuffers()[0];
    const primitive = doc.createPrimitive().setMaterial(materials[kind]);
    for (const [name, key, shape] of [['POSITION', 'position', 'VEC3'], ['NORMAL', 'normal', 'VEC3'], ['TEXCOORD_0', 'uv', 'VEC2'], ['COLOR_0', 'color', 'VEC3']]) {
      primitive.setAttribute(name, doc.createAccessor().setType(shape).setArray(new Float32Array(geometry.getAttribute(key).array)).setBuffer(buffer));
    }
    high.addChild(doc.createNode(`Alpine${type}_${kind}`).setMesh(doc.createMesh().addPrimitive(primitive)));
  }
  console.log(`Tree ${type} (${species.name}): ${geometries.reduce((sum, g) => sum + g.getAttribute('position').count / 3, 0)} triangles`);
  await applyBakedTreeBillboard(doc, type, textures);
  await doc.transform(prune(), draco());
  await io.write(`public/Assets/terrain/fantasy/tree${type}.glb`, doc);
  console.log(`Generated alpine tree ${type}`);
}
