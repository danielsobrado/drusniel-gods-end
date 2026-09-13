import * as THREE from 'three';
import {
  coastalJungleKeepFraction,
  coastalJungleVisibilityLimit,
  isCoastalJungleTreeKind,
} from './CoastalJungleVisibility.js';

const NON_TREE_DISTANCE_PADDING = 1;

function elapsedMs(started) {
  const now = globalThis.performance?.now?.() ?? Date.now();
  return Math.max(0, now - started);
}

export class CoastalJungleCulling {
  constructor(profile, batches, singles) {
    this.profile = profile;
    this.batches = batches;
    this.singles = singles;
    this.chunks = [];
    this.dirty = true;
    this.revision = 0;
    this.lastCameraPosition = new THREE.Vector3(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    this.lastCameraQuaternion = new THREE.Quaternion();
    this.frustum = new THREE.Frustum();
    this.projection = new THREE.Matrix4();
    this.matrix = new THREE.Matrix4();
  }

  build() {
    const size = Math.max(1, Number(this.profile.render?.chunkSize) || 16);
    const chunks = new Map();
    const bounds = new THREE.Box3();
    const add = (entry) => {
      const { position, sphere } = entry.record;
      const key = `${Math.floor(position.x / size)},${Math.floor(position.z / size)}`;
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = { records: [], bounds: new THREE.Box3().makeEmpty(), center: new THREE.Vector3() };
        chunks.set(key, chunk);
      }
      chunk.records.push(entry);
      sphere.getBoundingBox(bounds);
      chunk.bounds.union(bounds);
    };

    for (const batch of this.batches) {
      for (const record of batch.records) add({ record, batch, single: null });
    }
    for (const single of this.singles) {
      if (single.record) add({ record: single.record, batch: null, single });
    }
    this.chunks = [...chunks.values()];
    for (const chunk of this.chunks) chunk.bounds.getCenter(chunk.center);
    this.dirty = true;
    return this.chunks.length;
  }

  markDirty() {
    this.dirty = true;
  }

  update(camera, quality = {}, force = false) {
    if (!camera) return null;
    const render = this.profile.render ?? {};
    const moveThreshold = Math.max(0, Number(render.cameraMoveThreshold) || 0);
    const rotationThreshold = Math.max(0, Number(render.cameraRotationThreshold) || 0);
    const moved = camera.position.distanceToSquared(this.lastCameraPosition) >= moveThreshold * moveThreshold;
    const rotated = 1 - Math.abs(camera.quaternion.dot(this.lastCameraQuaternion)) >= rotationThreshold;
    if (!force && !this.dirty && !moved && !rotated) return null;

    const started = globalThis.performance?.now?.() ?? Date.now();
    this.lastCameraPosition.copy(camera.position);
    this.lastCameraQuaternion.copy(camera.quaternion);
    this.dirty = false;
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(
      this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
    );

    const maxDistance = Math.max(1, Number(quality.maxDistance) || Number(render.treeDistance) || 180);
    const visibleChunks = [];
    const visibleInstances = new Set();
    const byKind = {};
    let triangles = 0;

    for (const batch of this.batches) batch.writeCount = 0;
    for (const single of this.singles) single.object.visible = false;

    for (const chunk of this.chunks) {
      if (chunk.bounds.distanceToPoint(camera.position) > maxDistance) continue;
      if (!this.frustum.intersectsBox(chunk.bounds)) continue;
      visibleChunks.push(chunk);
    }
    visibleChunks.sort(
      (left, right) => left.center.distanceToSquared(camera.position) - right.center.distanceToSquared(camera.position),
    );

    for (const chunk of visibleChunks) {
      for (const entry of chunk.records) {
        const { record } = entry;
        if (!this.frustum.intersectsSphere(record.sphere)) continue;
        const distance = record.position.distanceTo(camera.position);
        const limit = coastalJungleVisibilityLimit(record.kind, render, quality);
        const padding = isCoastalJungleTreeKind(record.kind) ? record.sphere.radius : NON_TREE_DISTANCE_PADDING;
        if (distance > limit + padding) continue;
        if (record.stableFraction > coastalJungleKeepFraction(record.kind, distance, render, quality)) continue;

        if (entry.batch) {
          this.matrix.fromArray(record.matrix);
          entry.batch.object.setMatrixAt(entry.batch.writeCount, this.matrix);
          entry.batch.writeCount += 1;
          triangles += entry.batch.triangles;
        } else if (entry.single) {
          entry.single.object.visible = true;
          triangles += entry.single.triangles;
        }

        if (!visibleInstances.has(record.instanceKey)) {
          visibleInstances.add(record.instanceKey);
          byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
        }
      }
    }

    for (const batch of this.batches) {
      const attribute = batch.object.instanceMatrix;
      batch.object.count = batch.writeCount;
      batch.object.visible = batch.writeCount > 0;
      attribute.clearUpdateRanges?.();
      if (batch.writeCount > 0) {
        attribute.addUpdateRange?.(0, batch.writeCount * 16);
        attribute.needsUpdate = true;
      }
    }

    this.revision += 1;
    return {
      visibleInstances: visibleInstances.size,
      visibleChunks: visibleChunks.length,
      triangles: Math.round(triangles),
      bookkeepingMs: elapsedMs(started),
      revision: this.revision,
      byKind,
    };
  }
}
