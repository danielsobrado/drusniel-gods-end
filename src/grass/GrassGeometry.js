import * as THREE from 'three/webgpu';

const HASH_X = 127.1;
const HASH_Y = 311.7;
const HASH_SCALE = 43758.5453123;
const NOISE_HASH_SCALE = 43758.5453;
const TWO_PI = Math.PI * 2;
const ATLAS_VARIANTS = 4;

function fract(value) {
  return value - Math.floor(value);
}

function hash2d(x, y) {
  return fract(Math.sin(x * HASH_X + y * HASH_Y) * HASH_SCALE);
}

function gradient(x, y) {
  const angle = fract(Math.sin(x * HASH_X + y * HASH_Y) * NOISE_HASH_SCALE) * TWO_PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function gradientNoise2d(x, y) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const localX = x - cellX;
  const localY = y - cellY;
  const fadeX = localX * localX * (3 - 2 * localX);
  const fadeY = localY * localY * (3 - 2 * localY);

  const g00 = gradient(cellX, cellY);
  const g10 = gradient(cellX + 1, cellY);
  const g01 = gradient(cellX, cellY + 1);
  const g11 = gradient(cellX + 1, cellY + 1);
  const n00 = g00.x * localX + g00.y * localY;
  const n10 = g10.x * (localX - 1) + g10.y * localY;
  const n01 = g01.x * localX + g01.y * (localY - 1);
  const n11 = g11.x * (localX - 1) + g11.y * (localY - 1);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(n00, n10, fadeX),
    THREE.MathUtils.lerp(n01, n11, fadeX),
    fadeY,
  ) + 0.5;
}

function createBladeTemplate(detail) {
  const segments = Math.max(1, Math.round(detail));
  const positions = [];
  const uvs = [];
  const indices = [];
  let vertex = 0;

  for (let segment = 0; segment < segments; segment += 1) {
    const ratio = segment / segments;
    const nextRatio = (segment + 1) / segments;
    const halfWidth = (1 - ratio) * 0.5;
    const nextHalfWidth = (1 - nextRatio) * 0.5;

    positions.push(
      -halfWidth, ratio, 0,
      halfWidth, ratio, 0,
      -nextHalfWidth, nextRatio, 0,
    );
    uvs.push(0, ratio, 1, ratio, 0, nextRatio);

    if (segment < segments - 1) {
      positions.push(nextHalfWidth, nextRatio, 0);
      uvs.push(1, nextRatio);
      indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
      vertex += 4;
    } else {
      indices.push(vertex, vertex + 1, vertex + 2);
      vertex += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createBillboardTemplate(detail) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];

  if (detail >= 1) {
    positions.push(
      -0.5, 0, 0,
      0.5, 0, 0,
      -0.5, 1, 0,
      0.5, 1, 0,
    );
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    indices.push(0, 1, 2, 2, 1, 3);
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function createInstanceBuffers(type, density, tileSize, stable) {
  const gridCount = Math.floor(tileSize * density);
  const instancePositions = [];
  const instanceRotations = [];
  const instanceData = [];

  for (let gridX = 0; gridX < gridCount; gridX += 1) {
    for (let gridZ = 0; gridZ < gridCount; gridZ += 1) {
      const billboard = type === 'billboard';
      const index = gridX * gridCount + gridZ;
      const jitterX = billboard ? Math.random() : hash2d(gridX, gridZ);
      const jitterZ = billboard ? Math.random() : hash2d(gridX + 1, gridZ);
      const rotationHash = billboard ? Math.random() : hash2d(gridX + 2, gridZ);
      // Every prefix covers the tile; lower LODs keep the same stems.
      const x = stable ? (fract(0.5 + (index + 1) * 0.7548776662466927 + (hash2d(index, 31) - 0.5) * 0.018) - 0.5) * tileSize
        : -tileSize * 0.5 + (gridX + jitterX) / density;
      const z = stable ? (fract(0.5 + (index + 1) * 0.5698402909980532 + (hash2d(index, 47) - 0.5) * 0.018) - 0.5) * tileSize
        : -tileSize * 0.5 + (gridZ + jitterZ) / density;
      const angle = (stable ? hash2d(index, 7) : rotationHash) * TWO_PI;

      instancePositions.push(x, 0, z);
      instanceRotations.push(Math.sin(angle), Math.cos(angle));
      instanceData.push(
        billboard ? Math.floor((stable ? hash2d(index, 11) : Math.random()) * ATLAS_VARIANTS) : 0,
        stable ? index : 0,
        gradientNoise2d(x * 0.2, z * 0.2) * TWO_PI,
        gradientNoise2d(x * (billboard ? 0.1 : 0.3), z * (billboard ? 0.1 : 0.3)),
      );
    }
  }

  return {
    position: new Float32Array(instancePositions),
    rotation: new Float32Array(instanceRotations),
    data: new Float32Array(instanceData),
    count: instanceData.length / 4,
  };
}

export function createGrassGeometry({
  type,
  detail,
  density,
  tileSize,
  bladeHeight,
  stable = false,
}) {
  const baseGeometry = type === 'billboard'
    ? createBillboardTemplate(detail)
    : createBladeTemplate(detail);
  const buffers = createInstanceBuffers(type, density, tileSize, stable);
  const geometry = new THREE.InstancedBufferGeometry();

  geometry.index = baseGeometry.index;
  geometry.attributes.position = baseGeometry.attributes.position;
  geometry.attributes.normal = baseGeometry.attributes.normal;
  geometry.attributes.uv = baseGeometry.attributes.uv;
  geometry.instanceCount = buffers.count;
  geometry.setAttribute(
    'instancePosition',
    new THREE.StorageInstancedBufferAttribute(buffers.position, 3),
  );
  geometry.setAttribute(
    'instanceRotation',
    new THREE.StorageInstancedBufferAttribute(buffers.rotation, 2),
  );
  geometry.setAttribute(
    'instanceData',
    new THREE.StorageInstancedBufferAttribute(buffers.data, 4),
  );

  const sideValues = new Float32Array(baseGeometry.getAttribute('position').count);
  for (let index = 0; index < sideValues.length; index += 1) {
    sideValues[index] = index % 2 === 0 ? -1 : 1;
  }
  geometry.setAttribute('bladeSide', new THREE.Float32BufferAttribute(sideValues, 1));

  const height = Number(bladeHeight ?? 1.5);
  const halfSize = tileSize * 0.5;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-halfSize, 0, -halfSize),
    new THREE.Vector3(halfSize, height, halfSize),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, height * 0.5, 0),
    Math.sqrt(tileSize * tileSize * 2) * 0.5 + height,
  );
  geometry.userData.instanceCount = buffers.count;
  geometry.userData.lod = { type, detail, density };
  baseGeometry.dispose();
  return geometry;
}
