import * as THREE from 'three';
import {
  coastalJungleCurveKeep,
  coastalJungleKeepCurve,
  coastalJungleVisibilityLimit,
  isCoastalJungleTreeKind,
} from './CoastalJungleVisibility.js';

const NON_TREE_DISTANCE_PADDING = 1;

function elapsedMs(started) {
  const now = globalThis.performance?.now?.() ?? Date.now();
  return Math.max(0, now - started);
}

function recordPadding(record) {
  return isCoastalJungleTreeKind(record.kind) ? record.sphere.radius : NON_TREE_DISTANCE_PADDING;
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
    this.kindInfo = new Map();
  }

  // Each chunk keeps its records grouped by batch (or single), so a short-range
  // kind such as grass skips whole chunks beyond its reach.
  build() {
    const size = Math.max(1, Number(this.profile.render?.chunkSize) || 16);
    const chunks = new Map();
    const bounds = new THREE.Box3();
    const add = (record, owner, single) => {
      const { position, sphere } = record;
      const key = `${Math.floor(position.x / size)},${Math.floor(position.z / size)}`;
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = { groups: new Map(), bounds: new THREE.Box3().makeEmpty(), center: new THREE.Vector3(), distance: 0 };
        chunks.set(key, chunk);
      }
      let group = chunk.groups.get(owner);
      if (!group) {
        group = { owner, single, kind: record.kind, records: [], padding: 0 };
        chunk.groups.set(owner, group);
      }
      group.records.push(record);
      group.padding = Math.max(group.padding, recordPadding(record));
      sphere.getBoundingBox(bounds);
      chunk.bounds.union(bounds);
    };

    for (const batch of this.batches) {
      for (const record of batch.records) add(record, batch, false);
    }
    for (const single of this.singles) {
      if (single.record) add(single.record, single, true);
    }
    this.chunks = [...chunks.values()].map((chunk) => ({ ...chunk, groups: [...chunk.groups.values()] }));
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

    const cameraPosition = camera.position;
    const maxDistance = Math.max(1, Number(quality.maxDistance) || Number(render.treeDistance) || 180);
    const visibleChunks = [];
    const byKind = {};
    let visibleInstances = 0;
    let triangles = 0;

    for (const batch of this.batches) batch.writeCount = 0;
    for (const single of this.singles) single.object.visible = false;

    for (const chunk of this.chunks) {
      chunk.distance = chunk.bounds.distanceToPoint(cameraPosition);
      if (chunk.distance > maxDistance) continue;
      if (!this.frustum.intersectsBox(chunk.bounds)) continue;
      visibleChunks.push(chunk);
    }
    visibleChunks.sort(
      (left, right) => left.center.distanceToSquared(cameraPosition) - right.center.distanceToSquared(cameraPosition),
    );

    // Visibility limit and keep curve depend only on the kind, so resolve them
    // once per kind per update instead of per record.
    const kindInfo = this.kindInfo;
    kindInfo.clear();

    for (const chunk of visibleChunks) {
      for (const group of chunk.groups) {
        let info = kindInfo.get(group.kind);
        if (info === undefined) {
          info = {
            limit: coastalJungleVisibilityLimit(group.kind, render, quality),
            tree: isCoastalJungleTreeKind(group.kind),
            curve: coastalJungleKeepCurve(group.kind, render, quality),
          };
          kindInfo.set(group.kind, info);
        }
        // Every record lies inside the chunk bounds, so none is nearer than they are.
        if (chunk.distance > info.limit + group.padding) continue;

        const { curve } = info;
        const batch = group.single ? null : group.owner;
        let shown = 0;
        for (const record of group.records) {
          // The keep curve only falls with distance: a plant above its near end
          // never shows, one below its far end always does within reach.
          const fraction = record.stableFraction;
          if (fraction > curve.near) continue;
          const reach = info.limit + (info.tree ? record.sphere.radius : NON_TREE_DISTANCE_PADDING);
          const distanceSquared = record.position.distanceToSquared(cameraPosition);
          if (distanceSquared > reach * reach) continue;
          if (fraction > curve.far && fraction > coastalJungleCurveKeep(curve, Math.sqrt(distanceSquared))) continue;
          if (!this.frustum.intersectsSphere(record.sphere)) continue;

          if (batch) {
            batch.attribute.array.set(record.matrix, batch.writeCount * 16);
            batch.writeCount += 1;
          } else {
            group.owner.object.visible = true;
          }
          shown += 1;
        }
        if (shown === 0) continue;
        triangles += shown * (batch ?? group.owner).triangles;
        // A single's parts share its plant; only its first part counts it.
        if (!batch && !group.owner.primary) continue;
        visibleInstances += shown;
        byKind[group.kind] = (byKind[group.kind] ?? 0) + shown;
      }
    }

    for (const batch of this.batches) {
      const { attribute, writeCount } = batch;
      for (const part of batch.parts) {
        part.count = writeCount;
        part.visible = writeCount > 0;
      }
      attribute.clearUpdateRanges?.();
      if (writeCount > 0) {
        attribute.addUpdateRange?.(0, writeCount * 16);
        attribute.needsUpdate = true;
      }
    }

    this.revision += 1;
    return {
      visibleInstances,
      visibleChunks: visibleChunks.length,
      triangles: Math.round(triangles),
      bookkeepingMs: elapsedMs(started),
      revision: this.revision,
      byKind,
    };
  }
}
