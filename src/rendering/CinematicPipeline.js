import {
  RenderPipeline, FloatType, RedFormat, NearestFilter, Vector2, Vector3, MathUtils, ACESFilmicToneMapping, AgXToneMapping,
} from 'three/webgpu';
import {
  pass, renderOutput, vec4, vec3, vec2, uniform, mix, dot, uv, smoothstep, float, fract, sin, screenCoordinate, time,
  mrt, output, velocity, Fn, If, Loop, step, perspectiveDepthToViewZ, atan, interleavedGradientNoise,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { GpuOcclusion } from './GpuOcclusion.js';
import { createDepthNormals } from './DepthNormals.js';
import { EffectTarget } from './EffectTarget.js';
import { withSceneWarmup } from './SceneWarmup.js';
import { isPostEffect, resolvePostEffects } from './postEffects.js';
import {
  accountComposite,
  applyCpuMarks,
  resetCpuStats,
  wrapNodeUpdateBefore,
} from '../debug/cinematicCpuBreakdown.js';

const _sunDirection = new Vector3();
const _sunPoint = new Vector3();
const _forward = new Vector3();
// Toggles that only change a uniform; everything else rebuilds the graph.
const UNIFORM_EFFECTS = new Set(['grain', 'vignette']);
const STREAK_LANES = 96;
// View distances (world units) over which screen-space AO fades out.
const AO_FADE_START = 120;
const AO_FADE_END = 260;
// Light shafts are low-frequency, so both of their passes run at a quarter of
// the screen's width and height and upsample bilinearly for free.
const SHAFT_RESOLUTION = 0.25;
// Offsets, in low-resolution texels, of the depth taps each mask texel takes,
// so thin silhouettes do not flicker in and out of a single nearest tap.
const SHAFT_MASK_TAPS = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];

export class CinematicPipeline {
  constructor(world, config) {
    this.world = world;
    this.settings = config.cinematic?.post;
    this.enabled = Boolean(config.cinematic?.enabled);
    this.gpuOcclusion = new GpuOcclusion(world, config.cinematic?.occlusion);
    this.cpu = resetCpuStats({});
    this.hookedNodes = new WeakSet();
    this.effects = resolvePostEffects(this.settings);
    if (!this.enabled) return;
    this.post = new RenderPipeline(world.renderer);
    this.post.outputColorTransform = false;
    this.stages = {};
    this.transient = [];
    this.quality = config.ui.initialQuality;
    this.occlusionScale = 1;
    this.aoStrength = uniform(this.settings.aoStrength);
    const post = this.settings;
    this.grade = {
      saturation: uniform(post.saturation ?? 1),
      contrast: uniform(post.contrast ?? 1),
      lift: uniform(new Vector3().fromArray(post.lift ?? [0, 0, 0])),
      gain: uniform(new Vector3().fromArray(post.gain ?? [1, 1, 1])),
      highlightDesaturation: uniform(post.highlightDesaturation ?? 0),
      vignette: uniform(0),
      grain: uniform(0),
      streaks: uniform(0),
    };
    this.clip = { near: uniform(0.1), far: uniform(1000) };
    this.shafts = {
      uv: uniform(new Vector2(0.5, 0.5)),
      color: uniform(new Vector3()),
      intensity: uniform(0),
      aspect: uniform(1),
      boost: 0,
    };
    this.focus = {
      distance: uniform(post.depthOfField?.focusDistance ?? 6),
      range: uniform(post.depthOfField?.focalRange ?? 28),
      bokeh: uniform(post.depthOfField?.bokehScale ?? 1),
    };
    this.sharpness = uniform(post.sharpness ?? 0.6);
    this.#applyUniformEffects();
    this.setQuality(this.quality);
  }

  // Filmic grade in linear light ahead of the output tonemapper:
  // saturation, pivot-preserving contrast, a lift/gain split that cools
  // shadows and warms highlights, highlight desaturation so sunlit grass
  // bleaches toward white instead of neon, a soft vignette and animated grain.
  #grade(input) {
    const luma = vec3(0.2126, 0.7152, 0.0722);
    const saturated = mix(vec3(dot(input, luma)), input, this.grade.saturation);
    const pivot = float(0.18);
    const contrasted = saturated.sub(pivot).mul(this.grade.contrast).add(pivot).max(0);
    const shaped = contrasted.mul(this.grade.gain).add(this.grade.lift.mul(contrasted.oneMinus().max(0)));
    const shapedLuma = dot(shaped, luma);
    const rolled = mix(shaped, vec3(shapedLuma), smoothstep(0.55, 1.4, shapedLuma).mul(this.grade.highlightDesaturation));
    const vignette = smoothstep(0.18, 0.95, uv().sub(0.5).length()).mul(this.grade.vignette).oneMinus();
    const grain = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233)).add(time.fract().mul(43758.5453))).mul(43758.5453))
      .sub(0.5).mul(this.grade.grain);
    // Speed streaks: sparse radial dashes racing outward at the frame edge.
    const centered = uv().sub(0.5);
    const radius = centered.length();
    const lanes = atan(centered.y, centered.x).mul(STREAK_LANES / (Math.PI * 2)).add(STREAK_LANES);
    const laneSeed = fract(sin(lanes.floor().mul(91.7)).mul(43758.5453));
    const laneWidth = lanes.fract().sub(0.5).abs().mul(2).oneMinus().pow(6);
    const dash = fract(radius.mul(2.2).sub(time.mul(2.8)).add(laneSeed.mul(9)));
    const streak = Fn(() => {
      const value = float(0).toVar();
      If(this.grade.streaks.greaterThan(0), () => {
        value.assign(smoothstep(0.62, 1, laneSeed).mul(laneWidth).mul(smoothstep(0.55, 0.9, dash))
          .mul(smoothstep(0.24, 0.62, radius)).mul(this.grade.streaks));
      });
      return value;
    })();
    return rolled.mul(vignette).mul(streak.mul(0.55).add(1)).add(streak.mul(0.05)).add(grain).max(0);
  }

  setSpeedStreaks(value) {
    if (!this.enabled) return;
    this.grade.streaks.value = MathUtils.clamp(Number(value) || 0, 0, 4);
  }

  // One scene pass per antialiasing mode, created on first use. TRAA needs a
  // single-sample target plus a velocity attachment and jitters the camera itself.
  #stage(temporal) {
    const key = temporal ? 'temporal' : 'multisample';
    if (this.stages[key]) return this.stages[key];
    const { scene, camera } = this.world;
    // Coverage samples stabilize moving subpixel blades; FXAA alone cannot.
    const scenePass = pass(scene, camera, { samples: temporal ? 0 : this.settings.samples ?? 4 });
    if (temporal) scenePass.setMRT(mrt({ output, velocity }));
    const color = scenePass.getTextureNode('output');
    // r185 still issues an invalid mip-level query for multisampled depth in
    // GTAO. Resolve to color and explicitly reconstruct scalar-depth normals.
    const depth = new EffectTarget(scenePass.getTextureNode('depth').r, {
      type: FloatType, format: RedFormat, minFilter: NearestFilter, magFilter: NearestFilter,
    });
    const normals = createDepthNormals(depth, camera);
    const occlusion = ao(depth, normals, camera);
    occlusion.radius.value = this.settings.aoRadius;
    occlusion.thickness.value = 1;
    occlusion.resolutionScale = 0.5;
    const resolve = temporal
      ? traa(color, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera)
      : null;
    this.stages[key] = { scenePass, depth, normals, occlusion, resolve, beauty: resolve ?? color, bloom: null };
    return this.stages[key];
  }

  // Screen-space light shafts in two quarter-resolution passes. The first
  // marks open sky (the sky dome writes no depth), brightest around the sun,
  // so rays spill from the sun's surroundings rather than from all of the sky.
  // The second marches each texel toward the sun's screen point over that
  // mask, jittered to hide banding. Together they cost about two texture reads
  // per screen pixel. The result is added in scene radiance, ahead of the
  // tonemapper, so bright shafts roll off with everything else.
  #lightShafts(stage) {
    if (stage.shaftOutput) {
      this.shafts.passes = stage.shaftPasses;
      return stage.shaftOutput;
    }
    const { depth } = stage;
    const samples = this.settings.lightShafts?.samples ?? 32;
    const decay = this.settings.lightShafts?.decay ?? 0.96;
    const sourceRadius = this.settings.lightShafts?.sourceRadius ?? 0.45;
    const normalization = (1 - decay) / (1 - decay ** samples);
    const { uv: sunUv, aspect } = this.shafts;

    const mask = new EffectTarget(Fn(() => {
      const texel = vec2(1).div(depth.size(0).toVec2().mul(SHAFT_RESOLUTION));
      const sky = float(0).toVar();
      for (const [x, y] of SHAFT_MASK_TAPS) {
        sky.addAssign(step(0.99999, depth.sample(uv().add(texel.mul(vec2(x, y)))).r));
      }
      const offset = uv().sub(sunUv).mul(vec2(aspect, 1));
      const nearSun = offset.length().div(sourceRadius).oneMinus().max(0);
      return vec4(sky.mul(0.25).mul(nearSun.mul(nearSun)), 0, 0, 1);
    })());
    mask.setResolutionScale(SHAFT_RESOLUTION);

    const march = new EffectTarget(Fn(() => {
      const coord = uv().toVar();
      const stepUv = sunUv.sub(coord).div(samples);
      coord.addAssign(stepUv.mul(interleavedGradientNoise(screenCoordinate)));
      const sum = float(0).toVar();
      const weight = float(1).toVar();
      Loop(samples, () => {
        coord.addAssign(stepUv);
        sum.addAssign(mask.sample(coord).r.mul(weight));
        weight.mulAssign(decay);
      });
      return vec4(sum.mul(normalization), 0, 0, 1);
    })());
    march.setResolutionScale(SHAFT_RESOLUTION);

    stage.shaftPasses = [mask, march];
    this.shafts.passes = stage.shaftPasses;
    for (const node of stage.shaftPasses) node.isActive = () => this.warming || this.shafts.intensity.value > 0;
    stage.shaftOutput = this.shafts.color.mul(march.sample(uv()).r.mul(this.shafts.intensity));
    return stage.shaftOutput;
  }

  // Extra shaft strength over snow country, where the valley mist gives the
  // light something to catch in. `weight` is the snow-country weight.
  setShaftAtmosphere(weight) {
    if (!this.enabled) return;
    const value = Number(weight);
    this.shafts.boost = Number.isFinite(value) ? MathUtils.clamp(value, 0, 1) : 0;
  }

  #track(node) {
    this.transient.push(node);
    return node;
  }

  #build() {
    for (const node of this.transient) node.dispose?.();
    this.transient = [];
    const lean = this.quality === 'performance';
    const temporal = this.effects.taa;
    const stage = this.#stage(temporal);
    this.stage = stage;
    let lit = stage.beauty.rgb;
    if (!lean) {
      // Past a few hundred metres the depth buffer is too coarse for GTAO,
      // which then prints a regular lattice over open ground; fade it out.
      const viewDistance = perspectiveDepthToViewZ(stage.depth.r, this.clip.near, this.clip.far).negate();
      const aoFade = smoothstep(AO_FADE_END, AO_FADE_START, viewDistance);
      lit = lit.mul(mix(1, stage.occlusion.r, this.aoStrength.mul(aoFade)));
      if (this.effects.bloom) {
        stage.bloom ??= bloom(stage.beauty, this.settings.bloomStrength, 0.3, this.settings.bloomThreshold);
        lit = lit.add(stage.bloom.rgb);
      }
      if (this.effects.lightShafts) lit = lit.add(this.#lightShafts(stage));
    }
    let hdr = vec4(lit, stage.beauty.a);
    if (!lean && this.effects.depthOfField) {
      const viewZ = perspectiveDepthToViewZ(stage.depth.r, this.clip.near, this.clip.far);
      hdr = this.#track(dof(this.#track(new EffectTarget(hdr)), viewZ, this.focus.distance, this.focus.range, this.focus.bokeh));
    }
    const toneMapping = this.effects.tonemapper === 'agx' ? AgXToneMapping : ACESFilmicToneMapping;
    let display = renderOutput(vec4(this.#grade(hdr.rgb), hdr.a), toneMapping);
    if (this.effects.sharpen) display = this.#track(sharpen(this.#track(new EffectTarget(display)), this.sharpness));
    // High/Ultra already use multisample coverage and TAA resolves its own
    // edges. A second FXAA pass there only softens foliage detail.
    const smoothEdges = !temporal && (lean || this.quality === 'balanced' || (this.settings.samples ?? 4) < 2);
    if (smoothEdges) display = this.#track(fxaa(display.isTextureNode ? display : this.#track(new EffectTarget(display))));
    this.post.outputNode = display;
    this.post.needsUpdate = true;
  }

  #applyUniformEffects() {
    this.grade.vignette.value = this.effects.vignette ? this.settings.vignette ?? 0 : 0;
    this.grade.grain.value = this.effects.grain ? this.settings.grain ?? 0 : 0;
  }

  setQuality(name) {
    if (!this.post) return;
    this.quality = name;
    this.#applyOcclusionStrength();
    this.#build();
  }

  // Regional AO scale. A snowfield is the worst case for screen-space
  // occlusion: open, smooth and bright, so what GTAO returns there is mostly
  // its own view-dependent bias sliding across the ground.
  setOcclusionScale(scale) {
    const value = Number(scale);
    const next = Number.isFinite(value) ? MathUtils.clamp(value, 0, 1) : 1;
    if (next === this.occlusionScale) return;
    this.occlusionScale = next;
    this.#applyOcclusionStrength();
  }

  #applyOcclusionStrength() {
    if (!this.aoStrength) return;
    const quality = this.quality === 'balanced' ? 0.75 : 1;
    this.aoStrength.value = this.settings.aoStrength * quality * (this.occlusionScale ?? 1);
  }

  setEffect(name, value) {
    if (!isPostEffect(name, value) || this.effects[name] === value) return;
    this.effects[name] = value;
    if (!this.post) return;
    if (UNIFORM_EFFECTS.has(name)) this.#applyUniformEffects();
    else this.#build();
  }

  setFocusDistance(distance) {
    if (this.focus && Number.isFinite(distance)) this.focus.distance.value = distance;
  }

  #updateUniforms() {
    const { camera, sun } = this.world;
    this.clip.near.value = camera.near;
    this.clip.far.value = camera.far;
    this.shafts.aspect.value = camera.aspect;
    if (!this.effects.lightShafts || !sun) {
      this.shafts.intensity.value = 0;
      return;
    }
    const direction = _sunDirection.copy(sun.position).sub(sun.target.position).normalize();
    const facing = MathUtils.smoothstep(camera.getWorldDirection(_forward).dot(direction), 0, 0.3);
    const ndc = _sunPoint.copy(direction).multiplyScalar(camera.far * 0.5).add(camera.position).project(camera);
    const onScreen = 1 - MathUtils.smoothstep(Math.max(Math.abs(ndc.x), Math.abs(ndc.y)), 1, 1.7);
    // Shafts belong to a low sun; at midday they fade out entirely.
    const elevation = MathUtils.smoothstep(direction.y, -0.02, 0.08) * (1 - MathUtils.smoothstep(direction.y, 0.45, 0.75));
    this.shafts.uv.value.set(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    this.shafts.color.value.set(sun.color.r, sun.color.g, sun.color.b);
    const shafts = this.settings.lightShafts;
    const strength = MathUtils.lerp(shafts?.strength ?? 0.6, shafts?.snowStrength ?? shafts?.strength ?? 0.6, this.shafts.boost);
    this.shafts.intensity.value = facing * onScreen * elevation * strength;
  }

  async warmup({ water, signal, nextFrame = () => new Promise(requestAnimationFrame) } = {}) {
    signal?.throwIfAborted();
    // PassNode updates once per renderer frame, including during loading.
    await nextFrame();
    signal?.throwIfAborted();
    const started = performance.now();
    const counts = withSceneWarmup(this.world.scene, () => {
      const render = () => {
        this.warming = true;
        try { this.render({ occlusionEnabled: false }); }
        finally { this.warming = false; }
      };
      if (water) water.withReflectionWarmup(render);
      else render();
    });
    const cpuMs = performance.now() - started;
    await this.world.renderer.backend?.device?.queue.onSubmittedWorkDone();
    this.warmupStats = { ...counts, cpuMs, elapsedMs: performance.now() - started };
    signal?.throwIfAborted();
    // Allow a real opening-view render to replace the empty preparation pass.
    await nextFrame();
    signal?.throwIfAborted();
  }

  #installCpuHooks() {
    if (!this.enabled) return;
    const { scenePass, depth, occlusion, bloom: bloomNode } = this.stage;
    for (const [node, name] of [[scenePass, 'scene'], [depth, 'depthResolve'], [occlusion, 'gtao'], [bloomNode, 'bloom']]) {
      if (!node || this.hookedNodes.has(node)) continue;
      this.hookedNodes.add(node);
      wrapNodeUpdateBefore(node, this.cpu, name);
    }
  }

  render({ occlusionEnabled = true, profiler } = {}) {
    this.#installCpuHooks();
    resetCpuStats(this.cpu);
    this.world.scene.userData.updateCoastalJungleVisibility?.(this.world.camera);
    const started = performance.now();
    if (occlusionEnabled) this.gpuOcclusion.prepare();
    else this.gpuOcclusion.active.clear();
    this.gpuOcclusion.lastPrepareMs = performance.now() - started;
    const drawStart = performance.now();
    this.gpuOcclusion.render(() => {
      if (this.enabled) {
        this.#updateUniforms();
        this.post.render();
      } else {
        const sceneStart = performance.now();
        this.world.renderer.render(this.world.scene, this.world.camera);
        this.cpu.scene += performance.now() - sceneStart;
      }
    });
    accountComposite(this.cpu, performance.now() - drawStart);
    applyCpuMarks(profiler, this.cpu);
  }

  dispose() {
    this.gpuOcclusion.dispose();
    for (const node of this.transient ?? []) node.dispose?.();
    for (const stage of Object.values(this.stages ?? {})) {
      stage.scenePass.dispose();
      stage.depth.dispose();
      stage.normals?.dispose?.();
      stage.occlusion.dispose();
      stage.resolve?.dispose();
      stage.bloom?.dispose();
      for (const node of stage.shaftPasses ?? []) node.dispose();
    }
    this.post?.dispose();
  }
}
