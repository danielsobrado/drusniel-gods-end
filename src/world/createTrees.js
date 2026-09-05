import * as THREE from 'three';
import { createRandom } from '../utils/random.js';

export function createTrees(scene, config) {
  const random = createRandom(0x2a7139);
  const group = new THREE.Group();
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#5b4631', roughness: 1 });
  const foliageMaterials = [
    new THREE.MeshStandardMaterial({ color: '#294d2a', roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: '#3c6935', roughness: 0.9 }),
  ];

  for (let index = 0; index < config.trees.fallbackCount; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 34 + random() * 30;
    const height = 3.5 + random() * 5;
    const tree = new THREE.Group();

    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.32, height * 0.55, 7), trunkMaterial);
    trunk.position.y = height * 0.275;
    trunk.castShadow = true;
    tree.add(trunk);

    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(1.3 + random() * 1.3, height * 0.72, 8),
      foliageMaterials[index % foliageMaterials.length],
    );
    crown.position.y = height * 0.68;
    crown.castShadow = true;
    tree.add(crown);

    tree.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    tree.rotation.y = random() * Math.PI * 2;
    tree.scale.setScalar(0.8 + random() * 0.55);
    group.add(tree);
  }

  scene.add(group);
  return group;
}
