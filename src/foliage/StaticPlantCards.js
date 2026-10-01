import * as THREE from 'three/webgpu';
import { attribute, atan, cameraPosition, cos, positionGeometry, sin, smoothstep, uniform, varying } from 'three/tsl';

/** Immutable plant placements: facing, view selection and distance fades run on the GPU. */
export function plantCardNodes(capture, customWind = null, kind = 'plant') {
  const ranges = uniform(new THREE.Vector4());
  const origin = attribute('cardOrigin', 'vec3'), center = attribute('cardCenter', 'vec3');
  const sourceRight = attribute('cardRight', 'vec3'), sourceForward = attribute('cardForward', 'vec3');
  const delta = cameraPosition.sub(center);
  const angle = atan(delta.dot(attribute('cardInverseX', 'vec3')), delta.dot(attribute('cardInverseZ', 'vec3')));
  const right = sourceRight.mul(cos(angle)).sub(sourceForward.mul(sin(angle)));
  let position = center.add(right.mul(positionGeometry.x.mul(capture.width)))
    .add(attribute('cardUp', 'vec3').mul(positionGeometry.y.mul(capture.height)));
  if (customWind) position = position.add(customWind({ origin, right: sourceRight, forward: sourceForward, kind }));
  const distance = cameraPosition.distance(origin);
  const near = smoothstep(ranges.x, ranges.y, distance);
  const far = smoothstep(ranges.z.mul(0.9), ranges.z, distance).oneMinus();
  return { ranges, position, angle: varying(angle),
    minimum: varying(near.oneMinus().mul(far).mul(attribute('cardMeshReady', 'float'))), maximum: varying(far),
    density: attribute('cardFraction', 'float').lessThanEqual(ranges.w) };
}

export function createPlantCards(chunk, scene) {
  const template = chunk.templates[3][0];
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(template.geometry.index.clone());
  for (const [name, attr] of Object.entries(template.geometry.attributes)) geometry.setAttribute(name, attr);
  const attributes = ['cardOrigin', 'cardCenter', 'cardRight', 'cardUp', 'cardForward', 'cardInverseX', 'cardInverseZ', 'lodTint'];
  // One instance stream stays within WebGPU's eight vertex-buffer limit.
  const instances = new THREE.InstancedInterleavedBuffer(new Float32Array(chunk.records.length * 25), 25);
  attributes.forEach((name, index) => geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(instances, 3, index * 3)));
  geometry.setAttribute('cardFraction', new THREE.InterleavedBufferAttribute(instances, 1, 24));
  geometry.setAttribute('cardMeshReady', new THREE.InstancedBufferAttribute(new Float32Array(chunk.records.length).fill(1), 1));
  const matrix = new THREE.Matrix4(), inverse = new THREE.Matrix4(), center = new THREE.Vector3();
  chunk.records.forEach((record, index) => {
    const m = record.matrix;
    matrix.fromArray(m); inverse.copy(matrix).invert();
    const v = inverse.elements;
    geometry.attributes.cardOrigin.setXYZ(index, record.position.x, record.position.y, record.position.z);
    center.fromArray(chunk.capture.center).applyMatrix4(matrix);
    geometry.attributes.cardCenter.setXYZ(index, center.x, center.y, center.z);
    for (const [name, offset] of [['cardRight', 0], ['cardUp', 4], ['cardForward', 8]]) geometry.attributes[name].setXYZ(index, m[offset], m[offset + 1], m[offset + 2]);
    geometry.attributes.cardInverseX.setXYZ(index, v[0], v[4], v[8]);
    geometry.attributes.cardInverseZ.setXYZ(index, v[2], v[6], v[10]);
    geometry.attributes.lodTint.setXYZ(index, record.tint?.r ?? 1, record.tint?.g ?? 1, record.tint?.b ?? 1);
    geometry.attributes.cardFraction.setX(index, record.fraction ?? 0);
  });
  geometry.instanceCount = chunk.records.length;
  const mesh = new THREE.Mesh(geometry, template.material);
  mesh.name = `${chunk.key}:billboard`; mesh.frustumCulled = false; mesh.visible = false;
  mesh.userData.excludeFromReflection = true; mesh.userData.occlusionCull = false; mesh.userData.skipWarmup = true;
  scene?.add(mesh);
  return { mesh, ranges: chunk.cardNodes.ranges, meshReady: true };
}

export function setPlantCardsMeshReady(cards, ready) {
  if (cards.meshReady === ready) return;
  cards.meshReady = ready;
  const attribute = cards.mesh.geometry.getAttribute('cardMeshReady');
  attribute.array.fill(ready ? 1 : 0);
  attribute.needsUpdate = true;
}
