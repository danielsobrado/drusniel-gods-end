import {
  RenderPipeline, FloatType, RedFormat, NearestFilter, Vector2, Vector3, MathUtils, ACESFilmicToneMapping, AgXToneMapping,
} from 'three/webgpu';
import {
  pass, rtt, renderOutput, vec4, vec3, vec2, uniform, mix, dot, uv, smoothstep, float, fract, sin, screenCoordinate, time,
  mrt, output, velocity, Fn, Loop, step, perspectiveDepthToViewZ,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { GpuOcclusion } from './GpuOcclusion.js';
import { createDepthNormals } from './DepthNormals.js';
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
    };
    this.clip = { near: uniform(0.1), far: uniform(1000) };
    this.shafts = { uv: uniform(new Vector2(0.5, 0.5)), color: uniform(new Vector3()), intensity: uniform(0) };
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
    return rolled.mul(vignette).add(grain).max(0);
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
    const depth = rtt(scenePass.getTextureNode('depth').r, null, null, {
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

  // Screen-space shafts: march from each pixel toward the sun's screen point and
  // accumulate how much of that ray sees open sky (the sky dome writes no depth).
  #lightShafts(depth) {
    const samples = this.settings.lightShafts?.samples ?? 28;
    const decay = this.settings.lightShafts?.decay ?? 0.95;
    const normalization = (1 - decay) / (1 - decay ** samples);
    return Fn(() => {
      const coord = uv().toVar();
      const stepUv = this.shafts.uv.sub(coord).div(samples);
      const sum = float(0).toVar();
      const weight = float(1).toVar();
      Loop(samples, () => {
        coord.addAssign(stepUv);
        sum.addAssign(step(0.99999, depth.sample(coord).r).mul(weight));
        weight.mulAssign(decay);
      });
      const nearSun = smoothstep(0.85, 0, uv().sub(this.shafts.uv).length());
      return this.shafts.color.mul(sum.mul(normalization).mul(nearSun).mul(this.shafts.intensity));
    })();
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
      lit = lit.mul(mix(1, stage.occlusion.r, this.aoStrength));
      if (this.effects.bloom) {
        stage.bloom ??= bloom(stage.beauty, this.settings.bloomStrength, 0.3, this.settings.bloomThreshold);
        lit = lit.add(stage.bloom.rgb);
      }
      if (this.effects.lightShafts) lit = lit.add(this.#lightShafts(stage.depth));
    }
    let hdr = vec4(lit, stage.beauty.a);
    if (!lean && this.effects.depthOfField) {
      const viewZ = perspectiveDepthToViewZ(stage.depth.r, this.clip.near, this.clip.far);
      hdr = this.#track(dof(hdr, viewZ, this.focus.distance, this.focus.range, this.focus.bokeh));
    }
    const toneMapping = this.effects.tonemapper === 'agx' ? AgXToneMapping : ACESFilmicToneMapping;
    let display = renderOutput(vec4(this.#grade(hdr.rgb), hdr.a), toneMapping);
    if (this.effects.sharpen) display = this.#track(sharpen(display, this.sharpness));
    // High/Ultra already use multisample coverage and TAA resolves its own
    // edges. A second FXAA pass there only softens foliage detail.
    const smoothEdges = !temporal && (lean || this.quality === 'balanced' || (this.settings.samples ?? 4) < 2);
    if (smoothEdges) display = this.#track(fxaa(display));
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
    this.aoStrength.value = this.settings.aoStrength * (name === 'balanced' ? 0.75 : 1);
    this.#build();
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
    this.shafts.intensity.value = facing * onScreen * elevation * (this.settings.lightShafts?.strength ?? 0.6);
  }

  async warmup({ water, signal, nextFrame = () => new Promise(requestAnimationFrame) } = {}) {
    signal?.throwIfAborted();
    // PassNode updates once per renderer frame, including during loading.
    await nextFrame();
    signal?.throwIfAborted();
    const started = performance.now();
    const counts = withSceneWarmup(this.world.scene, () => {
      const render = () => this.render({ occlusionEnabled: false });
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
    }
    this.post?.dispose();
  }
}
