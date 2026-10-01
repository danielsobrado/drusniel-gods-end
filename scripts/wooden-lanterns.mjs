import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Original wooden supports and three lantern silhouettes, baked offline. */
export function buildWoodenLanterns(doc, setGeometry, barkTexture, stoneSource) {
  const scene = doc.createScene();
  const texture = doc.createTexture('Weathered wood').setImage(barkTexture.getImage()).setMimeType(barkTexture.getMimeType());
  const wood = doc.createMaterial('Weathered oak').setBaseColorTexture(texture).setBaseColorFactor([0.85, 0.68, 0.45, 1]).setRoughnessFactor(0.95).setMetallicFactor(0);
  const iron = doc.createMaterial('Forged dark iron').setBaseColorFactor([0.055, 0.067, 0.065, 1]).setMetallicFactor(0.72).setRoughnessFactor(0.48);
  const brass = doc.createMaterial('Aged brass fittings').setBaseColorFactor([0.38, 0.22, 0.065, 1]).setMetallicFactor(0.75).setRoughnessFactor(0.4);
  const amber = doc.createMaterial('Amber lantern glass').setBaseColorFactor([0.8, 0.33, 0.065, 1]).setEmissiveFactor([1, 0.42, 0.09]).setRoughnessFactor(0.3);
  const stoneTexture = doc.createTexture('Painted foundation stone').setImage(stoneSource.texture.getImage()).setMimeType(stoneSource.texture.getMimeType());
  const stone = doc.createMaterial('Foundation stone').setBaseColorTexture(stoneTexture).setMetallicFactor(0).setRoughnessFactor(1);
  const names = ['Lantern', 'LanternWoodland', 'LanternRoadside'];
  for (let style = 0; style < 3; style++) {
    const root = doc.createNode(names[style]).setExtras({ lanternStyle: ['Timber crossbeam', 'Twisted woodland', 'Braced roadside'][style] });
    scene.addChild(root);
    const batches = new Map([wood, iron, brass, amber, stone].map(m => [m, []]));
    const add = (material, geometry, x = 0, y = 0, z = 0) => {
      geometry.translate(x, y, z);
      batches.get(material).push(geometry.index ? geometry.toNonIndexed() : geometry);
    };
    const beam = (a, b, width, depth = width) => {
      const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
      const g = new THREE.BoxGeometry(width, delta.length(), depth);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
      const center = start.add(end).multiplyScalar(0.5);
      add(wood, g, center.x, center.y, center.z);
    };
    const curve = (points, radius, material = wood) => add(material, new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), points.length === 2 ? 1 : 40, radius, 10, false));
    // Irregular masonry footing, rather than a miniature display plinth.
    for (let tier = 0; tier < 2; tier++) for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + tier * 0.4;
      const block = stoneSource.geometry.clone();
      block.computeBoundingBox();
      const center = block.boundingBox.getCenter(new THREE.Vector3());
      const size = block.boundingBox.getSize(new THREE.Vector3());
      const diameter = 0.48 + (i % 3) * 0.04;
      block.translate(-center.x, -center.y, -center.z);
      block.scale(diameter / size.x, diameter / size.y, diameter / size.z);
      block.scale(1, 0.75, 0.85); block.rotateY(a);
      add(stone, block, Math.cos(a) * (0.34 - tier * 0.07), 0.14 + tier * 0.23, Math.sin(a) * (0.34 - tier * 0.07));
    }
    if (style === 1) {
      curve([[0, 0, 0], [-0.12, 1, 0.04], [0.09, 2, -0.04], [-0.14, 3.15, 0.02],
        [0.16, 4.35, 0], [0.8, 4.75, 0], [1.32, 4.3, 0]], 0.13);
      const vine = [];
      for (let i = 0; i <= 60; i++) {
        const y = i / 60 * 4.25, a = y * 5.5;
        vine.push([Math.cos(a) * 0.17, y, Math.sin(a) * 0.17]);
      }
      curve(vine, 0.045);
      curve([[-0.05, 3.6, 0], [-0.5, 3.98, 0], [-0.57, 4.14, 0]], 0.07);
    } else {
      beam([0, 0, 0], [0, 4.65, 0], style === 0 ? 0.34 : 0.28);
      beam([-0.2, 4.32, 0], [1.52, 4.32, 0], 0.28);
      if (style === 2) beam([0.04, 3.34, 0], [1.02, 4.23, 0], 0.17);
      for (const y of [0.7, 4.3]) {
        add(iron, new THREE.BoxGeometry(0.39, 0.25, 0.39), 0, y, 0);
        for (const x of [-0.11, 0.11]) add(brass, new THREE.SphereGeometry(0.035, 6, 5), x, y, 0.21);
      }
      if (style === 2) {
        add(wood, new THREE.BoxGeometry(0.7, 0.42, 0.08), 0, 2.7, 0.22);
        add(brass, new THREE.TorusGeometry(0.13, 0.022, 5, 4), 0, 2.7, 0.275);
      }
    }
    const x = 1.27;
    for (let i = 0; i < 3; i++) {
      const link = new THREE.TorusGeometry(0.065, 0.018, 6, 12);
      if (i % 2) link.rotateY(Math.PI / 2);
      add(iron, link, x, 4.16 - i * 0.1, 0);
    }
    const sides = style === 1 ? 4 : style === 0 ? 8 : 6;
    // Bell-shaped cage, swept pagoda hood, and hexagonal travel lamp.
    const topRadius = style === 0 ? 0.16 : 0.28;
    const bottomRadius = style === 0 ? 0.32 : 0.25;
    add(amber, new THREE.CylinderGeometry(topRadius, bottomRadius, 0.7, sides), x, 3.43, 0);
    if (style === 1) {
      const profile = [[0.035, 0.25], [0.16, 0.1], [0.3, 0], [0.47, -0.06], [0.5, 0.015]].map(p => new THREE.Vector2(...p));
      const hood = new THREE.LatheGeometry(profile, 4); hood.rotateY(Math.PI / 4);
      add(brass, hood, x, 3.79, 0);
    } else add(iron, new THREE.ConeGeometry(style === 0 ? 0.25 : 0.43, 0.25, sides), x, 3.9, 0);
    for (let side = 0; side < sides; side++) {
      const a = side / sides * Math.PI * 2;
      curve([[x + Math.sin(a) * topRadius, 3.78, Math.cos(a) * topRadius],
        [x + Math.sin(a) * bottomRadius, 3.08, Math.cos(a) * bottomRadius]], 0.028, iron);
    }
    for (const [radius, y] of [[topRadius + 0.04, 3.8], [bottomRadius + 0.05, 3.05]]) {
      add(brass, new THREE.CylinderGeometry(radius, radius, 0.065, sides), x, y, 0);
    }
    add(iron, new THREE.ConeGeometry(bottomRadius + 0.03, 0.23, sides).rotateZ(Math.PI), x, 2.92, 0);
    add(brass, new THREE.SphereGeometry(0.065, 8, 6), x, 2.77, 0);
    for (const [material, geometries] of batches) {
      if (!geometries.length) continue;
      const primitive = doc.createPrimitive().setMaterial(material);
      setGeometry(doc, primitive, mergeGeometries(geometries));
      root.addChild(doc.createNode(`${names[style]} ${material.getName()}`).setMesh(doc.createMesh().addPrimitive(primitive)));
    }
  }
}
