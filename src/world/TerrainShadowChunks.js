import { Box3, BufferGeometry, Mesh, Sphere, Vector3 } from 'three/webgpu';

// A dedicated layer keeps proxies out of the main view and reflection cameras.
export const SHADOW_LAYER = 30;

/** Partition existing triangles, without simplifying or changing the visible terrain. */
export function createTerrainShadowChunks(target, shadowCamera, cellSize = 128) {
  if (!target?.isMesh || !target.geometry.index || !target.parent) return null;
  const source = target.geometry, position = source.attributes.position, index = source.index;
  target.updateWorldMatrix(true, false);
  const matrix = target.matrixWorld.elements, cells = new Map();
  const point = new Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
    const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const key = `${Math.floor(worldX / cellSize)},${Math.floor(worldZ / cellSize)}`;
    let cell = cells.get(key);
    if (!cell) { cell = { indices: [], bounds: new Box3() }; cells.set(key, cell); }
    cell.indices.push(a, b, c);
    for (const vertex of [a, b, c]) cell.bounds.expandByPoint(point.fromBufferAttribute(position, vertex));
  }
  const proxies = [], previousCastShadow = target.castShadow, previousLayers = shadowCamera.layers.mask;
  shadowCamera.layers.enable(SHADOW_LAYER);
  for (const [key, cell] of cells) {
    const geometry = new BufferGeometry();
    // Immutable vertex data is shared; only each section's index buffer is new.
    for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(cell.indices);
    geometry.boundingBox = cell.bounds;
    geometry.boundingSphere = cell.bounds.getBoundingSphere(new Sphere());
    // Include shader snow displacement in the conservative shadow bounds.
    geometry.boundingSphere.radius += 2;
    const mesh = new Mesh(geometry, target.material);
    mesh.name = `Terrain shadow: ${key}`;
    mesh.layers.set(SHADOW_LAYER); mesh.castShadow = true; mesh.receiveShadow = false;
    mesh.matrix.copy(target.matrix); mesh.matrixAutoUpdate = false;
    mesh.userData.excludeFromReflection = true; mesh.userData.occlusionCull = false;
    target.parent.add(mesh); proxies.push(mesh);
  }
  target.castShadow = false;
  let disposed = false;
  return { proxies, setEnabled(enabled) {
    target.castShadow = enabled ? false : previousCastShadow;
    for (const mesh of proxies) mesh.visible = enabled;
  }, dispose() {
    if (disposed) return; disposed = true;
    for (const mesh of proxies) { mesh.removeFromParent(); mesh.geometry.dispose(); }
    target.castShadow = previousCastShadow; shadowCamera.layers.mask = previousLayers;
  } };
}
