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

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
});
const manifest = JSON.parse(await readFile(`${TEXTURE_DIRECTORY}/manifest.json`, 'utf8'));
const textures = new Map(await Promise.all(manifest.textures.map(async t => [t.name, await readFile(`${TEXTURE_DIRECTORY}/${t.file}`)])));
for (const type of [10, 11]) {
  const doc = await io.read('public/Assets/terrain/trees/tree1.glb');
  const high = doc.getRoot().listNodes().find(n => n.getName() === 'Tree1_High');
  for (const child of high.listChildren()) high.removeChild(child);
  high.setName(`Tree${type}_High`).setTranslation([0, 0, 0]).setExtras({ species: type === 10 ? 'Snow spruce' : 'Windswept mountain pine', roots: 6 });
  const low = doc.getRoot().listNodes().find(n => n.getName() === 'Tree1_Low');
  low.setName(`Tree${type}_Low`).setTranslation([0, 0, 0]);
  low.traverse(node => { for (const primitive of node.getMesh()?.listPrimitives() ?? []) primitive.getMaterial().setExtras({ snowPalette: true }); });
  const barkMap = doc.createTexture('Alpine bark').setImage(textures.get('bark-rugged')).setMimeType('image/jpeg');
  const materials = [doc.createMaterial('Alpine bark').setBaseColorTexture(barkMap).setRoughnessFactor(0.95),
    doc.createMaterial('Evergreen needles').setBaseColorFactor(type === 10 ? [0.065, 0.17, 0.135, 1] : [0.12, 0.22, 0.18, 1]).setRoughnessFactor(1),
    doc.createMaterial('Settled snow').setBaseColorFactor([0.88, 0.94, 0.98, 1]).setRoughnessFactor(0.95)];
  for (const material of materials) material.setMetallicFactor(0);
  const batches = [[], [], []], random = createSeededRandom(type * 837);
  const height = type === 10 ? 15 : 12;
  const lean = y => type === 10 ? Math.sin(y * 0.2) * 0.16 : (y / height) ** 1.5 * 2;
  const add = (kind, geometry) => batches[kind].push(geometry.index ? geometry.toNonIndexed() : geometry);
  const branch = (points, radius) => add(0, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 8, radius, 6, false));
  const trunk = new THREE.CylinderGeometry(0.07, 0.48, height, 9, 16).translate(0, height / 2, 0);
  const tp = trunk.getAttribute('position');
  for (let i = 0; i < tp.count; i++) tp.setX(i, tp.getX(i) + lean(tp.getY(i)));
  trunk.computeVertexNormals(); add(0, trunk);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    branch([new THREE.Vector3(0, 0.65, 0), new THREE.Vector3(Math.cos(a) * 0.6, 0.12, Math.sin(a) * 0.6),
      new THREE.Vector3(Math.cos(a) * 1.2, -0.12, Math.sin(a) * 1.2)], 0.13);
  }
  const tiers = type === 10 ? 9 : 6;
  for (let tier = 0; tier < tiers; tier++) {
    const baseY = type === 10 ? 2.4 + tier * (height - 3.4) / tiers : 4 + tier * 1.2;
    const radius = (type === 10 ? 4.1 : 4.6) * (1 - tier / (tiers + 0.8));
    for (let arm = 0; arm < 6; arm++) {
      const y = baseY + (random() - 0.5) * 0.65;
      const a = arm * Math.PI / 3 + tier * 1.9 + random() * 0.4;
      const length = radius * (0.75 + random() * 0.4) * (type === 11 ? 1 + Math.cos(a) * 0.3 : 1);
      const tip = new THREE.Vector3(lean(y) + Math.cos(a) * length, y - 0.35, Math.sin(a) * length);
      branch([new THREE.Vector3(lean(y), y, 0), new THREE.Vector3(lean(y) + Math.cos(a) * length * 0.6, y - 0.4, Math.sin(a) * length * 0.6), tip], 0.07 + (1 - tier / tiers) * 0.035);
      for (let tuft = 0; tuft < 3; tuft++) {
        const t = 0.35 + tuft * 0.28;
        const x = lean(y) + Math.cos(a) * length * t, z = Math.sin(a) * length * t;
        const size = (0.48 + length * 0.18) * (1 - tuft * 0.12);
        const needles = new THREE.IcosahedronGeometry(1, 1).scale(size, size * 0.48, size * 1.2).rotateY(-a + Math.PI / 2).translate(x, y, z);
        add(1, needles);
        const snow = new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2)
          .scale(size * 0.95, size * 0.48, size * 1.12).rotateY(-a + Math.PI / 2).translate(x, y + size * 0.12, z);
        add(2, snow);
      }
    }
  }
  for (let tip = 0; tip < 3; tip++) {
    const y = height - 1.4 + tip * 0.55, radius = 0.65 - tip * 0.2;
    add(1, new THREE.IcosahedronGeometry(1, 1).scale(radius, 0.55, radius).translate(lean(y), y, 0));
    add(2, new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(radius * 0.95, 0.45, radius * 0.95).translate(lean(y), y + 0.2, 0));
  }
  for (let kind = 0; kind < 3; kind++) {
    const geometry = mergeGeometries(batches[kind]), buffer = doc.getRoot().listBuffers()[0];
    const primitive = doc.createPrimitive().setMaterial(materials[kind]);
    for (const [name, key, shape] of [['POSITION', 'position', 'VEC3'], ['NORMAL', 'normal', 'VEC3'], ['TEXCOORD_0', 'uv', 'VEC2']]) {
      primitive.setAttribute(name, doc.createAccessor().setType(shape).setArray(geometry.getAttribute(key).array).setBuffer(buffer));
    }
    high.addChild(doc.createNode(`Alpine${type}_${kind}`).setMesh(doc.createMesh().addPrimitive(primitive)));
  }
  await applyBakedTreeBillboard(doc, type, textures);
  await doc.transform(prune(), draco());
  await io.write(`public/Assets/terrain/fantasy/tree${type}.glb`, doc);
  console.log(`Generated alpine tree ${type}`);
}
