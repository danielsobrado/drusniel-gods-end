/** Offline derivatives: keep authored sources intact; no geometry generation at startup. */
import { mkdir } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../src/core/math.js';
import { buildWoodenLanterns } from './wooden-lanterns.mjs';
import { prepareStylizedTreeTextures, applyStylizedTreeTextures, applyBakedTreeBillboard } from './stylized-tree-textures.mjs';

const base = 'public/Assets/terrain';
const output = `${base}/fantasy`;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await mkdir(output, { recursive: true });
const stylizedTextures = await prepareStylizedTreeTextures();

function geometryOf(primitive) {
  const geometry = new THREE.BufferGeometry();
  for (const [semantic, key, size] of [['POSITION', 'position', 3], ['NORMAL', 'normal', 3], ['TEXCOORD_0', 'uv', 2]]) {
    const array = primitive.getAttribute(semantic)?.getArray();
    if (array) geometry.setAttribute(key, new THREE.BufferAttribute(new Float32Array(array), size));
  }
  const indices = primitive.getIndices()?.getArray();
  if (indices) geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  return geometry;
}

function setGeometry(doc, primitive, geometry) {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  for (const semantic of primitive.listSemantics()) primitive.setAttribute(semantic, null);
  for (const [semantic, key, type] of [['POSITION', 'position', 'VEC3'], ['NORMAL', 'normal', 'VEC3'], ['TEXCOORD_0', 'uv', 'VEC2']]) {
    const attribute = geometry.getAttribute(key);
    if (attribute) primitive.setAttribute(semantic, doc.createAccessor().setType(type).setArray(attribute.array).setBuffer(buffer));
  }
  primitive.setIndices(geometry.index
    ? doc.createAccessor().setType('SCALAR').setArray(geometry.index.array).setBuffer(buffer) : null);
}

async function save(doc, name) {
  await doc.transform(prune(), draco({ encodeSpeed: 5, decodeSpeed: 5, quantizePosition: 16, quantizeTexcoord: 14 }));
  await io.write(`${output}/${name}.glb`, doc);
  console.log(`Generated ${name}.glb`);
}

// The two palette-only pebbles need coherent painted UV islands, not random
// face samples. Sculpt the textured 06/07 templates to their original bounds.
const rocks = await io.read(`${base}/props/free_pack_-_rocks_stylized.glb`);
for (const node of rocks.getRoot().listNodes().filter(n => /^SM_Rocks_(10|11)_/.test(n.getName()))) {
  for (const primitive of node.getMesh().listPrimitives()) {
    const original = geometryOf(primitive);
    original.computeBoundingBox();
    const sourceName = node.getName().startsWith('SM_Rocks_10_') ? 'SM_Rocks_06_' : 'SM_Rocks_07_';
    const reference = rocks.getRoot().listNodes().find(n => n.getName().startsWith(sourceName)).getMesh().listPrimitives()[0];
    const geometry = geometryOf(reference);
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    const targetCenter = original.boundingBox.getCenter(new THREE.Vector3());
    const scale = original.boundingBox.getSize(new THREE.Vector3()).divide(geometry.boundingBox.getSize(new THREE.Vector3()));
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.scale(scale.x, scale.y, scale.z);
    geometry.translate(targetCenter.x, targetCenter.y, targetCenter.z);
    setGeometry(rocks, primitive, geometry);
    node.setExtras({ ...node.getExtras(), paintedRockUVs: true });
  }
}
await save(rocks, 'rocks');

function rootsGeometry(radius, seed) {
  const random = createSeededRandom(seed);
  const positions = [], uvs = [], indices = [];
  const roots = 7, rings = 9, sides = 10;
  for (let root = 0; root < roots; root++) {
    const angle = (root + random() * 0.35) / roots * Math.PI * 2;
    const length = radius * (2.8 + random() * 1.7);
    const bend = (random() - 0.5) * 1.8;
    const offset = positions.length / 3;
    for (let ring = 0; ring <= rings; ring++) {
      const t = ring / rings, a = angle + bend * t;
      const distance = radius * 0.45 + length * t;
      const width = radius * (0.48 * (1 - t) ** 1.4 + 0.025);
      const height = radius * (0.8 * (1 - t) ** 2 + 0.02);
      for (let side = 0; side <= sides; side++) {
        const theta = side / sides * Math.PI * 2;
        const across = Math.cos(theta) * width;
        positions.push(Math.cos(a) * distance - Math.sin(a) * across,
          Math.sin(theta) * height + height * 0.35 - radius * 0.12,
          Math.sin(a) * distance + Math.cos(a) * across);
        uvs.push(side / sides, t * 0.95);
      }
    }
    for (let ring = 0; ring < rings; ring++) for (let side = 0; side < sides; side++) {
      const a = offset + ring * (sides + 1) + side, b = a + sides + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

for (let type = 1; type <= 9; type++) {
  const doc = await io.read(`${base}/trees/tree${type}.glb`);
  applyStylizedTreeTextures(doc, type, stylizedTextures);
  const high = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_High`);
  const nodes = [];
  high.traverse(n => { if (n.getMesh()) nodes.push(n); });
  const bark = nodes.find(n => n.getMesh().listPrimitives()[0].getMaterial().getAlphaMode() === 'OPAQUE');
  const barkPrimitive = bark.getMesh().listPrimitives()[0];
  const barkGeometry = geometryOf(barkPrimitive);
  barkGeometry.computeBoundingBox();
  const height = barkGeometry.boundingBox.max.y;
  const position = barkGeometry.getAttribute('position');
  let radius = 0;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) < height * 0.015) radius = Math.max(radius, Math.hypot(position.getX(i), position.getZ(i)));
  }
  radius = Math.max(radius, height * 0.012);
  for (const node of nodes) for (const primitive of node.getMesh().listPrimitives()) {
    let geometry = primitive === barkPrimitive ? barkGeometry : geometryOf(primitive);
    if (node !== bark) {
      // The new sprig grows from the bottom; authored cards attach at the top.
      const uv = geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getX(i), 1 - uv.getY(i));
    }
    const p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), t = Math.max(0, y / height);
      const flare = node === bark ? 1 + 0.55 * Math.exp(-y / (radius * 1.8)) : 1;
      const sway = Math.sin(t * Math.PI * 1.1) * height * (0.016 + type % 3 * 0.006);
      p.setXYZ(i, p.getX(i) * flare + sway * Math.cos(type * 2.4), y,
        p.getZ(i) * flare + sway * Math.sin(type * 2.4));
    }
    if (node === bark) {
      geometry.computeVertexNormals();
      const roots = rootsGeometry(radius, type * 137);
      const a = geometry.index ? geometry.toNonIndexed() : geometry;
      geometry = mergeGeometries([a, roots.toNonIndexed()]);
    }
    setGeometry(doc, primitive, geometry);
  }
  high.setExtras({ ...high.getExtras(), fantasyRoots: 7, curvedTrunk: true });
  await applyBakedTreeBillboard(doc, type, stylizedTextures);
  await save(doc, `tree${type}`);
}

// All three supports share wood, metal, glass and foundation materials.
const lantern = new Document();
const treeDoc = await io.read(base + '/trees/tree1.glb');
const bark = treeDoc.getRoot().listMaterials().find(m => m.getAlphaMode() === "OPAQUE");
buildWoodenLanterns(lantern, setGeometry, bark.getBaseColorTexture());
await save(lantern, "lantern");
