import * as THREE from 'three/webgpu';
import { atan, attribute, cameraPosition, cos, dot, float, floor, fract, interleavedGradientNoise,
  mix, positionGeometry, screenCoordinate, sin, smoothstep, sqrt, texture, time,
  transformNormalToView, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import { getPresetAppearance } from '../rendering/PresetAppearance.js';
import { adventureCanopyColor } from '../rendering/AdventurePalette.js';
import { foliageBacklight, foliageLight } from '../rendering/CinematicLighting.js';
import { logger } from '../utils/logger.js';
import { TurnEnvelopeFrustum } from '../rendering/TurnEnvelopeFrustum.js';
import { SHADOW_LAYER } from '../world/TerrainShadowChunks.js';
import { characterOcclusionKeep } from '../rendering/CharacterOcclusion.js';
import {
  TREE_KINDS,
  TREE_LOD_DEFAULTS,
  VEGETATION_UPDATE_DEFAULTS,
  projectedTreeHeightPixels,
  vegetationLodScreenWeights,
  vegetationLodWeights,
} from './vegetationLodPolicy.js';
import { createPlantCards, plantCardNodes, setPlantCardsMeshReady } from './StaticPlantCards.js';
import { VegetationJob } from './vegetationRebuild.js';
import { isDetailedTreeImpostorQuality, resolveTreeImpostorSettings } from './TreeImpostorMaps.js';
import {
  createCinematicWindFieldNode,
  getSharedWindUniforms,
  resolveWindConfig,
} from '../weather/WindField.js';
import { vegetationStageDrawOrder } from '../rendering/drawOrder.js';
import { createInstanceMatrixAttribute } from '../rendering/instanceMatrices.js';

const names = ['full', 'medium', 'low', 'billboard'];
// Static per-billboard record. The LOD interval, the only part that changes
// with the camera, lives in its own attribute so a stable set uploads 8 bytes
// per billboard instead of the whole 104-byte record.
const BILLBOARD_INSTANCE_STRIDE = 24;
const BILLBOARD_RECORD_STRIDE = 18;
const VARIANT_STAGE_BATCH_SIZE = 256;
const WARMUP_DRAW_CAPACITY = 1;
// Warmup builds a remote draw at full size when its instance buffers stay
// under this: expanding a compact draw later replaces its meshes, and three
// compiles every new InstancedMesh again (its uuid is in the cache key), so a
// compact draw's warmup compile is thrown away and paid for mid-flight. The
// meadow and alpine trees fit (0.3 MB together); only big jungle stands stay
// compact.
const FULL_WARMUP_MAX_BYTES = 1 << 20;
// Floats per instance in a mesh draw: matrix 16, interval 2, tint 3, bend 2,
// up 3, origin 3, view 1.
const DRAW_INSTANCE_FLOATS = 30;
const DEFAULT_NORMAL_RETRY = Object.freeze({ maxAttempts: 3, delayMs: 1500 });
const BILLBOARD_OFFSETS = Object.freeze({
  tint: 0,
  origin: 3,
  center: 6,
  right: 9,
  up: 12,
  forward: 15,
  inverseX: 18,
  inverseZ: 21,
});
// Frustum.intersectsBox answers "not wholly outside". This answers "wholly
// inside" by testing the corner furthest against each plane normal: if that one
// is in front of every plane, so is the whole box. A chunk's bounds are the
// union of its records' sphere boxes, so a contained chunk holds no record the
// frustum could reject and the per-record sphere test can be skipped.
function frustumContainsBox(frustum, box) {
  const { min, max } = box;
  for (const plane of frustum.planes) {
    const { normal } = plane;
    const x = normal.x > 0 ? min.x : max.x;
    const y = normal.y > 0 ? min.y : max.y;
    const z = normal.z > 0 ? min.z : max.z;
    if (normal.x * x + normal.y * y + normal.z * z + plane.constant < 0) return false;
  }
  return true;
}
const triangles = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
// Every scene mesh a draw owns: its visible stage plus any shadow caster.
const drawMeshes = draw => draw.shadow ? [...draw.meshes, ...draw.shadow.meshes] : draw.meshes;
// New draws compile this many meshes per frame. Each new mesh costs a node
// build (~7 ms) on top of the preparation pass itself (~10 ms), and a tree
// draw carries 6-9 meshes: prepared at once they made the 70-90 ms frames
// seen flying over the alpine forest.
const PREPARE_MESHES_PER_FRAME = 1;
const nextFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

/**
 * Prepares `meshes` a slice per frame through `prepare`; the returned promise
 * settles once every slice is prepared (or rejects when `signal` aborts).
 */
export async function prepareInSlices(prepare, meshes, signal, perFrame = PREPARE_MESHES_PER_FRAME) {
  if (meshes.length <= perFrame) return prepare(meshes, signal);
  for (let index = 0; index < meshes.length; index += perFrame) {
    // A cancelled job settles at once, freeing the scheduler's prepare slot.
    signal?.throwIfAborted();
    if (index > 0) await nextFrame();
    signal?.throwIfAborted();
    await prepare(meshes.slice(index, index + perFrame), signal);
  }
  return undefined;
}
const INSTANCE_ATTRIBUTES = [
  ['lodInterval', 'interval'], ['lodTint', 'tint'], ['lodRootBend', 'bend'],
  ['lodUp', 'up'], ['lodOrigin', 'origin'], ['lodView', 'view'],
];

function markAttributeUpload(attr, count) {
  if (!attr) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

function coverageMask() {
  const interval = attribute('lodInterval', 'vec2');
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  return noise.greaterThanEqual(interval.x).and(noise.lessThan(interval.y));
}
function usesFantasyTreeWind(key, config) {
  const match = /^tree(\d+)$/.exec(key);
  if (!match) return false;
  const definition = config.trees?.types?.[Number(match[1]) - 1];
  return Boolean(definition?.highLeaves || definition?.leaves);
}

function usesCanopyShading(key, kind, entry, config) {
  if (!config.cinematic?.enabled || !TREE_KINDS.has(kind) || key.startsWith('jungle-')) return false;
  if (typeof entry?.canopyPalette === 'boolean') return entry.canopyPalette;
  const match = /^tree(\d+)$/.exec(key);
  if (!match) return false;
  return config.trees?.types?.[Number(match[1]) - 1]?.zone !== 'snow';
}
function approximateCanopyMask(rgb, settings) {
  const mask = settings.fallback;
  const maxChannel = rgb.r.max(rgb.g).max(rgb.b);
  const minChannel = rgb.r.min(rgb.g).min(rgb.b);
  const green = rgb.g.sub(rgb.r.mul(mask.greenRedWeight).add(rgb.b.mul(mask.greenBlueWeight)));
  const yellow = rgb.r.min(rgb.g).sub(rgb.b).mul(mask.yellowWeight);
  const chroma = maxChannel.sub(minChannel).mul(mask.chromaWeight);
  const signal = green.max(yellow).max(chroma);
  return smoothstep(mask.maskSignalLow, mask.maskSignalHigh, signal)
    .mul(smoothstep(mask.maskBrightnessLow, mask.maskBrightnessHigh, maxChannel));
}
function treeBillboardWindOffset(origin, right, forward, config, windUniforms) {
  if (!windUniforms || resolveWindConfig(config).model !== 'cinematic') return vec3(0, 0, 0);
  const sharedWind = getSharedWindUniforms();
  const response = resolveWindConfig(config).response.trees;
  const field = createCinematicWindFieldNode({
    positionXZ: origin.xz,
    timeNode: time,
    directionDegrees: sharedWind.directionDegrees,
    intensity: windUniforms.speed,
    simulationSpeed: windUniforms.simulationSpeed,
    noiseScale: sharedWind.noiseScale.mul(windUniforms.frequency),
    config,
  });
  const weight = uv().y.clamp(0, 1).pow(2);
  const bend = field.strength
    .mul(response.bendScale)
    .mul(windUniforms.strength)
    .mul(weight);
  const perpendicular = vec2(field.direction.y.negate(), field.direction.x);
  const flutter = field.flutter
    .mul(windUniforms.speed)
    .mul(response.flutterScale)
    .mul(weight);
  const localX = field.direction.x.mul(bend).add(perpendicular.x.mul(flutter));
  const localZ = field.direction.y.mul(bend).add(perpendicular.y.mul(flutter));
  return right.mul(localX).add(forward.mul(localZ));
}

function treeBillboardNodes(capture, config, windUniforms, customWind = null, kind = 'tree') {
  const origin = attribute('lodOrigin', 'vec3');
  const center = attribute('lodCenter', 'vec3');
  const sourceRight = attribute('lodRight', 'vec3');
  const sourceUp = attribute('lodUp', 'vec3');
  const sourceForward = attribute('lodForward', 'vec3');
  const delta = cameraPosition.sub(center);
  const angle = atan(
    delta.dot(attribute('lodInverseX', 'vec3')),
    delta.dot(attribute('lodInverseZ', 'vec3')),
  );
  const viewAngle = varying(angle);
  const right = sourceRight
    .mul(cos(angle))
    .sub(sourceForward.mul(sin(angle)));
  const windOffset = customWind
    ? customWind({ origin, right: sourceRight, forward: sourceForward, kind })
    : treeBillboardWindOffset(origin, sourceRight, sourceForward, config, windUniforms);
  const position = center
    .add(right.mul(positionGeometry.x.mul(capture.width)))
    .add(sourceUp.mul(positionGeometry.y.mul(capture.height)))
    .add(windOffset);
  const normalFromCapture = (normal) => {
    const c = cos(viewAngle), s = sin(viewAngle);
    const scaleX = sourceRight.length().max(0.0001);
    const scaleY = sourceUp.length().max(0.0001);
    const scaleZ = sourceForward.length().max(0.0001);
    const localX = normal.x.mul(c).add(normal.z.mul(s)).div(scaleX);
    const localY = normal.y.div(scaleY);
    const localZ = normal.z.mul(c).sub(normal.x.mul(s)).div(scaleZ);
    const worldNormal = sourceRight.normalize().mul(localX)
      .add(sourceUp.normalize().mul(localY))
      .add(sourceForward.normalize().mul(localZ))
      .normalize();
    return transformNormalToView(worldNormal);
  };
  return {
    position,
    angle: viewAngle,
    normalFromCapture,
    windEnabled: Boolean(customWind || windUniforms),
  };
}

function prepareTreeBillboardRecord(record, capture, matrix, inverse, center, target, offset) {
  matrix.fromArray(record.matrix);
  inverse.copy(matrix).invert();
  center.fromArray(capture.center).applyMatrix4(matrix);
  const source = record.matrix;
  const inverted = inverse.elements;
  target[offset] = center.x;
  target[offset + 1] = center.y;
  target[offset + 2] = center.z;
  target[offset + 3] = source[0];
  target[offset + 4] = source[1];
  target[offset + 5] = source[2];
  target[offset + 6] = source[4];
  target[offset + 7] = source[5];
  target[offset + 8] = source[6];
  target[offset + 9] = source[8];
  target[offset + 10] = source[9];
  target[offset + 11] = source[10];
  target[offset + 12] = inverted[0];
  target[offset + 13] = inverted[4];
  target[offset + 14] = inverted[8];
  target[offset + 15] = inverted[2];
  target[offset + 16] = inverted[6];
  target[offset + 17] = inverted[10];
}
function atlasMaterial(
  atlas,
  normalMask,
  capture,
  config,
  cards,
  alphaTest = 0.35,
  canopyShading = false,
  normalMapReady = true,
  prepareAppearance = null,
  appearanceContext = null,
) {
  const angle = cards?.angle ?? attribute('lodView', 'float');
  const view = fract(angle.div(Math.PI * 2).add(1)).mul(capture.views);
  const first = floor(view), next = first.add(1).mod(capture.views), fraction = fract(view);
  const gutter = Math.max(0, Number(capture.gutter) || 0);
  const inset = gutter > 0 ? (gutter + 0.5) / capture.tileSize : 1.5 / capture.tileSize;
  const tileUV = uv().mul(1 - inset * 2).add(inset);
  const sample = (map, index) => texture(map, vec2(tileUV.x.add(index).div(capture.views), tileUV.y));
  const a = sample(atlas, first), b = sample(atlas, next), alpha = mix(a.a, b.a, fraction);
  const sourceRgb = mix(a.rgb.mul(a.a), b.rgb.mul(b.a), fraction).div(alpha.max(0.001));
  const settings = resolveTreeImpostorSettings(config);
  let foliageMask = approximateCanopyMask(sourceRgb, settings);
  let detailedNormal = null;
  let mapReadyWeight = null;
  if (normalMask) {
    const packedA = sample(normalMask, first), packedB = sample(normalMask, next);
    const packedAlpha = mix(packedA.a, packedB.a, fraction);
    const packed = mix(
      packedA.rgb.mul(packedA.a),
      packedB.rgb.mul(packedB.a),
      fraction,
    ).div(packedAlpha.max(0.001));
    mapReadyWeight = uniform(normalMapReady ? 1 : 0);
    foliageMask = mix(foliageMask, packed.b.clamp(0, 1), mapReadyWeight);
    const normalXY = vec2(packed.r, packed.g).mul(2).sub(1);
    const normalZ = sqrt(float(1).sub(dot(normalXY, normalXY)).max(0.001));
    detailedNormal = vec3(normalXY.x, normalXY.y, normalZ).normalize();
  }

  const tint = attribute('lodTint', 'vec3');
  const sourceColor = sourceRgb.mul(tint);
  const canopyColor = canopyShading ? adventureCanopyColor(sourceRgb, config).mul(tint) : sourceColor;
  const rgb = canopyShading ? mix(sourceColor, canopyColor, foliageMask) : sourceColor;
  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.9,
    side: THREE.DoubleSide,
    alphaTest,
  });
  if (config.cinematic?.enabled && canopyShading) {
    material.roughnessNode = mix(float(0.9), float(0.82), foliageMask);
  }
  material.colorNode = vec4(rgb, alpha);
  if (config.cinematic?.enabled) {
    if (canopyShading) {
      material.emissiveNode = foliageBacklight(canopyColor, 0.8).mul(foliageMask);
      if (config.cinematic.style?.enabled) {
        material.emissiveNode = material.emissiveNode.add(
          canopyColor.mul(foliageLight.fill).mul(getPresetAppearance(config).foliageFill).mul(foliageMask),
        );
      }
    } else if (!cards?.normalFromCapture) {
      material.emissiveNode = foliageBacklight(rgb, 0.2);
    }
  }

  const flatNormal = cards?.normalFromCapture
    ? cards.normalFromCapture(vec3(0, 0, 1))
    : transformNormalToView(vec3(0, 1, 0));
  if (detailedNormal) {
    const transformedNormal = cards?.normalFromCapture
      ? cards.normalFromCapture(detailedNormal)
      : detailedNormal;
    const normalWeight = uniform(
      normalMapReady && isDetailedTreeImpostorQuality(config) ? 1 : 0,
    );
    material.normalNode = mix(flatNormal, transformedNormal, normalWeight).normalize();
    material.userData.impostorNormalControl = { normalWeight, mapReadyWeight };
  } else {
    material.normalNode = flatNormal;
  }
  material.alphaToCoverage = Boolean(config.cinematic?.enabled);
  material.maskNode = coverageMask();
  if (cards) {
    material.positionNode = cards.position;
    if (typeof cards.windEnabled === 'boolean') {
      material.userData.treeBillboardWindEnabled = cards.windEnabled;
    }
    if (cards.minimum) {
      const noise = interleavedGradientNoise(screenCoordinate.xy);
      material.maskNode = noise.greaterThanEqual(cards.minimum)
        .and(noise.lessThan(cards.maximum))
        .and(cards.density);
    }
  }
  if (prepareAppearance) {
    prepareAppearance(material, {
      sourceRgb,
      baseRgb: rgb,
      alpha,
      foliageMask,
      ...(appearanceContext ?? {}),
    });
  }
  return material;
}

// Occlusion bounds for one vegetation draw, built from the aggregate sphere the
// LOD update already maintains. Padding covers wind sway near the silhouette.
const occlusionScratch = new THREE.Vector3();
const OCCLUSION_PADDING = 2;

/** Shared four-stage renderer. World-space records are immutable; only compact GPU submissions change. */
export class VegetationLodRenderer {
  constructor({
    scene,
    config,
    chunkSize = TREE_LOD_DEFAULTS.chunkSize,
    prepareMaterial,
    policy,
    prepareAtlasMaterial = null,
    preparePlantBillboardWind = null,
    prepareTreeBillboardWind = null,
    windUniforms = null,
    viewportHeight = null,
    shadowCamera = null,
    fullWarmupMaxBytes = FULL_WARMUP_MAX_BYTES,
  }) {
    this.fullWarmupMaxBytes = fullWarmupMaxBytes;
    Object.assign(this, {
      scene,
      config,
      chunkSize,
      prepareMaterial,
      policy,
      prepareAtlasMaterial,
      preparePlantBillboardWind,
      prepareTreeBillboardWind,
    });
    this.viewportHeight = typeof viewportHeight === 'function' ? viewportHeight : null;
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    this.treeWindUniforms = windUniforms ?? {
      speed: uniform(finite(config.trees?.windSpeed, 0)),
      strength: uniform(finite(config.trees?.windStrength, 0)),
      frequency: uniform(finite(config.trees?.windFrequency, 1)),
      simulationSpeed: uniform(finite(config.trees?.simulationSpeed, 1)),
    };
    this.chunks = []; this.templates = []; this.resources = [];
    this.variantStages = new Set();
    this.shared = new Map(); this.sharedCapacity = new Map();
    this.normalQualityControls = []; this.normalControlsByKey = new Map();
    this.turnEnvelope = new TurnEnvelopeFrustum();
    this.frustum = this.turnEnvelope.frustum; this.projection = this.turnEnvelope.projectionView;
    this.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity); this.lastQuaternion = new THREE.Quaternion();
    this.lastProjection = new THREE.Matrix4();
    this.lastViewportHeight = -1;
    this.quality = 'high'; this.dirty = true; this.renderEnabled = true; this.weights = [0, 0, 0, 0];
    const update = config.vegetationLod?.update ?? VEGETATION_UPDATE_DEFAULTS;
    const moveThreshold = Number(update.cameraMoveThreshold);
    const rotationThreshold = Number(update.cameraRotationThreshold);
    const turnMargin = Number(update.cameraTurnMarginDegrees);
    this.cameraMoveThreshold = Number.isFinite(moveThreshold)
      ? Math.max(0, moveThreshold) : VEGETATION_UPDATE_DEFAULTS.cameraMoveThreshold;
    this.cameraRotationThreshold = Number.isFinite(rotationThreshold)
      ? Math.max(0, rotationThreshold) : VEGETATION_UPDATE_DEFAULTS.cameraRotationThreshold;
    this.cameraTurnMarginDegrees = Number.isFinite(turnMargin)
      ? Math.max(0, turnMargin) : VEGETATION_UPDATE_DEFAULTS.cameraTurnMarginDegrees;
    // Distance beyond which a vegetation draw stops casting a shadow. A tree
    // outside the sun's shadow region cannot contribute a visible shadow, so
    // distant LODs only multiply shadow-pass geometry. Zero disables the gate.
    const shadowDistance = Number(update.shadowCastDistance);
    this.shadowCastDistance = Number.isFinite(shadowDistance) && shadowDistance > 0 ? shadowDistance : 0;
    // Shared tree draws nearer than this stage cast their shadow from this
    // stage's mesh instead, drawn only by the sun's shadow camera. Shadows need
    // silhouette, not wood detail. Null keeps each stage casting its own mesh.
    const shadowLevel = Number(update.shadowLodLevel);
    this.shadowLodLevel = shadowCamera && Number.isInteger(shadowLevel) && shadowLevel > 0 && shadowLevel < 3
      ? shadowLevel : null;
    if (this.shadowLodLevel !== null) shadowCamera.layers.enable(SHADOW_LAYER);
    this.nearRecords = [];
    this.scheduler = null;
    this.jobPrefix = THREE.MathUtils.generateUUID();
    this.prepareDraws = null;
    this.deferDrawConstruction = false;
    this.drawJobs = new Set();
    this.drawGeneration = 0;
    // Plant-card construction (an instance stream per chunk) is not #buildDraw,
    // so it debits the scheduler on its own class when one is attached.
    this.cardJobs = new Set();
    this.pendingCards = new Map();
    this.cardGeneration = 0;
    this.stats = { full: 0, medium: 0, low: 0, billboard: 0, triangles: 0, visibleInstances: 0, visibleChunks: 0, bookkeepingMs: 0, byKind: {} };
  }

  setRenderEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderEnabled === next) return;
    this.renderEnabled = next;
    if (!next) {
      for (const draw of this.shared.values()) for (const mesh of drawMeshes(draw)) mesh.visible = false;
      for (const chunk of this.chunks) {
        if (chunk.cards) chunk.cards.mesh.visible = false;
        for (const draw of chunk.draws) if (draw) for (const mesh of draw.meshes) mesh.visible = false;
      }
      return;
    }
    this.dirty = true;
  }

  setScheduler(scheduler, { prepare } = {}) {
    if (this.scheduler && this.scheduler !== scheduler) {
      this.#cancelDrawJobs();
      for (const id of this.cardJobs) this.scheduler.cancel(id);
    }
    this.scheduler = scheduler ?? null;
    this.prepareDraws = prepare ?? null;
    this.deferDrawConstruction = Boolean(scheduler);
  }
  createVariantStage({
    key,
    kind = 'tree',
    full,
    asset,
    records,
    excludeFromReflection = false,
    castShadow = true,
  }) {
    if (!records?.length) return null;
    const stage = {
      key,
      kind,
      full,
      asset,
      records,
      excludeFromReflection,
      castShadow,
      resources: [],
      normalControls: [],
      groups: new Map(),
      chunks: [],
      templates: null,
      billboardData: null,
      inverseData: null,
      ready: false,
      committed: false,
      disposed: false,
      iterator: null,
    };
    stage.iterator = this.#buildVariantStage(stage);
    this.variantStages.add(stage);
    return stage;
  }

  *#buildVariantStage(stage) {
    const {
      key, kind, full, asset, records, excludeFromReflection, castShadow,
    } = stage;
    const levels = [full, asset?.levels[1], asset?.levels[2], null];
    const plant = this.policy(records[0], kind, this.quality).plant;
    const plantNodes = plant && asset?.atlas && asset.entry.capture
      ? plantCardNodes(asset.entry.capture, this.preparePlantBillboardWind, kind)
      : null;
    const treeCardNodes = !plant && TREE_KINDS.has(kind) && asset?.atlas && asset.entry.capture
      ? treeBillboardNodes(
        asset.entry.capture,
        this.config,
        usesFantasyTreeWind(key, this.config) ? this.treeWindUniforms : null,
        this.prepareTreeBillboardWind,
        kind,
      )
      : null;
    const atlasNodes = plantNodes ?? treeCardNodes;
    if (asset?.atlas && asset.entry.capture) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = atlasMaterial(
        asset.atlas,
        asset.normalMask,
        asset.entry.capture,
        this.config,
        atlasNodes,
        Number(asset.entry.alphaCutoff) || 0.35,
        usesCanopyShading(key, kind, asset.entry, this.config),
        asset.normalMask ? (asset.normalMaskReady?.() ?? true) : false,
        this.prepareAtlasMaterial,
        { key, kind },
      );
      if (material.userData.impostorNormalControl) {
        stage.normalControls.push({
          ...material.userData.impostorNormalControl,
          ensure: asset.ensureNormalMask ?? null,
          ready: asset.normalMaskReady ?? null,
          key,
          loading: false,
          failed: false,
          attempts: 0,
          nextRetryAt: 0,
          retryTimer: null,
        });
      }
      levels[3] = [{ geometry, material, atlas: true }];
      stage.resources.push(() => { geometry.dispose(); material.dispose(); });
    }
    stage.templates = levels.map((parts, level) => parts?.map(part => {
      const source = Array.isArray(part.material) ? part.material : [part.material];
      const materials = source.map(material => {
        if (part.atlas) return material;
        const prepared = this.prepareMaterial(material, { kind, name: part.name, level });
        prepared.opacity = 1; prepared.opacityNode = float(1); prepared.alphaHash = false;
        const mask = coverageMask();
        // Leaves and branches in front of the player dither away; shadows keep
        // only the LOD coverage, so the canopy's shadow is never cut.
        const visibleMask = mask.and(characterOcclusionKeep());
        prepared.maskNode = prepared.maskNode ? prepared.maskNode.and(visibleMask) : visibleMask;
        prepared.maskShadowNode = prepared.maskShadowNode ? prepared.maskShadowNode.and(mask) : mask;
        stage.resources.push(() => prepared.dispose());
        return prepared;
      });
      return { geometry: part.geometry, material: Array.isArray(part.material) ? materials : materials[0] };
    }) ?? null);
    yield;

    if (treeCardNodes) stage.billboardData = new Float32Array(records.length * BILLBOARD_RECORD_STRIDE);
    else if (!plantNodes && asset?.atlas && asset.entry.capture) stage.inverseData = new Float32Array(records.length * 16);

    const recordBounds = new THREE.Box3();
    const billboardMatrix = new THREE.Matrix4();
    const billboardInverse = new THREE.Matrix4();
    const billboardCenter = new THREE.Vector3();
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex];
      const cell = `${Math.floor(record.position.x / this.chunkSize)},${Math.floor(record.position.z / this.chunkSize)}`;
      let chunk = stage.groups.get(cell);
      if (!chunk) {
        chunk = {
          key,
          cell,
          kind,
          templates: stage.templates,
          available: stage.templates.map(Boolean),
          cardNodes: plantNodes,
          treeCardNodes,
          excludeFromReflection,
          castShadow,
          capture: asset?.entry.capture,
          records: [],
          recordIndices: [],
          billboardData: stage.billboardData,
          inverseData: stage.inverseData,
          maxHeight: 0,
          bounds: new THREE.Box3(),
          draws: [null, null, null, null],
        };
        stage.groups.set(cell, chunk);
      }
      if (treeCardNodes) {
        prepareTreeBillboardRecord(
          record,
          asset.entry.capture,
          billboardMatrix,
          billboardInverse,
          billboardCenter,
          stage.billboardData,
          recordIndex * BILLBOARD_RECORD_STRIDE,
        );
      } else if (stage.inverseData) {
        billboardMatrix.fromArray(record.matrix);
        billboardInverse.copy(billboardMatrix).invert();
        stage.inverseData.set(billboardInverse.elements, recordIndex * 16);
      }
      chunk.records.push(record);
      chunk.recordIndices.push(recordIndex);
      chunk.maxHeight = Math.max(chunk.maxHeight, record.height ?? record.sphere.radius * 2);
      chunk.bounds.union(record.sphere.getBoundingBox(recordBounds));
      if ((recordIndex + 1) % VARIANT_STAGE_BATCH_SIZE === 0) yield;
    }

    stage.chunks = [...stage.groups.values()];
    for (const chunk of stage.chunks) chunk.bounds.expandByScalar(3);
    stage.ready = true;
  }

  commitVariantStage(stage) {
    if (!stage || stage.committed) return;
    if (stage.disposed || !stage.ready) throw new Error('Vegetation variant stage is not ready to commit.');
    this.templates.push(stage.templates);
    this.sharedCapacity.set(stage.key, (this.sharedCapacity.get(stage.key) ?? 0) + stage.records.length);
    this.resources.push(...stage.resources);
    for (const control of stage.normalControls) {
      this.normalQualityControls.push(control);
      const controls = this.normalControlsByKey.get(control.key) ?? [];
      controls.push(control);
      this.normalControlsByKey.set(control.key, controls);
    }
    for (const chunk of stage.chunks) {
      this.chunks.push(chunk);
      if (!chunk.cardNodes) continue;
      if (this.scheduler && this.deferDrawConstruction) this.#requestCards(chunk);
      else this.#buildCards(chunk);
    }
    stage.committed = true;
    stage.resources = [];
    stage.normalControls = [];
    this.variantStages.delete(stage);
    this.dirty = true;
  }

  disposeVariantStage(stage) {
    if (!stage || stage.committed || stage.disposed) return;
    stage.disposed = true;
    for (const release of stage.resources) release();
    stage.resources = [];
    stage.normalControls = [];
    stage.groups.clear();
    stage.chunks.length = 0;
    this.variantStages.delete(stage);
  }

  addVariant(options) {
    const stage = this.createVariantStage(options);
    if (!stage) return;
    for (const _step of stage.iterator) continue;
    this.commitVariantStage(stage);
  }

  setQuality(name) {
    if (this.quality !== name) {
      this.#cancelDrawJobs();
      for (const draw of [...this.shared.values(), ...this.chunks.flatMap(chunk => chunk.draws)]) {
        if (draw) draw.failed = false;
      }
      for (const chunk of this.chunks) chunk.cardsFailed = false;
    }
    this.quality = name;
    const detailedNormals = isDetailedTreeImpostorQuality(this.config, name);
    for (const control of this.normalQualityControls) {
      const ready = control.ready?.() ?? !control.ensure;
      control.mapReadyWeight.value = ready ? 1 : 0;
      control.normalWeight.value = detailedNormals && ready ? 1 : 0;
    }
    this.dirty = true;
  }

  #ensureDetailedNormals(key) {
    if (!isDetailedTreeImpostorQuality(this.config, this.quality)) return;
    const configured = this.config.vegetationLod?.impostorNormalRetry ?? DEFAULT_NORMAL_RETRY;
    const attemptsValue = Number(configured.maxAttempts);
    const maxAttempts = Number.isInteger(attemptsValue) && attemptsValue > 0
      ? attemptsValue : DEFAULT_NORMAL_RETRY.maxAttempts;
    const delayValue = Number(configured.delayMs);
    const delayMs = Number.isFinite(delayValue) && delayValue >= 0
      ? delayValue : DEFAULT_NORMAL_RETRY.delayMs;
    const currentTime = globalThis.performance?.now?.() ?? Date.now();
    for (const control of this.normalControlsByKey.get(key) ?? []) {
      const ready = control.ready?.() ?? !control.ensure;
      if (ready) {
        if (control.retryTimer) globalThis.clearTimeout(control.retryTimer);
        control.retryTimer = null;
        control.mapReadyWeight.value = 1;
        control.normalWeight.value = 1;
        control.failed = false;
        control.attempts = 0;
        control.nextRetryAt = 0;
        continue;
      }
      if (!control.ensure || control.loading) continue;
      if (control.failed && (control.attempts >= maxAttempts || currentTime < control.nextRetryAt)) continue;
      if (control.retryTimer) globalThis.clearTimeout(control.retryTimer);
      control.retryTimer = null;
      control.failed = false;
      control.loading = true;
      control.attempts += 1;
      control.ensure().then(() => {
        if (control.retryTimer) globalThis.clearTimeout(control.retryTimer);
        control.retryTimer = null;
        if (this.disposed) return;
        control.failed = false;
        control.attempts = 0;
        control.nextRetryAt = 0;
        control.mapReadyWeight.value = 1;
        control.normalWeight.value = isDetailedTreeImpostorQuality(this.config, this.quality) ? 1 : 0;
      }).catch((error) => {
        control.failed = true;
        control.nextRetryAt = (globalThis.performance?.now?.() ?? Date.now()) + delayMs;
        if (control.attempts < maxAttempts) {
          control.retryTimer = globalThis.setTimeout(() => {
            control.retryTimer = null;
            if (this.disposed) return;
            control.failed = false;
            control.nextRetryAt = 0;
            this.dirty = true;
          }, delayMs);
        }
        if (!this.disposed) logger.warn(`Tree impostor normal map unavailable: ${control.key}`, error);
      }).finally(() => {
        control.loading = false;
      });
    }
  }
  prepareAll({ compiled = true } = {}) {
    const deferred = this.deferDrawConstruction;
    this.deferDrawConstruction = false;
    try {
      // Opening-view draws were already created at production capacity by
      // prepareNearby(). Remote layouts use a one-instance buffer for shader
      // warmup and expand cooperatively before their first gameplay use.
      for (const chunk of this.chunks) {
        if (chunk.cards) chunk.cards.mesh.userData.skipWarmup = false;
        for (let level = 0; level < 4; level++) {
          if (!chunk.templates[level] || (level === 3 && chunk.cardNodes)) continue;
          let draw = this.#lookupDraw(chunk, level);
          if (!draw) draw = this.#createDraw(chunk, level, { compact: this.#warmupCompact(chunk, level) });
          if (!draw.count) for (const mesh of draw.meshes) mesh.visible = false;
          draw.compiled = compiled;
          draw.prepared = draw.compact ? false : compiled;
        }
      }
    } finally {
      this.deferDrawConstruction = deferred;
    }
  }
  unpreparedMeshes() {
    const meshes = [];
    for (const draw of [...this.shared.values(), ...this.chunks.flatMap((chunk) => chunk.draws)]) {
      if (draw && draw.prepared === false) meshes.push(...drawMeshes(draw));
    }
    return meshes;
  }
  prepareNearby(camera, travelDistance = 12) {
    const deferred = this.deferDrawConstruction;
    this.deferDrawConstruction = false;
    try {
    // Prepare only mesh stages reachable on the first walk/turn. Lazy creation
    // at a threshold otherwise compiles pipelines in a visible gameplay frame.
    this.turnEnvelope.update(camera, this.cameraTurnMarginDegrees);
    const sphere = new THREE.Sphere();
    const viewportHeight = this.#resolveViewportHeight();
    const warmWeights = [0, 0, 0, 0];
    for (const chunk of this.chunks) {
      if (chunk.cardNodes && !chunk.cards) continue;
      if (chunk.cards) {
        const settings = this.policy(chunk.records[0], chunk.kind, this.quality);
        const chunkDistance = chunk.bounds.distanceToPoint(camera.position);
        if (chunkDistance - travelDistance >= settings.far) continue;
        const blend = settings.blend ?? 0.15;
        const turnRange = (settings.centers?.[0] ?? 0) * (1 + blend) + travelDistance;
        chunk.bounds.getBoundingSphere(sphere);
        sphere.radius += travelDistance;
        if (chunkDistance <= turnRange || this.frustum.intersectsSphere(sphere)) {
          chunk.cards.mesh.userData.skipWarmup = false;
        }
        continue;
      }
      for (const record of chunk.records) {
        const settings = this.policy(record, chunk.kind, this.quality);
        const distance = record.position.distanceTo(camera.position);
        if (distance - travelDistance >= settings.far) continue;
        const blend = settings.blend ?? 0.15;
        const centers = settings.centers ?? [];
        const turnRange = (centers[centers.length - 1] ?? 0) * (1 + blend) + travelDistance;
        sphere.copy(record.sphere); sphere.radius += travelDistance;
        const inOpeningView = this.frustum.intersectsSphere(sphere);
        if (distance > turnRange && !inOpeningView) continue;

        const warm = [false, false, false, false];
        const view = camera.matrixWorldInverse.elements;
        const { x, y, z } = record.sphere.center;
        const viewDepth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
        const baseDepth = inOpeningView ? viewDepth : distance;
        for (const offset of [-travelDistance, 0, travelDistance]) {
          const sampleDistance = Math.max(0, distance + offset);
          if (settings.screenHeights?.length) {
            const sampleDepth = Math.max(camera.near, baseDepth + offset);
            const projectedHeight = projectedTreeHeightPixels(
              record.height,
              sampleDepth,
              camera.projectionMatrix.elements[5],
              viewportHeight,
            );
            vegetationLodScreenWeights(projectedHeight, sampleDistance, settings, warmWeights);
          } else {
            vegetationLodWeights(sampleDistance, settings, warmWeights);
          }
          for (let level = 0; level < 4; level++) warm[level] ||= warmWeights[level] > 0;
        }
        for (let level = 0; level < 4; level++) {
          if (!warm[level] || !chunk.templates[level]) continue;
          if (level === 3) this.#ensureDetailedNormals(chunk.key);
          const draw = this.#draw(chunk, level);
          if (!draw.count) for (const mesh of draw.meshes) mesh.visible = false;
          draw.prepared = true;
        }
      }
    }
    } finally {
      this.deferDrawConstruction = deferred;
    }
  }
  #drawKey(chunk, level) {
    const sharedTreeDraw = TREE_KINDS.has(chunk.kind) && !chunk.cards;
    if (sharedTreeDraw || (level === 3 && !chunk.cards)) {
      return sharedTreeDraw ? `${chunk.key}:${level}` : chunk.key;
    }
    return `${chunk.key}:${chunk.cell}:${level}`;
  }

  #lookupDraw(chunk, level) {
    const sharedTreeDraw = TREE_KINDS.has(chunk.kind) && !chunk.cards;
    if (sharedTreeDraw || (level === 3 && !chunk.cards)) {
      return this.shared.get(this.#drawKey(chunk, level)) ?? null;
    }
    return chunk.draws[level] ?? null;
  }

  #storeDraw(chunk, level, draw) {
    const sharedTreeDraw = TREE_KINDS.has(chunk.kind) && !chunk.cards;
    if (sharedTreeDraw || (level === 3 && !chunk.cards)) this.shared.set(this.#drawKey(chunk, level), draw);
    else chunk.draws[level] = draw;
    return draw;
  }

  #cancelDrawJobs() {
    if (!this.scheduler) {
      this.drawJobs.clear();
      return;
    }
    for (const id of this.drawJobs) this.scheduler.cancel(id);
    this.drawJobs.clear();
    this.drawGeneration += 1;
  }

  #requestDraw(chunk, level) {
    if (!this.scheduler) return;
    const id = `draw:${this.jobPrefix}:${this.#drawKey(chunk, level)}`;
    if (this.drawJobs.has(id) || this.scheduler.pending(id)) return;
    this.drawJobs.add(id);
    const generation = this.drawGeneration;
    this.scheduler.replace(id, new VegetationJob({
      class: 'draw',
      owner: chunk.key,
      generation,
      bounds: chunk.bounds,
      visibleRange: this.policy(chunk.records[0], chunk.kind, this.quality).far,
      generate: () => this.#generateDraw(chunk, level),
      prepare: this.prepareDraws
        ? (signal) => {
          const draw = this.#lookupDraw(chunk, level);
          if (!draw || this.disposed) return;
          const cast = chunk.castShadow && level < 2
            && this.quality !== 'performance' && this.quality !== 'balanced';
          for (const mesh of draw.meshes) mesh.castShadow = cast && !draw.shadow;
          return prepareInSlices(this.prepareDraws, drawMeshes(draw), signal);
        }
        : null,
      publish: () => {
        this.drawJobs.delete(id);
        const draw = this.#lookupDraw(chunk, level);
        if (!draw || this.disposed || generation !== this.drawGeneration) return;
        draw.prepared = true;
        for (const mesh of drawMeshes(draw)) {
          mesh.userData.renderPrepared = true;
          if (!mesh.parent) this.scene.add(mesh);
        }
        this.dirty = true;
      },
      onSettled: (job) => {
        this.drawJobs.delete(id);
        if (job.failed) {
          const draw = this.#lookupDraw(chunk, level);
          if (draw) draw.failed = true;
          console.error('Vegetation draw preparation failed.', job.error);
        }
        this.dirty = true;
      },
    }));
  }

  *#generateDraw(chunk, level) {
    if (this.disposed) return;
    const existing = this.#lookupDraw(chunk, level);
    if (existing) {
      if (!existing.compact) return;
      this.#expandDraw(existing);
      existing.prepared = false;
      yield existing;
      return;
    }
    const draw = this.#createDraw(chunk, level);
    draw.prepared = false;
    yield draw;
  }

  // One plant-card instance stream plus its near-mesh CPU cells. Shared by the
  // synchronous loading path and the scheduler's generate step.
  #createCards(chunk) {
    const cards = createPlantCards(chunk, this.deferDrawConstruction ? null : this.scene);
    setPlantCardsMeshReady(cards, !this.deferDrawConstruction);
    const cells = new Map();
    for (const record of chunk.records) {
      const key = `${Math.floor(record.position.x / 32)},${Math.floor(record.position.z / 32)}`;
      let cell = cells.get(key);
      if (!cell) { cell = { bounds: new THREE.Box3(), records: [] }; cells.set(key, cell); }
      cell.records.push(record); cell.bounds.expandByPoint(record.position);
    }
    return { cards, nearCells: [...cells.values()] };
  }

  #buildCards(chunk) {
    const built = this.#createCards(chunk);
    chunk.cards = built.cards;
    chunk.nearCells = built.nearCells;
    return built.cards;
  }

  *#generateCards(chunk) {
    if (this.disposed || chunk.cards) return;
    yield this.#createCards(chunk);
  }

  #requestCards(chunk) {
    if (!this.scheduler) return;
    const id = `cards:${this.jobPrefix}:${chunk.key}:${chunk.cell}`;
    if (this.cardJobs.has(id) || this.scheduler.pending(id)) return;
    this.cardJobs.add(id);
    const generation = this.cardGeneration;
    let built = null;
    this.scheduler.replace(id, new VegetationJob({
      class: 'cards',
      owner: chunk.key,
      generation,
      bounds: chunk.bounds,
      visibleRange: this.policy(chunk.records[0], chunk.kind, this.quality).far,
      generate: () => this.#generateCards(chunk),
      consume: (value) => { built = value; this.pendingCards.set(id, value.cards.mesh); },
      prepare: this.prepareDraws
        ? (signal) => {
          if (!built || this.disposed) return;
          return this.prepareDraws([built.cards.mesh], signal);
        }
        : null,
      publish: () => {
        this.cardJobs.delete(id);
        this.pendingCards.delete(id);
        if (this.disposed || !built || generation !== this.cardGeneration) return;
        chunk.cards = built.cards;
        this.scene.add(chunk.cards.mesh);
        if (!this.renderEnabled) chunk.cards.mesh.visible = false;
        chunk.nearCells = built.nearCells;
        chunk.cards.mesh.userData.renderPrepared = true;
        this.dirty = true;
      },
      onSettled: (job) => {
        this.cardJobs.delete(id);
        this.pendingCards.delete(id);
        if (!job.published && built) {
          built.cards.mesh.removeFromParent();
          built.cards.mesh.geometry.dispose();
        }
        if (job.failed) {
          chunk.cardsFailed = true;
          console.error('Vegetation card preparation failed.', job.error);
        }
        this.dirty = true;
      },
    }));
  }

  #disposePendingCards() {
    for (const mesh of this.pendingCards.values()) { mesh.removeFromParent(); mesh.geometry.dispose(); }
    this.pendingCards.clear();
  }

  #targetDrawCapacity(chunk, level) {
    const sharedTreeDraw = TREE_KINDS.has(chunk.kind) && !chunk.cards;
    return sharedTreeDraw || (level === 3 && !chunk.cards)
      ? Math.max(64, 2 ** Math.ceil(Math.log2(this.sharedCapacity.get(chunk.key) ?? 64)))
      : Math.max(64, 2 ** Math.ceil(Math.log2(chunk.records.length)));
  }

  #warmupCompact(chunk, level) {
    const casters = TREE_KINDS.has(chunk.kind) && !chunk.cards && level === 0 && chunk.castShadow ? 2 : 1;
    return this.#targetDrawCapacity(chunk, level) * DRAW_INSTANCE_FLOATS * 4 * casters > this.fullWarmupMaxBytes;
  }

  #createDraw(chunk, level, { compact = false } = {}) {
    const targetCapacity = this.#targetDrawCapacity(chunk, level);
    const capacity = compact ? Math.min(WARMUP_DRAW_CAPACITY, targetCapacity) : targetCapacity;
    const draw = this.#buildDraw(chunk, level, capacity);
    draw.capacity = capacity;
    draw.targetCapacity = targetCapacity;
    draw.compact = capacity < targetCapacity;
    return this.#storeDraw(chunk, level, draw);
  }

  #draw(chunk, level) {
    // Trees are culled by chunk and record on the CPU, then compacted into one
    // variant-level instance batch per LOD. This keeps spatial culling while
    // removing the draw-call multiplier from visible spatial chunks.
    const existing = this.#lookupDraw(chunk, level);
    if (existing) {
      if (existing.compact) {
        existing.prepared = false;
        if (this.deferDrawConstruction) this.#requestDraw(chunk, level);
        else {
          this.#expandDraw(existing);
          existing.prepared = true;
        }
      } else if (existing.prepared === false && !existing.failed && this.deferDrawConstruction) {
        this.#requestDraw(chunk, level);
      }
      return existing;
    }
    if (this.deferDrawConstruction) {
      this.#requestDraw(chunk, level);
      return null;
    }
    return this.#createDraw(chunk, level);
  }

  #prefetchChunk(chunk, camera, viewportHeight, settings, distance) {
    if (!this.deferDrawConstruction) return;
    // A turn margin prepares bands before the current frustum first asks for
    // them. This remains a soft lookahead, not a promise of ready assets after
    // arbitrary teleportation or a slow network/driver.
    const lookahead = 64;
    if (distance > settings.far + lookahead) return;
    for (let level = 0; level < 4; level++) {
      if (!chunk.templates[level] || (level === 3 && chunk.cardNodes)) continue;
      let range = settings.far;
      if (level < 3) {
        const threshold = settings.screenHeights?.[level];
        range = threshold > 0
          ? chunk.maxHeight * Math.abs(camera.projectionMatrix.elements[5]) * viewportHeight
            / (2 * threshold * (1 - (settings.blend ?? 0.15)))
          : (settings.centers?.[level] ?? settings.far) * (1 + (settings.blend ?? 0.15));
      }
      if (distance <= Math.min(settings.far, range) + lookahead) this.#draw(chunk, level);
    }
  }
  #createDrawBuffers(level, gpuBillboard, capacity) {
    let matrices = null, interval = null, tint = null, bend = null, up = null, origin = null, view = null;
    let billboardInstances = null;
    const billboardAttributes = new Map();
    if (gpuBillboard) {
      billboardInstances = new THREE.InstancedInterleavedBuffer(
        new Float32Array(capacity * BILLBOARD_INSTANCE_STRIDE),
        BILLBOARD_INSTANCE_STRIDE,
      );
      interval = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      billboardAttributes.set('lodInterval', interval);
      for (const [name, size, offset] of [
        ['lodTint', 3, BILLBOARD_OFFSETS.tint],
        ['lodOrigin', 3, BILLBOARD_OFFSETS.origin],
        ['lodCenter', 3, BILLBOARD_OFFSETS.center],
        ['lodRight', 3, BILLBOARD_OFFSETS.right],
        ['lodUp', 3, BILLBOARD_OFFSETS.up],
        ['lodForward', 3, BILLBOARD_OFFSETS.forward],
        ['lodInverseX', 3, BILLBOARD_OFFSETS.inverseX],
        ['lodInverseZ', 3, BILLBOARD_OFFSETS.inverseZ],
      ]) {
        billboardAttributes.set(name, new THREE.InterleavedBufferAttribute(
          billboardInstances,
          size,
          offset,
        ));
      }
    } else {
      matrices = createInstanceMatrixAttribute(capacity);
      interval = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      bend = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      up = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      origin = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      if (level === 3) view = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    }
    return {
      matrices, interval, tint, bend, up, origin, view, billboardInstances, billboardAttributes,
    };
  }

  // Grown buffers go into new meshes. Three builds a mesh's render object once,
  // keyed by the mesh and its geometry, and keeps reading the attribute and
  // instance buffers it was built with: swapping buffers into the same mesh
  // left an expanded draw reading its old, smaller buffers. Stale LOD
  // intervals then dithered whole trees away (alpine trees faded out when
  // approached) until some unrelated change happened to force a rebuild.
  #applyDrawBuffers(draw, buffers) {
    Object.assign(draw, buffers);
    draw.recordRefs.length = 0;
    draw.staticChanged = true;
    draw.meshes = draw.meshes.map(mesh => this.#rebuildMesh(mesh, buffers, draw.gpuBillboard));
  }

  #rebuildMesh(old, buffers, gpuBillboard) {
    const replaced = new Set([
      ...INSTANCE_ATTRIBUTES.map(([name]) => name),
      ...(gpuBillboard ? buffers.billboardAttributes.keys() : []),
    ]);
    const geometry = gpuBillboard ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(old.geometry.attributes)) if (!replaced.has(name)) geometry.setAttribute(name, attr);
    geometry.setIndex(old.geometry.index);
    for (const group of old.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    let mesh;
    if (gpuBillboard) {
      for (const [name, attr] of buffers.billboardAttributes) geometry.setAttribute(name, attr);
      geometry.instanceCount = 0;
      mesh = new THREE.Mesh(geometry, old.material);
    } else {
      for (const [name, key] of INSTANCE_ATTRIBUTES) if (buffers[key]) geometry.setAttribute(name, buffers[key]);
      mesh = new THREE.InstancedMesh(geometry, old.material, buffers.matrices.count);
      mesh.instanceMatrix = buffers.matrices;
      mesh.count = 0;
      mesh.boundingSphere = old.boundingSphere?.clone() ?? new THREE.Sphere();
    }
    mesh.name = old.name;
    mesh.renderOrder = old.renderOrder;
    mesh.frustumCulled = old.frustumCulled;
    mesh.castShadow = old.castShadow;
    mesh.receiveShadow = old.receiveShadow;
    mesh.layers.mask = old.layers.mask;
    mesh.visible = false;
    mesh.userData = { ...old.userData };
    const parent = old.parent;
    if (parent) {
      parent.add(mesh);
      parent.remove(old);
    }
    return mesh;
  }

  #expandDraw(draw) {
    if (!draw.compact) return;
    const buffers = this.#createDrawBuffers(draw.level, draw.gpuBillboard, draw.targetCapacity);
    this.#applyDrawBuffers(draw, buffers);
    if (draw.shadow) {
      this.#applyDrawBuffers(draw.shadow, this.#createDrawBuffers(draw.shadow.level, false, draw.targetCapacity));
      draw.shadow.capacity = draw.targetCapacity;
    }
    draw.capacity = draw.targetCapacity;
    draw.compact = false;
  }

  #buildDraw(chunk, level, capacity) {
    const sharedTreeDraw = TREE_KINDS.has(chunk.kind) && !chunk.cards;
    // #commitDraw explicitly versions changed data. DynamicDrawUsage makes
    // Three upload it again on every render pass, even after that version was
    // consumed (and after the first pass cleared the limited update range).
    const gpuBillboard = level === 3 && Boolean(chunk.treeCardNodes);
    const buffers = this.#createDrawBuffers(level, gpuBillboard, capacity);
    const meshes = chunk.templates[level].map(template => {
      const geometry = gpuBillboard
        ? new THREE.InstancedBufferGeometry()
        : new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(template.geometry.attributes)) geometry.setAttribute(name, attr);
      geometry.setIndex(template.geometry.index?.clone() ?? null);
      for (const group of template.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      if (gpuBillboard) {
        for (const [name, attr] of buffers.billboardAttributes) geometry.setAttribute(name, attr);
        geometry.instanceCount = 0;
      } else {
        for (const [name, key] of INSTANCE_ATTRIBUTES) if (buffers[key]) geometry.setAttribute(name, buffers[key]);
      }
      const mesh = gpuBillboard
        ? new THREE.Mesh(geometry, template.material)
        : new THREE.InstancedMesh(geometry, template.material, capacity);
      if (!gpuBillboard) {
        mesh.instanceMatrix = buffers.matrices;
        mesh.count = 0;
        mesh.boundingSphere = new THREE.Sphere();
      }
      mesh.frustumCulled = level < 3;
      mesh.name = `${chunk.key}:${names[level]}`;
      mesh.renderOrder = vegetationStageDrawOrder(level);
      mesh.castShadow = chunk.castShadow && level < 2; mesh.receiveShadow = level < 3;
      mesh.userData.excludeFromReflection = chunk.excludeFromReflection || level === 3;
      // Spatially local mesh stages carry accurate world-space bounds and can
      // participate in whole-draw occlusion. Shared tree batches span many
      // chunks, but one indirect command cannot cull their instances separately,
      // so keep those global draws out of the candidate set.
      mesh.userData.occlusionCull = level < 3 && !sharedTreeDraw ? undefined : false;
      mesh.visible = false;
      if (!this.deferDrawConstruction) this.scene.add(mesh);
      return mesh;
    });
    // One shadow caster per tree variant, owned by its full stage: every tree
    // drawn at full or medium detail within shadow range casts once, solid,
    // from the cheaper stage. (Per-stage proxies doubled the draws and cast a
    // cross-fading tree's shadow twice, each dithered.) Its layer keeps it out
    // of the main and reflection cameras.
    const shadowLevel = this.shadowLodLevel;
    const shadow = sharedTreeDraw && shadowLevel !== null && level === 0
      && chunk.castShadow && chunk.templates[shadowLevel]
      ? this.#buildShadowCaster(chunk, shadowLevel, capacity)
      : null;
    return {
      key: chunk.key,
      meshes,
      shadow,
      ...buffers,
      gpuBillboard,
      level,
      castShadow: chunk.castShadow,
      bounds: new THREE.Box3(),
      recordRefs: [],
      staticChanged: true,
      count: 0,
    };
  }

  #buildShadowCaster(chunk, level, capacity) {
    const buffers = this.#createDrawBuffers(level, false, capacity);
    const meshes = chunk.templates[level].map(template => {
      const geometry = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(template.geometry.attributes)) geometry.setAttribute(name, attr);
      geometry.setIndex(template.geometry.index?.clone() ?? null);
      for (const group of template.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      for (const [name, key] of INSTANCE_ATTRIBUTES) if (buffers[key]) geometry.setAttribute(name, buffers[key]);
      const mesh = new THREE.InstancedMesh(geometry, template.material, capacity);
      mesh.instanceMatrix = buffers.matrices;
      mesh.count = 0;
      mesh.boundingSphere = new THREE.Sphere();
      mesh.name = `${chunk.key}:shadow`;
      mesh.layers.set(SHADOW_LAYER);
      mesh.castShadow = true; mesh.receiveShadow = false;
      mesh.userData.excludeFromReflection = true; mesh.userData.occlusionCull = false;
      mesh.visible = false;
      if (!this.deferDrawConstruction) this.scene.add(mesh);
      return mesh;
    });
    return {
      meshes, ...buffers, level, capacity, count: 0, bounds: new THREE.Box3(), recordRefs: [], staticChanged: true,
    };
  }

  // Adds a tree to its variant's shadow caster: one solid instance per tree,
  // whatever stages it is cross-fading between.
  #castTreeShadow(shadow, record) {
    if (shadow.count >= shadow.capacity) return;
    const index = shadow.count++;
    if (shadow.recordRefs[index] !== record) {
      shadow.recordRefs[index] = record;
      shadow.staticChanged = true;
      shadow.matrices.array.set(record.matrix, index * 16);
      shadow.interval.setXY(index, 0, 1);
      shadow.tint.setXYZ(index, record.tint?.r ?? 1, record.tint?.g ?? 1, record.tint?.b ?? 1);
      shadow.bend.setXY(index, record.bend?.x ?? 0, record.bend?.y ?? 0);
      shadow.up.setXYZ(index, record.matrix[4], record.matrix[5], record.matrix[6]);
      shadow.origin.setXYZ(index, record.position.x, record.position.y, record.position.z);
    }
    const { center, radius } = record.sphere, { min, max } = shadow.bounds;
    min.x = Math.min(min.x, center.x - radius); min.y = Math.min(min.y, center.y - radius); min.z = Math.min(min.z, center.z - radius);
    max.x = Math.max(max.x, center.x + radius); max.y = Math.max(max.y, center.y + radius); max.z = Math.max(max.z, center.z + radius);
  }

  #commitDraw(draw, stats) {
    // Every index below count keeps the values last uploaded unless it was
    // rewritten this update, and each rewrite flags its group, so unchanged
    // groups need no upload even when count changed.
    if (draw.staticChanged || draw.intervalChanged) markAttributeUpload(draw.interval, draw.count);
    if (draw.gpuBillboard) {
      if (draw.staticChanged) {
        draw.billboardInstances.clearUpdateRanges();
        draw.billboardInstances.addUpdateRange(0, draw.count * BILLBOARD_INSTANCE_STRIDE);
        draw.billboardInstances.needsUpdate = true;
      }
    } else {
      if (draw.level === 3) {
        markAttributeUpload(draw.matrices, draw.count);
        markAttributeUpload(draw.view, draw.count);
      } else if (draw.staticChanged) {
        markAttributeUpload(draw.matrices, draw.count);
      }
      if (draw.staticChanged) {
        markAttributeUpload(draw.tint, draw.count);
        markAttributeUpload(draw.bend, draw.count);
        markAttributeUpload(draw.up, draw.count);
        markAttributeUpload(draw.origin, draw.count);
      }
    }
    for (const mesh of draw.meshes) stats.triangles += triangles(mesh.geometry) * draw.count;
  }

  #setDrawCount(draw) {
    for (const mesh of draw.meshes) {
      if (draw.gpuBillboard) mesh.geometry.instanceCount = draw.count;
      else mesh.count = draw.count;
      mesh.visible = draw.count > 0 && draw.prepared !== false;
    }
    if (draw.shadow) for (const mesh of draw.shadow.meshes) mesh.count = draw.shadow.count;
  }

  // Casting follows quality and distance. Stages below the shadow stage hand
  // the cast to their variant's shadow caster and never enter the shadow pass.
  #applyCastShadow(draw, castShadow, camera) {
    const allowed = castShadow && draw.level < 2 && this.quality !== 'performance'
      && this.quality !== 'balanced';
    const caster = this.shadowLodLevel !== null && draw.level < this.shadowLodLevel
      ? this.shared.get(`${draw.key}:0`)?.shadow ?? null
      : null;
    const cast = allowed && !caster && (!draw.meshes[0] || this.#withinShadowDistance(draw.meshes[0], camera));
    for (const mesh of draw.meshes) mesh.castShadow = cast;
    const shadow = draw.shadow;
    if (!shadow) return;
    let visible = allowed && shadow.count > 0 && draw.prepared !== false;
    if (visible) {
      const sphere = shadow.meshes[0].boundingSphere;
      shadow.bounds.getBoundingSphere(sphere);
      for (const mesh of shadow.meshes) if (mesh !== shadow.meshes[0]) mesh.boundingSphere.copy(sphere);
      visible = this.#withinShadowDistance(shadow.meshes[0], camera);
    }
    for (const mesh of shadow.meshes) mesh.visible = visible;
    if (visible && shadow.staticChanged) {
      for (const key of ['matrices', 'interval', 'tint', 'bend', 'up', 'origin']) markAttributeUpload(shadow[key], shadow.count);
    }
  }

  #resolveViewportHeight() {
    const screenSpace = this.config.trees?.lod?.screenSpace;
    // With a reference height the thresholds are a fraction of the screen, so a
    // larger window or a zoomed-out browser keeps the same trees at each level
    // instead of promoting more of them to Full (the frame's biggest cost).
    const reference = Number(screenSpace?.referenceViewportHeight);
    if (Number.isFinite(reference) && reference > 0) return reference;
    const fallback = Number(screenSpace?.fallbackViewportHeight ?? 1080);
    const requested = Number(this.viewportHeight?.());
    return Number.isFinite(requested) && requested > 0 ? requested : fallback;
  }

  // World-space box for the occlusion pass, from the aggregate draw sphere. The
  // view culler and occlusion test both read it, so it must track the instances
  // actually submitted this frame; invisible draws are skipped by traversal.
  #updateOcclusionBounds(mesh, level) {
    if (level >= 3) return;
    const sphere = mesh.boundingSphere;
    if (!sphere) return;
    const box = mesh.userData.occlusionBounds ?? new THREE.Box3();
    box.setFromCenterAndSize(sphere.center, occlusionScratch.setScalar(sphere.radius * 2))
      .expandByScalar(OCCLUSION_PADDING);
    mesh.userData.occlusionBounds = box;
  }

  // A draw casts shadows only while it is close enough to matter; the gate is
  // disabled (always true) unless a positive shadow distance is configured.
  #withinShadowDistance(mesh, camera) {
    const limit = this.shadowCastDistance;
    if (!(limit > 0)) return true;
    const sphere = mesh.boundingSphere;
    if (!sphere) return true;
    return sphere.center.distanceTo(camera.position) - sphere.radius <= limit;
  }

  update(camera, force = false) {
    if (this.disposed || !this.renderEnabled) return this.stats;
    const viewportHeight = this.#resolveViewportHeight();
    const viewportChanged = Math.abs(viewportHeight - this.lastViewportHeight) >= 0.5;
    const moved = camera.position.distanceToSquared(this.lastPosition)
      >= this.cameraMoveThreshold * this.cameraMoveThreshold;
    const rotated = 1 - Math.abs(camera.quaternion.dot(this.lastQuaternion))
      >= this.cameraRotationThreshold;
    if (!force && !this.dirty && !moved && !rotated && !viewportChanged
      && camera.projectionMatrix.equals(this.lastProjection)) return this.stats;
    const start = performance.now(); this.dirty = false;
    this.lastPosition.copy(camera.position); this.lastQuaternion.copy(camera.quaternion);
    this.lastProjection.copy(camera.projectionMatrix); this.lastViewportHeight = viewportHeight;
    this.turnEnvelope.update(camera, this.cameraTurnMarginDegrees);
    const stats = this.stats;
    for (const key of ['full', 'medium', 'low', 'billboard', 'triangles', 'visibleInstances', 'visibleChunks']) stats[key] = 0;
    stats.byKind = {};
    for (const draw of this.shared.values()) {
      draw.count = 0;
      draw.staticChanged = false;
      draw.intervalChanged = false;
      draw.bounds.makeEmpty();
      if (draw.shadow) {
        draw.shadow.count = 0;
        draw.shadow.staticChanged = false;
        draw.shadow.bounds.makeEmpty();
      }
      for (const mesh of drawMeshes(draw)) mesh.visible = false;
    }
    for (const chunk of this.chunks) {
      if (chunk.cards) chunk.cards.mesh.visible = false;
      for (const draw of chunk.draws) if (draw) {
        draw.count = 0;
        draw.staticChanged = false;
        draw.intervalChanged = false;
        draw.bounds.makeEmpty();
        for (const mesh of draw.meshes) mesh.visible = false;
      }
      let chunkPolicy = null;
      let chunkDistance = null;
      if (this.deferDrawConstruction) {
        chunkPolicy = this.policy(chunk.records[0], chunk.kind, this.quality);
        chunkDistance = chunk.bounds.distanceToPoint(camera.position);
        this.#prefetchChunk(chunk, camera, viewportHeight, chunkPolicy, chunkDistance);
      }
      // A card chunk whose billboard stream is still on the scheduler has no
      // representation yet; it must not fall through to per-level mesh draws.
      if (chunk.cardNodes && !chunk.cards) {
        if (!chunk.cardsFailed) this.#requestCards(chunk);
        continue;
      }
      if (!this.frustum.intersectsBox(chunk.bounds)) continue;
      const chunkCulled = !frustumContainsBox(this.frustum, chunk.bounds);
      chunkPolicy ??= this.policy(chunk.records[0], chunk.kind, this.quality);
      chunkDistance ??= chunk.bounds.distanceToPoint(camera.position);
      if (chunkDistance >= chunkPolicy.far) continue;
      if (chunk.cards) {
        const { centers, blend, far, density = 1 } = chunkPolicy;
        chunk.cards.ranges.value.set(centers[0] * (1 - blend), centers[0] * (1 + blend), far, density);
        chunk.cards.mesh.visible = true;
        const nearDraw = this.#lookupDraw(chunk, 0);
        setPlantCardsMeshReady(chunk.cards, Boolean(nearDraw && nearDraw.prepared !== false));
        const count = chunk.records.length;
        stats.billboard += count; stats.triangles += count * 2; stats.visibleInstances += count;
        stats.byKind[chunk.kind] = (stats.byKind[chunk.kind] ?? 0) + count;
        // Distant chunks require no per-stem CPU work or buffer uploads on movement.
        if (chunkDistance >= centers[0] * (1 + blend)) { stats.visibleChunks++; continue; }
      }
      const available = chunk.available;
      for (let level = 0; level < available.length; level += 1) {
        available[level] = Boolean(chunk.templates[level]);
      }
      let chunkVisible = false;
      let records = chunk.records;
      const shadowLevel = this.shadowLodLevel;
      const castsTreeShadows = shadowLevel !== null && TREE_KINDS.has(chunk.kind) && !chunk.cards && chunk.castShadow;
      if (chunk.cards) {
        records = this.nearRecords; records.length = 0;
        const range = chunkPolicy.centers[0] * (1 + chunkPolicy.blend);
        for (const cell of chunk.nearCells) if (cell.bounds.distanceToPoint(camera.position) < range) {
          for (const record of cell.records) records.push(record);
        }
      }
      for (let recordOffset = 0; recordOffset < records.length; recordOffset += 1) {
        const record = records[recordOffset];
        const sourceRecordIndex = records === chunk.records ? chunk.recordIndices[recordOffset] : -1;
        if (chunkCulled && !this.frustum.intersectsSphere(record.sphere)) continue;
        const distance = record.position.distanceTo(camera.position);
        if (chunk.cards && distance >= chunkPolicy.centers[0] * (1 + chunkPolicy.blend)) continue;
        const settings = this.policy(record, chunk.kind, this.quality);
        if (distance >= settings.far || record.fraction > (settings.density ?? 1)) continue;
        // Reuse policy records; spreading one object per visible jungle stem creates
        // tens of thousands of temporary objects each camera update.
        settings.available = settings.plant ? undefined : available;
        let weights;
        if (!settings.plant && settings.screenHeights?.length) {
          const view = camera.matrixWorldInverse.elements;
          const { x, y, z } = record.sphere.center;
          const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
          const projectedHeight = projectedTreeHeightPixels(
            record.height,
            Math.max(camera.near, depth),
            camera.projectionMatrix.elements[5],
            viewportHeight,
          );
          weights = vegetationLodScreenWeights(projectedHeight, distance, settings, this.weights);
        } else {
          weights = vegetationLodWeights(distance, settings, this.weights);
        }
        // A plant has only full geometry and a billboard, and the policy already places
        // its weights in those slots. Without an atlas the near mesh covers the range.
        if (settings.plant && !available[3]) { weights[0] += weights[3]; weights[3] = 0; }
        if (!settings.plant && weights[3] > 0 && available[3]) this.#ensureDetailedNormals(chunk.key);
        // Missing preparation must not punch holes in a transitioning tree.
        // Request the intended stages, retaining a prepared stage's coverage.
        for (let level = 0; level < 4; level++) {
          if (!(weights[level] > 0) || !available[level] || (level === 3 && chunk.cards)) continue;
          const desired = this.#draw(chunk, level);
          if (desired && desired.prepared !== false) continue;
          if (chunk.cards) { weights[level] = 0; continue; }
          let fallback = -1;
          for (let offset = 1; offset < 4 && fallback < 0; offset++) {
            for (const candidate of [level - offset, level + offset]) {
              if (candidate < 0 || candidate > 3) continue;
              const draw = this.#lookupDraw(chunk, candidate);
              if (draw && draw.prepared !== false) { fallback = candidate; break; }
            }
          }
          if (fallback >= 0) { weights[fallback] += weights[level]; weights[level] = 0; }
        }
        let total = 0, shown = false, castsShadow = false;
        for (let level = 0; level < 4; level++) {
          if (level === 3 && chunk.cardNodes) continue;
          const weight = weights[level];
          if (!(weight > 0) || !available[level]) continue;
          const draw = this.#draw(chunk, level);
          if (!draw || draw.prepared === false) continue;
          const index = draw.count++;
          const recordChanged = draw.recordRefs[index] !== record;
          if (recordChanged) {
            draw.recordRefs[index] = record;
            draw.staticChanged = true;
          }
          if (level < 3) {
            const { center, radius } = record.sphere, { min, max } = draw.bounds;
            min.x = Math.min(min.x, center.x - radius); min.y = Math.min(min.y, center.y - radius); min.z = Math.min(min.z, center.z - radius);
            max.x = Math.max(max.x, center.x + radius); max.y = Math.max(max.y, center.y + radius); max.z = Math.max(max.z, center.z + radius);
          }
          const intervalStart = Math.fround(total);
          total += weight;
          const intervals = draw.interval.array, intervalOffset = index * 2, intervalEnd = Math.fround(total);
          if (intervals[intervalOffset] !== intervalStart || intervals[intervalOffset + 1] !== intervalEnd) {
            intervals[intervalOffset] = intervalStart;
            intervals[intervalOffset + 1] = intervalEnd;
            draw.intervalChanged = true;
          }
          if (draw.gpuBillboard) {
            const data = draw.billboardInstances.array;
            const offset = index * BILLBOARD_INSTANCE_STRIDE;
            if (recordChanged) {
              data[offset + BILLBOARD_OFFSETS.tint] = record.tint?.r ?? 1;
              data[offset + BILLBOARD_OFFSETS.tint + 1] = record.tint?.g ?? 1;
              data[offset + BILLBOARD_OFFSETS.tint + 2] = record.tint?.b ?? 1;
              data[offset + BILLBOARD_OFFSETS.origin] = record.position.x;
              data[offset + BILLBOARD_OFFSETS.origin + 1] = record.position.y;
              data[offset + BILLBOARD_OFFSETS.origin + 2] = record.position.z;
              const sourceOffset = sourceRecordIndex * BILLBOARD_RECORD_STRIDE;
              for (let value = 0; value < BILLBOARD_RECORD_STRIDE; value += 1) {
                data[offset + BILLBOARD_OFFSETS.center + value] = chunk.billboardData[sourceOffset + value];
              }
            }
          } else {
            if (recordChanged) {
              if (level < 3) draw.matrices.array.set(record.matrix, index * 16);
              draw.tint.setXYZ(index, record.tint?.r ?? 1, record.tint?.g ?? 1, record.tint?.b ?? 1);
              draw.bend.setXY(index, record.bend?.x ?? 0, record.bend?.y ?? 0);
              draw.up.setXYZ(index, record.matrix[4], record.matrix[5], record.matrix[6]);
              draw.origin.setXYZ(index, record.position.x, record.position.y, record.position.z);
            }
            if (level === 3) {
              const inverseOffset = sourceRecordIndex * 16;
              const inverse = chunk.inverseData;
              const localX = inverse[inverseOffset] * camera.position.x
                + inverse[inverseOffset + 4] * camera.position.y
                + inverse[inverseOffset + 8] * camera.position.z
                + inverse[inverseOffset + 12];
              const localZ = inverse[inverseOffset + 2] * camera.position.x
                + inverse[inverseOffset + 6] * camera.position.y
                + inverse[inverseOffset + 10] * camera.position.z
                + inverse[inverseOffset + 14];
              const center = chunk.capture.center;
              const angle = Math.atan2(localX - center[0], localZ - center[2]);
              draw.view.setX(index, angle);
              const m = record.matrix, out = draw.matrices.array, offset = index * 16;
              const c = Math.cos(angle), s = Math.sin(angle), { width, height } = chunk.capture;
              for (let row = 0; row < 3; row++) {
                out[offset + row] = (m[row] * c - m[8 + row] * s) * width;
                out[offset + 4 + row] = m[4 + row] * height;
                out[offset + 8 + row] = m[row] * s + m[8 + row] * c;
                out[offset + 12 + row] = m[row] * center[0] + m[4 + row] * center[1] + m[8 + row] * center[2] + m[12 + row];
              }
            }
          }
          stats[names[level]]++; shown = chunkVisible = true;
          if (shadowLevel !== null && level < shadowLevel) castsShadow = true;
        }
        // The caster lives on the full stage, created (or, when deferred,
        // requested) here even for a variant seen only at medium detail. Until
        // it is expanded and prepared the tree casts from the next update.
        const shadowHost = castsShadow && castsTreeShadows ? this.#draw(chunk, 0) : null;
        if (shadowHost?.shadow && !shadowHost.compact && shadowHost.prepared !== false) {
          this.#castTreeShadow(shadowHost.shadow, record);
        }
        if (shown && !chunk.cards) { stats.visibleInstances++; stats.byKind[chunk.kind] = (stats.byKind[chunk.kind] ?? 0) + 1; }
      }
      if (chunkVisible || chunk.cards) stats.visibleChunks++;
      for (let level = 0; level < 4; level++) {
        const draw = chunk.draws[level]; if (!draw) continue;
        this.#setDrawCount(draw);
        for (const mesh of draw.meshes) {
          if (level < 3 && draw.count) {
            draw.bounds.getBoundingSphere(mesh.boundingSphere);
            if (mesh.userData.occlusionCull !== false) this.#updateOcclusionBounds(mesh, level);
          }
          mesh.castShadow = chunk.castShadow && level < 2 && this.quality !== 'performance'
            && this.quality !== 'balanced' && this.#withinShadowDistance(mesh, camera);
        }
        if (draw.count) this.#commitDraw(draw, stats);
      }
    }
    for (const draw of this.shared.values()) {
      this.#setDrawCount(draw);
      for (const mesh of draw.meshes) {
        if (draw.level < 3 && draw.count) {
          draw.bounds.getBoundingSphere(mesh.boundingSphere);
          if (mesh.userData.occlusionCull !== false) this.#updateOcclusionBounds(mesh, draw.level);
        }
      }
      this.#applyCastShadow(draw, draw.castShadow, camera);
      if (draw.count) this.#commitDraw(draw, stats);
    }
    stats.bookkeepingMs = performance.now() - start;
    return stats;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.#cancelDrawJobs();
    // Card jobs are independent of quality, so they are only abandoned here.
    this.cardGeneration += 1;
    for (const id of this.cardJobs) this.scheduler?.cancel(id);
    this.cardJobs.clear();
    this.#disposePendingCards();
    for (const chunk of this.chunks) if (chunk.cards) { chunk.cards.mesh.removeFromParent(); chunk.cards.mesh.geometry.dispose(); }
    const draws = [...this.chunks.flatMap(chunk => chunk.draws), ...this.shared.values()];
    for (const stage of [...this.variantStages]) this.disposeVariantStage(stage);
    for (const draw of draws) if (draw) for (const mesh of drawMeshes(draw)) {
      mesh.removeFromParent(); mesh.geometry.dispose(); mesh.dispose?.();
    }
    this.shared.clear(); this.sharedCapacity.clear(); this.normalControlsByKey.clear();
    for (const control of this.normalQualityControls) {
      if (control.retryTimer) globalThis.clearTimeout(control.retryTimer);
    }
    this.normalQualityControls.length = 0;
    this.nearRecords.length = 0;
    for (const release of this.resources) release();
    this.resources.length = this.chunks.length = this.templates.length = 0;
  }
}
