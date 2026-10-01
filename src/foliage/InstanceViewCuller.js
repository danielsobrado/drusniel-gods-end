import { Matrix4, Quaternion, Sphere, Vector3 } from 'three';
import { TurnEnvelopeFrustum } from '../rendering/TurnEnvelopeFrustum.js';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  cameraMoveThreshold: 0.75,
  cameraRotationThreshold: 0.0014,
  turnMarginDegrees: 12,
  boundsScale: 1.15,
  boundsPadding: 0.5,
});

const DEFAULT_CULL_BUDGET_MS = 1.5;

export function resolveViewCullBudgetMs(settings = {}) {
  const value = Number(settings.budgetMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CULL_BUDGET_MS;
}

// One shared time budget per frame. Wild grass, understory and meadow all
// repack on the same camera turn, so without a shared budget their spikes stack
// into a single long frame. Each system always advances at least one unit so
// none is starved, then yields once the frame budget is spent.
export class ViewCullBudget {
  constructor({ budgetMs = DEFAULT_CULL_BUDGET_MS, now = () => performance.now() } = {}) {
    this.budgetMs = Math.max(0, Number(budgetMs) || 0);
    this.now = now;
    this.deadline = -Infinity;
  }

  // `budgetMs` lowers this frame's budget when the frame has less slack.
  begin(budgetMs = this.budgetMs) {
    const value = Number(budgetMs);
    this.deadline = this.now() + (Number.isFinite(value) && value >= 0 ? Math.min(value, this.budgetMs) : this.budgetMs);
  }

  get exhausted() {
    return this.now() >= this.deadline;
  }

  remaining() {
    return Math.max(0, this.deadline - this.now());
  }
}

// Spreads one view-cull repack over successive frames. `request()` starts a pass
// or coalesces a newer camera envelope into one repeat. `restart()` abandons
// partial work when the source data changes. `step()` returns true only when
// all requested passes are complete. With no budget it completes in one step.
export class IncrementalViewCull {
  constructor(budget = null) {
    this.budget = budget;
    this.cursor = 0;
    this.pending = false;
    this.repeat = false;
  }

  request() {
    if (this.pending) {
      this.repeat = true;
      return false;
    }
    return this.restart();
  }

  restart() {
    this.cursor = 0;
    this.pending = true;
    this.repeat = false;
    return true;
  }

  cancel() {
    this.cursor = 0;
    this.pending = false;
    this.repeat = false;
  }

  step(units, apply, onPassStart = null) {
    if (!this.pending) return false;
    if (this.cursor === 0) onPassStart?.();
    const { budget } = this;
    while (this.cursor < units.length) {
      apply(units[this.cursor]);
      this.cursor += 1;
      if (this.cursor < units.length && budget?.exhausted) break;
    }
    if (this.cursor < units.length) return false;
    if (this.repeat) {
      this.repeat = false;
      this.cursor = 0;
      return false;
    }
    this.pending = false;
    return true;
  }
}

function finite(value, fallback, min = -Infinity) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, number) : fallback;
}

export function resolveInstanceViewCullingSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    cameraMoveThreshold: finite(settings.cameraMoveThreshold, DEFAULT_SETTINGS.cameraMoveThreshold, 0),
    cameraRotationThreshold: finite(settings.cameraRotationThreshold, DEFAULT_SETTINGS.cameraRotationThreshold, 0),
    turnMarginDegrees: finite(settings.turnMarginDegrees, DEFAULT_SETTINGS.turnMarginDegrees, 0),
    boundsScale: finite(settings.boundsScale, DEFAULT_SETTINGS.boundsScale, 1),
    boundsPadding: finite(settings.boundsPadding, DEFAULT_SETTINGS.boundsPadding, 0),
  };
}

export function copySelectedInstances(source, target, itemSize, indices, count) {
  for (let write = 0; write < count; write += 1) {
    const sourceOffset = indices[write] * itemSize;
    const targetOffset = write * itemSize;
    for (let component = 0; component < itemSize; component += 1) {
      target[targetOffset + component] = source[sourceOffset + component];
    }
  }
}

export function markAttributeUpdate(attribute, count) {
  attribute.clearUpdateRanges?.();
  if (count <= 0) return;
  attribute.addUpdateRange?.(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

export class InstanceViewCuller {
  constructor(camera, settings = {}) {
    this.camera = camera ?? null;
    this.settings = resolveInstanceViewCullingSettings(settings);
    this.enabled = Boolean(this.camera && this.settings.enabled);
    this.turnEnvelope = new TurnEnvelopeFrustum();
    this.frustum = this.turnEnvelope.frustum;
    this.matrix = new Matrix4();
    this.sphere = new Sphere();
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.lastPosition = new Vector3(Infinity, Infinity, Infinity);
    this.lastQuaternion = new Quaternion();
    this.lastProjection = new Matrix4();
    this.ready = false;
    this.dirty = true;
    this.revision = 0;
  }

  markDirty() {
    this.dirty = true;
  }

  update(force = false) {
    if (!this.enabled) return false;
    const { camera, settings } = this;
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.position);
    camera.getWorldQuaternion(this.quaternion);

    const moved = this.position.distanceToSquared(this.lastPosition)
      >= settings.cameraMoveThreshold * settings.cameraMoveThreshold;
    const rotated = 1 - Math.abs(this.quaternion.dot(this.lastQuaternion))
      >= settings.cameraRotationThreshold;
    const projectionChanged = !camera.projectionMatrix.equals(this.lastProjection);
    if (!force && !this.dirty && !moved && !rotated && !projectionChanged) return false;

    this.turnEnvelope.update(camera, settings.turnMarginDegrees);
    this.lastPosition.copy(this.position);
    this.lastQuaternion.copy(this.quaternion);
    this.lastProjection.copy(camera.projectionMatrix);
    this.ready = true;
    this.dirty = false;
    this.revision += 1;
    return true;
  }

  // `cache` (an InstanceSphereCache) keeps the padded world-space spheres
  // between camera moves: placements only change when a rebuild publishes, so
  // transforming every sphere again on each view update was repeated work.
  collectVisible(matrices, count, localSphere, output, cache = null) {
    const limit = Math.min(
      Math.max(0, Math.trunc(count)),
      Math.floor((matrices?.length ?? 0) / 16),
      output?.length ?? 0,
    );
    if (limit === 0) return 0;
    if (!this.enabled || !localSphere || !(localSphere.radius >= 0)) {
      for (let i = 0; i < limit; i += 1) output[i] = i;
      return limit;
    }
    if (!this.ready) this.update(true);

    const { sphere, frustum } = this;
    let visible = 0;
    if (cache) {
      const spheres = cache.resolve(matrices, limit, localSphere, this.settings);
      for (let i = 0; i < limit; i += 1) {
        const offset = i * 4;
        sphere.center.set(spheres[offset], spheres[offset + 1], spheres[offset + 2]);
        sphere.radius = spheres[offset + 3];
        if (frustum.intersectsSphere(sphere)) output[visible++] = i;
      }
      return visible;
    }
    for (let i = 0; i < limit; i += 1) {
      this.matrix.fromArray(matrices, i * 16);
      sphere.copy(localSphere).applyMatrix4(this.matrix);
      sphere.radius = sphere.radius * this.settings.boundsScale + this.settings.boundsPadding;
      if (frustum.intersectsSphere(sphere)) output[visible++] = i;
    }
    return visible;
  }
}

// World-space culling spheres for one published placement array. Owners call
// invalidate() whenever they publish new matrices into the same array; the
// cache also rebuilds when the count, local bounds or padding change. Doubles
// keep the result identical to transforming the sphere on every cull.
export class InstanceSphereCache {
  constructor() {
    this.spheres = new Float64Array(0);
    this.valid = false;
    this.matrices = null;
    this.count = 0;
    this.local = new Sphere();
    this.boundsScale = NaN;
    this.boundsPadding = NaN;
    this.matrix = new Matrix4();
    this.sphere = new Sphere();
  }

  invalidate() {
    this.valid = false;
  }

  resolve(matrices, count, localSphere, settings) {
    if (this.valid && this.matrices === matrices && this.count === count
      && this.local.equals(localSphere)
      && this.boundsScale === settings.boundsScale && this.boundsPadding === settings.boundsPadding) {
      return this.spheres;
    }
    if (this.spheres.length < count * 4) this.spheres = new Float64Array(count * 4);
    const { spheres, matrix, sphere } = this;
    for (let i = 0; i < count; i += 1) {
      matrix.fromArray(matrices, i * 16);
      sphere.copy(localSphere).applyMatrix4(matrix);
      const offset = i * 4;
      spheres[offset] = sphere.center.x;
      spheres[offset + 1] = sphere.center.y;
      spheres[offset + 2] = sphere.center.z;
      spheres[offset + 3] = sphere.radius * settings.boundsScale + settings.boundsPadding;
    }
    this.valid = true;
    this.matrices = matrices;
    this.count = count;
    this.local.copy(localSphere);
    this.boundsScale = settings.boundsScale;
    this.boundsPadding = settings.boundsPadding;
    return spheres;
  }
}

// Remembers the instance selection last copied into a mesh's attributes so an
// unchanged selection from an unchanged source skips the copy and the upload.
// A count comparison is not enough: the same count can hold other instances.
export class InstanceSelectionMemo {
  constructor() {
    this.indices = new Uint32Array(0);
    this.count = -1;
    this.source = -1;
  }

  invalidate() {
    this.count = -1;
  }

  // True when `indices[0..count)` from source revision `source` is what was
  // last committed. Otherwise records it and returns false.
  matches(source, indices, count) {
    if (this.count === count && this.source === source) {
      let same = true;
      for (let i = 0; i < count; i += 1) {
        if (this.indices[i] !== indices[i]) { same = false; break; }
      }
      if (same) return true;
    }
    if (this.indices.length < count) this.indices = new Uint32Array(Math.max(count, this.indices.length * 2));
    for (let i = 0; i < count; i += 1) this.indices[i] = indices[i];
    this.count = count;
    this.source = source;
    return false;
  }
}
